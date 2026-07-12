/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – Headless-Test ohne VS Code.
 * Testet: Tool-Ausführung, Agent-Loop (Function Calling), Review-Gating (Annahme + Ablehnung),
 * replace_in_file-Eindeutigkeit, Kommando-Ergebnisfluss, task_complete, Historienformat,
 * Aktivitäts-Index (Frecency + Delta seit letzter Agent-Erfassung).
 *
 * Ausführen:  node test/run.js
 *--------------------------------------------------------------------------------------------*/

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { AgentRun } = require('../lib/agentController');
const { executeTool, countOccurrences } = require('../lib/tools');
const { buildSystemPrompt } = require('../lib/prompts');
const { normalizeModelName, createSseParser, mergeStreamResponses, FirebaseAiLogicClient } = require('../lib/firebaseClient');
const { ActivityIndex } = require('../lib/activityIndex');
const { createLogger, formatDetail, NOOP_LOGGER } = require('../lib/logger');
const { buildInlineEditRequest, buildApplyRequest, extractCode, sanitizeStreamText, APPLY_MAX_LINES } = require('../lib/inlineEdit');
const { computeLineHunks, revertHunkInLines, splitLines } = require('../lib/lineDiff');
const { stripAnsi, normalizeCommandApproval } = require('../lib/terminalExec');
const { MODEL_CATALOG, pickerModels, resolveRoute, fixedLocation } = require('../lib/modelCatalog');
const { signInWithGoogle, refreshIdToken, createPkce, decodeJwtPayload } = require('../lib/firebaseAuth');
const { AuthManager, AUTH_SECRET_KEY } = require('../lib/authManager');

// ── Mock-Host (In-Memory-Dateisystem) ──────────────────────────────────────

function createMockHost(files, decisions) {
	const fs = new Map(Object.entries(files));
	const log = { approvalsAsked: [], commandsAsked: [] };
	return {
		fs,
		log,
		rootName: 'demo-projekt',
		async listProjectFiles() {
			return [...fs.keys()].sort().join('\n');
		},
		async fileExists(p) { return fs.has(p); },
		async readFile(p) {
			if (!fs.has(p)) { throw new Error(`Datei nicht gefunden: ${p}`); }
			return fs.get(p);
		},
		async searchText(query) {
			const out = [];
			for (const [p, content] of fs) {
				const lines = content.split('\n');
				lines.forEach((l, i) => {
					if (l.includes(query)) { out.push({ path: p, line: i + 1, text: l }); }
				});
			}
			return out;
		},
		async applyChange(change) {
			log.approvalsAsked.push(change.path);
			const decision = decisions.edits.shift();
			if (decision === false) {
				return { status: 'rejected', message: 'Vom Benutzer abgelehnt.' };
			}
			if (change.kind === 'delete') { fs.delete(change.path); }
			else { fs.set(change.path, change.newContent); }
			return { status: 'applied' };
		},
		async runCommand(command) {
			log.commandsAsked.push(command);
			const decision = decisions.commands.shift();
			if (decision === false) { return { status: 'skipped', message: 'Vom Benutzer abgelehnt.' }; }
			// Simulierter Testlauf: grün, sobald der Bugfix drin ist.
			const code = fs.get('src/rechner.js') || '';
			const fixed = code.includes('a + b');
			return {
				status: 'ran',
				exitCode: fixed ? 0 : 1,
				stdout: fixed ? '1 passing' : '1 failing: erwartete 5, bekam -1',
				stderr: '',
				durationMs: 42
			};
		},
		async getRecentActivity() { return '(mock activity)'; },
		async getDiagnostics() { return []; }
	};
}

// ── Mock-Client: geskriptete Modell-Antworten ──────────────────────────────

function scriptedClient(turns) {
	let i = 0;
	const requests = [];
	return {
		requests,
		async generateContent(request) {
			requests.push(JSON.parse(JSON.stringify(request)));
			const parts = turns[i++];
			if (!parts) { throw new Error('Skript zu Ende – Loop hätte stoppen müssen.'); }
			return { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] };
		}
	};
}

function fc(name, args) { return { functionCall: { name, args } }; }

// ── UI-Senke ────────────────────────────────────────────────────────────────

function collectorUi() {
	const events = [];
	return {
		events,
		assistantText: (t) => events.push(['text', t]),
		toolStart: (id, name) => events.push(['start', name]),
		toolEnd: (id, name, summary, ok) => events.push(['end', name, ok]),
		info: (t) => events.push(['info', t]),
		error: (t) => events.push(['error', t])
	};
}

// ── Tests ───────────────────────────────────────────────────────────────────

async function testFullAgentLoop() {
	const host = createMockHost({
		'src/rechner.js': 'function add(a, b) {\n  return a - b; // BUG\n}\nmodule.exports = { add };\n',
		'test/rechner.test.js': 'const { add } = require("../src/rechner");\nif (add(2, 3) !== 5) { throw new Error("erwartete 5"); }\n'
	}, {
		edits: [true],
		commands: [true, true]
	});

	const client = scriptedClient([
		[{ text: 'Plan: Bug in add() finden, fixen, Tests laufen lassen.' }, fc('read_file', { path: 'src/rechner.js' })],
		[fc('run_command', { command: 'npm test', purpose: 'Fehler reproduzieren' })],
		[fc('replace_in_file', {
			path: 'src/rechner.js',
			old_text: 'return a - b; // BUG',
			new_text: 'return a + b;',
			summary: 'Subtraktion durch Addition ersetzt'
		})],
		[fc('run_command', { command: 'npm test', purpose: 'Fix verifizieren' })],
		[fc('task_complete', { summary: 'Bug behoben, Tests grün.', success: true })]
	]);

	const ui = collectorUi();
	const run = new AgentRun({
		client,
		host,
		ui,
		systemPrompt: buildSystemPrompt({ rootName: 'demo', platform: 'test', fileTree: 'src/\ntest/', approvalMode: 'review' }),
		maxIterations: 10
	});

	const result = await run.run('Behebe den Bug in der add-Funktion und stelle sicher, dass die Tests grün sind.');

	assert.strictEqual(result.status, 'completed', 'Lauf sollte abgeschlossen sein');
	assert.strictEqual(result.success, true);
	assert.ok(host.fs.get('src/rechner.js').includes('a + b'), 'Fix muss angewendet sein');
	assert.deepStrictEqual(host.log.approvalsAsked, ['src/rechner.js'], 'genau eine Edit-Freigabe');
	assert.strictEqual(host.log.commandsAsked.length, 2, 'zwei Kommando-Freigaben');
	assert.strictEqual(run.filesChanged.size, 1);

	const last = client.requests[client.requests.length - 1];
	const roles = last.contents.map(c => c.role);
	assert.strictEqual(roles[0], 'user');
	assert.ok(roles.includes('model'));
	const fnResponses = last.contents.filter(c => c.role === 'user' && c.parts.some(p => p.functionResponse));
	assert.ok(fnResponses.length >= 4, 'functionResponses müssen als user-Content zurückgehen');
	assert.ok(last.systemInstruction.parts[0].text.includes('VSCodium Agent'));
	assert.ok(last.tools[0].functionDeclarations.length >= 9, 'Tool-Deklarationen müssen mitgesendet werden');

	const lastCmdResponse = fnResponses[fnResponses.length - 1].parts[0].functionResponse.response;
	assert.strictEqual(lastCmdResponse.exitCode, 0, 'Tests nach Fix grün');

	console.log('✔ Agent-Loop: Bug-Fix-Workflow (lesen → testen → fixen → testen → fertig)');
}

async function testRejectionFlow() {
	const host = createMockHost(
		{ 'a.txt': 'hallo welt\n' },
		{ edits: [false], commands: [] }
	);
	const client = scriptedClient([
		[fc('write_file', { path: 'a.txt', content: 'ersetzt\n', summary: 'Alles ersetzen' })],
		[fc('task_complete', { summary: 'Vom Benutzer abgelehnt, keine Änderung.', success: false })]
	]);
	const ui = collectorUi();
	const run = new AgentRun({ client, host, ui, systemPrompt: 'test', maxIterations: 5 });
	const result = await run.run('Ersetze a.txt');

	assert.strictEqual(result.status, 'completed');
	assert.strictEqual(result.success, false);
	assert.strictEqual(host.fs.get('a.txt'), 'hallo welt\n', 'Ablehnung darf nichts ändern');
	assert.strictEqual(run.filesChanged.size, 0);

	const secondRequest = client.requests[1];
	const fr = secondRequest.contents[secondRequest.contents.length - 1].parts[0].functionResponse.response;
	assert.strictEqual(fr.status, 'rejected');
	console.log('✔ Review-Modus: Ablehnung stoppt die Änderung und ist für das Modell sichtbar');
}

async function testReplaceUniqueness() {
	const host = createMockHost({ 'x.js': 'let a = 1;\nlet a2 = 1;\n' }, { edits: [true], commands: [] });
	const result = await executeTool(host, 'replace_in_file', {
		path: 'x.js', old_text: '= 1;', new_text: '= 2;', summary: 'test'
	});
	assert.ok(result.error && result.error.includes('nicht eindeutig'), 'Mehrdeutigkeit muss Fehler geben');

	const missing = await executeTool(host, 'replace_in_file', {
		path: 'x.js', old_text: 'gibt es nicht', new_text: 'x', summary: 'test'
	});
	assert.ok(missing.error && missing.error.includes('nicht gefunden'));

	assert.strictEqual(countOccurrences('aaa', 'aa'), 1, 'nicht überlappend zählen');
	console.log('✔ replace_in_file: Eindeutigkeits- und Existenzprüfung');
}

async function testMaxIterationsGuard() {
	const host = createMockHost({ 'a.txt': 'x' }, { edits: [], commands: [] });
	const endless = Array.from({ length: 20 }, () => [fc('list_files', {})]);
	const client = scriptedClient(endless);
	const ui = collectorUi();
	const run = new AgentRun({ client, host, ui, systemPrompt: 'test', maxIterations: 3 });
	const result = await run.run('irgendwas');
	assert.strictEqual(result.status, 'max-iterations');
	assert.ok(ui.events.some(e => e[0] === 'info'), 'Hinweis an den Benutzer');
	console.log('✔ Drift-Schutz: maxIterations bricht Endlosschleifen ab');
}

async function testToolBasics() {
	const host = createMockHost({ 'dir/lang.txt': Array.from({ length: 500 }, (_, i) => `Zeile ${i + 1}`).join('\n') }, { edits: [true], commands: [] });

	const read = await executeTool(host, 'read_file', { path: 'dir/lang.txt', start_line: 10, end_line: 12 });
	assert.strictEqual(read.shownRange, '10-12');
	assert.ok(read.content.includes('10\tZeile 10'));

	const search = await executeTool(host, 'search_project', { query: 'Zeile 499' });
	assert.strictEqual(search.matchCount, 1);

	const bad = await executeTool(host, 'read_file', { path: 'fehlt.txt' });
	assert.ok(bad.error, 'fehlende Datei → error-Feld statt Exception');

	const unknown = await executeTool(host, 'so_ein_tool_gibts_nicht', {});
	assert.ok(unknown.error.includes('Unbekannt'));

	assert.strictEqual(normalizeModelName('models/gemini-2.5-pro'), 'gemini-2.5-pro');
	assert.strictEqual(normalizeModelName('publishers/google/models/gemini-2.5-flash'), 'gemini-2.5-flash');
	console.log('✔ Tools: read_file-Bereiche, Suche, Fehlerpfade, Modellnamen-Normalisierung');
}

async function testModelCatalog() {
	// Katalog: eindeutige IDs, 3.5-flash enthalten, Picker-Einträge tragen die feste Region.
	const ids = MODEL_CATALOG.map(m => m.id);
	assert.strictEqual(new Set(ids).size, ids.length, 'Modell-IDs müssen eindeutig sein');
	assert.ok(ids.includes('gemini-3.5-flash'));
	const picker = pickerModels();
	assert.strictEqual(picker.find(m => m.id === 'gemini-3.5-flash').region, 'global', 'fester Standort muss im Picker sichtbar sein');
	assert.strictEqual(picker.find(m => m.id === 'gemini-2.5-flash').region, undefined, 'regional freie Modelle ohne Regions-Anzeige');

	// vertexAI: 3.x wird auf global gepinnt, 2.5 respektiert die Location-Einstellung.
	assert.deepStrictEqual(
		resolveRoute('gemini-3.5-flash', { backend: 'vertexAI', location: 'us-central1' }),
		{ backend: 'vertexAI', location: 'global', pinned: true }
	);
	assert.deepStrictEqual(
		resolveRoute('gemini-3.5-flash', { backend: 'vertexAI', location: 'global' }),
		{ backend: 'vertexAI', location: 'global', pinned: false }
	);
	assert.deepStrictEqual(
		resolveRoute('gemini-2.5-flash', { backend: 'vertexAI', location: 'europe-west1' }),
		{ backend: 'vertexAI', location: 'europe-west1', pinned: false }
	);
	// Unbekannte 3.x-Modelle (z. B. Previews aus den Einstellungen) greifen über die Heuristik.
	assert.deepStrictEqual(
		resolveRoute('gemini-3.1-pro-preview', { backend: 'vertexAI', location: 'europe-west1' }),
		{ backend: 'vertexAI', location: 'global', pinned: true }
	);
	// Präfix-Schreibweisen routen identisch (normalizeModelName).
	assert.deepStrictEqual(
		resolveRoute('models/gemini-3.5-flash', { backend: 'vertexAI', location: 'us-central1' }),
		{ backend: 'vertexAI', location: 'global', pinned: true }
	);
	// googleAI kennt keinen Standort: nichts wird gepinnt; leere Konfiguration fällt sauber zurück.
	assert.deepStrictEqual(
		resolveRoute('gemini-3.5-flash', { backend: 'googleAI', location: 'us-central1' }),
		{ backend: 'googleAI', location: 'us-central1', pinned: false }
	);
	assert.deepStrictEqual(
		resolveRoute('gemini-2.5-flash', {}),
		{ backend: 'googleAI', location: 'us-central1', pinned: false }
	);

	// fixedLocation: gemeinsame Anzeige-Regel, auch für unbekannte 3.x und Präfix-Formen.
	assert.strictEqual(fixedLocation('gemini-3-pro-preview'), 'global');
	assert.strictEqual(fixedLocation('models/gemini-3.5-flash'), 'global');
	assert.strictEqual(fixedLocation('gemini-2.5-flash'), undefined);

	// normalizeModelName: trailing Slash ist Tippfehler-tolerant statt Default-Umleitung;
	// nur wirklich leere Eingabe erhält den Default.
	assert.strictEqual(normalizeModelName('gemini-3.5-flash/'), 'gemini-3.5-flash');
	assert.strictEqual(normalizeModelName('models/'), 'models');
	assert.strictEqual(normalizeModelName(''), 'gemini-2.5-flash');
	console.log('✔ Modell-Katalog: Picker-Einträge, Auto-Routing (Gemini 3.x → global), Overrides');
}

async function testFirebaseAuth() {
	// PKCE: Challenge ist SHA-256 des Verifiers (base64url).
	const pkce = createPkce();
	assert.ok(pkce.verifier.length >= 43);
	assert.strictEqual(
		crypto.createHash('sha256').update(pkce.verifier).digest().toString('base64url'),
		pkce.challenge
	);

	// JWT-Nutzlast lesen (nur Anzeige, keine Verifikation).
	const fakeIdJwt = `h.${Buffer.from(JSON.stringify({ email: 'jwt@example.com' })).toString('base64url')}.s`;
	assert.strictEqual(decodeJwtPayload(fakeIdJwt).email, 'jwt@example.com');
	assert.strictEqual(decodeJwtPayload('kaputt'), null);

	// Voller Anmelde-Flow: echter Loopback-Server, Browser und Netz simuliert.
	let sentChallenge = '';
	const fakeFetch = async (url, init) => {
		if (url.startsWith('https://oauth2.googleapis.com/token')) {
			const params = new URLSearchParams(init.body);
			assert.strictEqual(params.get('code'), 'test-code');
			assert.strictEqual(params.get('grant_type'), 'authorization_code');
			assert.strictEqual(
				crypto.createHash('sha256').update(params.get('code_verifier')).digest().toString('base64url'),
				sentChallenge,
				'PKCE-Verifier muss zur Challenge aus der Auth-URL passen'
			);
			return { ok: true, status: 200, json: async () => ({ id_token: 'google-id-token' }) };
		}
		if (url.startsWith('https://identitytoolkit.googleapis.com/')) {
			assert.ok(url.includes('key=web-api-key'), 'API-Key muss an signInWithIdp gehen');
			const body = JSON.parse(init.body);
			assert.ok(body.postBody.includes('id_token=google-id-token'));
			assert.ok(body.postBody.includes('providerId=google.com'));
			return {
				ok: true, status: 200,
				json: async () => ({ idToken: 'firebase-id-token', refreshToken: 'refresh-1', email: 'nutzer@example.com', expiresIn: '3600' })
			};
		}
		throw new Error(`Unerwarteter Netzaufruf: ${url}`);
	};
	const result = await signInWithGoogle({
		clientId: 'cid', clientSecret: 'csec', apiKey: 'web-api-key', fetchImpl: fakeFetch,
		openBrowser: async (authUrl) => {
			const u = new URL(authUrl);
			assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256');
			sentChallenge = u.searchParams.get('code_challenge');
			const redirect = u.searchParams.get('redirect_uri');
			assert.ok(redirect.startsWith('http://127.0.0.1:'), 'Redirect muss auf den Loopback zeigen');
			// Browser-Simulation: Google leitet mit Code und State zurück.
			const res = await fetch(`${redirect}?code=test-code&state=${encodeURIComponent(u.searchParams.get('state'))}`);
			assert.strictEqual(res.status, 200);
		}
	});
	assert.deepStrictEqual(
		{ idToken: result.idToken, refreshToken: result.refreshToken, email: result.email },
		{ idToken: 'firebase-id-token', refreshToken: 'refresh-1', email: 'nutzer@example.com' }
	);
	assert.ok(result.expiresAt > Date.now());

	// State-Mismatch (CSRF/fremder Redirect) bricht den Flow ab.
	await assert.rejects(signInWithGoogle({
		clientId: 'cid', clientSecret: 'csec', apiKey: 'k', fetchImpl: fakeFetch,
		openBrowser: async (authUrl) => {
			const redirect = new URL(authUrl).searchParams.get('redirect_uri');
			const res = await fetch(`${redirect}?code=test-code&state=falsch`);
			assert.strictEqual(res.status, 400);
		}
	}), /state/);

	// Abbruch über AbortSignal: Flow endet sofort mit „abgebrochen“ und räumt auf.
	const abortController = new AbortController();
	await assert.rejects(signInWithGoogle({
		clientId: 'cid', clientSecret: 'csec', apiKey: 'k', fetchImpl: fakeFetch,
		signal: abortController.signal,
		openBrowser: async () => { abortController.abort(); }
	}), /abgebrochen/i);

	// Ohne Web-API-Key wird die Erneuerung gar nicht erst versucht.
	await assert.rejects(refreshIdToken({ apiKey: '', refreshToken: 'r' }), /Web-API-Key/);

	// Token-Erneuerung inkl. Rotation des Refresh-Tokens.
	const refreshed = await refreshIdToken({
		apiKey: 'k', refreshToken: 'r-alt',
		fetchImpl: async (url, init) => {
			assert.ok(url.startsWith('https://securetoken.googleapis.com/v1/token'));
			assert.strictEqual(new URLSearchParams(init.body).get('refresh_token'), 'r-alt');
			return { ok: true, status: 200, json: async () => ({ id_token: 'id-neu', refresh_token: 'r-neu', expires_in: '3600' }) };
		}
	});
	assert.deepStrictEqual(
		{ idToken: refreshed.idToken, refreshToken: refreshed.refreshToken },
		{ idToken: 'id-neu', refreshToken: 'r-neu' }
	);

	console.log('✔ Firebase-Auth: PKCE, Loopback-Flow, state-Prüfung, signInWithIdp, Refresh-Rotation');
}

async function testAuthManager() {
	const store = new Map();
	const secrets = {
		get: async (k) => store.get(k),
		store: async (k, v) => { store.set(k, v); },
		delete: async (k) => { store.delete(k); }
	};
	let tNow = Date.now();
	let refreshCalls = 0;
	const fetchImpl = async () => {
		refreshCalls++;
		return { ok: true, status: 200, json: async () => ({ id_token: `id-${refreshCalls}`, refresh_token: `r-${refreshCalls}`, expires_in: '3600' }) };
	};

	// Abgemeldet: Status falsch, Token-Abruf wirft verständlich.
	const anon = new AuthManager({ secrets, now: () => tNow, fetchImpl });
	assert.strictEqual(await anon.isSignedIn(), false);
	await assert.rejects(anon.getIdToken('k'), /angemeldet/i);

	// Angemeldeter Zustand (Refresh-Token liegt in der SecretStorage).
	await secrets.store(AUTH_SECRET_KEY, JSON.stringify({ refreshToken: 'r-0', email: 'e@example.com' }));
	const mgr = new AuthManager({ secrets, now: () => tNow, fetchImpl });
	assert.strictEqual(await mgr.isSignedIn(), true);
	assert.strictEqual(await mgr.email(), 'e@example.com');
	assert.strictEqual(await mgr.getIdToken('k'), 'id-1');
	assert.strictEqual(await mgr.getIdToken('k'), 'id-1', 'zweiter Abruf muss aus dem Cache kommen');
	assert.strictEqual(refreshCalls, 1);
	assert.ok(store.get(AUTH_SECRET_KEY).includes('r-1'), 'rotierter Refresh-Token muss persistiert sein');

	// Nach Ablauf wird erneuert.
	tNow += 3600 * 1000 + 1;
	assert.strictEqual(await mgr.getIdToken('k'), 'id-2');
	assert.strictEqual(refreshCalls, 2);

	// Cache ist pro API-Key: anderer Key (= anderes Projekt) erzwingt neue Erneuerung.
	assert.strictEqual(await mgr.getIdToken('anderer-key'), 'id-3');
	assert.strictEqual(refreshCalls, 3);

	// Abmelden räumt alles weg.
	await mgr.signOut();
	assert.strictEqual(await mgr.isSignedIn(), false);
	assert.ok(!store.has(AUTH_SECRET_KEY));

	// Race: Abmelden WÄHREND einer laufenden Erneuerung darf nicht rückgängig gemacht werden.
	await secrets.store(AUTH_SECRET_KEY, JSON.stringify({ refreshToken: 'r-x', email: 'x@example.com' }));
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	const racy = new AuthManager({
		secrets, now: () => tNow,
		fetchImpl: async () => {
			await gate;
			return { ok: true, status: 200, json: async () => ({ id_token: 'spät', refresh_token: 'r-rotiert', expires_in: '3600' }) };
		}
	});
	const pending = racy.getIdToken('k');
	pending.catch(() => { }); // Ablehnung kommt erst nach dem signOut
	await new Promise((resolve) => setImmediate(resolve)); // Erneuerung ist jetzt in flight
	await racy.signOut();
	release();
	await assert.rejects(pending, /angemeldet/i);
	assert.strictEqual(await racy.isSignedIn(), false, 'verspätete Erneuerung darf das Abmelden nicht aufheben');
	assert.ok(!store.has(AUTH_SECRET_KEY), 'rotierter Token darf nach signOut nicht zurückgeschrieben werden');

	// Transienter SecretStorage-Fehler (z. B. gesperrter Keyring) wird nicht memoiert.
	let keyringLocked = true;
	const flaky = {
		get: async () => {
			if (keyringLocked) { throw new Error('Keyring gesperrt'); }
			return JSON.stringify({ refreshToken: 'r', email: 'e@example.com' });
		},
		store: async () => { }, delete: async () => { }
	};
	const retrying = new AuthManager({ secrets: flaky, now: () => tNow, fetchImpl });
	assert.strictEqual(await retrying.isSignedIn(), false, 'gesperrter Keyring → vorerst abgemeldet');
	keyringLocked = false;
	assert.strictEqual(await retrying.isSignedIn(), true, 'nächster Zugriff liest erneut statt dauerhaft abgemeldet zu bleiben');

	// Formprüfung: parsebarer, aber unbrauchbarer Eintrag gilt als abgemeldet.
	const junkStore = new Map([[AUTH_SECRET_KEY, JSON.stringify({ foo: 1 })]]);
	const junky = new AuthManager({
		secrets: { get: async (k) => junkStore.get(k), store: async () => { }, delete: async () => { } },
		now: () => tNow, fetchImpl
	});
	assert.strictEqual(await junky.isSignedIn(), false);

	// invalidate(): extern geänderte Secrets (zweites Fenster) werden neu gelesen.
	const shared = new Map([[AUTH_SECRET_KEY, JSON.stringify({ refreshToken: 'r-a', email: 'a@example.com' })]]);
	const windowB = new AuthManager({
		secrets: { get: async (k) => shared.get(k), store: async (k, v) => { shared.set(k, v); }, delete: async (k) => { shared.delete(k); } },
		now: () => tNow, fetchImpl
	});
	assert.strictEqual(await windowB.isSignedIn(), true);
	shared.delete(AUTH_SECRET_KEY); // „anderes Fenster“ meldet ab
	assert.strictEqual(await windowB.isSignedIn(), true, 'ohne invalidate bleibt der Cache stehen');
	windowB.invalidate();
	assert.strictEqual(await windowB.isSignedIn(), false, 'nach invalidate zählt der echte Speicherstand');

	console.log('✔ Auth-Verwaltung: Cache pro API-Key, Ablauf-Erneuerung, Rotation, signOut-Race, Keyring-Retry, invalidate');
}

async function testActivityIndex() {
	let now = 1000000;
	const idx = new ActivityIndex(() => now);

	idx.noteView('src/a.js', 10);
	idx.noteEdit('src/a.js');
	now += 60000;                        // 1 min später
	idx.noteEdit('src/b.js');
	idx.noteSave('src/b.js');
	const captureAt = now;               // "letzte Erfassung durch den Agenten"
	now += 120000;                       // 2 min später
	idx.noteEdit('src/c.js');            // nach der Erfassung angefasst
	idx.noteEdit('src/c.js');
	idx.noteEdit('src/c.js');            // mehrfach bearbeitet -> heisseste Datei
	idx.noteAgentWrite('src/agent.js');  // Agent-Schreibvorgang nach Erfassung

	// Delta seit letzter Erfassung: c.js (Benutzer) + agent.js (Agent), nicht a/b.
	const delta = idx.changedSince(captureAt);
	assert.deepStrictEqual(delta.map(d => d.path).sort(), ['src/agent.js', 'src/c.js']);
	const agentEntry = delta.find(d => d.path === 'src/agent.js');
	assert.strictEqual(agentEntry.byAgent, true, 'Agent-Write muss markiert sein');

	const text = idx.summary(8, captureAt);
	assert.ok(text.includes('Touched since your last context capture'), text);
	assert.ok(text.includes('src/c.js'), 'Delta-Datei fehlt in Summary');
	assert.ok(text.includes('(by you, the agent)'), 'Agent-Markierung fehlt');
	assert.ok(text.includes('Active file in editor: src/a.js'), 'aktive Datei fehlt');

	// Frecency: frisch editierte c.js muss vor der alten a.js stehen.
	const rankedPart = text.slice(text.indexOf('worked on recently'));
	assert.ok(rankedPart.indexOf('src/c.js') < rankedPart.indexOf('src/a.js'), 'Ranking falsch');

	// Ohne Aktivität seit Erfassung: explizite "nichts passiert"-Zeile.
	const quiet = idx.summary(8, now + 1);
	assert.ok(quiet.includes('No files were touched since'), quiet);

	// Serialisierung round-trip
	const restored = ActivityIndex.fromJSON(idx.toJSON(), () => now);
	assert.strictEqual(restored.files.size, idx.files.size);
	assert.deepStrictEqual(restored.activeFile, idx.activeFile);

	// Umbenennen/Löschen
	restored.noteRenamed('src/c.js', 'src/c2.js');
	assert.ok(restored.files.has('src/c2.js') && !restored.files.has('src/c.js'));
	restored.noteRemoved('src/c2.js');
	assert.ok(!restored.files.has('src/c2.js'));

	// Tool-Anbindung
	const result = await executeTool({ getRecentActivity: async () => idx.summary(8, captureAt) }, 'get_recent_activity', {});
	assert.ok(result.activity.includes('src/c.js'));

	// Systemprompt enthält die Aktivitäts-Sektion
	const prompt = buildSystemPrompt({ rootName: 'x', platform: 'test', fileTree: '', approvalMode: 'review', activity: text });
	assert.ok(prompt.includes('== Recent user activity ==') && prompt.includes('src/c.js'));

	console.log('✔ Aktivitäts-Index: Frecency-Ranking, Delta seit letzter Agent-Erfassung, Persistenz, Tool');
}

async function testLogger() {
	const lines = [];
	const channel = {
		info: (m) => lines.push(['info', m]),
		warn: (m) => lines.push(['warn', m]),
		error: (m) => lines.push(['error', m])
	};
	const log = createLogger(channel);

	log.info('Nur Text');
	log.warn('Mit Detail', { a: 1 });
	const err = new Error('Kaputt');
	err.name = 'FirebaseAiError';
	err.status = 429;
	err.hint = 'Später erneut versuchen';
	log.error('API-Fehler', err);

	assert.deepStrictEqual(lines[0], ['info', 'Nur Text']);
	assert.strictEqual(lines[1][1], 'Mit Detail {"a":1}');
	assert.ok(lines[2][1].includes('[FirebaseAiError]'), lines[2][1]);
	assert.ok(lines[2][1].includes('(HTTP 429)'));
	assert.ok(lines[2][1].includes('Hinweis: Später erneut versuchen'));

	// Fehlerhafte Channels dürfen nie durchschlagen.
	const broken = createLogger({ info() { throw new Error('boom'); }, warn() { }, error() { } });
	broken.info('darf nicht werfen');

	// Zirkuläre Details dürfen nicht crashen.
	const circular = {};
	circular.self = circular;
	assert.strictEqual(typeof formatDetail(circular), 'string');

	// No-op-Logger hat dieselbe Oberfläche.
	NOOP_LOGGER.info('x');
	NOOP_LOGGER.warn('x');
	NOOP_LOGGER.error('x');

	console.log('✔ Logger: Formatierung, Fehler-Details, Robustheit');
}

async function testInlineEdit() {
	// Prompt-Aufbau: alle Bausteine landen im Request.
	const req = buildInlineEditRequest({
		instruction: 'Auf async/await umstellen',
		languageId: 'javascript',
		relPath: 'src/app.js',
		before: 'const a = 1;',
		selection: 'fetch(url).then(r => r.json());',
		after: 'console.log(a);'
	});
	const sys = req.systemInstruction.parts[0].text;
	const user = req.contents[0].parts[0].text;
	assert.ok(sys.includes('ONLY the replacement code'), 'System-Prompt muss Nur-Code fordern');
	assert.ok(user.includes('src/app.js') && user.includes('javascript'));
	assert.ok(user.includes('--- REGION to rewrite ---') && user.includes('fetch(url)'));
	assert.ok(user.includes('Auf async/await umstellen'));
	assert.ok(req.generationConfig.maxOutputTokens >= 4096);

	// Leere Kontexte werden benannt statt leer gelassen.
	const req2 = buildInlineEditRequest({ instruction: 'x', languageId: 'js', relPath: 'a.js', before: '', selection: 's', after: '' });
	const user2 = req2.contents[0].parts[0].text;
	assert.ok(user2.includes('(start of file)') && user2.includes('(end of file)'));

	// Apply-Request: Datei + Snippet enthalten.
	const apply = buildApplyRequest({ code: 'const x = 2;', fileContent: 'const y = 1;\n', relPath: 'b.js', languageId: 'javascript' });
	const applyUser = apply.contents[0].parts[0].text;
	assert.ok(applyUser.includes('--- Snippet to integrate ---') && applyUser.includes('const x = 2;'));
	assert.ok(apply.systemInstruction.parts[0].text.includes('complete new file content'));
	assert.ok(APPLY_MAX_LINES >= 100);

	// extractCode: roher Code bleibt unangetastet (inkl. Einrückung der ersten Zeile).
	assert.strictEqual(extractCode('\tif (a) { b(); }'), '\tif (a) { b(); }');
	// Führende Leerzeilen + trailing Whitespace fallen weg.
	assert.strictEqual(extractCode('\n\n  code();\n\n'), '  code();');
	// Fence mit Sprache wird ausgepackt.
	assert.strictEqual(extractCode('```js\nconst a = 1;\n```'), 'const a = 1;');
	// Prosa um den Fence herum wird ignoriert.
	assert.strictEqual(extractCode('Hier die Lösung:\n```python\nx = 1\n```\nViel Erfolg!'), 'x = 1');
	// Erster Fence gewinnt bei mehreren.
	assert.strictEqual(extractCode('```\neins\n```\ndazwischen\n```\nzwei\n```'), 'eins');
	// Leere Antwort → leerer String.
	assert.strictEqual(extractCode(''), '');

	// Stream-Sanitizer: öffnende Fence fällt sofort weg, auch mit Sprach-Tag.
	assert.strictEqual(sanitizeStreamText('```js\nconst a'), 'const a');
	// Teilweise empfangene schließende Fence wird zurückgehalten.
	assert.strictEqual(sanitizeStreamText('const a = 1;\n``'), 'const a = 1;');
	assert.strictEqual(sanitizeStreamText('const a = 1;\n```'), 'const a = 1;');
	// Ohne Fences bleibt der Text (samt Einrückung) unangetastet.
	assert.strictEqual(sanitizeStreamText('\tif (a) {'), '\tif (a) {');
	// Führende Leerzeilen fallen weg, wachsender Text hinten bleibt.
	assert.strictEqual(sanitizeStreamText('\n\n  x = 1\n  y ='), '  x = 1\n  y =');

	console.log('✔ Inline-Edit: Prompt-Aufbau, Apply-Request, Fence-Parsing, Stream-Sanitizer');
}

async function testSseStreaming() {
	// Parser: beliebig zerteilte Chunks, CRLF, mehrere data-Zeilen, Flush am Ende.
	const events = [];
	const parser = createSseParser((d) => events.push(d));
	parser.push('data: {"a"');
	parser.push(':1}\r\n\r\nda');
	parser.push('ta: {"b":2}\n\ndata: X\ndata: Y');
	parser.end();
	assert.deepStrictEqual(events, ['{"a":1}', '{"b":2}', 'X\nY']);

	// Merge: Text konkateniert, finishReason aus dem letzten Chunk, functionCalls bleiben.
	const merged = mergeStreamResponses([
		{ candidates: [{ content: { parts: [{ text: 'Hal' }] } }] },
		{ candidates: [{ content: { parts: [{ text: 'lo' }, { functionCall: { name: 'f', args: {} } }] }, finishReason: 'STOP' }] }
	]);
	assert.strictEqual(merged.candidates[0].content.parts[0].text, 'Hallo');
	assert.strictEqual(merged.candidates[0].content.parts[1].functionCall.name, 'f');
	assert.strictEqual(merged.candidates[0].finishReason, 'STOP');

	// Voller Streaming-Aufruf gegen ein gemocktes fetch (SSE-Body als async iterable).
	const sse = [
		'data: {"candidates":[{"content":{"parts":[{"text":"const a"}]}}]}\r\n\r\n',
		'data: {"candidates":[{"content":{"parts":[{"text":" = 1;"}]},"finishReason":"STOP"}]}\r\n\r\n'
	];
	const client = new FirebaseAiLogicClient({
		apiKey: 'k', projectId: 'p', model: 'gemini-2.5-flash',
		fetchImpl: async () => ({
			ok: true,
			body: (async function* () {
				for (const part of sse) { yield Buffer.from(part, 'utf8'); }
			})()
		})
	});
	const pieces = [];
	const response = await client.generateContentStream({ contents: [] }, undefined, (t) => pieces.push(t));
	assert.deepStrictEqual(pieces, ['const a', ' = 1;']);
	assert.strictEqual(merged.candidates[0].finishReason, 'STOP');
	assert.strictEqual(response.candidates[0].content.parts[0].text, 'const a = 1;');

	console.log('✔ SSE-Streaming: Parser (zerteilte Chunks), Chunk-Merge, generateContentStream');
}

async function testLineDiff() {
	// Identisch → keine Hunks.
	assert.deepStrictEqual(computeLineHunks('a\nb', 'a\nb'), []);
	// CRLF vs LF ist zeilenweise identisch.
	assert.deepStrictEqual(computeLineHunks('a\r\nb', 'a\nb'), []);

	// Eine geänderte Zeile in der Mitte.
	const change = computeLineHunks('a\nb\nc', 'a\nX\nc');
	assert.deepStrictEqual(change, [{ newStart: 1, newCount: 1, oldLines: ['b'] }]);

	// Reine Einfügung.
	const insert = computeLineHunks('a\nc', 'a\nb\nc');
	assert.deepStrictEqual(insert, [{ newStart: 1, newCount: 1, oldLines: [] }]);

	// Reine Löschung (Einfügepunkt vor Zeile 1 des neuen Texts).
	const del = computeLineHunks('a\nb\nc', 'a\nc');
	assert.deepStrictEqual(del, [{ newStart: 1, newCount: 0, oldLines: ['b'] }]);

	// Rekonstruktions-Invariante: Hunks von hinten nach vorn zurückrollen → alter Text.
	const cases = [
		['a\nb\nc\nd\ne', 'a\nX\nc\nY\nZ\ne'],
		['', 'neu'],
		['alt', ''],
		['f1\nf2\nf3', 'g1\ng2'],
		['gleich\nbleibt\ngleich', 'gleich\nbleibt\ngleich\nplus'],
		['x\ny\nz', 'z\ny\nx']
	];
	for (const [oldText, newText] of cases) {
		const hunks = computeLineHunks(oldText, newText);
		const lines = splitLines(newText);
		for (const h of hunks.slice().reverse()) { revertHunkInLines(lines, h); }
		assert.strictEqual(lines.join('\n'), oldText, `Rekonstruktion fehlgeschlagen für ${JSON.stringify([oldText, newText])}`);
	}

	// Hunk-Positionen zeigen in den neuen Text.
	const multi = computeLineHunks('k1\nk2\nk3\nk4', 'k1\nA\nB\nk3\nC');
	for (const h of multi) {
		assert.ok(h.newStart >= 0 && h.newStart <= 5);
	}

	console.log('✔ Zeilen-Diff: Hunks (Änderung/Einfügung/Löschung), Rekonstruktions-Invariante');
}

async function testTerminalHelpers() {
	// ANSI: Farben, Cursor-Sequenzen, OSC (Shell-Integration-Marker), CR-Übermalung.
	assert.strictEqual(stripAnsi('\x1b[32mgrün\x1b[0m'), 'grün');
	assert.strictEqual(stripAnsi('\x1b]633;A\x07ausgabe\x1b]633;B\x07'), 'ausgabe');
	assert.strictEqual(stripAnsi('a\x1b[2Kb'), 'ab');
	assert.strictEqual(stripAnsi('fortschritt 10%\rfertig      \n'), 'fertig      \n');
	assert.strictEqual(stripAnsi('zeile\r\n'), 'zeile\n');

	// Freigabe-Normalisierung: Boolean-Altpfad, Objekt, editiertes Kommando nur bei Annahme.
	assert.deepStrictEqual(normalizeCommandApproval(true, 'npm test'), { approved: true, command: 'npm test' });
	assert.deepStrictEqual(normalizeCommandApproval(false, 'npm test'), { approved: false, command: 'npm test' });
	assert.deepStrictEqual(
		normalizeCommandApproval({ approved: true, command: ' npm test -- --grep x ' }, 'npm test'),
		{ approved: true, command: 'npm test -- --grep x' }
	);
	assert.deepStrictEqual(
		normalizeCommandApproval({ accept: false, command: 'rm -rf /' }, 'npm test'),
		{ approved: false, command: 'npm test' }
	);
	assert.deepStrictEqual(normalizeCommandApproval({ approved: true, command: '' }, 'npm test'),
		{ approved: true, command: 'npm test' });

	console.log('✔ Terminal-Helfer: ANSI-Strip, Freigabe-Normalisierung (editierbare Kommandos)');
}

async function main() {
	await testToolBasics();
	await testReplaceUniqueness();
	await testFullAgentLoop();
	await testRejectionFlow();
	await testMaxIterationsGuard();
	await testModelCatalog();
	await testFirebaseAuth();
	await testAuthManager();
	await testActivityIndex();
	await testLogger();
	await testInlineEdit();
	await testSseStreaming();
	await testLineDiff();
	await testTerminalHelpers();
	console.log('\nAlle Tests bestanden.');
}

main().catch((err) => {
	console.error('✘ Test fehlgeschlagen:', err);
	process.exit(1);
});
