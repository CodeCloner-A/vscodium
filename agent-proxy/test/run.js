/*---------------------------------------------------------------------------------------------
 * VSCodium Agent Proxy – Headless-Tests ohne GCP.
 * Testet: Token-Prüfung (echte RSA-Signaturen), Katalog/Routing, Vertex-URL-Aufbau,
 * Rate-Limit, Usage-Scanner, Firestore-Metering (Quota-Gate, Increment-Commits, Fail-open),
 * HTTP-Endpunkte inkl. SSE-Durchleitung und /v1/usage.
 *
 * Ausführen:  node test/run.js
 *--------------------------------------------------------------------------------------------*/

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { createVerifier, TokenError } = require('../lib/verifyIdToken');
const { createVertexClient, hostFor } = require('../lib/vertex');
const { createMeter, monthKey } = require('../lib/metering');
const { createAuthRelay } = require('../lib/authRelay');
const { MODELS, findModel, publicCatalog } = require('../lib/catalog');
const { createServer, createRateLimiter, createUsageScanner } = require('../server');

const PROJECT = 'controlling-man';

// ── Hilfen: Schlüsselpaar + Token-Signatur ──────────────────────────────────

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const OTHER_KEYS = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEYS = new Map([['test-kid', publicKey]]);
const NOW = 1_800_000_000;

function signToken(payloadOverrides, { header, key } = {}) {
	const h = Buffer.from(JSON.stringify(header || { alg: 'RS256', kid: 'test-kid', typ: 'JWT' })).toString('base64url');
	const payload = {
		iss: `https://securetoken.google.com/${PROJECT}`,
		aud: PROJECT,
		sub: 'user-123',
		auth_time: NOW - 100,
		iat: NOW - 10,
		exp: NOW + 3600,
		...payloadOverrides
	};
	const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
	const signature = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key || privateKey).toString('base64url');
	return `${h}.${p}.${signature}`;
}

function makeVerifier() {
	return createVerifier({ projectId: PROJECT, now: () => NOW, getKeys: async () => KEYS });
}

async function expectTokenError(promise, hintText) {
	try {
		await promise;
		assert.fail(`Erwarteter TokenError blieb aus: ${hintText}`);
	} catch (err) {
		assert.ok(err instanceof TokenError, `${hintText}: ${err.message}`);
	}
}

// ── Tests ───────────────────────────────────────────────────────────────────

async function testVerifier() {
	const verify = makeVerifier();

	const good = await verify(signToken({}));
	assert.strictEqual(good.uid, 'user-123');
	assert.strictEqual(good.claims.aud, PROJECT);

	await expectTokenError(verify(''), 'leeres Token');
	await expectTokenError(verify('nur.zwei'), 'kein JWT');
	await expectTokenError(verify(signToken({ exp: NOW - 3600 })), 'abgelaufen');
	await expectTokenError(verify(signToken({ iat: NOW + 3600 })), 'iat in der Zukunft');
	await expectTokenError(verify(signToken({ aud: 'fremdes-projekt' })), 'falsche Audience');
	await expectTokenError(verify(signToken({ iss: 'https://accounts.google.com' })), 'falscher Issuer');
	await expectTokenError(verify(signToken({ sub: '' })), 'leeres Subject');
	await expectTokenError(verify(signToken({ auth_time: NOW + 3600 })), 'auth_time in der Zukunft');
	await expectTokenError(verify(signToken({ auth_time: undefined })), 'auth_time fehlt');
	// Algorithmus-Verwechslung ist der Klassiker: none/HS256 müssen hart scheitern.
	await expectTokenError(verify(signToken({}, { header: { alg: 'none', kid: 'test-kid' } })), 'alg none');
	await expectTokenError(verify(signToken({}, { header: { alg: 'HS256', kid: 'test-kid' } })), 'alg HS256');
	await expectTokenError(verify(signToken({}, { header: { alg: 'RS256', kid: 'unbekannt' } })), 'unbekannte kid');
	await expectTokenError(verify(signToken({}, { key: OTHER_KEYS.privateKey })), 'fremder Schlüssel');
	// Manipulierte Nutzlast bei gültiger Signatur eines anderen Tokens.
	const parts = signToken({}).split('.');
	const forged = `${parts[0]}.${Buffer.from(JSON.stringify({ sub: 'angreifer' })).toString('base64url')}.${parts[2]}`;
	await expectTokenError(verify(forged), 'manipulierte Nutzlast');

	console.log('✔ Token-Prüfung: gültig, Ablauf, Audience/Issuer, alg-Verwechslung, Fälschung');
}

async function testCatalogAndVertexUrl() {
	assert.ok(MODELS.length >= 4);
	assert.strictEqual(findModel('gemini-3.5-flash').location, 'eu', '3.5-flash läuft über die eu-Multiregion');
	assert.strictEqual(findModel('gemini-2.5-pro').location, 'europe-west1');
	assert.strictEqual(findModel('so-ein-modell-gibts-nicht'), null);
	assert.ok(publicCatalog().every(m => m.id && m.label && m.location));

	assert.strictEqual(hostFor('global'), 'aiplatform.googleapis.com');
	assert.strictEqual(hostFor('europe-west2'), 'europe-west2-aiplatform.googleapis.com');
	// Jurisdiktionale Multiregionen nutzen rep-Hosts – nicht das {loc}-aiplatform-Schema.
	assert.strictEqual(hostFor('eu'), 'aiplatform.eu.rep.googleapis.com');
	assert.strictEqual(hostFor('us'), 'aiplatform.us.rep.googleapis.com');

	// URL-Aufbau inkl. SSE-Suffix, ohne echten Netzverkehr.
	const seen = [];
	const vertex = createVertexClient({
		project: PROJECT,
		getAccessToken: async () => 'sa-token',
		fetchImpl: async (url, init) => {
			seen.push({ url, init });
			return { ok: true, status: 200, text: async () => '{}', body: null };
		}
	});
	await vertex.call(findModel('gemini-3.5-flash'), 'streamGenerateContent', { contents: [] }, { stream: true });
	assert.strictEqual(
		seen[0].url,
		`https://aiplatform.eu.rep.googleapis.com/v1/projects/${PROJECT}/locations/eu/publishers/google/models/gemini-3.5-flash:streamGenerateContent?alt=sse`
	);
	assert.strictEqual(seen[0].init.headers.Authorization, 'Bearer sa-token');
	await vertex.call({ id: 'gemini-x', location: 'global' }, 'generateContent', {}, {});
	assert.ok(seen[1].url.startsWith('https://aiplatform.googleapis.com/v1/projects/'));

	console.log('✔ Katalog & Vertex-URLs: Routing (3.5 → eu-Multiregion), rep-/globale Hosts, SSE-Suffix');
}

async function testRateLimiterAndScanner() {
	let t = 0;
	const allow = createRateLimiter({ limit: 2, windowMs: 60000, now: () => t });
	assert.ok(allow('u1') && allow('u1'));
	assert.ok(!allow('u1'), 'drittes Mal im Fenster muss scheitern');
	assert.ok(allow('u2'), 'anderer Nutzer unabhängig');
	t += 60001;
	assert.ok(allow('u1'), 'nach Fensterablauf wieder frei');

	// Fail-closed: Sind maxKeys heiße Nutzer erreicht, werden NEUE Schlüssel abgelehnt …
	let t2 = 0;
	const small = createRateLimiter({ limit: 5, windowMs: 60000, maxKeys: 2, now: () => t2 });
	assert.ok(small('a') && small('b'));
	assert.ok(!small('c'), 'neuer Schlüssel bei voller, heißer Map → abgelehnt');
	assert.ok(small('a'), 'bekannte Schlüssel funktionieren weiter');
	// … nach Abkühlung wird Platz geschaffen.
	t2 += 60001;
	assert.ok(small('c'), 'nach Fensterablauf werden alte Einträge verdrängt');

	// Usage-Scanner übersteht zerteilte Chunks und nimmt die letzte usageMetadata.
	const scanner = createUsageScanner();
	scanner.push(Buffer.from('data: {"candidates":[],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":2,"totalTokenC'));
	scanner.push(Buffer.from('ount":3}}\n\ndata: {"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":20,"totalTokenCount":30}}\n\n'));
	assert.deepStrictEqual(scanner.usage(), { promptTokens: 10, candidateTokens: 20, totalTokens: 30 });

	console.log('✔ Rate-Limit (Sliding Window) & Usage-Scanner (zerteilte SSE-Chunks)');
}

// ── Metering (Firestore-Mock) ───────────────────────────────────────────────

const NOW_MS = NOW * 1000;

/** Firestore-Attrappe: beantwortet :batchGet aus den Vorgaben, nimmt :commit entgegen. */
function fakeFirestore({ usageTokens = 0, limitField, disabled, plan } = {}) {
	const calls = [];
	const fetchImpl = async (url, init) => {
		const body = init && init.body ? JSON.parse(init.body) : undefined;
		calls.push({ url, body });
		if (url.includes(':batchGet')) {
			const docs = body.documents;
			const entFields = {};
			if (limitField !== undefined) { entFields.monthlyTokenLimit = { integerValue: String(limitField) }; }
			if (disabled) { entFields.disabled = { booleanValue: true }; }
			if (plan) { entFields.plan = { stringValue: plan }; }
			const out = [];
			out.push(Object.keys(entFields).length
				? { found: { name: docs[0], fields: entFields } }
				: { missing: docs[0] });
			out.push(usageTokens > 0
				? {
					found: {
						name: docs[1], fields: {
							promptTokens: { integerValue: '1' },
							candidateTokens: { integerValue: '2' },
							totalTokens: { integerValue: String(usageTokens) },
							requests: { integerValue: '9' }
						}
					}
				}
				: { missing: docs[1] });
			return { ok: true, status: 200, json: async () => out, text: async () => '' };
		}
		if (url.includes(':commit')) {
			return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
		}
		throw new Error(`Unerwarteter Firestore-Aufruf: ${url}`);
	};
	return { fetchImpl, calls };
}

function makeMeter(fs, overrides) {
	return createMeter({
		project: PROJECT,
		fetchImpl: fs.fetchImpl,
		getAccessToken: async () => 'fs-token',
		freeMonthlyTokens: 1000,
		now: () => NOW_MS,
		log: () => { },
		...overrides
	});
}

async function testMetering() {
	assert.strictEqual(monthKey(Date.UTC(2026, 6, 12)), '2026-07');

	// Unter dem Limit → erlaubt; zweiter Check kommt aus dem Cache (kein Firestore-Aufruf).
	const a = fakeFirestore({ usageTokens: 500 });
	const meterA = makeMeter(a);
	assert.deepStrictEqual(await meterA.check('user-123'), { allowed: true });
	const readsAfterFirst = a.calls.length;
	await meterA.check('user-123');
	assert.strictEqual(a.calls.length, readsAfterFirst, 'zweiter Check muss gecacht sein');

	// record: Commit mit leerer Update-Maske (Merge!) + atomaren Increments aufs Monatsdokument.
	await meterA.record('user-123', { promptTokens: 100, candidateTokens: 400, totalTokens: 500 });
	const commit = a.calls.find(c => c.url.includes(':commit'));
	const write = commit.body.writes[0];
	assert.deepStrictEqual(write.updateMask, { fieldPaths: [] }, 'ohne leere Maske würden die Zähler überschrieben');
	assert.ok(write.update.name.endsWith(`/usage/user-123/months/${monthKey(NOW_MS)}`));
	const increments = Object.fromEntries(
		write.updateTransforms.filter(t => t.increment).map(t => [t.fieldPath, t.increment.integerValue])
	);
	assert.deepStrictEqual(increments, { requests: '1', promptTokens: '100', candidateTokens: '400', totalTokens: '500' });
	assert.ok(write.updateTransforms.some(t => t.fieldPath === 'updatedAt' && t.setToServerValue === 'REQUEST_TIME'));

	// Der Cache zieht mit: 500 + 500 = 1000 ≥ Limit → sofort gesperrt, ohne neuen Read.
	const gate = await meterA.check('user-123');
	assert.strictEqual(gate.allowed, false);
	assert.strictEqual(gate.status, 429);
	assert.strictEqual(gate.reason, 'quota');
	assert.ok(gate.error.includes('1000'), 'Fehlertext nennt Verbrauch/Limit');

	// Entitlement übersteuert den Free-Default; disabled sperrt hart; Limit 0 = unbegrenzt.
	assert.strictEqual((await makeMeter(fakeFirestore({ usageTokens: 5000, limitField: 10000 })).check('u')).allowed, true);
	const locked = await makeMeter(fakeFirestore({ disabled: true })).check('u');
	assert.deepStrictEqual({ allowed: locked.allowed, status: locked.status }, { allowed: false, status: 403 });
	assert.strictEqual((await makeMeter(fakeFirestore({ usageTokens: 999999, limitField: 0 })).check('u')).allowed, true);

	// Fail-open: Firestore-Fehler sperren den Dienst nicht (Rate-Limits deckeln weiter) – aber
	// geloggt, und der Negativ-Cache verhindert, dass jede Anfrage erneut in den Timeout läuft.
	const warnings = [];
	let brokenCalls = 0;
	const broken = makeMeter(
		{ fetchImpl: async () => { brokenCalls++; throw new Error('Firestore weg'); } },
		{ log: (e) => warnings.push(e) }
	);
	const open = await broken.check('user-123');
	assert.deepStrictEqual({ allowed: open.allowed, degraded: open.degraded }, { allowed: true, degraded: true });
	assert.ok(warnings.some(w => w.severity === 'WARNING'));
	const open2 = await broken.check('user-123');
	assert.deepStrictEqual({ allowed: open2.allowed, degraded: open2.degraded }, { allowed: true, degraded: true });
	assert.strictEqual(brokenCalls, 1, 'Negativ-Cache: zweiter Check darf Firestore nicht erneut anfragen');

	// batchGet-Streamfehler ({error}-Element bei HTTP 200) ist ein Lesefehler, kein "Dokument
	// fehlt" – sonst würde ein fabrizierter Nullstand (Free-Limit, 0 Verbrauch) 60 s gecacht.
	const streamErr = makeMeter(
		{ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ([{ error: { code: 14, status: 'UNAVAILABLE' } }]), text: async () => '' }) },
		{ log: () => { } }
	);
	const errOpen = await streamErr.check('user-123');
	assert.strictEqual(errOpen.degraded, true, 'Fehlerelement muss in den Fail-open-Pfad, nicht als leeres Dokument gecacht werden');

	// record wirft nie: nicht-retrybarer Firestore-Fehler wird nur geloggt.
	const errors = [];
	const badWrite = makeMeter(
		{ fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({}), text: async () => 'schlecht' }) },
		{ log: (e) => errors.push(e) }
	);
	await badWrite.record('user-123', { totalTokens: 5 });
	assert.ok(errors.some(e => e.severity === 'ERROR'));

	// Ambige Fehler (Timeout/Netz, kein HTTP-Status) werden NICHT wiederholt: Der Commit
	// könnte serverseitig gelandet sein, ein Replay zählte die Tokens doppelt.
	let ambiguousCalls = 0;
	const ambiguous = makeMeter(
		{ fetchImpl: async () => { ambiguousCalls++; const e = new Error('fetch failed'); throw e; } },
		{ log: () => { } }
	);
	await ambiguous.record('user-123', { totalTokens: 5 });
	assert.strictEqual(ambiguousCalls, 1, 'kein Retry bei Fehlern ohne HTTP-Status (Doppelzählungs-Risiko)');

	// snapshot: Anzeige-Form für GET /v1/usage.
	const snap = await makeMeter(fakeFirestore({ usageTokens: 500, limitField: 2000, plan: 'pro' })).snapshot('user-123');
	assert.deepStrictEqual(snap, {
		month: monthKey(NOW_MS), plan: 'pro', limit: 2000, remaining: 1500,
		promptTokens: 1, candidateTokens: 2, totalTokens: 500, requests: 9
	});

	// UIDs, die keine Firebase-UIDs sein können, werden nie zum Firestore-Pfad.
	const weird = await meterA.check('../fremdes-dokument');
	assert.deepStrictEqual({ allowed: weird.allowed, status: weird.status }, { allowed: false, status: 403 });

	console.log('✔ Metering: Quota-Gate, Cache-Mitschrift, Increment-Commit (leere Maske), Fail-open + Negativ-Cache, batchGet-Streamfehler, kein ambiger Retry, Snapshot');
}

async function testMeteringHttp() {
	const recorded = [];
	const upstreamCalls = [];
	let gateResult = { allowed: true };
	const meter = {
		check: async () => gateResult,
		record: async (uid, usage) => { recorded.push({ uid, usage }); },
		snapshot: async () => ({
			month: '2027-01', plan: 'free', limit: 1000, remaining: 400,
			promptTokens: 100, candidateTokens: 500, totalTokens: 600, requests: 7
		})
	};
	const sse = [
		'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]}}]}\n\n',
		'data: {"candidates":[{"content":{"parts":[{"text":"!"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"totalTokenCount":7}}\n\n'
	];
	let sseAbort = false;
	const server = createServer({
		projectId: PROJECT,
		verify: makeVerifier(),
		vertex: {
			call: async (model, task) => {
				upstreamCalls.push(task);
				if (task === 'generateContent') {
					return {
						ok: true, status: 200, body: null,
						text: async () => JSON.stringify({
							candidates: [{ content: { parts: [{ text: 'ok' }] } }],
							usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 }
						})
					};
				}
				return {
					ok: true, status: 200,
					body: (async function* () {
						yield Buffer.from(sse[0], 'utf8');
						if (sseAbort) { throw new Error('Verbindung weg (simulierter Abbruch)'); }
						yield Buffer.from(sse[1], 'utf8');
					})()
				};
			}
		},
		rateLimitRpm: 100,
		meter,
		log: () => { }
	});
	await new Promise((resolve) => server.listen(0, resolve));
	const base = `http://127.0.0.1:${server.address().port}`;
	const auth = { 'Authorization': `Bearer ${signToken({})}` };
	try {
		// /v1/usage liefert den Snapshot des Meters.
		const usage = await (await fetch(`${base}/v1/usage`, { headers: auth })).json();
		assert.deepStrictEqual({ totalTokens: usage.totalTokens, limit: usage.limit, remaining: usage.remaining }, { totalTokens: 600, limit: 1000, remaining: 400 });

		// Erlaubter Lauf: record erhält die Tokenzahlen aus der JSON-Antwort …
		assert.strictEqual((await fetch(`${base}/v1/models/gemini-2.5-flash:generateContent`, {
			method: 'POST', headers: auth, body: JSON.stringify({ contents: [] })
		})).status, 200);
		assert.deepStrictEqual(recorded[0], { uid: 'user-123', usage: { promptTokens: 3, candidateTokens: 1, totalTokens: 4 } });

		// … und aus dem SSE-Strom.
		const stream = await fetch(`${base}/v1/models/gemini-2.5-flash:streamGenerateContent`, {
			method: 'POST', headers: auth, body: JSON.stringify({ contents: [] })
		});
		for await (const _chunk of stream.body) { /* Strom leeren */ }
		assert.deepStrictEqual(recorded[1], { uid: 'user-123', usage: { promptTokens: 5, candidateTokens: 2, totalTokens: 7 } });

		// Reißt der Strom VOR der usageMetadata ab, zählt trotzdem die Anfrage
		// (kein Quota-Schlupfloch durch Abbrechen kurz vor Stream-Ende).
		sseAbort = true;
		const aborted = await fetch(`${base}/v1/models/gemini-2.5-flash:streamGenerateContent`, {
			method: 'POST', headers: auth, body: JSON.stringify({ contents: [] })
		});
		try { for await (const _chunk of aborted.body) { /* leeren */ } } catch (_e) { /* Abbruch ist ok */ }
		sseAbort = false;
		assert.deepStrictEqual(recorded[2], { uid: 'user-123', usage: undefined }, 'abgebrochener Strom muss als Anfrage gezählt werden');

		// Kontingent erschöpft: Modell-Aufrufe → 429 mit reason 'quota', KEIN Upstream-Aufruf;
		// Katalog und Verbrauchsanzeige bleiben erreichbar.
		const callsBefore = upstreamCalls.length;
		gateResult = { allowed: false, status: 429, reason: 'quota', error: 'Monatskontingent erschöpft (1000 von 1000 Tokens im Monat 2027-01).' };
		const blocked = await fetch(`${base}/v1/models/gemini-2.5-flash:generateContent`, {
			method: 'POST', headers: auth, body: JSON.stringify({ contents: [] })
		});
		assert.strictEqual(blocked.status, 429);
		const blockedBody = await blocked.json();
		assert.strictEqual(blockedBody.reason, 'quota');
		assert.strictEqual(upstreamCalls.length, callsBefore, 'gesperrte Anfrage darf Vertex nie erreichen');
		assert.strictEqual((await fetch(`${base}/v1/models`, { headers: auth })).status, 200);
		assert.strictEqual((await fetch(`${base}/v1/usage`, { headers: auth })).status, 200);

		// Gesperrtes Konto → 403.
		gateResult = { allowed: false, status: 403, error: 'Konto gesperrt.' };
		assert.strictEqual((await fetch(`${base}/v1/models/gemini-2.5-flash:generateContent`, {
			method: 'POST', headers: auth, body: JSON.stringify({ contents: [] })
		})).status, 403);

		console.log('✔ Metering über HTTP: /v1/usage, record aus JSON & SSE, Abbruch zählt als Anfrage, Quota-429 (reason) ohne Upstream, 403 bei Sperre');
	} finally {
		server.close();
	}
}

async function testHttpServer() {
	const upstreamCalls = [];
	const sse = [
		'data: {"candidates":[{"content":{"parts":[{"text":"Hal"}]}}]}\n\n',
		'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"totalTokenCount":7}}\n\n'
	];
	const fakeVertex = {
		call: async (model, task, body, opts) => {
			upstreamCalls.push({ model: model.id, location: model.location, task, body });
			if (task === 'generateContent') {
				return {
					ok: true, status: 200, body: null,
					text: async () => JSON.stringify({
						candidates: [{ content: { parts: [{ text: 'ok' }] } }],
						usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 }
					})
				};
			}
			return {
				ok: true, status: 200,
				body: (async function* () {
					for (const part of sse) { yield Buffer.from(part, 'utf8'); }
				})()
			};
		}
	};
	const logs = [];
	const server = createServer({
		projectId: PROJECT,
		verify: makeVerifier(),
		vertex: fakeVertex,
		rateLimitRpm: 100,
		meter: null,
		log: (entry) => logs.push(entry)
	});
	await new Promise((resolve) => server.listen(0, resolve));
	const base = `http://127.0.0.1:${server.address().port}`;
	const token = signToken({});
	const auth = { 'Authorization': `Bearer ${token}` };

	try {
		// Health ohne Anmeldung, alles andere nur mit gültigem Token.
		assert.strictEqual((await fetch(`${base}/health`)).status, 200);
		assert.strictEqual((await fetch(`${base}/v1/models`)).status, 401);
		assert.strictEqual((await fetch(`${base}/v1/models`, { headers: { 'Authorization': 'Bearer kaputt' } })).status, 401);

		const catalog = await (await fetch(`${base}/v1/models`, { headers: auth })).json();
		assert.ok(catalog.models.some(m => m.id === 'gemini-3.5-flash' && m.location === 'eu'));

		// Unbekanntes Modell: Allowlist greift, kein Upstream-Aufruf.
		const unknown = await fetch(`${base}/v1/models/gpt-4:generateContent`, {
			method: 'POST', headers: auth, body: '{}'
		});
		assert.strictEqual(unknown.status, 404);
		assert.strictEqual(upstreamCalls.length, 0);

		// Kaputtes JSON → 400.
		const bad = await fetch(`${base}/v1/models/gemini-2.5-flash:generateContent`, {
			method: 'POST', headers: auth, body: '{kein json'
		});
		assert.strictEqual(bad.status, 400);

		// Nicht-Streaming: Antwort und Status werden durchgereicht, Usage landet im Log.
		const gen = await fetch(`${base}/v1/models/gemini-2.5-flash:generateContent`, {
			method: 'POST', headers: auth, body: JSON.stringify({ contents: [] })
		});
		assert.strictEqual(gen.status, 200);
		const genJson = await gen.json();
		assert.strictEqual(genJson.candidates[0].content.parts[0].text, 'ok');
		const genCall = upstreamCalls[upstreamCalls.length - 1];
		assert.deepStrictEqual(
			{ model: genCall.model, location: genCall.location, task: genCall.task },
			{ model: 'gemini-2.5-flash', location: 'europe-west1', task: 'generateContent' }
		);
		const genLog = logs[logs.length - 1];
		assert.strictEqual(genLog.uid, 'user-123');
		assert.deepStrictEqual(genLog.usage, { promptTokens: 3, candidateTokens: 1, totalTokens: 4 });

		// Streaming: SSE-Bytes kommen unverändert an, Routing zeigt auf europe-west2.
		const stream = await fetch(`${base}/v1/models/gemini-3.5-flash:streamGenerateContent`, {
			method: 'POST', headers: auth, body: JSON.stringify({ contents: [] })
		});
		assert.strictEqual(stream.status, 200);
		assert.ok(String(stream.headers.get('content-type')).startsWith('text/event-stream'));
		let received = '';
		for await (const chunk of stream.body) { received += Buffer.from(chunk).toString('utf8'); }
		assert.strictEqual(received, sse.join(''));
		const streamCall = upstreamCalls[upstreamCalls.length - 1];
		assert.deepStrictEqual(
			{ model: streamCall.model, location: streamCall.location, task: streamCall.task },
			{ model: 'gemini-3.5-flash', location: 'eu', task: 'streamGenerateContent' }
		);
		const streamLog = logs[logs.length - 1];
		assert.deepStrictEqual(streamLog.usage, { promptTokens: 5, candidateTokens: 2, totalTokens: 7 });
		// Privacy: Logs enthalten nie Inhalte.
		assert.ok(!JSON.stringify(logs).includes('Hallo'), 'Logs dürfen keine Antwortinhalte tragen');

		console.log('✔ HTTP-Server: Auth-Gate, Katalog, Allowlist, JSON- und SSE-Durchleitung, Metering-Logs');
	} finally {
		server.close();
	}
}

async function testRateLimitHttp() {
	const server = createServer({
		projectId: PROJECT,
		verify: makeVerifier(),
		vertex: { call: async () => ({ ok: true, status: 200, body: null, text: async () => '{}' }) },
		rateLimitRpm: 2,
		meter: null,
		log: () => { }
	});
	await new Promise((resolve) => server.listen(0, resolve));
	const base = `http://127.0.0.1:${server.address().port}`;
	const auth = { 'Authorization': `Bearer ${signToken({})}` };
	try {
		// Schema case-insensitiv (RFC 7235): "bearer" muss ebenfalls akzeptiert werden.
		assert.strictEqual((await fetch(`${base}/v1/models`, { headers: { 'Authorization': `bearer ${signToken({})}` } })).status, 200);
		assert.strictEqual((await fetch(`${base}/v1/models`, { headers: auth })).status, 200);
		assert.strictEqual((await fetch(`${base}/v1/models`, { headers: auth })).status, 429);
		console.log('✔ Rate-Limit über HTTP: dritter Aufruf im Fenster → 429; Bearer case-insensitiv');
	} finally {
		server.close();
	}
}

async function testGlobalRateLimitHttp() {
	// Zwei verschiedene Nutzer, Gesamtdeckel 2: die dritte Anfrage scheitert instanzweit.
	const server = createServer({
		projectId: PROJECT,
		verify: makeVerifier(),
		vertex: { call: async () => ({ ok: true, status: 200, body: null, text: async () => '{}' }) },
		rateLimitRpm: 100,
		globalRateLimitRpm: 2,
		meter: null,
		log: () => { }
	});
	await new Promise((resolve) => server.listen(0, resolve));
	const base = `http://127.0.0.1:${server.address().port}`;
	try {
		const authA = { 'Authorization': `Bearer ${signToken({ sub: 'nutzer-a' })}` };
		const authB = { 'Authorization': `Bearer ${signToken({ sub: 'nutzer-b' })}` };
		assert.strictEqual((await fetch(`${base}/v1/models`, { headers: authA })).status, 200);
		assert.strictEqual((await fetch(`${base}/v1/models`, { headers: authB })).status, 200);
		assert.strictEqual((await fetch(`${base}/v1/models`, { headers: authA })).status, 429);
		console.log('✔ Globaler Gesamtdeckel: greift über Nutzergrenzen hinweg (Schutz vor Konto-Fluten)');
	} finally {
		server.close();
	}
}

// ── Auth-Relay ──────────────────────────────────────────────────────────────

/** Fake-ID-Token mit lesbarer E-Mail-Nutzlast (Signatur egal – das Relay prüft nicht). */
function fakeIdToken(payload) {
	const part = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
	return `${part({ alg: 'none' })}.${part(payload)}.sig`;
}

async function testAuthRelay() {
	const calls = [];
	const relay = createAuthRelay({
		clientId: 'client-1',
		clientSecret: 'geheim',
		apiKey: 'web-key',
		fetchImpl: async (url, init) => {
			calls.push({ url, init });
			if (url.startsWith('https://oauth2.googleapis.com/token')) {
				return { ok: true, status: 200, json: async () => ({ id_token: 'google-idt' }) };
			}
			if (url.startsWith('https://identitytoolkit.googleapis.com/')) {
				return {
					ok: true, status: 200, json: async () => ({
						idToken: fakeIdToken({ email: 'jwt@example.com' }),
						refreshToken: 'fb-refresh', expiresIn: '3600', email: 'mail@example.com'
					})
				};
			}
			if (url.startsWith('https://securetoken.googleapis.com/')) {
				return { ok: true, status: 200, json: async () => ({ id_token: 'fb-idt-2', refresh_token: 'fb-refresh-2', expires_in: '3600' }) };
			}
			throw new Error(`Unerwarteter Aufruf: ${url}`);
		}
	});

	// Happy Path: Code-Tausch (mit Secret + PKCE-Verifier) → signInWithIdp (mit Key).
	const result = await relay.exchange({ code: 'c0de', codeVerifier: 'v3rifier', redirectUri: 'http://127.0.0.1:49152/callback' });
	assert.deepStrictEqual(
		{ refreshToken: result.refreshToken, expiresInSec: result.expiresInSec, email: result.email },
		{ refreshToken: 'fb-refresh', expiresInSec: 3600, email: 'mail@example.com' }
	);
	const tokenBody = new URLSearchParams(calls[0].init.body);
	assert.strictEqual(tokenBody.get('client_secret'), 'geheim', 'Secret bleibt serverseitig im Token-Tausch');
	assert.strictEqual(tokenBody.get('code_verifier'), 'v3rifier');
	assert.ok(calls[1].url.includes('key=web-key'), 'Web-API-Key nur im signInWithIdp-Aufruf');

	// Refresh: Rotation wird durchgereicht; ohne Rotation bleibt der alte Token.
	const rotated = await relay.refresh({ refreshToken: 'fb-refresh' });
	assert.deepStrictEqual(rotated, { idToken: 'fb-idt-2', refreshToken: 'fb-refresh-2', expiresInSec: 3600 });

	// redirectUri: nur der Loopback der Extension – das Relay ist kein offener Token-Tauscher.
	for (const bad of ['https://angreifer.example/callback', 'http://localhost:9/callback', 'http://127.0.0.1:1/woanders']) {
		await assert.rejects(relay.exchange({ code: 'c', codeVerifier: 'v', redirectUri: bad }), (err) => err.status === 400);
	}
	await assert.rejects(relay.refresh({ refreshToken: '' }), (err) => err.status === 400);
	await assert.rejects(relay.refresh({ refreshToken: 'x'.repeat(5000) }), (err) => err.status === 400, 'Längendeckel');

	// Google-Fehler: 401 mit Fehlerkennung, ohne dass Code/Token in der Meldung landen.
	const failing = createAuthRelay({
		clientId: 'c', clientSecret: 's', apiKey: 'k',
		fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'Code verbraucht' }) })
	});
	await assert.rejects(
		failing.exchange({ code: 'geheimer-code', codeVerifier: 'v', redirectUri: 'http://127.0.0.1:1234/callback' }),
		(err) => err.status === 401 && err.message.includes('Code verbraucht') && !err.message.includes('geheimer-code')
	);

	// Netzfehler → 502 (Google nicht erreichbar), kein Crash.
	const offline = createAuthRelay({
		clientId: 'c', clientSecret: 's', apiKey: 'k',
		fetchImpl: async () => { throw new Error('ECONNREFUSED'); }
	});
	await assert.rejects(offline.refresh({ refreshToken: 'r' }), (err) => err.status === 502);

	// E-Mail-Fallback aus der JWT-Nutzlast, wenn Firebase kein email-Feld liefert.
	const noEmail = createAuthRelay({
		clientId: 'c', clientSecret: 's', apiKey: 'k',
		fetchImpl: async (url) => url.startsWith('https://oauth2.googleapis.com/')
			? { ok: true, status: 200, json: async () => ({ id_token: 'g' }) }
			: { ok: true, status: 200, json: async () => ({ idToken: fakeIdToken({ email: 'jwt@example.com' }), refreshToken: 'r', expiresIn: '3600' }) }
	});
	assert.strictEqual((await noEmail.exchange({ code: 'c', codeVerifier: 'v', redirectUri: 'http://127.0.0.1:1/callback' })).email, 'jwt@example.com');

	console.log('✔ Auth-Relay: Exchange (Secret/Key serverseitig), Refresh-Rotation, Loopback-Pflicht, Fehler ohne Token-Leak');
}

async function testAuthRelayHttp() {
	// Ohne Relay (nicht konfiguriert) antworten die Auth-Endpunkte 501, alles andere läuft.
	const bare = createServer({ projectId: PROJECT, verify: makeVerifier(), vertex: { call: async () => ({}) }, meter: null, log: () => { } });
	await new Promise((resolve) => bare.listen(0, resolve));
	const bareBase = `http://127.0.0.1:${bare.address().port}`;
	try {
		assert.strictEqual((await fetch(`${bareBase}/v1/auth/refresh`, { method: 'POST', body: '{}' })).status, 501);
		assert.strictEqual((await fetch(`${bareBase}/health`)).status, 200);
	} finally {
		bare.close();
	}

	// Mit Relay: Erfolg + Fehler-Mapping + per-IP-Rate-Limit; Logs ohne Token.
	const logs = [];
	const relay = {
		exchange: async () => ({ idToken: 'idt', refreshToken: 'rt', expiresInSec: 3600, email: 'a@b.c' }),
		refresh: async ({ refreshToken }) => {
			if (refreshToken !== 'gültig') { throw Object.assign(new Error('Token-Erneuerung fehlgeschlagen: TOKEN_EXPIRED'), { status: 401 }); }
			return { idToken: 'idt-2', refreshToken: 'rt-2', expiresInSec: 3600 };
		}
	};
	const server = createServer({
		projectId: PROJECT, verify: makeVerifier(), vertex: { call: async () => ({}) },
		meter: null, authRelay: relay, authRateLimitRpm: 4, log: (entry) => logs.push(entry)
	});
	await new Promise((resolve) => server.listen(0, resolve));
	const base = `http://127.0.0.1:${server.address().port}`;
	try {
		const ok = await fetch(`${base}/v1/auth/refresh`, { method: 'POST', body: JSON.stringify({ refreshToken: 'gültig' }) });
		assert.strictEqual(ok.status, 200);
		assert.deepStrictEqual(await ok.json(), { idToken: 'idt-2', refreshToken: 'rt-2', expiresInSec: 3600 });

		const expired = await fetch(`${base}/v1/auth/refresh`, { method: 'POST', body: JSON.stringify({ refreshToken: 'alt' }) });
		assert.strictEqual(expired.status, 401);
		assert.ok((await expired.json()).error.includes('TOKEN_EXPIRED'));

		const exchange = await fetch(`${base}/v1/auth/exchange`, { method: 'POST', body: JSON.stringify({ code: 'c', codeVerifier: 'v', redirectUri: 'http://127.0.0.1:1/callback' }) });
		assert.strictEqual(exchange.status, 200);

		// Kaputtes JSON → 400 (Rate-Limit zählt trotzdem mit – es greift VOR dem Parsen);
		// fünftes Mal im Fenster (gleiche IP) → 429.
		assert.strictEqual((await fetch(`${base}/v1/auth/refresh`, { method: 'POST', body: '{kein json' })).status, 400);
		assert.strictEqual((await fetch(`${base}/v1/auth/refresh`, { method: 'POST', body: '{}' })).status, 429);

		// Privacy: Auth-Logs tragen nur Pfad/Status/Dauer – nie Tokens oder Codes.
		const authLogs = logs.filter(l => l.path && l.path.startsWith('/v1/auth/'));
		assert.ok(authLogs.length >= 4);
		assert.ok(!JSON.stringify(authLogs).match(/idt|rt-2|gültig|codeVerifier/), 'Auth-Logs dürfen keine Tokens/Codes tragen');

		console.log('✔ Auth-Relay über HTTP: 501 unkonfiguriert, Erfolg, 401-Mapping, per-IP-429, Logs ohne Geheimnisse');
	} finally {
		server.close();
	}
}

async function testAuthGlobalIsolation() {
	// Ein (unauthentifizierter) Anmelde-Flood darf den globalen Eimer der bezahlten
	// Modell-Endpunkte NICHT leeren – Auth-Endpunkte haben einen eigenen Gesamtdeckel.
	const relay = {
		exchange: async () => ({ idToken: 'idt', refreshToken: 'rt', expiresInSec: 3600, email: 'a@b.c' }),
		refresh: async () => ({ idToken: 'idt-2', refreshToken: 'rt-2', expiresInSec: 3600 })
	};
	const server = createServer({
		projectId: PROJECT, verify: makeVerifier(),
		vertex: { call: async () => ({ ok: true, status: 200, body: null, text: async () => '{}' }) },
		meter: null, authRelay: relay,
		authRateLimitRpm: 100, authGlobalRateLimitRpm: 100,
		globalRateLimitRpm: 2, rateLimitRpm: 100, // kleiner Modell-Gesamtdeckel
		log: () => { }
	});
	await new Promise((resolve) => server.listen(0, resolve));
	const base = `http://127.0.0.1:${server.address().port}`;
	const auth = { 'Authorization': `Bearer ${signToken({})}` };
	try {
		// Fünf Anmelde-Anfragen (unauthentifiziert) …
		for (let i = 0; i < 5; i++) {
			await fetch(`${base}/v1/auth/refresh`, { method: 'POST', body: JSON.stringify({ refreshToken: 'x' }) });
		}
		// … dürfen den Modell-Eimer (global=2) nicht angetastet haben.
		assert.strictEqual((await fetch(`${base}/v1/models`, { headers: auth })).status, 200);
		assert.strictEqual((await fetch(`${base}/v1/models`, { headers: auth })).status, 200);
		assert.strictEqual((await fetch(`${base}/v1/models`, { headers: auth })).status, 429, 'erst der dritte Modell-Aufruf reißt den Modell-Deckel');
		console.log('✔ Auth-Isolation: Anmelde-Flood leert den globalen Modell-Eimer nicht (getrennte Deckel, per-IP zuerst)');
	} finally {
		server.close();
	}
}

async function main() {
	await testVerifier();
	await testCatalogAndVertexUrl();
	await testRateLimiterAndScanner();
	await testMetering();
	await testMeteringHttp();
	await testHttpServer();
	await testRateLimitHttp();
	await testGlobalRateLimitHttp();
	await testAuthRelay();
	await testAuthRelayHttp();
	await testAuthGlobalIsolation();
	console.log('\nAlle Proxy-Tests bestanden.');
}

main().catch((err) => {
	console.error('✘ Test fehlgeschlagen:', err);
	process.exit(1);
});
