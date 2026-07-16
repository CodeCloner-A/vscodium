/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – die 10 Agent-Tools als native LanguageModelTools (Roadmap Phase K).
 *
 * Aufbau:
 *   - registerNativeTools(): registriert alle Tools außer task_complete über
 *     vscode.lm.registerTool (stabile API). Freigaben laufen über
 *     prepareInvocation.confirmationMessages – der Core rendert Weiter/Abbrechen
 *     direkt in der Chat-UI; im Auto-Modus entfällt die Rückfrage.
 *   - runContexts: verbindet eine Tool-Invocation mit ihrem Agent-Lauf. Der
 *     Participant-Handler meldet Host+Stream unter dem toolInvocationToken an;
 *     die Tool-Implementierung findet beides darüber wieder. Schlüssel ist die
 *     sessionResource aus dem Token (Laufzeitform, siehe docs/phase-k-verdrahtung.md);
 *     fehlt sie, greift ein Fallback auf den zuletzt gestarteten Lauf.
 *   - NativeRunHost: WorkspaceHost-Variante für native Läufe. Datei-Edits gehen
 *     NICHT auf die Platte, sondern als textEdit-/workspaceEdit-Parts in den
 *     ChatResponseStream – das native Chat-Editing übernimmt Anwendung und
 *     Multi-File-Review (Annehmen/Verwerfen pro Datei). Kommandos laufen über den
 *     geerbten Pfad (Terminal/Captured), die Freigabe kam bereits vom Core.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const vscode = require('vscode');
const { WorkspaceHost } = require('../lib/workspaceHost');
const { executeTool } = require('../lib/tools');
const {
	NATIVE_LM_TOOLS,
	toolConfirmation,
	toolInvocationMessage,
	toolResultToText
} = require('../lib/nativeChat');

// ── Run-Kontext-Registry ─────────────────────────────────────────────────────

/**
 * Schlüssel aus dem (offiziell opaken) ChatParticipantToolToken ableiten.
 * Laufzeitform in 1.121: { sessionResource, workingDirectory } – der Main-Thread
 * hydriert das Token neu, Objekt-Identität trägt also NICHT (deshalb kein WeakMap).
 * Ändert Upstream die Form, liefert die Funktion null und der Fallback greift.
 */
function tokenKey(token) {
	if (token && token.sessionResource != null) {
		try { return `sr:${String(token.sessionResource)}`; } catch (_e) { return null; }
	}
	return null;
}

const runContexts = {
	/** @type {Map<string, object>} */
	_byKey: new Map(),
	/** @type {object|null} Fallback: zuletzt angemeldeter Lauf. */
	_last: null,

	/**
	 * Lauf anmelden. Rückgabe: Abmelde-Funktion (im finally des Handlers aufrufen).
	 * @param {any} token   request.toolInvocationToken
	 * @param {{ host: object, signal?: AbortSignal }} ctx
	 */
	enter(token, ctx) {
		const key = tokenKey(token);
		if (key) { this._byKey.set(key, ctx); }
		this._last = ctx;
		return () => {
			if (key && this._byKey.get(key) === ctx) { this._byKey.delete(key); }
			if (this._last === ctx) { this._last = null; }
		};
	},

	/** Kontext zu einer Tool-Invocation finden (Token-Schlüssel, sonst letzter Lauf). */
	lookup(token) {
		const key = tokenKey(token);
		if (key && this._byKey.has(key)) { return this._byKey.get(key); }
		return this._last;
	}
};

// ── Nativer Host: Edits in den Stream statt auf die Platte ──────────────────

class NativeRunHost extends WorkspaceHost {
	/**
	 * @param {import('vscode').ChatResponseStream} stream
	 * @param {{ approvalMode: string, terminalMode: string, commandTimeoutSec: number, maxTreeEntries: number, logger?: object }} options
	 */
	constructor(stream, options) {
		// Freigaben erteilt der Core über die Tool-Confirmation – hier immer durchwinken.
		super({
			requestEditApproval: async () => true,
			requestCommandApproval: async () => true
		}, options);
		this.stream = stream;
		/** @type {Set<string>} relative Pfade mit gestreamten Edits (für die Abschlussmeldung). */
		this.streamedEdits = new Set();
	}

	/**
	 * Lesen bevorzugt aus offenen Dokumenten: Das native Chat-Editing wendet Edits
	 * auf den Text-Puffer an; die Platte kann dahinter zurückliegen. So sieht der
	 * Agent seine eigenen (und ungespeicherte Nutzer-)Änderungen.
	 */
	async readFile(relPath) {
		const uri = this.resolve(relPath);
		const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
		if (open) { return open.getText(); }
		return super.readFile(relPath);
	}

	/** Existiert die Datei – auf der Platte oder als (noch ungespeichertes) Dokument? */
	async fileExists(relPath) {
		if (await super.fileExists(relPath)) { return true; }
		const uri = this.resolve(relPath);
		return vscode.workspace.textDocuments.some(d => d.uri.toString() === uri.toString());
	}

	/**
	 * Änderungen als Chat-Editing-Parts streamen. Bewusst EIN Whole-Document-Edit
	 * statt Hunk-TextEdits: Das Review-Diff berechnet der Core ohnehin selbst aus
	 * Vorher/Nachher; feinere Edits wären reine Streaming-Kosmetik, aber eine
	 * EOL-/Offset-Fehlerquelle.
	 */
	async applyChange(change) {
		const uri = this.resolve(change.path);
		const rel = this.relFromUri(uri);

		if (change.kind === 'delete') {
			if (!await this.fileExists(change.path)) {
				return { status: 'rejected', message: 'Datei existiert nicht.' };
			}
			// ChatWorkspaceFileEdit-Form: oldResource ohne newResource = Löschung
			// (chatEditingSession.applyWorkspaceEdit → startDeletion; KEIN vscode.WorkspaceEdit).
			this.stream.workspaceEdit([{ oldResource: uri }]);
			this.streamedEdits.add(rel);
			this.log.info(`Nativer Lauf: Löschung von ${rel} ins Review gestreamt.`);
			return { status: 'applied' };
		}

		if (change.kind !== 'write') {
			return { status: 'rejected', message: `Unbekannte Änderungsart: ${change.kind}` };
		}

		const newContent = String(change.newContent ?? '');
		let edit;
		if (await this.fileExists(change.path)) {
			// Volle Dokument-Range über das (ggf. bereits editierte) Dokument bestimmen.
			const doc = await vscode.workspace.openTextDocument(uri);
			const fullRange = doc.validateRange(new vscode.Range(0, 0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER));
			if (doc.getText() === newContent) {
				return { status: 'applied', message: 'Inhalt unverändert – kein Edit nötig.' };
			}
			edit = new vscode.TextEdit(fullRange, newContent);
		} else {
			edit = vscode.TextEdit.insert(new vscode.Position(0, 0), newContent);
		}
		this.stream.textEdit(uri, [edit]);
		this.stream.textEdit(uri, true);
		this.streamedEdits.add(rel);
		this.log.info(`Nativer Lauf: Edit an ${rel} ins Review gestreamt (${newContent.length} Zeichen).`);
		return { status: 'applied' };
	}
}

// ── Tool-Registrierung ───────────────────────────────────────────────────────

/**
 * Alle nativen Tools registrieren. Feature-Detection wie beim Participant:
 * auf Basen ohne lm.registerTool (oder ohne unsere languageModelTools-Contribution)
 * scheitert die Registrierung kontrolliert – der native Agent-Modus meldet dann
 * beim Request einen verständlichen Fehler, Webview und Ask-Modus bleiben intakt.
 *
 * @param {import('vscode').ExtensionContext} context
 * @param {{ approvalMode: () => string, logger: { info: Function, warn: Function } }} deps
 * @returns {number} Anzahl erfolgreich registrierter Tools
 */
function registerNativeTools(context, deps) {
	if (!vscode.lm || typeof vscode.lm.registerTool !== 'function') {
		deps.logger.info('Native Tools: lm.registerTool nicht verfügbar – Agent-/Edit-Modus bleibt ohne native Tools.');
		return 0;
	}
	let registered = 0;
	for (const name of NATIVE_LM_TOOLS) {
		try {
			const disposable = vscode.lm.registerTool(name, {
				prepareInvocation(options, _token) {
					const input = (options && options.input) || {};
					const prepared = { invocationMessage: toolInvocationMessage(name, input) };
					const confirmation = toolConfirmation(name, input, deps.approvalMode());
					if (confirmation) {
						prepared.confirmationMessages = {
							title: confirmation.title,
							message: new vscode.MarkdownString(confirmation.message)
						};
					}
					return prepared;
				},
				async invoke(options, _token) {
					const ctx = runContexts.lookup(options && options.toolInvocationToken);
					let result;
					if (!ctx || !ctx.host) {
						result = { error: 'Kein aktiver Agent-Lauf – dieses Tool arbeitet nur innerhalb einer Agent-/Edit-Anfrage des VSCodium Agent.' };
					} else {
						result = await executeTool(ctx.host, name, (options && options.input) || {});
					}
					return new vscode.LanguageModelToolResult([
						new vscode.LanguageModelTextPart(toolResultToText(result))
					]);
				}
			});
			context.subscriptions.push(disposable);
			registered++;
		} catch (err) {
			deps.logger.warn(`Native Tools: Registrierung von "${name}" nicht möglich.`, err);
		}
	}
	if (registered > 0) {
		deps.logger.info(`Native Tools: ${registered}/${NATIVE_LM_TOOLS.length} Tools registriert.`);
	}
	return registered;
}

module.exports = { registerNativeTools, runContexts, NativeRunHost, tokenKey };
