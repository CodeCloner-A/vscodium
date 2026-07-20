/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – Kernlogik für den nativen Core-Chat (Roadmap Phase K).
 *
 * Headless testbar, bewusst ohne vscode-Import: Historie → Gemini-contents, Ask-Request,
 * Streaming in eine Text-Senke, Konvertierung der Language-Model-API-Nachrichten.
 * Die Editor-Glue (ChatParticipant, Modell-Provider) liegt in ui/nativeChatController.js.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const { extractText } = require('./firebaseClient');
const { TOOL_DECLARATIONS } = require('./tools');

/** Kontext-Deckel: alte Runden tragen selten bei, kosten aber Tokens. */
const MAX_HISTORY_TURNS = 24;
const MAX_TURN_CHARS = 16000;

/** Überlange Einzelbeiträge kappen (Historie, nicht die aktuelle Frage). */
function capText(text) {
	const t = String(text || '');
	return t.length > MAX_TURN_CHARS ? `${t.slice(0, MAX_TURN_CHARS)}\n[… gekürzt]` : t;
}

/**
 * Systemtext für den Ask-Modus des nativen Chats: erklären, nicht ändern.
 * (Edits/Kommandos liefert der Agent-Modus, der in einem späteren Phase-K-Schritt
 * auf die native Oberfläche umzieht.)
 * @param {{ rootName?: string, platform?: string, today?: string, activity?: string, fileTree?: string }} ctx
 */
function buildAskSystemText(ctx) {
	const dateLine = ctx.today
		? `Current date: ${ctx.today}. This is the real current date – never fall back to your training data.`
		: '';
	return [
		'You are the VSCodium Agent in "Ask" mode inside the native chat of the VSCodium IDE.',
		'You answer questions about the user\'s project and about programming: explain code, find causes, propose concrete fixes.',
		'In this mode you cannot edit files or run commands. When the user asks for changes, show the exact edits as fenced code blocks and note that the agentic mode (which applies changes with review) is available in the "Agent" view.',
		'',
		`Workspace root: "${ctx.rootName || '(no workspace)'}"${ctx.platform ? ` | OS: ${ctx.platform}` : ''}`,
		...(dateLine ? [dateLine] : []),
		'',
		'== Recent user activity ==',
		ctx.activity || '(no recorded user activity yet)',
		'',
		'== Project tree (truncated) ==',
		ctx.fileTree || '(empty workspace)',
		'',
		'Respond to the user in German unless asked otherwise. Be concise.'
	].join('\n');
}

/**
 * Vereinfachte Historie → Gemini-contents. Leere Beiträge fallen weg, alte Runden
 * und überlange Texte werden gekappt.
 * @param {Array<{role: 'user'|'assistant', text: string}>} turns
 */
function historyToContents(turns) {
	const out = [];
	for (const turn of Array.isArray(turns) ? turns : []) {
		const text = String((turn && turn.text) || '').trim();
		if (!text) { continue; }
		out.push({
			role: turn.role === 'assistant' ? 'model' : 'user',
			parts: [{ text: capText(text) }]
		});
	}
	return out.slice(-MAX_HISTORY_TURNS);
}

/**
 * Native Chat-Historie (ChatRequestTurn/ChatResponseTurn) → vereinfachte Runden.
 * Duck-Typing statt instanceof: Request-Turns tragen `prompt`, Response-Turns ein
 * `response`-Array aus Parts, deren Markdown-Inhalt unter `value.value` liegt.
 * @param {ReadonlyArray<any>} history
 * @returns {Array<{role: 'user'|'assistant', text: string}>}
 */
function simplifyHistory(history) {
	const out = [];
	for (const turn of Array.isArray(history) ? history : []) {
		if (!turn) { continue; }
		if (typeof turn.prompt === 'string') {
			out.push({ role: 'user', text: turn.prompt });
		} else if (Array.isArray(turn.response)) {
			const text = turn.response
				.map((part) => {
					const v = part && part.value;
					if (typeof v === 'string') { return v; }
					return v && typeof v.value === 'string' ? v.value : '';
				})
				.join('');
			if (text.trim()) { out.push({ role: 'assistant', text }); }
		}
	}
	return out;
}

/**
 * Nachrichten der Language-Model-API (LanguageModelChatRequestMessage) → Gemini-contents.
 * Rolle 2 = Assistant → 'model', alles andere → 'user'; Text-Parts tragen `value`.
 * @param {ReadonlyArray<{ role: number, content: ReadonlyArray<any> }>} messages
 */
function lmMessagesToContents(messages) {
	const out = [];
	for (const msg of Array.isArray(messages) ? messages : []) {
		if (!msg) { continue; }
		const text = (Array.isArray(msg.content) ? msg.content : [])
			.map((part) => (part && typeof part.value === 'string' ? part.value : ''))
			.join('');
		if (!text.trim()) { continue; }
		out.push({
			role: msg.role === 2 ? 'model' : 'user',
			parts: [{ text: capText(text) }]
		});
	}
	return out;
}

/**
 * Kompletter Ask-Request im Gemini-Format (Wire-Format bleibt auch für Claude gleich –
 * die Übersetzung übernimmt der Proxy).
 */
function buildAskRequest(ctx, history, prompt) {
	const contents = historyToContents(history);
	contents.push({ role: 'user', parts: [{ text: String(prompt || '').trim() || '(leer)' }] });
	return {
		systemInstruction: { role: 'user', parts: [{ text: buildAskSystemText(ctx) }] },
		contents
	};
}

/**
 * Antwort streamen: `onText` je Fragment; Rückgabe ist der vollständige Text.
 * Fällt auf `generateContent` zurück, wenn der Client kein Streaming anbietet
 * (z. B. Test-Mocks). Liefert die zusammengeführte Antwort mehr Text als die
 * Fragmente, wird der Rest nachgereicht – kein Fragment geht verloren.
 */
async function streamAskResponse(client, request, signal, onText) {
	const emit = typeof onText === 'function' ? onText : () => { };
	if (typeof client.generateContentStream === 'function') {
		let streamed = '';
		const merged = await client.generateContentStream(request, signal, (t) => {
			streamed += t;
			emit(t);
		});
		const full = safeExtractText(merged);
		if (full && full.length > streamed.length && full.startsWith(streamed)) {
			emit(full.slice(streamed.length));
		}
		return full || streamed;
	}
	const response = await client.generateContent(request, signal);
	const text = safeExtractText(response);
	if (text) { emit(text); }
	return text;
}

function safeExtractText(response) {
	try { return extractText(response) || ''; } catch (_e) { return ''; }
}

// ── Nativer Agent-/Edit-Modus (Phase K, Inkrement 2) ─────────────────────────

/**
 * Tools der Plan-Modi (Entscheid 17.07.2026): reines Lesen – erkunden, fragen,
 * planen. Kein Schreiben, kein Löschen, keine Kommandos. `task_complete` bleibt
 * als Kontrollfluss-Abschluss erhalten.
 */
const PLAN_MODE_TOOLS = new Set([
	'list_files', 'read_file', 'search_project',
	'get_diagnostics', 'get_recent_activity', 'task_complete'
]);

/** Marker in den .agent.md-Instructions, an dem der Handler unsere Modi erkennt. */
const MODE_MARKER_RE = /<!--\s*vscodium-agent:mode=([a-z][a-z0-9-]*)\s*-->/;

/**
 * Modus-Marker aus `request.modeInstructions` ziehen (Inhalt der .agent.md).
 *
 * Der Marker ist der API-risikofreie Erkennungskanal: Die UI-Mechanik für
 * Custom-Agent-Tool-Listen kann sich ändern – der Instructions-Text kommt aber
 * immer an, und die Tool-Beschränkung wird serverseitig hart erzwungen.
 *
 * @param {string|undefined} instructions
 * @returns {{ mode: string|null, instructions: string }} mode (z. B. 'plan',
 *   'plan-extended') oder null; instructions ohne Marker-Zeile (für generische
 *   Custom Agents, die kein Marker tragen: unverändert).
 */
function parseModeMarker(instructions) {
	const text = String(instructions || '');
	const match = text.match(MODE_MARKER_RE);
	if (!match) { return { mode: null, instructions: text.trim() }; }
	return { mode: match[1], instructions: text.replace(MODE_MARKER_RE, '').trim() };
}

/** Tools, die im nativen Modus über vscode.lm.invokeTool laufen (alle außer task_complete). */
const NATIVE_LM_TOOLS = TOOL_DECLARATIONS.map(d => d.name).filter(n => n !== 'task_complete');

/**
 * Deklarationen für einen nativen Chat-Request filtern.
 *
 * `enabledByName` kommt aus `request.tools` (nur im Agent-Modus gefüllt): Tools, die
 * der Nutzer im Picker abgewählt hat (false), fallen weg. `task_complete` bleibt
 * immer erhalten (Kontrollfluss des Loops, kein UI-Tool). Unbekannte Namen in
 * `enabledByName` (Tools fremder Extensions) sind irrelevant – gefiltert wird nur,
 * was wir selbst deklarieren.
 *
 * @param {'agent'|'plan'|'plan-extended'} mode
 * @param {Record<string, boolean>|undefined} enabledByName
 * @returns {Array<object>} Teilmenge von TOOL_DECLARATIONS
 */
function declarationsForMode(mode, enabledByName) {
	const planMode = mode === 'plan' || mode === 'plan-extended';
	return TOOL_DECLARATIONS.filter((decl) => {
		if (decl.name === 'task_complete') { return true; }
		if (planMode && !PLAN_MODE_TOOLS.has(decl.name)) { return false; }
		if (enabledByName && enabledByName[decl.name] === false) { return false; }
		return true;
	});
}

/**
 * `request.tools` (Map<LanguageModelToolInformation, boolean>) → { name: boolean }.
 * Duck-Typing statt instanceof, damit die Funktion headless testbar bleibt.
 */
function toolsMapToNames(toolsMap) {
	const out = {};
	if (toolsMap && typeof toolsMap.forEach === 'function') {
		toolsMap.forEach((enabled, info) => {
			const name = info && typeof info.name === 'string' ? info.name : null;
			if (name) { out[name] = Boolean(enabled); }
		});
	}
	return out;
}

/**
 * Freigabe-Metadaten für die native Tool-Card: Im Review-Modus verlangen die
 * eingreifenden Tools eine Bestätigung (Core rendert Weiter/Abbrechen in der
 * Chat-UI), im Auto-Modus läuft alles durch. Lese-Tools fragen nie.
 * @returns {{ title: string, message: string } | null}
 */
function toolConfirmation(name, args, approvalMode) {
	if (approvalMode !== 'review') { return null; }
	const a = args || {};
	switch (name) {
		case 'write_file':
			return { title: `Datei schreiben: ${a.path || '?'}`, message: a.summary || 'Der Agent möchte diese Datei anlegen oder überschreiben.' };
		case 'replace_in_file':
			return { title: `Datei ändern: ${a.path || '?'}`, message: a.summary || 'Der Agent möchte eine Textstelle in dieser Datei ersetzen.' };
		case 'delete_file':
			return { title: `Datei löschen: ${a.path || '?'}`, message: a.summary || 'Der Agent möchte diese Datei löschen.' };
		case 'run_command':
			return { title: 'Kommando ausführen', message: `\`${a.command || '?'}\`${a.purpose ? ` — ${a.purpose}` : ''}` };
		default:
			return null;
	}
}

/** Kurze Statusmeldung für die laufende Tool-Card („was passiert gerade?“). */
function toolInvocationMessage(name, args) {
	const a = args || {};
	switch (name) {
		case 'list_files': return 'Liest den Projektbaum';
		case 'read_file': return `Liest ${a.path || 'eine Datei'}`;
		case 'search_project': return `Sucht nach „${truncateForUi(a.query, 60)}“`;
		case 'write_file': return `Schreibt ${a.path || 'eine Datei'}`;
		case 'replace_in_file': return `Ändert ${a.path || 'eine Datei'}`;
		case 'delete_file': return `Löscht ${a.path || 'eine Datei'}`;
		case 'run_command': return `Führt aus: ${truncateForUi(a.command, 80)}`;
		case 'get_recent_activity': return 'Liest die letzte Editor-Aktivität';
		case 'get_diagnostics': return a.path ? `Prüft Diagnosen für ${a.path}` : 'Prüft Diagnosen';
		default: return `Führt ${name} aus`;
	}
}

function truncateForUi(value, max) {
	const s = String(value || '');
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Tool-Ergebnis (JSON-serialisierbar) → Text für LanguageModelToolResult. */
function toolResultToText(result) {
	try { return JSON.stringify(result === undefined ? {} : result); } catch (_e) { return JSON.stringify({ error: 'Ergebnis nicht serialisierbar.' }); }
}

/**
 * Text aus einem LanguageModelToolResult zurück in das Ergebnis-Objekt des Loops.
 * Fremdformate (kein JSON) werden als { output } weitergereicht statt zu werfen.
 */
function parseToolResultText(text) {
	const s = String(text == null ? '' : text);
	if (!s.trim()) { return {}; }
	try {
		const parsed = JSON.parse(s);
		return parsed && typeof parsed === 'object' ? parsed : { output: parsed };
	} catch (_e) {
		return { output: s };
	}
}

/** Text aus den content-Parts eines LanguageModelToolResult ziehen (Duck-Typing). */
function lmResultToText(lmResult) {
	const parts = lmResult && Array.isArray(lmResult.content) ? lmResult.content : [];
	return parts.map(p => (p && typeof p.value === 'string' ? p.value : '')).join('');
}

/**
 * Zusatzregeln für Läufe OHNE geöffneten Workspace-Ordner: Der Chat bleibt voll
 * gesprächsfähig (Fragen, Erklärungen, Code-Beispiele) – nur die Datei-/Kommando-
 * Werkzeuge fehlen. Einsteiger werden bei Bedarf zum Ordner-Öffnen geführt,
 * ohne Fachbegriffe wie „Workspace“ vorauszusetzen.
 */
const NO_WORKSPACE_NOTES = [
	'== No folder open ==',
	'No project folder is open in this window, so ALL file and command tools are unavailable for this conversation. Never call tools and never claim you created, changed or ran anything.',
	'You can still answer questions, explain concepts and show code as fenced code blocks – do that normally.',
	'Only when the user wants you to work on files or build something in their project: explain in one friendly beginner-proof sentence (do NOT assume they know terms like "workspace") that they first need a project folder. Below your answer the UI shows two buttons – "Neuen Projektordner anlegen" (creates and opens one for them) and "Vorhandenen Ordner öffnen…" – point them there; afterwards they simply re-send their request.'
].join('\n');

/**
 * Zusatzregeln für den Agent-Modus im nativen Chat: erklären, wie das
 * Multi-File-Review im Chat-Editing funktioniert (der volle System-Prompt
 * kommt aus prompts.buildSystemPrompt).
 */
function buildNativeModeNotes() {
	return [
		'== Native chat notes ==',
		'File edits you make appear as pending changes in the editor (multi-file review): the user accepts or rejects them per file after your run. Rejected changes are NOT on disk – never assume an earlier rejected edit exists.',
		'Do not print full file contents in chat after editing; the review view already shows the diff.'
	].join('\n');
}

module.exports = {
	MAX_HISTORY_TURNS,
	MAX_TURN_CHARS,
	buildAskSystemText,
	historyToContents,
	simplifyHistory,
	lmMessagesToContents,
	buildAskRequest,
	streamAskResponse,
	PLAN_MODE_TOOLS,
	NATIVE_LM_TOOLS,
	parseModeMarker,
	declarationsForMode,
	toolsMapToNames,
	toolConfirmation,
	toolInvocationMessage,
	toolResultToText,
	parseToolResultText,
	lmResultToText,
	buildNativeModeNotes,
	NO_WORKSPACE_NOTES
};
