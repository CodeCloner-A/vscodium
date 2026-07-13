/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – Google-Anmeldung für Firebase Auth ohne Abhängigkeiten (Phase S).
 *
 * Ablauf (OAuth 2.0 für installierte Apps, PKCE):
 *   1. Loopback-Server auf 127.0.0.1:<zufälliger Port> starten.
 *   2. Browser zur Google-Anmeldung öffnen (code_challenge = S256, state gegen CSRF).
 *   3. Redirect liefert den Auth-Code an den Loopback.
 *   4. Auth-Code + PKCE-Verifier ans Auth-Relay des Agent-Proxys (/v1/auth/exchange) –
 *      OAuth-Client-Secret und Firebase-Web-API-Key leben NUR dort (Secret Manager),
 *      nie im Client. Zurück kommen Firebase-ID-Token + Refresh-Token.
 *
 * Auch die Token-Erneuerung läuft über das Relay (/v1/auth/refresh).
 *--------------------------------------------------------------------------------------------*/

'use strict';

const crypto = require('crypto');
const http = require('http');

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

class AuthError extends Error {
	constructor(message) {
		super(message);
		this.name = 'AuthError';
	}
}

function createPkce() {
	const verifier = crypto.randomBytes(48).toString('base64url');
	const challenge = crypto.createHash('sha256').update(verifier).digest().toString('base64url');
	return { verifier, challenge };
}

/** Nutzlast eines JWT lesen (ohne Signaturprüfung – nur für Anzeige/Ablaufzeit). */
function decodeJwtPayload(token) {
	try {
		return JSON.parse(Buffer.from(String(token).split('.')[1] || '', 'base64url').toString('utf8'));
	} catch (_e) {
		return null;
	}
}

function buildAuthUrl({ clientId, redirectUri, challenge, state }) {
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: 'code',
		scope: 'openid email',
		code_challenge: challenge,
		code_challenge_method: 'S256',
		state,
		prompt: 'select_account'
	});
	return `${GOOGLE_AUTH_URL}?${params}`;
}

function htmlPage(title, body) {
	return `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><title>${title}</title>` +
		`<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0}div{text-align:center}</style>` +
		`</head><body><div><h1>${title}</h1><p>${body}</p></div></body></html>`;
}

/** POST ans Auth-Relay des Proxys; Fehlerkörper {error} wird zur AuthError-Meldung. */
async function postAuthRelay({ proxyUrl, path, payload, fetchImpl, timeoutMs }) {
	let res;
	try {
		res = await fetchImpl(`${proxyUrl}${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(timeoutMs)
		});
	} catch (err) {
		throw new AuthError(`Agent-Proxy nicht erreichbar: ${err.name === 'TimeoutError' ? 'Zeitüberschreitung' : err.message}`);
	}
	let json;
	try { json = await res.json(); } catch (_e) { json = {}; }
	if (!res.ok) {
		throw new AuthError(json.error || `Agent-Proxy antwortet mit HTTP ${res.status}`);
	}
	return json;
}

/**
 * Kompletter Anmelde-Flow. Alle Netz-/Browser-Zugriffe injizierbar (Tests).
 *
 * @param {{ clientId: string, proxyUrl: string,
 *           openBrowser: (url: string) => Promise<void> | void,
 *           fetchImpl?: typeof fetch, timeoutMs?: number, signal?: AbortSignal }} options
 * @returns {Promise<{ idToken: string, refreshToken: string, expiresAt: number, email: string }>}
 */
async function signInWithGoogle(options) {
	const { clientId, proxyUrl, openBrowser, signal } = options;
	if (!clientId) {
		throw new AuthError('OAuth-Client-ID fehlt (fest eingebaut in lib/saasConfig.js – vor dem Release eintragen).');
	}
	if (!proxyUrl) { throw new AuthError('Proxy-URL fehlt (Einstellung vscodiumAgent.proxy.url).'); }
	if (signal && signal.aborted) { throw new AuthError('Anmeldung abgebrochen.'); }
	const fetchImpl = options.fetchImpl || fetch;
	const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
	const { verifier, challenge } = createPkce();
	const state = crypto.randomBytes(16).toString('base64url');

	// Loopback nur auf 127.0.0.1; Port vergibt das Betriebssystem.
	const server = http.createServer();
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;

	// Genau ein gültiger Redirect beendet das Warten; Timeout und Abbruch (AbortSignal)
	// lassen es scheitern. timer/onAbort liegen außerhalb, damit der finally-Block unten
	// auch bei einem Fehler in openBrowser() aufräumen kann (sonst bliebe der Loopback
	// bis zu timeoutMs gebunden).
	let timer;
	let onAbort;
	const codePromise = new Promise((resolve, reject) => {
		timer = setTimeout(() => {
			reject(new AuthError('Anmeldung abgelaufen (keine Antwort vom Browser).'));
			server.close();
		}, timeoutMs);
		if (signal) {
			onAbort = () => {
				reject(new AuthError('Anmeldung abgebrochen.'));
				server.close();
			};
			signal.addEventListener('abort', onAbort, { once: true });
		}
		const finish = (fn, value, res, status, page) => {
			res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
			res.end(page);
			fn(value);
			setImmediate(() => server.close());
		};
		server.on('request', (req, res) => {
			const url = new URL(req.url, 'http://127.0.0.1');
			if (url.pathname !== '/callback') {
				res.writeHead(404);
				res.end();
				return;
			}
			const error = url.searchParams.get('error');
			const code = url.searchParams.get('code');
			const gotState = url.searchParams.get('state');
			if (error || !code || gotState !== state) {
				finish(reject, new AuthError(error ? `Google meldet: ${error}` : 'Ungültige Antwort (state-Prüfung).'),
					res, 400, htmlPage('Anmeldung fehlgeschlagen', 'Dieses Fenster kann geschlossen werden.'));
				return;
			}
			finish(resolve, code,
				res, 200, htmlPage('Anmeldung erfolgreich', 'Zurück zur IDE – dieses Fenster kann geschlossen werden.'));
		});
	});

	// Schutz-Handler: Der Redirect (und damit eine mögliche Ablehnung) kann eintreffen,
	// solange der Flow noch in openBrowser() steckt – ohne Handler würde Node den
	// Prozess wegen unhandled rejection beenden. Der Fehler kommt beim await unten an.
	codePromise.catch(() => { });

	let code;
	try {
		await openBrowser(buildAuthUrl({ clientId, redirectUri, challenge, state }));
		code = await codePromise;
	} finally {
		clearTimeout(timer);
		if (signal && onAbort) { signal.removeEventListener('abort', onAbort); }
		server.close(); // idempotent – doppelt schließen ist harmlos
	}

	// Auth-Code + PKCE-Verifier ans Relay – die Geheimnisse (Client-Secret, Web-API-Key)
	// setzt der Proxy serverseitig ein; die Ablaufzeit rechnet der Client mit SEINER Uhr.
	const json = await postAuthRelay({
		proxyUrl, path: '/v1/auth/exchange',
		payload: { code, codeVerifier: verifier, redirectUri },
		fetchImpl, timeoutMs: 30000
	});
	if (!json.idToken || !json.refreshToken) {
		throw new AuthError('Unvollständige Antwort des Auth-Relays (idToken/refreshToken fehlt).');
	}
	return {
		idToken: json.idToken,
		refreshToken: json.refreshToken,
		expiresAt: Date.now() + (parseInt(json.expiresInSec, 10) || 3600) * 1000,
		email: json.email || (decodeJwtPayload(json.idToken) || {}).email || ''
	};
}

/**
 * Firebase-ID-Token über das Auth-Relay erneuern. Achtung: Der Refresh-Token kann
 * rotieren – der zurückgegebene ersetzt den gespeicherten.
 */
async function refreshIdToken({ proxyUrl, refreshToken, fetchImpl }) {
	if (!proxyUrl) { throw new AuthError('Proxy-URL fehlt (Einstellung vscodiumAgent.proxy.url).'); }
	// Zeitlimit: Hängende Erneuerungen offen zu lassen wäre ein unbegrenztes Race-Fenster
	// (z. B. Abmelden während der Wartezeit).
	const json = await postAuthRelay({
		proxyUrl, path: '/v1/auth/refresh',
		payload: { refreshToken },
		fetchImpl: fetchImpl || fetch, timeoutMs: 20000
	});
	if (!json.idToken) {
		throw new AuthError('Unvollständige Antwort des Auth-Relays (idToken fehlt).');
	}
	return {
		idToken: json.idToken,
		refreshToken: json.refreshToken || refreshToken,
		expiresAt: Date.now() + (parseInt(json.expiresInSec, 10) || 3600) * 1000
	};
}

module.exports = { signInWithGoogle, refreshIdToken, createPkce, buildAuthUrl, decodeJwtPayload, AuthError };
