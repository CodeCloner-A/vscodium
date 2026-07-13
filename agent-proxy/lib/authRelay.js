/*---------------------------------------------------------------------------------------------
 * VSCodium Agent Proxy – Auth-Relay (Phase S, BYOK-Rückbau).
 *
 * Die Extension trägt keinerlei Zugangsdaten mehr: OAuth-Client-Secret und Firebase-
 * Web-API-Key leben nur hier (Secret-Manager-gestützte Env-Vars). Das Relay übernimmt
 * die beiden Aufrufe, die der Client früher selbst machte:
 *
 *   exchange: Auth-Code (+ PKCE-Verifier) → Google-Tokens → accounts:signInWithIdp
 *             → Firebase-ID-Token + Refresh-Token
 *   refresh:  Refresh-Token → securetoken.googleapis.com → frisches ID-Token
 *             (Rotation wird durchgereicht)
 *
 * Niemals Tokens, Codes oder Verifier loggen – Fehlermeldungen enthalten nur die
 * Google-Fehlerkennung, nie Nutzdaten.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SIGNIN_WITH_IDP_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp';
const REFRESH_URL = 'https://securetoken.googleapis.com/v1/token';
const UPSTREAM_TIMEOUT_MS = 20000;
const MAX_FIELD_LENGTH = 4096;

function httpError(status, message) {
	return Object.assign(new Error(message), { status });
}

/** Pflichtfeld: nicht-leerer String mit Längendeckel (schützt vor Missbrauch als Datenschleuder). */
function requireField(value, name) {
	if (typeof value !== 'string' || !value.trim() || value.length > MAX_FIELD_LENGTH) {
		throw httpError(400, `Feld fehlt oder ist ungültig: ${name}`);
	}
	return value;
}

/** Nutzlast eines JWT lesen (ohne Signaturprüfung – nur für die E-Mail-Anzeige). */
function decodeJwtPayload(token) {
	try {
		return JSON.parse(Buffer.from(String(token).split('.')[1] || '', 'base64url').toString('utf8'));
	} catch (_e) {
		return null;
	}
}

/**
 * @param {{ clientId: string, clientSecret: string, apiKey: string, fetchImpl?: typeof fetch }} options
 */
function createAuthRelay(options) {
	const { clientId, clientSecret, apiKey } = options;
	if (!clientId || !clientSecret || !apiKey) {
		throw new Error('Auth-Relay braucht clientId, clientSecret und apiKey.');
	}
	const fetchImpl = options.fetchImpl || fetch;

	async function postForm(url, params) {
		let res;
		try {
			res = await fetchImpl(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: params.toString(),
				signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
			});
		} catch (err) {
			throw httpError(502, `Google nicht erreichbar: ${err.name === 'TimeoutError' ? 'Zeitüberschreitung' : err.message}`);
		}
		let json;
		try { json = await res.json(); } catch (_e) { json = {}; }
		return { res, json };
	}

	return {
		/**
		 * Auth-Code der Browser-Anmeldung einlösen. redirectUri muss der Loopback der
		 * Extension sein – das Relay ist kein offener Token-Tauscher für fremde Flows.
		 * @returns {Promise<{ idToken: string, refreshToken: string, expiresInSec: number, email: string }>}
		 */
		async exchange({ code, codeVerifier, redirectUri }) {
			requireField(code, 'code');
			requireField(codeVerifier, 'codeVerifier');
			requireField(redirectUri, 'redirectUri');
			if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/callback$/.test(redirectUri)) {
				throw httpError(400, 'redirectUri muss der Loopback der Anmeldung sein (http://127.0.0.1:<Port>/callback).');
			}

			const token = await postForm(GOOGLE_TOKEN_URL, new URLSearchParams({
				code,
				client_id: clientId,
				client_secret: clientSecret,
				redirect_uri: redirectUri,
				grant_type: 'authorization_code',
				code_verifier: codeVerifier
			}));
			if (!token.res.ok || !token.json.id_token) {
				// invalid_grant = Code abgelaufen/verbraucht/PKCE falsch → Schuld liegt beim Client (401).
				throw httpError(401, `Token-Tausch fehlgeschlagen: ${token.json.error_description || token.json.error || token.res.status}`);
			}

			let idpRes, idpJson;
			try {
				idpRes = await fetchImpl(`${SIGNIN_WITH_IDP_URL}?key=${encodeURIComponent(apiKey)}`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						postBody: `id_token=${token.json.id_token}&providerId=google.com`,
						requestUri: 'http://localhost',
						returnSecureToken: true
					}),
					signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
				});
				idpJson = await idpRes.json();
			} catch (err) {
				throw httpError(502, `Firebase nicht erreichbar: ${err.name === 'TimeoutError' ? 'Zeitüberschreitung' : err.message}`);
			}
			if (!idpRes.ok || !idpJson.idToken || !idpJson.refreshToken) {
				const message = (idpJson.error && idpJson.error.message) || idpRes.status;
				throw httpError(401, `Firebase-Anmeldung fehlgeschlagen: ${message}`);
			}
			return {
				idToken: idpJson.idToken,
				refreshToken: idpJson.refreshToken,
				// Der Client rechnet die Ablaufzeit mit SEINER Uhr aus (Sekunden statt
				// absolutem Zeitstempel – vermeidet Uhren-Drift zwischen Client und Relay).
				expiresInSec: parseInt(idpJson.expiresIn || '3600', 10),
				email: idpJson.email || (decodeJwtPayload(idpJson.idToken) || {}).email || ''
			};
		},

		/**
		 * ID-Token erneuern. Der Refresh-Token kann rotieren – der zurückgegebene
		 * ersetzt beim Client den gespeicherten.
		 * @returns {Promise<{ idToken: string, refreshToken: string, expiresInSec: number }>}
		 */
		async refresh({ refreshToken }) {
			requireField(refreshToken, 'refreshToken');
			const { res, json } = await postForm(`${REFRESH_URL}?key=${encodeURIComponent(apiKey)}`,
				new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }));
			if (!res.ok || !json.id_token) {
				const message = (json.error && json.error.message) || res.status;
				// TOKEN_EXPIRED/USER_DISABLED etc. → Client muss sich neu anmelden.
				throw httpError(401, `Token-Erneuerung fehlgeschlagen: ${message}`);
			}
			return {
				idToken: json.id_token,
				refreshToken: json.refresh_token || refreshToken,
				expiresInSec: parseInt(json.expires_in || '3600', 10)
			};
		}
	};
}

module.exports = { createAuthRelay };
