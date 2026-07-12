/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – Extension-Einstiegspunkt.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const vscode = require('vscode');
const { ChatViewProvider, SECRET_KEY } = require('./ui/chatViewProvider');
const { InlineEditController } = require('./ui/inlineEditController');
const { AgentCodeActionProvider } = require('./ui/codeActions');
const { DIFF_SCHEME, EXCLUDED_DIRS } = require('./lib/workspaceHost');
const { ActivityIndex } = require('./lib/activityIndex');
const { createLogger } = require('./lib/logger');

const ACTIVITY_STATE_KEY = 'vscodiumAgent.activity.v1';

/** @param {vscode.ExtensionContext} context */
function activate(context) {
	// Lokales Logging (Output-Panel „VSCodium Agent“); es verlassen keine Daten die Maschine.
	const output = vscode.window.createOutputChannel('VSCodium Agent', { log: true });
	context.subscriptions.push(output);
	const logger = createLogger(output);
	logger.info(`Extension aktiviert (v${context.extension.packageJSON.version})`);

	const activity = ActivityIndex.fromJSON(context.workspaceState.get(ACTIVITY_STATE_KEY));
	wireActivityTracking(context, activity);

	const provider = new ChatViewProvider(context, activity, logger);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
			webviewOptions: { retainContextWhenHidden: true }
		})
	);

	// Diff-Vorschau (virtuelle Dokumente); Provider delegiert an den jeweils aktiven Host.
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, {
			provideTextDocumentContent(uri) {
				const host = provider.host;
				if (!host) { return ''; }
				return host.createDiffContentProvider().provideTextDocumentContent(uri);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('vscodiumAgent.setApiKey', async () => {
			const value = await vscode.window.showInputBox({
				title: 'Firebase Web-API-Key',
				prompt: 'API-Key aus der Firebase Console (Projekteinstellungen → Allgemein → Web-App → apiKey)',
				password: true,
				ignoreFocusOut: true,
				placeHolder: 'AIza…'
			});
			if (value) {
				await context.secrets.store(SECRET_KEY, value.trim());
				void vscode.window.showInformationMessage('Firebase API-Key gespeichert (SecretStorage).');
				void provider._sendInit();
			}
		}),

		vscode.commands.registerCommand('vscodiumAgent.clearApiKey', async () => {
			await context.secrets.delete(SECRET_KEY);
			void vscode.window.showInformationMessage('Firebase API-Key gelöscht.');
			void provider._sendInit();
		}),

		vscode.commands.registerCommand('vscodiumAgent.testConnection', async () => {
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: 'Teste Firebase AI Logic…' },
				async () => {
					try {
						const client = await provider.buildClient();
						const text = await client.ping();
						void vscode.window.showInformationMessage(`Verbindung OK (Projekt "${client.projectId}", Modell "${client.model}"): ${text.slice(0, 80)}`);
					} catch (err) {
						logger.error('Verbindungstest fehlgeschlagen', err);
						const hint = err && err.hint ? ` – ${err.hint}` : '';
						void vscode.window.showErrorMessage(`Verbindung fehlgeschlagen: ${err.message}${hint}`);
					}
				}
			);
		}),

		vscode.commands.registerCommand('vscodiumAgent.newSession', () => provider.newSession()),

		vscode.commands.registerCommand('vscodiumAgent.openSettings', () => {
			void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:vscodium.vscodium-agent');
		}),

		vscode.commands.registerCommand('vscodiumAgent.showLog', () => output.show(true))
	);

	// ── Inline-Edit (Strg+I), Quick-Fixes, Terminal-Debug ───────────────────
	const inlineEdit = new InlineEditController(provider, logger);
	context.subscriptions.push(
		inlineEdit,

		vscode.commands.registerCommand('vscodiumAgent.inlineEdit', () => inlineEdit.run()),

		vscode.commands.registerCommand('vscodiumAgent.fixWithAi', (uri, diagnostic) => {
			if (!uri || !diagnostic) { return; }
			void inlineEdit.fixDiagnostic(uri, diagnostic);
		}),

		vscode.commands.registerCommand('vscodiumAgent.explainProblem', async (uri, diagnostic) => {
			if (!uri || !diagnostic) { return; }
			const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
			const source = diagnostic.source ? ` (Quelle: ${diagnostic.source})` : '';
			await vscode.commands.executeCommand('vscodiumAgent.chatView.focus');
			void provider.runTask(
				`Erkläre das folgende Problem in ${rel}, Zeile ${diagnostic.range.start.line + 1}, und schlage eine Behebung vor. Nur erklären, noch nichts ändern: "${diagnostic.message}"${source}`
			);
		}),

		vscode.commands.registerCommand('vscodiumAgent.debugTerminal', async () => {
			const previousClipboard = await vscode.env.clipboard.readText();
			let outputText = '';
			try {
				await vscode.commands.executeCommand('workbench.action.terminal.copyLastCommandOutput');
				outputText = await vscode.env.clipboard.readText();
			} catch (_e) { /* Shell-Integration evtl. nicht aktiv */ }
			if (!outputText || outputText === previousClipboard) {
				try {
					await vscode.commands.executeCommand('workbench.action.terminal.selectAll');
					await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
					await vscode.commands.executeCommand('workbench.action.terminal.clearSelection');
					outputText = await vscode.env.clipboard.readText();
				} catch (_e) { /* kein Terminal offen */ }
			}
			await vscode.env.clipboard.writeText(previousClipboard); // Zwischenablage wiederherstellen

			if (!outputText || outputText === previousClipboard) {
				void vscode.window.showWarningMessage('Keine Terminal-Ausgabe gefunden. Ist ein Terminal geöffnet und die Shell-Integration aktiv?');
				return;
			}
			const tail = outputText.split('\n').slice(-150).join('\n').trim().slice(-12000);
			logger.info(`Terminal-Debug gestartet (${tail.length} Zeichen Ausgabe)`);
			await vscode.commands.executeCommand('vscodiumAgent.chatView.focus');
			void provider.runTask(
				`Debugge diesen Terminal-Fehler. Analysiere die Ausgabe, finde die Ursache im Projekt und schlage eine Behebung vor:\n\`\`\`\n${tail}\n\`\`\``
			);
		}),

		vscode.languages.registerCodeActionsProvider(
			{ scheme: 'file' },
			new AgentCodeActionProvider(),
			{ providedCodeActionKinds: AgentCodeActionProvider.providedCodeActionKinds }
		)
	);

	// Agent-Chat beim IDE-Start automatisch öffnen (wie in agentischen IDEs üblich).
	const cfg = vscode.workspace.getConfiguration('vscodiumAgent');
	if (cfg.get('openOnStartup', true) && (vscode.workspace.workspaceFolders || []).length > 0) {
		setTimeout(() => {
			vscode.commands.executeCommand('vscodiumAgent.chatView.focus').then(undefined, () => { /* View noch nicht bereit – unkritisch */ });
		}, 600);
	}
}

/**
 * Verkabelt den Aktivitäts-Index mit den IDE-Ereignissen.
 * Push-basiert (keine Hintergrund-Schleifen); Tipp-Ereignisse werden pro Datei
 * entprellt, Persistenz läuft gesammelt alle 5 Sekunden.
 */
function wireActivityTracking(context, activity) {
	/** Uri → workspace-relativer Pfad oder null (fremde Schemata, ausgeschlossene Ordner). */
	const rel = (uri) => {
		if (!uri || uri.scheme !== 'file' || !vscode.workspace.getWorkspaceFolder(uri)) { return null; }
		const p = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
		const segments = p.split('/');
		if (segments.some(s => EXCLUDED_DIRS.includes(s))) { return null; }
		return p;
	};

	const editTimers = new Map();

	context.subscriptions.push(
		vscode.workspace.onDidChangeTextDocument((e) => {
			const p = rel(e.document.uri);
			if (!p || e.contentChanges.length === 0) { return; }
			// Entprellen: eine Notiz pro Datei und Tipp-Pause, nicht pro Tastendruck.
			if (editTimers.has(p)) { return; }
			editTimers.set(p, setTimeout(() => {
				editTimers.delete(p);
				activity.noteEdit(p);
			}, 800));
		}),

		vscode.workspace.onDidSaveTextDocument((doc) => {
			const p = rel(doc.uri);
			if (p) { activity.noteSave(p); }
		}),

		vscode.window.onDidChangeActiveTextEditor((editor) => {
			if (!editor) { return; }
			const p = rel(editor.document.uri);
			if (p) { activity.noteView(p, editor.selection.active.line + 1); }
		}),

		vscode.workspace.onDidDeleteFiles((e) => {
			for (const uri of e.files) {
				const p = rel(uri);
				if (p) { activity.noteRemoved(p); }
			}
		}),

		vscode.workspace.onDidRenameFiles((e) => {
			for (const { oldUri, newUri } of e.files) {
				const po = rel(oldUri);
				const pn = rel(newUri);
				if (po && pn) { activity.noteRenamed(po, pn); }
			}
		})
	);

	// Änderungen außerhalb des Editors (git checkout, andere Programme).
	const watcher = vscode.workspace.createFileSystemWatcher('**/*');
	const noteFs = (uri) => {
		const p = rel(uri);
		// Editor-Speichern feuert den Watcher ebenfalls – Doppelmeldungen sind
		// unkritisch, da pro Datei nur Zeitstempel aktualisiert werden.
		if (p) { activity.noteFsChange(p); }
	};
	watcher.onDidChange(noteFs);
	watcher.onDidCreate(noteFs);
	watcher.onDidDelete((uri) => {
		const p = rel(uri);
		if (p) { activity.noteRemoved(p); }
	});
	context.subscriptions.push(watcher);

	// Persistenz: gesammelt, nur bei Änderungen.
	const persistTimer = setInterval(() => {
		if (activity.dirty) {
			activity.dirty = false;
			void context.workspaceState.update(ACTIVITY_STATE_KEY, activity.toJSON());
		}
	}, 5000);
	context.subscriptions.push({ dispose: () => clearInterval(persistTimer) });

	// Beim Start: aktuell geöffnete Datei erfassen.
	if (vscode.window.activeTextEditor) {
		const p = rel(vscode.window.activeTextEditor.document.uri);
		if (p) { activity.noteView(p, vscode.window.activeTextEditor.selection.active.line + 1); }
	}
}

function deactivate() { /* nichts zu tun */ }

module.exports = { activate, deactivate };
