/*---------------------------------------------------------------------------------------------
 * PHI47 – Extension-Einstiegspunkt.
 *
 * Seit v0.17.0 gibt es genau EINE Chat-Oberfläche: den nativen Core-Chat. Das eigene
 * Webview (bis v0.16.0 `ui/chatViewProvider.js` samt `media/chat.*`) ist entfernt –
 * zwei parallele Chat-UIs waren technische Schuld, die jeder Upstream-Merge bezahlt
 * hätte. Übrig bleibt die Motor-Schicht: `ui/agentService.js` (Einstellungen, Proxy,
 * Anmeldung, Modell-Katalog, Workspace-Host) plus die Registrierungen unten.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const vscode = require('vscode');
const { AgentService } = require('./ui/agentService');
const { registerNativeChat } = require('./ui/nativeChatController');
const { registerActivitySignal } = require('./ui/activitySignalController');
const { registerAttachFromComputer } = require('./ui/attachFromComputer');
const { InlineEditController } = require('./ui/inlineEditController');
const { AgentCodeActionProvider } = require('./ui/codeActions');
const { EXCLUDED_DIRS } = require('./lib/workspaceHost');
const { MEMORY_PATH, HEADER: MEMORY_HEADER } = require('./lib/projectMemory');

/** Chat öffnen und (optional) eine Frage vorbelegen – der native Chat ist die einzige Oberfläche. */
async function openChat(query) {
	try {
		await vscode.commands.executeCommand('workbench.action.chat.open', query ? { query } : undefined);
	} catch (_e) {
		// Auf Basen ohne Core-Chat (fremder Build): still bleiben statt Fehler zu zeigen.
	}
}
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

	const service = new AgentService(context, activity, logger);

	// SaaS-Anmeldung (Phase S): Google-Login, Refresh-Token in SecretStorage.
	const auth = new AuthManager({ secrets: context.secrets, log: logger });
	service.auth = auth;

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
			// der gecachte Modell-Katalog gehört zum alten Konto.
			service.invalidateCatalog();
		}
	}));

	context.subscriptions.push(
		vscode.commands.registerCommand('vscodiumAgent.testConnection', async () => {
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: 'Teste Agent-Proxy…' },
				async () => {
					try {
						const client = await service.buildClient();
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
					// Nach der Anmeldung liefert der Proxy ein anderes Angebot.
					service.invalidateCatalog();
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
			service.invalidateCatalog();
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

		vscode.commands.registerCommand('vscodiumAgent.openSettings', () => {
			void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:vscodium.vscodium-agent');
		}),

		vscode.commands.registerCommand('vscodiumAgent.showLog', () => output.show(true)),

		// Projekt-Gedächtnis zum Nachlesen/Bearbeiten öffnen (legt es bei Bedarf an).
		vscode.commands.registerCommand('vscodiumAgent.openMemory', async () => {
			const folder = (vscode.workspace.workspaceFolders || [])[0];
			if (!folder) {
				void vscode.window.showInformationMessage('Kein Projektordner geöffnet – das Gedächtnis gehört zu einem Projekt.');
				return;
			}
			const uri = vscode.Uri.joinPath(folder.uri, ...MEMORY_PATH.split('/'));
			try {
				try {
					await vscode.workspace.fs.stat(uri);
				} catch (_e) {
					await vscode.workspace.fs.writeFile(uri, Buffer.from(MEMORY_HEADER, 'utf8'));
					logger.info(`Projekt-Gedächtnis angelegt: ${MEMORY_PATH}`);
				}
				await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
			} catch (err) {
				logger.error('Projekt-Gedächtnis konnte nicht geöffnet werden', err);
				void vscode.window.showErrorMessage(`Projekt-Gedächtnis konnte nicht geöffnet werden: ${err.message}`);
			}
		}),

		// Einsteiger-Weg aus dem ordnerlosen Chat (Phase K): legt auf Klick einen
		// neuen Projektordner unter Dokumente\VSCodium-Projekte an und öffnet ihn.
		// Läuft NUR auf Nutzer-Geste – der Agent selbst schreibt nie außerhalb
		// eines geöffneten Workspace.
		vscode.commands.registerCommand('vscodiumAgent.createWorkspace', async () => {
			const name = await vscode.window.showInputBox({
				prompt: 'Wie soll dein Projektordner heißen?',
				value: 'mein-projekt',
				validateInput: (v) => /^[\w][\w .-]*$/.test(String(v || '').trim())
					? undefined
					: 'Bitte nur Buchstaben, Zahlen, Leerzeichen, Punkt, - und _ verwenden.'
			});
			if (!name) { return; }
			try {
				const os = require('os');
				const path = require('path');
				const base = path.join(os.homedir(), 'Documents', 'VSCodium-Projekte');
				let target = path.join(base, name.trim());
				// Namenskollision: mein-projekt, mein-projekt-2, mein-projekt-3, …
				for (let i = 2; ; i++) {
					try {
						await vscode.workspace.fs.stat(vscode.Uri.file(target));
						target = path.join(base, `${name.trim()}-${i}`);
					} catch (_e) { break; }
				}
				const uri = vscode.Uri.file(target);
				await vscode.workspace.fs.createDirectory(uri);
				logger.info(`Neuer Projektordner angelegt: ${target}`);
				await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: false });
			} catch (err) {
				logger.error('Projektordner anlegen fehlgeschlagen', err);
				void vscode.window.showErrorMessage(`Projektordner konnte nicht angelegt werden: ${err.message}`);
			}
		})
	);

	// ── Inline-Edit (Strg+I), Quick-Fixes, Terminal-Debug ───────────────────
	const inlineEdit = new InlineEditController(service, logger);
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
			await openChat(
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
			await openChat(
				`Debugge diesen Terminal-Fehler. Analysiere die Ausgabe, finde die Ursache im Projekt und schlage eine Behebung vor:\n\`\`\`\n${tail}\n\`\`\``
			);
		}),

		vscode.languages.registerCodeActionsProvider(
			{ scheme: 'file' },
			new AgentCodeActionProvider(),
			{ providedCodeActionKinds: AgentCodeActionProvider.providedCodeActionKinds }
		)
	);

	// ── Nativer Core-Chat (Roadmap Phase K) ─────────────────────────────────
	// Die einzige Chat-Oberfläche: Default-Participant + Plan-Modi + Modell-Picker.
	// Auf fremden Basen (ohne unsere Proposal-Freischaltung) scheitert die
	// Registrierung kontrolliert – dann bleibt die Extension ein reiner Motor
	// für Inline-Edit und Quick-Fixes.
	registerNativeChat(context, service, activity, logger);

	// ── KEEP IT SIMPLE: sichtbare Aktivität + einsteigerfreundlicher Datei-Anhang ──
	registerActivitySignal(context, logger);
	registerAttachFromComputer(context, logger);

	// ── Erststart: Walkthrough zeigen, danach zur Anmeldung führen ──────────
	void firstRunExperience(context, auth, logger);

	// Chat beim IDE-Start öffnen (wie in agentischen IDEs üblich).
	const cfg = vscode.workspace.getConfiguration('vscodiumAgent');
	if (cfg.get('openOnStartup', true)) {
		setTimeout(() => { void openChat(); }, 600);
	}
}

/**
 * Erster Start nach der Installation: die Willkommensseite mit dem PHI47-Walkthrough
 * öffnen. Ist der Nutzer (auch später) nicht angemeldet, einmal pro Installation
 * freundlich dazu einladen – nicht bei jedem Start, das nervt.
 */
async function firstRunExperience(context, auth, logger) {
	const FIRST_RUN_KEY = 'phi47.firstRun.v1';
	const SIGN_IN_PROMPT_KEY = 'phi47.signInPrompted.v1';
	try {
		if (!context.globalState.get(FIRST_RUN_KEY)) {
			await context.globalState.update(FIRST_RUN_KEY, Date.now());
			logger.info('Erststart erkannt – Willkommensseite wird geöffnet.');
			await vscode.commands.executeCommand(
				'workbench.action.openWalkthrough',
				{ category: `${context.extension.id}#phi47.start` },
				false
			).then(undefined, () => { /* Auf fremden Basen ohne Walkthrough-Seite: still bleiben. */ });
		}

		if (context.globalState.get(SIGN_IN_PROMPT_KEY)) { return; }
		// Kurz warten: Beim Start ist das Fenster noch mit sich selbst beschäftigt.
		await new Promise((resolve) => setTimeout(resolve, 2500));
		if (await auth.isSignedIn()) { return; }
		await context.globalState.update(SIGN_IN_PROMPT_KEY, Date.now());
		const choice = await vscode.window.showInformationMessage(
			'Willkommen bei PHI47! Melde dich einmal mit Google an – danach steht dir der Agent mit allen Modellen zur Verfügung.',
			'Jetzt anmelden',
			'Später'
		);
		if (choice === 'Jetzt anmelden') {
			await vscode.commands.executeCommand('vscodiumAgent.signIn');
		}
	} catch (err) {
		logger.warn('Erststart-Ablauf übersprungen.', err);
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
