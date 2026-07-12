/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – Client für den Agent-Proxy (Cloud Run, Phase S).
 *
 * Gleiches Interface wie FirebaseAiLogicClient (generateContent, generateContentStream,
 * ping, model/projectId), aber: Authentifizierung per Firebase-ID-Token (Bearer) statt
 * API-Key, und Standort-Routing liegt beim Server. `getIdToken` liefert pro Anfrage ein
 * frisches Token (Auto-Erneuerung übernimmt der AuthManager).
 *--------------------------------------------------------------------------------------------*/

'use strict';

const { createSseParser, mergeStreamResponses, normalizeModelName, extractText } = require('./firebaseClient');

const MAX_ATTEMPTS = 3;

class ProxyError extends Error {
	constructor(message, { status, hint, retryable } = {}) {
		super(message);
		this.name = 'ProxyError';
		this.status = status;
		this.hint = hint;
		this.retryable = Boolean(retryable);
	}
}

function sleep(ms, signal) {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		if (signal) {
			signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
		}
	});
}

class ProxyClient {
	/**
	 * @param {{ baseUrl: string, model?: string, getIdToken: () => Promise<string>,
	 *           fetchImpl?: typeof fetch }} options
	 */
	constructor(options) {
		if (!options.baseUrl) { throw new ProxyError('Proxy-URL fehlt (Einstellung vscodiumAgent.proxy.url).'); }
		if (typeof options.getIdToken !== 'function') { throw new ProxyError('getIdToken fehlt.'); }
		this.baseUrl = String(options.baseUrl).replace(/\/+$/, '');
		this.model = normalizeModelName(options.model || 'gemini-2.5-flash');
		this.getIdToken = options.getIdToken;
		this.fetchImpl = options.fetchImpl || fetch;
		this.retryDelayMs = options.retryDelayMs === undefined ? 2500 : options.retryDelayMs;
		this.kind = 'proxy';
		// Pendant zur Projekt-ID des Key-Pfads – nur für Anzeigen (Verbindungstest, Logs).
		try { this.projectId = new URL(this.baseUrl).host; } catch (_e) { this.projectId = this.baseUrl; }
	}

	url(task) {
		return `${this.baseUrl}/v1/models/${encodeURIComponent(this.model)}:${task}`;
	}

	async _headers() {
		return {
			'Authorization': `Bearer ${await this.getIdToken()}`,
			'Content-Type': 'application/json'
		};
	}

	/** Nicht-streamender Aufruf mit einfachem Retry bei 429/5xx (wie der Key-Pfad). */
	async generateContent(request, signal) {
		let lastError;
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			try {
				let response;
				try {
					response = await this.fetchImpl(this.url('generateContent'), {
						method: 'POST',
						headers: await this._headers(),
						body: JSON.stringify(request),
						signal
					});
				} catch (err) {
					if (err && err.name === 'AbortError') { throw err; }
					throw new ProxyError(`Netzwerkfehler zum Agent-Proxy: ${err.message}`, { retryable: true });
				}
				if (!response.ok) { throw await this._errorFromResponse(response); }
				return await response.json();
			} catch (err) {
				lastError = err;
				const aborted = signal && signal.aborted;
				if (aborted || !(err instanceof ProxyError) || !err.retryable || attempt === MAX_ATTEMPTS) {
					throw err;
				}
				await sleep(attempt * this.retryDelayMs, signal);
			}
		}
		throw lastError;
	}

	/**
	 * Streamender Aufruf (SSE-Durchleitung des Proxys). Verhalten wie der Key-Pfad:
	 * onText je Fragment, am Ende die zusammengeführte Antwort, bewusst ohne Retry.
	 */
	async generateContentStream(request, signal, onText) {
		let response;
		try {
			response = await this.fetchImpl(this.url('streamGenerateContent'), {
				method: 'POST',
				headers: await this._headers(),
				body: JSON.stringify(request),
				signal
			});
		} catch (err) {
			if (err && err.name === 'AbortError') { throw err; }
			throw new ProxyError(`Netzwerkfehler beim Streaming über den Agent-Proxy: ${err.message}`, { retryable: true });
		}
		if (!response.ok || !response.body) {
			throw await this._errorFromResponse(response);
		}

		const chunks = [];
		const parser = createSseParser((data) => {
			let json;
			try { json = JSON.parse(data); } catch (_e) { return; }
			chunks.push(json);
			const text = extractText(json);
			if (text && onText) { onText(text); }
		});
		const decoder = new TextDecoder('utf-8');
		for await (const piece of response.body) {
			parser.push(decoder.decode(piece, { stream: true }));
		}
		parser.push(decoder.decode());
		parser.end();

		if (chunks.length === 0) {
			throw new ProxyError('Leere Streaming-Antwort vom Agent-Proxy.');
		}
		return mergeStreamResponses(chunks);
	}

	/** Katalog des Proxys – zugleich das Angebot für den Modell-Picker. */
	async listModels(signal) {
		const response = await this.fetchImpl(`${this.baseUrl}/v1/models`, {
			headers: { 'Authorization': `Bearer ${await this.getIdToken()}` },
			signal
		});
		if (!response.ok) { throw await this._errorFromResponse(response); }
		const json = await response.json();
		return Array.isArray(json.models) ? json.models : [];
	}

	/** Verbindungstest: Katalog abrufen statt Tokens zu verbrauchen. */
	async ping(signal) {
		const models = await this.listModels(signal);
		return `${models.length} Modelle im Angebot`;
	}

	async _errorFromResponse(response) {
		if (!response) { return new ProxyError('Keine Antwort vom Agent-Proxy.'); }
		let message = '';
		try {
			const json = await response.json();
			if (json && json.error) {
				message = typeof json.error === 'string' ? json.error : JSON.stringify(json.error);
				if (json.detail) { message += ` (${json.detail})`; }
			}
		} catch (_e) { /* kein JSON-Körper */ }
		let hint;
		if (response.status === 401) {
			hint = 'Anmeldung fehlt oder ist abgelaufen – Kommando „Agent: Mit Google anmelden“ ausführen.';
		} else if (response.status === 429) {
			hint = 'Anfrage-Limit erreicht – kurz warten und erneut versuchen.';
		} else if (response.status === 404) {
			hint = 'Modell nicht im Proxy-Angebot – im Modell-Picker eines der angebotenen Modelle wählen.';
		}
		return new ProxyError(`Agent-Proxy [${response.status}]: ${message || response.statusText || 'Fehler'}`, {
			status: response.status,
			hint,
			retryable: response.status === 429 || response.status >= 500
		});
	}
}

module.exports = { ProxyClient, ProxyError };
