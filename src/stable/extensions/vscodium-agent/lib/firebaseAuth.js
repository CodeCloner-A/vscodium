/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – Google-Anmeldung für Firebase Auth ohne Abhängigkeiten (Phase S).
 *
 * Ablauf (OAuth 2.0 für installierte Apps, PKCE):
 *   1. Loopback-Server auf 127.0.0.1:<zufälliger Port> starten.
 *   2. Browser zur Google-Anmeldung öffnen (code_challenge = S256, state gegen CSRF).
 *   3. Redirect liefert den Auth-Code an den Loopback; Code → Google-Tokens tauschen.
 *   4. Google-ID-Token bei Firebase einlösen (accounts:signInWithIdp) →
 *      Firebase-ID-Token + Refresh-Token.
 *
 * Der Client-Secret eines "Desktop-App"-OAuth-Clients gilt laut Google-Doku ausdrücklich
 * NICHT als vertraulich – die eigentliche Sicherheit liefern PKCE und der Loopback.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const crypto = require('crypto');
const http = require('http');

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SIGNIN_WITH_IDP_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp';
const REFRESH_URL = 'https://securetoken.googleapis.com/v1/token';
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

/**
 * Kompletter Anmelde-Flow. Alle Netz-/Browser-Zugriffe injizierbar (Tests).
 *
 * @param {{ clientId: string, clientSecret: string, apiKey: string,
 *           openBrowser: (url: string) => Promise<void> | void,
 *           fetchImpl?: typeof fetch, timeoutMs?: number, signal?: AbortSignal }} options
 * @returns {Promise<{ idToken: string, refreshToken: string, expiresAt: number, email: string }>}
 */
async function signInWithGoogle(options) {
	const { clientId, clientSecret, apiKey, openBrowser, signal } = options;
	if (!clientId || !clientSecret) {
		throw new AuthError('OAuth-Client fehlt (Einstellungen: vscodiumAgent.auth.googleClientId/-Secret).');
	}
	if (!apiKey) { throw new AuthError('Firebase Web-API-Key fehlt.'); }
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

	// Auth-Code → Google-Tokens (der PKCE-Verifier belegt den Ursprung der Anfrage).
	const tokenRes = await fetchImpl(GOOGLE_TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			code,
			client_id: clientId,
			client_secret: clientSecret,
			redirect_uri: redirectUri,
			grant_type: 'authorization_code',
			code_verifier: verifier
		}).toString()
	});
	const tokenJson = await tokenRes.json();
	if (!tokenRes.ok || !tokenJson.id_token) {
		throw new AuthError(`Token-Tausch fehlgeschlagen: ${tokenJson.error_description || tokenJson.error || tokenRes.status}`);
	}

	// Google-ID-Token bei Firebase einlösen.
	const idpRes = await fetchImpl(`${SIGNIN_WITH_IDP_URL}?key=${encodeURIComponent(apiKey)}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			postBody: `id_token=${tokenJson.id_token}&providerId=google.com`,
			requestUri: 'http://localhost',
			returnSecureToken: true
		})
	});
	const idpJson = await idpRes.json();
	if (!idpRes.ok || !idpJson.idToken || !idpJson.refreshToken) {
		const message = (idpJson.error && idpJson.error.message) || idpRes.status;
		throw new AuthError(`Firebase-Anmeldung fehlgeschlagen: ${message}`);
	}
	const expiresInSec = parseInt(idpJson.expiresIn || '3600', 10);
	return {
		idToken: idpJson.idToken,
		refreshToken: idpJson.refreshToken,
		expiresAt: Date.now() + expiresInSec * 1000,
		email: idpJson.email || (decodeJwtPayload(idpJson.idToken) || {}).email || ''
	};
}

/**
 * Firebase-ID-Token erneuern. Achtung: Der Refresh-Token kann rotieren –
 * der zurückgegebene ersetzt den gespeicherten.
 */
async function refreshIdToken({ apiKey, refreshToken, fetchImpl }) {
	if (!apiKey) { throw new AuthError('Firebase Web-API-Key fehlt.'); }
	const doFetch = fetchImpl || fetch;
	const res = await doFetch(`${REFRESH_URL}?key=${encodeURIComponent(apiKey)}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
		// Hängende Erneuerungen offen zu lassen wäre ein unbegrenztes Race-Fenster
		// (z. B. Abmelden während der Wartezeit).
		signal: AbortSignal.timeout(20000)
	});
	const json = await res.json();
	if (!res.ok || !json.id_token) {
		const message = (json.error && json.error.message) || res.status;
		throw new AuthError(`Token-Erneuerung fehlgeschlagen: ${message}`);
	}
	return {
		idToken: json.id_token,
		refreshToken: json.refresh_token || refreshToken,
		expiresAt: Date.now() + parseInt(json.expires_in || '3600', 10) * 1000
	};
}

module.exports = { signInWithGoogle, refreshIdToken, createPkce, buildAuthUrl, decodeJwtPayload, AuthError };
