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
	'get_diagnostics', 'get_recent_activity',
	// Erkenntnisse aus dem Gespräch dürfen ins Projekt-Gedächtnis – mit Freigabe.
	// Das ist keine Projekt-Änderung, sondern die Notiz, die den Plan überlebt.
	'remember', 'task_complete'
]);

/**
 * Texte des Anmelde-Dialogs (erscheint, sobald jemand ohne Anmeldung in den Chat
 * schreibt). Hier zentral, damit Wortlaut und Knopfbeschriftungen testbar bleiben.
 */
const SIGN_IN_PROMPT = {
	message: 'Für PHI47 brauchst du eine Anmeldung',
	detail: 'Melde dich einmal mit Google an – danach antwortet der Agent und du kannst zwischen allen Modellen wählen. Deine Frage schicke ich anschließend automatisch ab.',
	signIn: 'Mit Google anmelden',
	skip: 'Überspringen'
};

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
		case 'remember':
			return { title: 'Ins Projekt-Gedächtnis aufnehmen', message: a.fact || 'Der Agent möchte sich etwas dauerhaft merken.' };
		default:
			return null;
	}
}

// ── Modellkarte (Picker-Detail und Tooltip) ─────────────────────────────────

/** Kontextgröße menschenlesbar: 128000 → „128k“, 1000000 → „1 Mio.“. */
function formatContext(tokens) {
	const v = Number.isFinite(tokens) ? tokens : 0;
	if (v <= 0) { return ''; }
	if (v >= 1000000) { return `${(v / 1000000).toFixed(v % 1000000 === 0 ? 0 : 1).replace('.', ',')} Mio.`; }
	return `${Math.round(v / 1000)}k`;
}

/**
 * Kurzinfo rechts im Picker: Region · Kontext · Bilder · Preisklasse.
 * Bewusst knapp – die Karte (Tooltip + Max context) liefert die Details.
 */
function modelDetail(m) {
	const parts = [];
	if (m && m.region) { parts.push(m.region); }
	const ctx = formatContext(m && m.maxInputTokens);
	if (ctx) { parts.push(`${ctx} Kontext`); }
	if (m && m.vision) { parts.push('Bilder'); }
	if (m && m.priceTier) { parts.push(m.priceTier); }
	return parts.join(' · ') || undefined;
}

/** Mehrzeiliger Tooltip der Modellkarte. */
function modelTooltip(m) {
	const lines = ['PHI47-Dienst'];
	if (m && m.region) { lines.push(`Region: ${m.region}`); }
	const input = formatContext(m && m.maxInputTokens);
	const output = formatContext(m && m.maxOutputTokens);
	if (input) { lines.push(`Kontext: ${input} Tokens${output ? ` · Ausgabe bis ${output}` : ''}`); }
	lines.push(m && m.vision ? 'Versteht Bilder (Screenshots, Mockups)' : 'Nur Text');
	if (m && m.priceTier) { lines.push(`Preisklasse: ${m.priceTier} (Verbrauch zählt entsprechend aufs Kontingent)`); }
	return lines.join('\n');
}

// ── Token-Anzeige (Verbrauch pro Lauf und Sitzung) ──────────────────────────

/** Tokenzahl kompakt: 940, 12,4k, 1,2 Mio. */
function formatTokens(n) {
	const v = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
	if (v < 1000) { return String(v); }
	if (v < 1000000) { return `${(v / 1000).toFixed(v < 10000 ? 1 : 0).replace('.', ',')}k`; }
	return `${(v / 1000000).toFixed(1).replace('.', ',')} Mio.`;
}

/** Zwei Verbrauchs-Zähler addieren (Sitzungssumme über mehrere Läufe). */
function addUsage(a, b) {
	const pick = (o, k) => (o && Number.isFinite(o[k]) ? o[k] : 0);
	return {
		prompt: pick(a, 'prompt') + pick(b, 'prompt'),
		output: pick(a, 'output') + pick(b, 'output'),
		cached: pick(a, 'cached') + pick(b, 'cached'),
		total: pick(a, 'total') + pick(b, 'total'),
		steps: pick(a, 'steps') + pick(b, 'steps')
	};
}

/**
 * Verbrauchszeile fürs Ende einer Antwort. Zeigt den Lauf und – sobald es mehr als
 * einen gab – die Summe der Sitzung; gecachte Eingaben werden ausgewiesen, weil sie
 * nur einen Bruchteil kosten.
 * @returns {string} Markdown-Zeile oder '' (nichts anzeigen)
 */
function buildUsageLine(run, session) {
	if (!run || !Number.isFinite(run.total) || run.total <= 0) { return ''; }
	const parts = [`Anfrage ${formatTokens(run.prompt)} · Antwort ${formatTokens(run.output)}`];
	if (run.cached > 0) { parts.push(`davon ${formatTokens(run.cached)} aus dem Cache`); }
	let line = `_Tokens · Lauf ${formatTokens(run.total)} (${parts.join(' · ')})`;
	if (session && session.total > run.total) {
		line += ` · Sitzung gesamt ${formatTokens(session.total)}`;
		if (session.cached > 0) { line += ` (${formatTokens(session.cached)} gecacht)`; }
	}
	return `${line}_`;
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
		case 'remember': return 'Merkt sich etwas fürs Projekt';
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

/** Vom Wire-Format unterstützte Bildtypen (alles andere wird nicht angehängt). */
const SUPPORTED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Deckel für angehängte Bilder – Base64 bläht den Request stark auf. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/**
 * Bild-Anhänge einer Chat-Anfrage → Gemini-Parts (`inlineData`).
 * Erwartet bereits eingelesene Anhänge ({ mimeType, data: Buffer|Uint8Array }); die
 * Editor-Seite holt sie aus `request.references` (siehe ui/nativeChatController.js).
 * Zu große oder fremde Formate werden übersprungen statt den Lauf zu sprengen.
 * @returns {{ parts: Array<object>, skipped: number }}
 */
function imageAttachmentParts(attachments) {
	const parts = [];
	let skipped = 0;
	for (const item of Array.isArray(attachments) ? attachments : []) {
		const mime = item && String(item.mimeType || '').toLowerCase();
		const bytes = item && item.data;
		if (!mime || !SUPPORTED_IMAGE_MIME.has(mime) || !bytes || !bytes.length) { skipped++; continue; }
		if (bytes.length > MAX_IMAGE_BYTES) { skipped++; continue; }
		const base64 = Buffer.isBuffer(bytes)
			? bytes.toString('base64')
			: Buffer.from(bytes).toString('base64');
		parts.push({ inlineData: { mimeType: mime, data: base64 } });
	}
	return { parts, skipped };
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
	SIGN_IN_PROMPT,
	formatTokens,
	addUsage,
	buildUsageLine,
	SUPPORTED_IMAGE_MIME,
	MAX_IMAGE_BYTES,
	imageAttachmentParts,
	formatContext,
	modelDetail,
	modelTooltip,
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
