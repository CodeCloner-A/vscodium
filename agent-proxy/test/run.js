/*---------------------------------------------------------------------------------------------
 * VSCodium Agent Proxy – Headless-Tests ohne GCP.
 * Testet: Token-Prüfung (echte RSA-Signaturen), Katalog/Routing, Vertex-URL-Aufbau,
 * Rate-Limit, Usage-Scanner, HTTP-Endpunkte inkl. SSE-Durchleitung.
 *
 * Ausführen:  node test/run.js
 *--------------------------------------------------------------------------------------------*/

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { createVerifier, TokenError } = require('../lib/verifyIdToken');
const { createVertexClient, hostFor } = require('../lib/vertex');
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
		log: (entry) => logs.push(entry)
	});
	await new Promise((resolve) => server.listen(0, resolve));
	const base = `http://127.0.0.1:${server.address().port}`;
	const token = signToken({});
	const auth = { 'Authorization': `Bearer ${token}` };

	try {
		// Health ohne Anmeldung, alles andere nur mit gültigem Token.
		assert.strictEqual((await fetch(`${base}/healthz`)).status, 200);
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

async function main() {
	await testVerifier();
	await testCatalogAndVertexUrl();
	await testRateLimiterAndScanner();
	await testHttpServer();
	await testRateLimitHttp();
	await testGlobalRateLimitHttp();
	console.log('\nAlle Proxy-Tests bestanden.');
}

main().catch((err) => {
	console.error('✘ Test fehlgeschlagen:', err);
	process.exit(1);
});
