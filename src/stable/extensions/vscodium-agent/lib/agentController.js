/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – Agent-Loop (Plan → Tools → Iteration) mit Drift-Schutz.
 *
 * Unabhängig von VS Code: braucht nur client (ProxyClient-kompatibel: generateContent),
 * host (siehe tools.js) und ui (Ereignis-Senke).
 *
 *   ui = {
 *     assistantText(text),
 *     toolStart(id, name, args) , toolEnd(id, name, resultSummary, ok),
 *     info(text), error(text)
 *   }
 *--------------------------------------------------------------------------------------------*/

'use strict';

const { TOOL_DECLARATIONS, executeTool } = require('./tools');
const { buildDriftReminder } = require('./prompts');
const { extractParts, extractBlockReason } = require('./firebaseClient');

const DRIFT_REMINDER_EVERY = 8;

class AgentRun {
	/**
	 * @param {{
	 *   client: { generateContent(req, signal): Promise<object> },
	 *   host: object,
	 *   ui: object,
	 *   systemPrompt: string,
	 *   maxIterations?: number,
	 *   signal?: AbortSignal,
	 *   history?: Array<object>,
	 *   toolDeclarations?: Array<object>,
	 *   invokeTool?: (name: string, args: object) => Promise<object>
	 * }} opts
	 */
	constructor(opts) {
		this.client = opts.client;
		this.host = opts.host;
		this.ui = opts.ui;
		this.systemPrompt = opts.systemPrompt;
		this.maxIterations = opts.maxIterations || 24;
		this.signal = opts.signal;
		/** Teilmenge der Tools für diesen Lauf (Default: alle). */
		this.toolDeclarations = Array.isArray(opts.toolDeclarations) ? opts.toolDeclarations : TOOL_DECLARATIONS;
		/** Austauschbare Tool-Ausführung (nativer Chat routet über vscode.lm.invokeTool). */
		this.invokeTool = typeof opts.invokeTool === 'function'
			? opts.invokeTool
			: (name, args) => executeTool(this.host, name, args);
		/** Pause vor dem einmaligen Wiederholversuch bei Netzfehlern (Tests: 0). */
		this.retryDelayMs = typeof opts.retryDelayMs === 'number' ? opts.retryDelayMs : 1200;
		/** Gemini-"contents"-Historie (über Aufgaben hinweg wiederverwendbar). */
		this.contents = Array.isArray(opts.history) ? opts.history : [];
		this.filesChanged = new Set();
		this.toolCounter = 0;
	}

	/**
	 * Führt eine Benutzeraufgabe aus.
	 * @param {string} userTask
	 * @returns {Promise<{status:'completed'|'stopped'|'max-iterations'|'error', summary?: string, success?: boolean}>}
	 */
	async run(userTask) {
		this.contents.push({ role: 'user', parts: [{ text: userTask }] });

		for (let iteration = 1; iteration <= this.maxIterations; iteration++) {
			if (this.signal && this.signal.aborted) {
				return { status: 'stopped' };
			}

			let response;
			// Ein einzelner Netz-Schluckauf (z. B. "fetch failed" mitten im Lauf) soll den
			// Lauf nicht beenden: Fehler OHNE HTTP-Status gelten als transient und werden
			// genau EINMAL wiederholt. Server-Antworten (Status gesetzt, z. B. Quota-429)
			// werden bewusst nicht wiederholt – das regeln Client und Proxy.
			for (let attempt = 1; ; attempt++) {
				try {
					const request = {
						systemInstruction: { role: 'system', parts: [{ text: this.systemPrompt }] },
						contents: this.contents,
						generationConfig: { temperature: 0.2 }
					};
					// Ohne Deklarationen (z. B. Chat ohne Workspace-Ordner) KEIN tools-Feld:
					// leere functionDeclarations quittieren manche Backends mit 400.
					if (this.toolDeclarations.length > 0) {
						request.tools = [{ functionDeclarations: this.toolDeclarations }];
						request.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
					}
					response = await this.client.generateContent(request, this.signal);
					break;
				} catch (err) {
					if (err && err.name === 'AbortError') {
						return { status: 'stopped' };
					}
					const transient = !(err && err.status) && attempt === 1;
					if (!transient) {
						const hint = err && err.hint ? `\n${err.hint}` : '';
						this.ui.error(`${err.message}${hint}`);
						return { status: 'error', summary: err.message };
					}
					this.ui.info('Verbindungsproblem – ich versuche es gleich noch einmal …');
					await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
					if (this.signal && this.signal.aborted) {
						return { status: 'stopped' };
					}
				}
			}

			const blockReason = extractBlockReason(response);
			const parts = extractParts(response);
			if (parts.length === 0) {
				this.ui.error(blockReason || 'Leere Antwort vom Modell.');
				return { status: 'error', summary: blockReason || 'Leere Antwort' };
			}

			// Modell-Antwort unverändert in die Historie (inkl. thoughtSignatures bei functionCalls).
			this.contents.push({ role: 'model', parts });

			const textParts = parts.filter(p => typeof p.text === 'string' && p.text.trim().length > 0 && !p.thought);
			for (const p of textParts) {
				this.ui.assistantText(p.text);
			}

			const functionCalls = parts.filter(p => p.functionCall && p.functionCall.name);
			if (functionCalls.length === 0) {
				// Kein Tool-Aufruf → Modell hat konversationell geantwortet; Aufgabe gilt als beendet.
				return { status: 'completed', summary: textParts.map(p => p.text).join('\n') };
			}

			const responseParts = [];
			let completion = null;

			for (const part of functionCalls) {
				if (this.signal && this.signal.aborted) {
					return { status: 'stopped' };
				}
				const { name, args } = part.functionCall;
				const id = `tool-${++this.toolCounter}`;
				this.ui.toolStart(id, name, args || {});

				const result = await this.invokeTool(name, args || {});

				const ok = !result.error && result.status !== 'rejected' && !result.skipped;
				this.ui.toolEnd(id, name, summarizeResult(name, args || {}, result), ok);

				if ((name === 'write_file' || name === 'replace_in_file' || name === 'delete_file') && result.status === 'applied') {
					this.filesChanged.add(args && args.path ? args.path : '?');
				}
				responseParts.push({ functionResponse: { name, response: result } });

				if (name === 'task_complete') {
					completion = {
						summary: (args && args.summary) || '',
						success: !args || args.success !== false
					};
				}
			}

			// Tool-Ergebnisse als user-Content zurück (Format wie firebase-js-sdk ChatSession).
			this.contents.push({ role: 'user', parts: responseParts });

			if (completion) {
				return { status: 'completed', summary: completion.summary, success: completion.success };
			}

			if (iteration > 0 && iteration % DRIFT_REMINDER_EVERY === 0) {
				this.contents.push({ role: 'user', parts: [{ text: buildDriftReminder(userTask, iteration) }] });
			}
		}

		this.ui.info(`Maximale Schrittzahl (${this.maxIterations}) erreicht – Lauf beendet. Einstellung vscodiumAgent.maxIterations erhöhen oder Aufgabe kleiner schneiden.`);
		return { status: 'max-iterations' };
	}
}

/** Kompakte, menschenlesbare Zusammenfassung eines Tool-Ergebnisses für die UI. */
function summarizeResult(name, args, result) {
	if (result.error) { return `Fehler: ${truncate(result.error, 200)}`; }
	switch (name) {
		case 'list_files': return 'Projektbaum geliefert';
		case 'read_file': return `${args.path} gelesen (${result.totalLines} Zeilen, ${result.shownRange})`;
		case 'search_project': return `${result.matchCount} Treffer${result.truncated ? ' (gekürzt)' : ''}`;
		case 'write_file':
		case 'replace_in_file':
			return result.status === 'applied' ? `Änderung an ${args.path} übernommen` : `Änderung an ${args.path} abgelehnt`;
		case 'delete_file':
			return result.status === 'applied' ? `${args.path} gelöscht` : `Löschen von ${args.path} abgelehnt`;
		case 'run_command':
			if (result.skipped) { return 'Kommando übersprungen (abgelehnt)'; }
			return `Exit-Code ${result.exitCode} nach ${Math.round((result.durationMs || 0) / 100) / 10}s`;
		case 'get_diagnostics': return `${result.count} Diagnose-Einträge`;
		case 'task_complete': return 'Aufgabe abgeschlossen';
		default: return 'OK';
	}
}

function truncate(s, n) {
	s = String(s);
	return s.length > n ? s.slice(0, n) + '…' : s;
}

module.exports = { AgentRun, summarizeResult };
