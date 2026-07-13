/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – Extension-Einstiegspunkt.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const vscode = require('vscode');
const { ChatViewProvider } = require('./ui/chatViewProvider');
const { InlineEditController } = require('./ui/inlineEditController');
const { AgentCodeActionProvider } = require('./ui/codeActions');
const { DIFF_SCHEME, EXCLUDED_DIRS } = require('./lib/workspaceHost');
const { ActivityIndex } = require('./lib/activityIndex');
const { createLogger } = require('./lib/logger');
const { AuthManager, AUTH_SECRET_KEY } = require('./lib/authManager');
const { ProxyClient, formatUsage } = require('./lib/proxyClient');
const { GOOGLE_OAUTH_CLIENT_ID } = require('./lib/saasConfig');

const ACTIVITY_STATE_KEY = 'vscodiumAgent.activity.v1';
// BYOK-Altlast (bis v0.8.0): gespeicherter Firebase-Web-API-Key. Wird beim Start gelöscht.
const LEGACY_API_KEY_SECRET = 'vscodiumAgent.firebaseApiKey';

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

	// SaaS-Anmeldung (Phase S): Google-Login, Refresh-Token in SecretStorage.
	const auth = new AuthManager({ secrets: context.secrets, log: logger });
	provider.auth = auth;

	// Einmal-Migration (BYOK-Rückbau, v0.9.0): Der API-Key-Pfad ist weg, ein liegen
	// gebliebener Key im Keyring wäre nur noch ein unnötiges Geheimnis.
	void context.secrets.delete(LEGACY_API_KEY_SECRET);
	/** @type {AbortController|null} laufender Anmeldeversuch */
	let signInFlow = null;

	// Anmeldung/Abmeldung aus einem anderen Fenster übernehmen (SecretStorage ist geteilt,
	// jedes Fenster hält aber einen eigenen Extension-Host mit eigenem Cache).
	context.subscriptions.push(context.secrets.onDidChange((e) => {
		if (e.key === AUTH_SECRET_KEY) {
			auth.invalidate();
			// Konto könnte gewechselt haben (An-/Abmelden, auch im anderen Fenster):
			// den Sitzungs-Sync neu abgleichen lassen statt mit dem alten Konto-Stand
			// weiterzuarbeiten. (Feuert auch bei Token-Rotation – ein gelegentlicher
			// zusätzlicher Abgleich ist unkritisch, er ist idempotent.)
			provider._pullStarted = false;
			void provider._sendInit();
		}
	}));

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
		vscode.commands.registerCommand('vscodiumAgent.testConnection', async () => {
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: 'Teste Agent-Proxy…' },
				async () => {
					try {
						const client = await provider.buildClient();
						const text = await client.ping();
						void vscode.window.showInformationMessage(`Verbindung OK (Agent-Proxy ${client.projectId}, Modell "${client.model}"): ${text.slice(0, 80)}`);
					} catch (err) {
						logger.error('Verbindungstest fehlgeschlagen', err);
						const hint = err && err.hint ? ` – ${err.hint}` : '';
						void vscode.window.showErrorMessage(`Verbindung fehlgeschlagen: ${err.message}${hint}`);
					}
				}
			);
		}),

		vscode.commands.registerCommand('vscodiumAgent.signIn', async () => {
			const cfg = vscode.workspace.getConfiguration('vscodiumAgent');
			const proxyUrl = String(cfg.get('proxy.url', '')).replace(/\/+$/, '');
			if (!proxyUrl) {
				void vscode.window.showErrorMessage('Keine Proxy-URL konfiguriert (vscodiumAgent.proxy.url).');
				return;
			}
			if (!GOOGLE_OAUTH_CLIENT_ID) {
				void vscode.window.showErrorMessage('OAuth-Client-ID fehlt im Build (lib/saasConfig.js) – dieses Paket kann keine Anmeldung durchführen.');
				return;
			}
			// Nur ein Anmeldeversuch zur Zeit: ein neuer bricht den alten ab
			// (verhindert parallele Loopback-Server und verspätete Fehler-Toasts).
			if (signInFlow) { signInFlow.abort(); }
			const flow = new AbortController();
			signInFlow = flow;
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: 'Google-Anmeldung im Browser – bitte dort fortfahren…', cancellable: true },
				async (_progress, token) => {
					token.onCancellationRequested(() => flow.abort());
					try {
						const { email } = await auth.signIn({
							clientId: GOOGLE_OAUTH_CLIENT_ID, proxyUrl,
							signal: flow.signal,
							openBrowser: (url) => vscode.env.openExternal(vscode.Uri.parse(url))
						});
						void vscode.window.showInformationMessage(`Angemeldet als ${email || 'unbekannt'}.`);
					} catch (err) {
						if (!flow.signal.aborted) {
							logger.error('Anmeldung fehlgeschlagen', err);
							void vscode.window.showErrorMessage(`Anmeldung fehlgeschlagen: ${err.message}`);
						}
					} finally {
						if (signInFlow === flow) { signInFlow = null; }
					}
					void provider._sendInit();
				}
			);
		}),

		vscode.commands.registerCommand('vscodiumAgent.signOut', async () => {
			try {
				await auth.signOut();
				void vscode.window.showInformationMessage('Abgemeldet.');
			} catch (err) {
				logger.error('Abmelden fehlgeschlagen', err);
				void vscode.window.showErrorMessage(`Abmelden fehlgeschlagen: ${err.message}`);
			}
			void provider._sendInit();
		}),

		vscode.commands.registerCommand('vscodiumAgent.testProxy', async () => {
			const cfg = vscode.workspace.getConfiguration('vscodiumAgent');
			const proxyUrl = String(cfg.get('proxy.url', '')).replace(/\/+$/, '');
			if (!proxyUrl) {
				void vscode.window.showErrorMessage('Keine Proxy-URL konfiguriert (vscodiumAgent.proxy.url).');
				return;
			}
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: 'Teste Agent-Proxy…' },
				async () => {
					try {
						// Exakt der Produktionspfad: gleicher Client, gleiche Token-Beschaffung.
						const client = new ProxyClient({ baseUrl: proxyUrl, getIdToken: () => auth.getIdToken(proxyUrl) });
						const models = await client.listModels(AbortSignal.timeout(15000));
						const ids = models.map(m => m.id).join(', ');
						void vscode.window.showInformationMessage(`Proxy OK – Angebot: ${ids || '(leer)'}`);
					} catch (err) {
						logger.error('Proxy-Test fehlgeschlagen', err);
						const hint = err.hint ? ` ${err.hint}` : '';
						void vscode.window.showErrorMessage(`Proxy-Test fehlgeschlagen: ${err.message}${hint}`);
					}
				}
			);
		}),

		vscode.commands.registerCommand('vscodiumAgent.showUsage', async () => {
			const cfg = vscode.workspace.getConfiguration('vscodiumAgent');
			const proxyUrl = String(cfg.get('proxy.url', '')).replace(/\/+$/, '');
			if (!proxyUrl) {
				void vscode.window.showErrorMessage('Keine Proxy-URL konfiguriert (vscodiumAgent.proxy.url).');
				return;
			}
			if (!await auth.isSignedIn()) {
				void vscode.window.showErrorMessage('Nicht angemeldet – zuerst „Agent: Mit Google anmelden“ ausführen.');
				return;
			}
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: 'Frage Verbrauch ab…' },
				async () => {
					try {
						const client = new ProxyClient({ baseUrl: proxyUrl, getIdToken: () => auth.getIdToken(proxyUrl) });
						const usage = await client.getUsage(AbortSignal.timeout(15000));
						void vscode.window.showInformationMessage(formatUsage(usage));
					} catch (err) {
						logger.error('Verbrauchsabfrage fehlgeschlagen', err);
						const hint = err.hint ? ` ${err.hint}` : '';
						void vscode.window.showErrorMessage(`Verbrauchsabfrage fehlgeschlagen: ${err.message}${hint}`);
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
