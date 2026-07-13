/*---------------------------------------------------------------------------------------------
 * VSCodium Agent Proxy – Türsteher zwischen IDE und Vertex AI (Phase S der Roadmap).
 *
 * Aufgaben: Firebase-ID-Token prüfen, Modell-Allowlist + Standort-Routing anwenden,
 * generateContent/streamGenerateContent (SSE) unverändert durchleiten, Tokenzahlen aus
 * usageMetadata pro Nutzer in Firestore fortschreiben und harte Monats-Quoten durchsetzen
 * (lib/metering.js) – ohne jemals Prompt- oder Code-Inhalte zu protokollieren.
 *
 * Endpunkte:
 *   GET  /health                                        (ohne Anmeldung; NICHT /healthz –
 *                                                        den fängt Googles Frontend auf
 *                                                        *.run.app ab, bevor er den
 *                                                        Container erreicht)
 *   POST /v1/auth/exchange                              Anmeldung: Auth-Code → Firebase-Tokens
 *   POST /v1/auth/refresh                               ID-Token erneuern (ohne Anmeldung –
 *                                                        sie SIND der Auth-Bootstrap; dafür
 *                                                        per-IP-Rate-Limit, s. lib/authRelay.js)
 *   GET  /v1/models                                     Katalog für den Modell-Picker
 *   GET  /v1/usage                                      Monatsverbrauch + Limit des Nutzers
 *   POST /v1/models/{model}:generateContent             Gemini-Request, JSON-Antwort
 *   POST /v1/models/{model}:streamGenerateContent       Gemini-Request, SSE-Antwort
 *--------------------------------------------------------------------------------------------*/

'use strict';

const http = require('http');
const { createVerifier } = require('./lib/verifyIdToken');
const { createVertexClient } = require('./lib/vertex');
const { createMeter } = require('./lib/metering');
const { createAuthRelay } = require('./lib/authRelay');
const { findModel, publicCatalog } = require('./lib/catalog');

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_AUTH_BODY_BYTES = 64 * 1024;
const MAX_TRACKED_USERS = 10000;

/** Einfaches Sliding-Window-Limit pro Schlüssel (pro Instanz; Monats-Quoten setzt das Firestore-Metering durch). */
function createRateLimiter({ limit, windowMs, maxKeys = MAX_TRACKED_USERS, now = Date.now }) {
	const hits = new Map();
	return function allow(uid) {
		const t = now();
		// Speicher begrenzen: bei Überlauf abgekühlte Einträge entsorgen; bringt das
		// nichts, werden NEUE Schlüssel abgelehnt (fail-closed statt unbegrenztem Wachstum
		// durch massenhaft frisch erzeugte Konten).
		if (!hits.has(uid) && hits.size >= maxKeys) {
			for (const [key, arr] of hits) {
				if (!arr.length || t - arr[arr.length - 1] >= windowMs) { hits.delete(key); }
			}
			if (hits.size >= maxKeys) { return false; }
		}
		let arr = hits.get(uid);
		if (!arr) { arr = []; hits.set(uid, arr); }
		while (arr.length && t - arr[0] >= windowMs) { arr.shift(); }
		if (arr.length >= limit) { return false; }
		arr.push(t);
		return true;
	};
}

/** Bearer-Token aus dem Authorization-Header (Schema case-insensitiv, RFC 7235). */
function bearerToken(headerValue) {
	const match = /^bearer\s+(\S+)$/i.exec(String(headerValue || '').trim());
	return match ? match[1] : '';
}

/**
 * Client-IP für das Auth-Rate-Limit. Auf Cloud Run hängt Googles Frontend die echte
 * Client-IP als LETZTEN Eintrag an X-Forwarded-For – alles davor kann der Client
 * selbst geschickt haben und ist nicht vertrauenswürdig.
 */
function clientIp(req) {
	const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
	return forwarded || req.socket.remoteAddress || 'unbekannt';
}

/** Liest den Request-Body als JSON, mit Größenlimit. */
function readJson(req, maxBytes) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > maxBytes) {
				reject(Object.assign(new Error('Anfrage zu groß.'), { status: 413 }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			} catch (_e) {
				reject(Object.assign(new Error('Kein gültiges JSON.'), { status: 400 }));
			}
		});
		req.on('error', (err) => reject(Object.assign(err, { status: 400 })));
	});
}

/** Tokenzahlen aus einer (nicht gestreamten) Gemini-Antwort ziehen – nur Zähler, nie Inhalte. */
function extractUsage(text) {
	try {
		const u = JSON.parse(text).usageMetadata;
		return u ? {
			promptTokens: u.promptTokenCount,
			candidateTokens: u.candidatesTokenCount,
			totalTokens: u.totalTokenCount
		} : undefined;
	} catch (_e) {
		return undefined;
	}
}

/** Zeilenweiser Scanner über den SSE-Strom: merkt sich die letzte usageMetadata. */
function createUsageScanner() {
	let tail = '';
	let usage;
	return {
		push(buffer) {
			const lines = (tail + buffer.toString('utf8')).split(/\r?\n/);
			tail = lines.pop() || '';
			for (const line of lines) {
				if (!line.startsWith('data: ')) { continue; }
				const found = extractUsage(line.slice(6));
				if (found) { usage = found; }
			}
		},
		usage() { return usage; }
	};
}

function send(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
	res.end(body);
}

/**
 * Begrenzt auf den Zähl-Commit warten, bevor die Antwort endet: Nach dem Antwort-Ende
 * drosselt Cloud Run die CPU (Request-Billing), Hintergrundarbeit ginge verloren.
 * Läuft der Commit länger als maxMs, wird er nicht abgebrochen, nur nicht mehr erwartet.
 */
function waitBounded(promise, maxMs) {
	return Promise.race([promise, new Promise((resolve) => setTimeout(resolve, maxMs))]);
}

/**
 * @param {{ projectId: string, vertexProject?: string, rateLimitRpm?: number,
 *           requestTimeoutSec?: number, freeMonthlyTokens?: number, verify?: Function,
 *           vertex?: object, meter?: object|null, log?: (entry: object) => void }} options
 */
function createServer(options) {
	const projectId = options.projectId;
	if (!projectId) { throw new Error('projectId erforderlich.'); }
	const log = options.log || ((entry) => console.log(JSON.stringify(entry)));
	const verify = options.verify || createVerifier({ projectId });
	const vertex = options.vertex || createVertexClient({ project: options.vertexProject || projectId });
	// Firestore-Metering (meter: null schaltet es bewusst ab, z. B. in Tests).
	// Die Zähler leben im Firebase-Projekt – dort schaut auch die Firebase Console drauf.
	const meter = options.meter !== undefined ? options.meter : createMeter({
		project: projectId,
		freeMonthlyTokens: options.freeMonthlyTokens,
		log
	});
	const allow = createRateLimiter({
		limit: options.rateLimitRpm === undefined ? 30 : options.rateLimitRpm,
		windowMs: 60000
	});
	// Gesamtdeckel pro Instanz: schützt die Abrechnung auch gegen viele frische Konten
	// (Per-Nutzer-Limits greifen dann nicht mehr). Grob: erwartete Nutzer × RPM.
	const allowGlobal = createRateLimiter({
		limit: options.globalRateLimitRpm === undefined ? 300 : options.globalRateLimitRpm,
		windowMs: 60000
	});
	// Auth-Relay (null = nicht konfiguriert, Endpunkte antworten 501). Die Auth-Endpunkte
	// laufen VOR der Token-Prüfung, deshalb ein eigenes, knappes per-IP-Limit.
	const authRelay = options.authRelay === undefined ? null : options.authRelay;
	const allowAuth = createRateLimiter({
		limit: options.authRateLimitRpm === undefined ? 10 : options.authRateLimitRpm,
		windowMs: 60000
	});
	// Eigener Gesamtdeckel NUR für die (unauthentifizierten) Auth-Endpunkte – bewusst NICHT
	// der mit den Modell-Endpunkten geteilte allowGlobal: Sonst könnte ein Anmelde-Flood aus
	// einer IP dessen Eimer leeren und den bezahlten Verkehr aussperren (429).
	const allowAuthGlobal = createRateLimiter({
		limit: options.authGlobalRateLimitRpm === undefined ? 100 : options.authGlobalRateLimitRpm,
		windowMs: 60000
	});
	const timeoutMs = (options.requestTimeoutSec === undefined ? 300 : options.requestTimeoutSec) * 1000;

	return http.createServer(async (req, res) => {
		const started = Date.now();
		try {
			const url = new URL(req.url, 'http://localhost');

			if (req.method === 'GET' && url.pathname === '/health') {
				return send(res, 200, { status: 'ok' });
			}

			// Auth-Bootstrap: die einzigen Endpunkte ohne Bearer-Prüfung (das Token entsteht
			// hier erst). Log nur mit Status + Dauer – niemals Codes oder Tokens.
			if (req.method === 'POST' && (url.pathname === '/v1/auth/exchange' || url.pathname === '/v1/auth/refresh')) {
				if (!authRelay) {
					return send(res, 501, { error: 'Anmeldung nicht konfiguriert (Auth-Relay fehlt).' });
				}
				// Per-IP ZUERST (Kurzschluss): ein einzelner Flooder wird auf sein IP-Limit
				// gedeckelt, bevor überhaupt ein Gesamt-Token gebucht wird; der Auth-Gesamtdeckel
				// ist zudem von den Modell-Endpunkten getrennt.
				if (!allowAuth(clientIp(req)) || !allowAuthGlobal('*')) {
					return send(res, 429, { error: 'Zu viele Anmeldeversuche. Bitte kurz warten.' });
				}
				let status = 200;
				try {
					const body = await readJson(req, MAX_AUTH_BODY_BYTES);
					const result = url.pathname === '/v1/auth/exchange'
						? await authRelay.exchange(body)
						: await authRelay.refresh(body);
					return send(res, 200, result);
				} catch (err) {
					status = (err && err.status) || 502;
					return send(res, status, { error: (err && err.message) || 'Anmeldung fehlgeschlagen.' });
				} finally {
					log({
						severity: status === 200 ? 'INFO' : 'WARNING',
						path: url.pathname, status, durationMs: Date.now() - started
					});
				}
			}

			// Ab hier gilt: ohne gültiges Firebase-ID-Token keine Antwort.
			const token = bearerToken(req.headers.authorization);
			let user;
			try {
				user = await verify(token);
			} catch (err) {
				return send(res, 401, { error: 'Nicht angemeldet.', detail: err.message });
			}
			if (!allowGlobal('*') || !allow(user.uid)) {
				return send(res, 429, { error: 'Zu viele Anfragen. Bitte kurz warten.' });
			}

			if (req.method === 'GET' && url.pathname === '/v1/models') {
				return send(res, 200, { models: publicCatalog() });
			}

			if (req.method === 'GET' && url.pathname === '/v1/usage') {
				if (!meter) { return send(res, 404, { error: 'Metering nicht konfiguriert.' }); }
				try {
					return send(res, 200, await meter.snapshot(user.uid));
				} catch (err) {
					return send(res, 502, { error: `Verbrauchsdaten nicht verfügbar: ${err.message}` });
				}
			}

			const match = /^\/v1\/models\/([^/:]+):(generateContent|streamGenerateContent)$/.exec(url.pathname);
			if (!match || req.method !== 'POST') {
				return send(res, 404, { error: 'Unbekannter Endpunkt.' });
			}
			const model = findModel(match[1]);
			if (!model) {
				return send(res, 404, { error: `Modell nicht im Angebot: ${match[1]}` });
			}
			const task = match[2];
			const streaming = task === 'streamGenerateContent';

			// Quota-Gate vor dem (teuren) Modell-Aufruf; nur die Modell-Endpunkte kosten Kontingent.
			if (meter) {
				const gate = await meter.check(user.uid);
				if (!gate.allowed) {
					log({
						severity: 'WARNING', uid: user.uid, model: model.id,
						status: gate.status, reason: gate.reason || 'gesperrt',
						durationMs: Date.now() - started
					});
					return send(res, gate.status, { error: gate.error, reason: gate.reason });
				}
			}

			const body = await readJson(req, MAX_BODY_BYTES);

			// Upstream abbrechen, wenn der Client verschwindet oder das Zeitlimit reißt.
			const abort = new AbortController();
			const timer = setTimeout(() => abort.abort(), timeoutMs);
			res.on('close', () => abort.abort());

			let upstream;
			try {
				upstream = await vertex.call(model, task, body, { stream: streaming, signal: abort.signal });

				if (!streaming || !upstream.ok || !upstream.body) {
					// JSON-Antwort (oder Upstream-Fehler) unverändert durchreichen; der
					// Zähl-Commit läuft (begrenzt) VOR dem Antwort-Ende, siehe waitBounded.
					const text = await upstream.text();
					res.writeHead(upstream.status, { 'Content-Type': 'application/json; charset=utf-8' });
					res.write(text);
					const usage = extractUsage(text);
					if (meter && upstream.ok) { await waitBounded(meter.record(user.uid, usage), 1500); }
					res.end();
					log({
						severity: upstream.ok ? 'INFO' : 'WARNING',
						uid: user.uid, model: model.id, location: model.location,
						status: upstream.status, stream: streaming,
						durationMs: Date.now() - started, usage
					});
					return;
				}

				// SSE-Durchleitung: Bytes unverändert weiterreichen, nebenbei usageMetadata zählen.
				res.writeHead(200, {
					'Content-Type': 'text/event-stream; charset=utf-8',
					'Cache-Control': 'no-store'
				});
				const scanner = createUsageScanner();
				try {
					for await (const chunk of upstream.body) {
						const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
						scanner.push(buffer);
						res.write(buffer);
					}
				} finally {
					// Auch bei Client-Abbruch zählen (sonst wäre Abbrechen kurz vor Stream-Ende
					// ein Quota-Schlupfloch): mindestens die Anfrage; Tokenzahlen nur, wenn die
					// usageMetadata (am Stream-Ende) noch ankam. Begrenzt gewartet, damit der
					// Commit nicht ins Cloud-Run-CPU-Throttling nach dem Antwort-Ende fällt.
					if (meter) { await waitBounded(meter.record(user.uid, scanner.usage()), 1500); }
				}
				res.end();
				log({
					severity: 'INFO',
					uid: user.uid, model: model.id, location: model.location,
					status: 200, stream: true,
					durationMs: Date.now() - started, usage: scanner.usage()
				});
			} finally {
				clearTimeout(timer);
			}
		} catch (err) {
			const aborted = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
			if (!res.headersSent) {
				send(res, aborted ? 499 : (err && err.status) || 502, {
					error: aborted ? 'Abgebrochen.' : (err && err.message) || 'Interner Fehler.'
				});
			} else {
				try { res.end(); } catch (_e) { /* Verbindung ist bereits weg. */ }
			}
			if (!aborted) {
				log({ severity: 'ERROR', message: String((err && err.message) || err), durationMs: Date.now() - started });
			}
		}
	});
}

if (require.main === module) {
	const projectId = process.env.FIREBASE_PROJECT_ID;
	if (!projectId) {
		console.error('FIREBASE_PROJECT_ID fehlt (Firebase-Projekt-ID = Token-Audience).');
		process.exit(1);
	}
	const port = parseInt(process.env.PORT || '8080', 10);
	// Auth-Relay nur, wenn alle drei Geheimnisse da sind (Secret Manager → Env-Vars).
	// Ohne sie läuft der Proxy weiter, die Anmelde-Endpunkte antworten 501.
	const authRelay = (process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET && process.env.FIREBASE_WEB_API_KEY)
		? createAuthRelay({
			clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
			clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
			apiKey: process.env.FIREBASE_WEB_API_KEY
		})
		: null;
	if (!authRelay) {
		console.log(JSON.stringify({ severity: 'WARNING', message: 'Auth-Relay nicht konfiguriert (GOOGLE_OAUTH_CLIENT_ID/-SECRET, FIREBASE_WEB_API_KEY) – /v1/auth/* antwortet 501.' }));
	}
	const server = createServer({
		projectId,
		authRelay,
		vertexProject: process.env.GCP_PROJECT || projectId,
		rateLimitRpm: parseInt(process.env.RATE_LIMIT_RPM || '30', 10),
		globalRateLimitRpm: parseInt(process.env.GLOBAL_RATE_LIMIT_RPM || '300', 10),
		authRateLimitRpm: parseInt(process.env.AUTH_RATE_LIMIT_RPM || '10', 10),
		authGlobalRateLimitRpm: parseInt(process.env.AUTH_GLOBAL_RATE_LIMIT_RPM || '100', 10),
		requestTimeoutSec: parseInt(process.env.REQUEST_TIMEOUT_SEC || '300', 10),
		// Monats-Quote pro Nutzer in Tokens; 0 = unbegrenzt (nur zählen). Ein Entitlement-
		// Dokument in Firestore (entitlements/{uid}.monthlyTokenLimit) übersteuert den Wert.
		freeMonthlyTokens: parseInt(process.env.FREE_MONTHLY_TOKENS || '2000000', 10)
	});
	server.listen(port, () => {
		console.log(JSON.stringify({ severity: 'INFO', message: `Agent-Proxy lauscht auf Port ${port}` }));
	});
}

module.exports = { createServer, createRateLimiter, createUsageScanner };
