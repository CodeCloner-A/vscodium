/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – Client für den Agent-Proxy (Cloud Run, Phase S).
 *
 * Seit dem BYOK-Rückbau (v0.9.0) der einzige Modell-Transport: Authentifizierung per
 * Firebase-ID-Token (Bearer), Standort-Routing und Modell-Allowlist liegen beim Server.
 * `getIdToken` liefert pro Anfrage ein frisches Token (Auto-Erneuerung übernimmt der
 * AuthManager).
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

/** Verbrauchs-Snapshot des Proxys (GET /v1/usage) als deutscher Anzeigetext. */
function formatUsage(usage) {
	const de = (n) => Number(n || 0).toLocaleString('de-DE');
	let monthLabel = String(usage.month || '');
	const parsed = /^(\d{4})-(\d{2})$/.exec(monthLabel);
	if (parsed) {
		monthLabel = new Date(Date.UTC(Number(parsed[1]), Number(parsed[2]) - 1, 1))
			.toLocaleDateString('de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' });
	}
	const suffix = `${de(usage.requests)} Anfragen · Tarif ${usage.plan || 'free'}`;
	if (!usage.limit || usage.limit <= 0) {
		return `Verbrauch im ${monthLabel}: ${de(usage.totalTokens)} Tokens (kein Limit) · ${suffix}`;
	}
	const percent = Math.round((Number(usage.totalTokens) || 0) / usage.limit * 100);
	return `Verbrauch im ${monthLabel}: ${de(usage.totalTokens)} von ${de(usage.limit)} Tokens (${percent} %) · ${suffix}`;
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
				// Token/Erneuerung außerhalb des Netzwerk-try beschaffen: Ein harter
				// Anmelde-/Erneuerungsfehler (Refresh-Token abgelaufen/widerrufen) ist KEIN
				// retrybarer Netzwerkfehler – sonst würde er 3× wiederholt und sein
				// Anmelde-Hinweis ginge hinter „Netzwerkfehler“ verloren.
				const headers = await this._headers();
				let response;
				try {
					response = await this.fetchImpl(this.url('generateContent'), {
						method: 'POST',
						headers,
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
		// Token/Erneuerung vor dem Netzwerk-try beschaffen (s. generateContent): ein
		// Anmelde-/Erneuerungsfehler soll nicht als „Netzwerkfehler“ verschleiert werden.
		const headers = await this._headers();
		let response;
		try {
			response = await this.fetchImpl(this.url('streamGenerateContent'), {
				method: 'POST',
				headers,
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

	/** Monatsverbrauch + Limit des angemeldeten Nutzers (GET /v1/usage). */
	async getUsage(signal) {
		const response = await this.fetchImpl(`${this.baseUrl}/v1/usage`, {
			headers: { 'Authorization': `Bearer ${await this.getIdToken()}` },
			signal
		});
		if (!response.ok) {
			const err = await this._errorFromResponse(response);
			// Der generische 404-Hinweis ("Modell nicht im Angebot") passt hier nicht:
			// 404 heißt bei /v1/usage alter Proxy oder abgeschaltetes Metering.
			if (err.status === 404) {
				err.hint = 'Der Proxy bietet keine Verbrauchsdaten an (ältere Proxy-Version oder Metering deaktiviert).';
			}
			throw err;
		}
		return response.json();
	}

	async _errorFromResponse(response) {
		if (!response) { return new ProxyError('Keine Antwort vom Agent-Proxy.'); }
		let message = '';
		let reason;
		try {
			const json = await response.json();
			if (json && json.error) {
				message = typeof json.error === 'string' ? json.error : JSON.stringify(json.error);
				if (json.detail) { message += ` (${json.detail})`; }
			}
			if (json) { reason = json.reason; }
		} catch (_e) { /* kein JSON-Körper */ }
		// reason 'quota' = Monatskontingent erschöpft: Warten hilft nicht, also kein Retry –
		// anders als beim Rate-Limit-429 (kurzes Fenster).
		const quota = response.status === 429 && reason === 'quota';
		let hint;
		if (response.status === 401) {
			hint = 'Anmeldung fehlt oder ist abgelaufen – Kommando „Agent: Mit Google anmelden“ ausführen.';
		} else if (quota) {
			hint = 'Monatskontingent erschöpft – Verbrauch über das Konto-Menü („Verbrauch anzeigen“) prüfen.';
		} else if (response.status === 429) {
			hint = 'Anfrage-Limit erreicht – kurz warten und erneut versuchen.';
		} else if (response.status === 404) {
			hint = 'Modell nicht im Proxy-Angebot – im Modell-Picker eines der angebotenen Modelle wählen.';
		}
		return new ProxyError(`Agent-Proxy [${response.status}]: ${message || response.statusText || 'Fehler'}`, {
			status: response.status,
			hint,
			retryable: (response.status === 429 && !quota) || response.status >= 500
		});
	}
}

module.exports = { ProxyClient, ProxyError, formatUsage };
