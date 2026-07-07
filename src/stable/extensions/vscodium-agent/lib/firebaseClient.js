/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – Firebase AI Logic Client
 *
 * Dependency-freier REST-Client gegen Firebase AI Logic (firebasevertexai.googleapis.com).
 * Entspricht dem Wire-Format des offiziellen firebase-js-sdk (packages/ai):
 *   - GoogleAI-Backend:  /v1beta/projects/{project}/models/{model}:generateContent
 *   - VertexAI-Backend:  /v1beta/projects/{project}/locations/{loc}/publishers/google/models/{model}:generateContent
 *   - Auth über Header "x-goog-api-key" (Firebase Web-API-Key), optional "X-Firebase-Appid".
 *--------------------------------------------------------------------------------------------*/

'use strict';

const DEFAULT_DOMAIN = 'firebasevertexai.googleapis.com';
const API_VERSION = 'v1beta';

class FirebaseAiError extends Error {
	/**
	 * @param {string} message
	 * @param {{status?: number, retryable?: boolean, hint?: string}} [opts]
	 */
	constructor(message, opts = {}) {
		super(message);
		this.name = 'FirebaseAiError';
		this.status = opts.status;
		this.retryable = Boolean(opts.retryable);
		this.hint = opts.hint;
	}
}

class FirebaseAiLogicClient {
	/**
	 * @param {{
	 *   apiKey: string,
	 *   projectId: string,
	 *   appId?: string,
	 *   backend?: 'googleAI'|'vertexAI',
	 *   location?: string,
	 *   model: string,
	 *   fetchImpl?: typeof fetch,
	 * }} options
	 */
	constructor(options) {
		if (!options || !options.apiKey) {
			throw new FirebaseAiError('Kein Firebase API-Key konfiguriert.', {
				hint: 'Kommando "Agent: Firebase API-Key setzen" ausführen (Key aus Firebase Console → Projekteinstellungen → Web-App).'
			});
		}
		if (!options.projectId) {
			throw new FirebaseAiError('Keine Firebase-Projekt-ID konfiguriert (Einstellung vscodiumAgent.firebase.projectId).');
		}
		this.apiKey = options.apiKey;
		this.projectId = options.projectId;
		this.appId = options.appId || '';
		this.backend = options.backend === 'vertexAI' ? 'vertexAI' : 'googleAI';
		this.location = options.location || 'us-central1';
		this.model = normalizeModelName(options.model || 'gemini-2.5-flash');
		this._fetch = options.fetchImpl || globalThis.fetch;
		if (typeof this._fetch !== 'function') {
			throw new FirebaseAiError('Globales fetch ist nicht verfügbar.');
		}
	}

	/** Pfad wie im firebase-js-sdk (backend.ts + AIModel.normalizeModelName). */
	get modelPath() {
		if (this.backend === 'vertexAI') {
			return `projects/${this.projectId}/locations/${this.location}/publishers/google/models/${this.model}`;
		}
		return `projects/${this.projectId}/models/${this.model}`;
	}

	/** @param {string} task */
	url(task) {
		return `https://${DEFAULT_DOMAIN}/${API_VERSION}/${this.modelPath}:${task}`;
	}

	headers() {
		const h = {
			'Content-Type': 'application/json',
			'x-goog-api-key': this.apiKey,
			'x-goog-api-client': 'gl-js/vscodium-agent fire/vscodium-agent'
		};
		if (this.appId) {
			h['X-Firebase-Appid'] = this.appId;
		}
		return h;
	}

	/**
	 * Nicht-streamender generateContent-Aufruf mit einfachem Retry bei 429/503.
	 * @param {object} request GenerateContentRequest (contents, tools, systemInstruction, …)
	 * @param {AbortSignal} [signal]
	 * @returns {Promise<object>} GenerateContentResponse
	 */
	async generateContent(request, signal) {
		const maxAttempts = 3;
		let lastError;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return await this._post(this.url('generateContent'), request, signal);
			} catch (err) {
				lastError = err;
				const aborted = signal && signal.aborted;
				if (aborted || !(err instanceof FirebaseAiError) || !err.retryable || attempt === maxAttempts) {
					throw err;
				}
				await sleep(attempt * 2500, signal);
			}
		}
		throw lastError;
	}

	/** Minimaler Verbindungstest. */
	async ping(signal) {
		const res = await this.generateContent({
			contents: [{ role: 'user', parts: [{ text: 'Antworte nur mit: ok' }] }],
			generationConfig: { maxOutputTokens: 10, temperature: 0 }
		}, signal);
		return extractText(res) || 'ok';
	}

	async _post(url, body, signal) {
		let response;
		try {
			response = await this._fetch(url, {
				method: 'POST',
				headers: this.headers(),
				body: JSON.stringify(body),
				signal
			});
		} catch (err) {
			if (err && err.name === 'AbortError') {
				throw err;
			}
			throw new FirebaseAiError(`Netzwerkfehler beim Aufruf von Firebase AI Logic: ${err.message}`, { retryable: true });
		}

		if (response.ok) {
			return response.json();
		}

		let message = '';
		let details;
		try {
			const json = await response.json();
			if (json && json.error) {
				message = json.error.message || '';
				details = json.error.details;
			}
		} catch (_e) { /* ignorieren */ }

		if (response.status === 403 && Array.isArray(details) && details.some(d => d && d.reason === 'SERVICE_DISABLED')) {
			throw new FirebaseAiError(
				'Die Firebase AI Logic API ist für dieses Projekt nicht aktiviert.',
				{
					status: 403,
					hint: `In der Firebase Console öffnen: https://console.firebase.google.com/project/${this.projectId}/ailogic/ → "Get started". Danach einige Minuten warten.`
				}
			);
		}
		if (response.status === 401 || response.status === 403) {
			throw new FirebaseAiError(`Authentifizierung fehlgeschlagen (${response.status}): ${message}`, {
				status: response.status,
				hint: 'API-Key prüfen (Firebase Console → Projekteinstellungen → Allgemein → Web-App → apiKey). Ggf. API-Key-Einschränkungen: firebasevertexai.googleapis.com muss erlaubt sein.'
			});
		}
		if (response.status === 404) {
			throw new FirebaseAiError(`Modell oder Pfad nicht gefunden (404): ${message}`, {
				status: 404,
				hint: `Modellname prüfen (Einstellung vscodiumAgent.model, aktuell "${this.model}") und Backend (googleAI/vertexAI).`
			});
		}
		const retryable = response.status === 429 || response.status >= 500;
		throw new FirebaseAiError(`Firebase AI Logic Fehler [${response.status} ${response.statusText}] ${message}`, {
			status: response.status,
			retryable
		});
	}
}

/** "models/x" | "publishers/google/models/x" | "x" → "x" */
function normalizeModelName(name) {
	const trimmed = String(name || '').trim();
	const parts = trimmed.split('/');
	return parts[parts.length - 1] || 'gemini-2.5-flash';
}

/** Erste Text-Teile einer Antwort extrahieren. */
function extractText(response) {
	const parts = extractParts(response);
	return parts.filter(p => typeof p.text === 'string').map(p => p.text).join('');
}

/** Alle Parts des ersten Kandidaten (leeres Array, wenn keine). */
function extractParts(response) {
	if (!response || !Array.isArray(response.candidates) || response.candidates.length === 0) {
		return [];
	}
	const content = response.candidates[0].content;
	return (content && Array.isArray(content.parts)) ? content.parts : [];
}

/** FunctionCall-Parts des ersten Kandidaten. */
function extractFunctionCalls(response) {
	return extractParts(response).filter(p => p.functionCall && p.functionCall.name);
}

/** Blockierung/Abbruchgrund als String (oder null). */
function extractBlockReason(response) {
	if (response && response.promptFeedback && response.promptFeedback.blockReason) {
		return `Prompt blockiert: ${response.promptFeedback.blockReason}`;
	}
	const cand = response && Array.isArray(response.candidates) ? response.candidates[0] : undefined;
	if (cand && cand.finishReason && !['STOP', 'MAX_TOKENS'].includes(cand.finishReason)) {
		return `Antwort beendet mit: ${cand.finishReason}`;
	}
	return null;
}

function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		if (signal) {
			signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
		}
	});
}

module.exports = {
	FirebaseAiLogicClient,
	FirebaseAiError,
	extractText,
	extractParts,
	extractFunctionCalls,
	extractBlockReason,
	normalizeModelName
};
