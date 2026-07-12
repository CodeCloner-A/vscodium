/*---------------------------------------------------------------------------------------------
 * VSCodium Agent Proxy – Türsteher zwischen IDE und Vertex AI (Phase S der Roadmap).
 *
 * Aufgaben: Firebase-ID-Token prüfen, Modell-Allowlist + Standort-Routing anwenden,
 * generateContent/streamGenerateContent (SSE) unverändert durchleiten, Tokenzahlen aus
 * usageMetadata als strukturierte Logs erfassen (Metering-Grundlage) – ohne jemals
 * Prompt- oder Code-Inhalte zu protokollieren.
 *
 * Endpunkte:
 *   GET  /health                                        (ohne Anmeldung; NICHT /healthz –
 *                                                        den fängt Googles Frontend auf
 *                                                        *.run.app ab, bevor er den
 *                                                        Container erreicht)
 *   GET  /v1/models                                     Katalog für den Modell-Picker
 *   POST /v1/models/{model}:generateContent             Gemini-Request, JSON-Antwort
 *   POST /v1/models/{model}:streamGenerateContent       Gemini-Request, SSE-Antwort
 *--------------------------------------------------------------------------------------------*/

'use strict';

const http = require('http');
const { createVerifier } = require('./lib/verifyIdToken');
const { createVertexClient } = require('./lib/vertex');
const { findModel, publicCatalog } = require('./lib/catalog');

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_TRACKED_USERS = 10000;

/** Einfaches Sliding-Window-Limit pro Schlüssel (pro Instanz; echtes Metering folgt via Firestore). */
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
 * @param {{ projectId: string, vertexProject?: string, rateLimitRpm?: number,
 *           requestTimeoutSec?: number, verify?: Function, vertex?: object,
 *           log?: (entry: object) => void }} options
 */
function createServer(options) {
	const projectId = options.projectId;
	if (!projectId) { throw new Error('projectId erforderlich.'); }
	const verify = options.verify || createVerifier({ projectId });
	const vertex = options.vertex || createVertexClient({ project: options.vertexProject || projectId });
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
	const timeoutMs = (options.requestTimeoutSec === undefined ? 300 : options.requestTimeoutSec) * 1000;
	const log = options.log || ((entry) => console.log(JSON.stringify(entry)));

	return http.createServer(async (req, res) => {
		const started = Date.now();
		try {
			const url = new URL(req.url, 'http://localhost');

			if (req.method === 'GET' && url.pathname === '/health') {
				return send(res, 200, { status: 'ok' });
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

			const body = await readJson(req, MAX_BODY_BYTES);

			// Upstream abbrechen, wenn der Client verschwindet oder das Zeitlimit reißt.
			const abort = new AbortController();
			const timer = setTimeout(() => abort.abort(), timeoutMs);
			res.on('close', () => abort.abort());

			let upstream;
			try {
				upstream = await vertex.call(model, task, body, { stream: streaming, signal: abort.signal });

				if (!streaming || !upstream.ok || !upstream.body) {
					// JSON-Antwort (oder Upstream-Fehler) unverändert durchreichen.
					const text = await upstream.text();
					res.writeHead(upstream.status, { 'Content-Type': 'application/json; charset=utf-8' });
					res.end(text);
					log({
						severity: upstream.ok ? 'INFO' : 'WARNING',
						uid: user.uid, model: model.id, location: model.location,
						status: upstream.status, stream: streaming,
						durationMs: Date.now() - started, usage: extractUsage(text)
					});
					return;
				}

				// SSE-Durchleitung: Bytes unverändert weiterreichen, nebenbei usageMetadata zählen.
				res.writeHead(200, {
					'Content-Type': 'text/event-stream; charset=utf-8',
					'Cache-Control': 'no-store'
				});
				const scanner = createUsageScanner();
				for await (const chunk of upstream.body) {
					const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
					scanner.push(buffer);
					res.write(buffer);
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
	const server = createServer({
		projectId,
		vertexProject: process.env.GCP_PROJECT || projectId,
		rateLimitRpm: parseInt(process.env.RATE_LIMIT_RPM || '30', 10),
		globalRateLimitRpm: parseInt(process.env.GLOBAL_RATE_LIMIT_RPM || '300', 10),
		requestTimeoutSec: parseInt(process.env.REQUEST_TIMEOUT_SEC || '300', 10)
	});
	server.listen(port, () => {
		console.log(JSON.stringify({ severity: 'INFO', message: `Agent-Proxy lauscht auf Port ${port}` }));
	});
}

module.exports = { createServer, createRateLimiter, createUsageScanner };
