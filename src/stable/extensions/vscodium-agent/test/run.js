/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – Headless-Test ohne VS Code.
 * Testet: Tool-Ausführung, Agent-Loop (Function Calling), Review-Gating (Annahme + Ablehnung),
 * replace_in_file-Eindeutigkeit, Kommando-Ergebnisfluss, task_complete, Historienformat.
 *
 * Ausführen:  node test/run.js
 *--------------------------------------------------------------------------------------------*/

'use strict';

const assert = require('assert');
const { AgentRun } = require('../lib/agentController');
const { executeTool, countOccurrences } = require('../lib/tools');
const { buildSystemPrompt } = require('../lib/prompts');
const { normalizeModelName } = require('../lib/firebaseClient');

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
		edits: [true],     // Fix wird angenommen
		commands: [true, true]  // Testlauf erlaubt (vor + nach Fix)
	});

	const client = scriptedClient([
		// Turn 1: Plan + Datei lesen
		[{ text: 'Plan: Bug in add() finden, fixen, Tests laufen lassen.' }, fc('read_file', { path: 'src/rechner.js' })],
		// Turn 2: Tests laufen lassen (rot erwartet)
		[fc('run_command', { command: 'npm test', purpose: 'Fehler reproduzieren' })],
		// Turn 3: gezielter Fix
		[fc('replace_in_file', {
			path: 'src/rechner.js',
			old_text: 'return a - b; // BUG',
			new_text: 'return a + b;',
			summary: 'Subtraktion durch Addition ersetzt'
		})],
		// Turn 4: Tests erneut (grün erwartet)
		[fc('run_command', { command: 'npm test', purpose: 'Fix verifizieren' })],
		// Turn 5: Abschluss
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

	// Historienformat: model-functionCalls unverändert, functionResponse als user-Content
	const last = client.requests[client.requests.length - 1];
	const roles = last.contents.map(c => c.role);
	assert.strictEqual(roles[0], 'user');
	assert.ok(roles.includes('model'));
	const fnResponses = last.contents.filter(c => c.role === 'user' && c.parts.some(p => p.functionResponse));
	assert.ok(fnResponses.length >= 4, 'functionResponses müssen als user-Content zurückgehen');
	assert.ok(last.systemInstruction.parts[0].text.includes('VSCodium Agent'));
	assert.ok(last.tools[0].functionDeclarations.length >= 8, 'Tool-Deklarationen müssen mitgesendet werden');

	// Der zweite Testlauf muss grün gewesen sein (Exit-Code 0 in der functionResponse)
	const lastCmdResponse = fnResponses[fnResponses.length - 1].parts[0].functionResponse.response;
	assert.strictEqual(lastCmdResponse.exitCode, 0, 'Tests nach Fix grün');

	console.log('✔ Agent-Loop: Bug-Fix-Workflow (lesen → testen → fixen → testen → fertig)');
}

async function testRejectionFlow() {
	const host = createMockHost(
		{ 'a.txt': 'hallo welt\n' },
		{ edits: [false], commands: [] }  // Benutzer lehnt ab
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

	// Das Modell muss die Ablehnung in der functionResponse sehen
	const secondRequest = client.requests[1];
	const fr = secondRequest.contents[secondRequest.contents.length - 1].parts[0].functionResponse.response;
	assert.strictEqual(fr.status, 'rejected');
	console.log('✔ Review-Modus: Ablehnung stoppt die Änderung und ist für das Modell sichtbar');
}

async function testReplaceUniqueness() {
	const host = createMockHost({ 'x.js': 'let a = 1;\nlet a2 = 1;\n' }, { edits: [true], commands: [] });
	// "= 1;" kommt zweimal vor → Tool muss Fehler liefern, nicht raten
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
	// Modell ruft endlos list_files auf → Loop muss bei maxIterations abbrechen
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

async function main() {
	await testToolBasics();
	await testReplaceUniqueness();
	await testFullAgentLoop();
	await testRejectionFlow();
	await testMaxIterationsGuard();
	console.log('\nAlle Tests bestanden.');
}

main().catch((err) => {
	console.error('✘ Test fehlgeschlagen:', err);
	process.exit(1);
});