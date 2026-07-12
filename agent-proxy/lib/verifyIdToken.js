/*---------------------------------------------------------------------------------------------
 * VSCodium Agent Proxy – Prüfung von Firebase-Auth-ID-Tokens ohne Abhängigkeiten.
 *
 * Verifiziert RS256-JWTs gegen Googles X.509-Zertifikate (securetoken@system) und prüft
 * die Firebase-Claims (exp/iat, aud = Projekt-ID, iss, sub). Die Zertifikate werden gemäß
 * Cache-Control zwischengespeichert. `getKeys` ist für Tests injizierbar.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const crypto = require('crypto');

const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const CLOCK_SKEW_SEC = 60;
const MAX_TOKEN_LENGTH = 4096;

class TokenError extends Error {
	constructor(message) {
		super(message);
		this.name = 'TokenError';
	}
}

function decodeSegment(segment) {
	try {
		return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
	} catch (_e) {
		return null;
	}
}

/**
 * @param {{ projectId: string, fetchImpl?: typeof fetch, now?: () => number,
 *           getKeys?: () => Promise<Map<string, crypto.KeyObject>> }} options
 * @returns {(token: string) => Promise<{ uid: string, claims: object }>}
 */
function createVerifier(options) {
	const projectId = options.projectId;
	if (!projectId) { throw new Error('projectId erforderlich.'); }
	const fetchImpl = options.fetchImpl || fetch;
	const now = options.now || (() => Math.floor(Date.now() / 1000));

	let cache = { keys: null, expiresAt: 0 };
	let inFlight = null;
	const getKeys = options.getKeys || (async () => {
		if (cache.keys && now() < cache.expiresAt) { return cache.keys; }
		// In-Flight-Dedup: bei kaltem Cache lädt genau EIN Abruf für alle wartenden
		// Anfragen (kein Thundering Herd); Timeout, damit ein hängender Endpunkt
		// nicht jede Anfrage blockiert.
		if (!inFlight) {
			inFlight = (async () => {
				const res = await fetchImpl(CERTS_URL, { signal: AbortSignal.timeout(5000) });
				if (!res.ok) { throw new TokenError(`Zertifikatsabruf fehlgeschlagen (${res.status}).`); }
				const json = await res.json();
				const keys = new Map();
				for (const [kid, pem] of Object.entries(json)) {
					keys.set(kid, new crypto.X509Certificate(pem).publicKey);
				}
				// Lebensdauer aus Cache-Control übernehmen (Fallback 1 h), mit Sicherheitsabstand.
				const match = /max-age=(\d+)/.exec(String(res.headers.get('cache-control') || ''));
				const maxAge = match ? parseInt(match[1], 10) : 3600;
				cache = { keys, expiresAt: now() + Math.max(60, maxAge - 60) };
				return keys;
			})().finally(() => { inFlight = null; });
		}
		return inFlight;
	});

	return async function verifyIdToken(token) {
		if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LENGTH) {
			throw new TokenError('Token fehlt oder ist unbrauchbar.');
		}
		const segments = token.split('.');
		if (segments.length !== 3) { throw new TokenError('Kein JWT.'); }
		const header = decodeSegment(segments[0]);
		const payload = decodeSegment(segments[1]);
		if (!header || !payload) { throw new TokenError('JWT nicht lesbar.'); }
		// Algorithmus strikt festnageln – alles außer RS256 (insb. "none"/HS256) ablehnen.
		if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
			throw new TokenError('Unerwarteter Signatur-Algorithmus.');
		}
		const keys = await getKeys();
		const key = keys.get(header.kid);
		if (!key) { throw new TokenError('Unbekannte Signatur-Key-ID.'); }
		const signed = Buffer.from(`${segments[0]}.${segments[1]}`, 'utf8');
		const signature = Buffer.from(segments[2], 'base64url');
		if (!crypto.verify('RSA-SHA256', signed, key, signature)) {
			throw new TokenError('Signatur ungültig.');
		}
		const t = now();
		if (typeof payload.exp !== 'number' || payload.exp <= t - CLOCK_SKEW_SEC) {
			throw new TokenError('Token abgelaufen.');
		}
		if (typeof payload.iat !== 'number' || payload.iat > t + CLOCK_SKEW_SEC) {
			throw new TokenError('Token noch nicht gültig.');
		}
		// auth_time gehört laut Firebase-Verifikationsregeln dazu: Anmeldezeitpunkt in der Vergangenheit.
		if (typeof payload.auth_time !== 'number' || payload.auth_time > t + CLOCK_SKEW_SEC) {
			throw new TokenError('Ungültiger Anmeldezeitpunkt.');
		}
		if (payload.aud !== projectId) { throw new TokenError('Falsche Audience.'); }
		if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
			throw new TokenError('Falscher Issuer.');
		}
		if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128) {
			throw new TokenError('Ungültiges Subject.');
		}
		return { uid: payload.sub, claims: payload };
	};
}

module.exports = { createVerifier, TokenError, CERTS_URL };
