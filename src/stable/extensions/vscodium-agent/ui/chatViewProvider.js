/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – Chat-Sidebar (WebviewViewProvider) inkl. Review-Karten, Orchestrierung
 * und persistenten Sitzungen (workspaceState, pro Projekt).
 *--------------------------------------------------------------------------------------------*/

'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const { FirebaseAiLogicClient, extractText, extractBlockReason, normalizeModelName } = require('../lib/firebaseClient');
const { AgentRun } = require('../lib/agentController');
const { WorkspaceHost } = require('../lib/workspaceHost');
const { buildSystemPrompt } = require('../lib/prompts');
const { NOOP_LOGGER } = require('../lib/logger');
const { buildApplyRequest, extractCode, APPLY_MAX_LINES } = require('../lib/inlineEdit');
const { pickerModels, resolveRoute, fixedLocation } = require('../lib/modelCatalog');

const SECRET_KEY = 'vscodiumAgent.firebaseApiKey';
const STATE_KEY = 'vscodiumAgent.sessions.v1';
const CAPTURE_KEY = 'vscodiumAgent.lastCaptureAt';

class ChatViewProvider {
	static viewType = 'vscodiumAgent.chatView';

	/**
	 * @param {vscode.ExtensionContext} context
	 * @param {import('../lib/activityIndex').ActivityIndex} [activity]
	 * @param {ReturnType<import('../lib/logger').createLogger>} [logger]
	 */
	constructor(context, activity, logger) {
		this.context = context;
		this.activity = activity || null;
		this.log = logger || NOOP_LOGGER;
		/** @type {import('../lib/authManager').AuthManager|null} wird vom Einstiegspunkt gesetzt */
		this.auth = null;
		/** @type {vscode.WebviewView|undefined} */
		this.view = undefined;
		this.running = false;
		this._applying = false;
		/** @type {AbortController|null} */
		this.abort = null;
		/** @type {Map<string, (accept: boolean) => void>} */
		this.pendingDecisions = new Map();
		/** @type {WorkspaceHost|null} */
		this.host = null;
		this._saveTimer = null;

		this._loadSessions();

		// Einstellungs-Änderungen (Modell, Modus …) in die Statusleiste des Webviews spiegeln.
		context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('vscodiumAgent')) {
				void this._sendInit();
			}
		}));
	}

	// ── Sitzungen (Persistenz: workspaceState, pro Projekt) ──────────────────

	_loadSessions() {
		const stored = this.context.workspaceState.get(STATE_KEY);
		if (stored && Array.isArray(stored.sessions) && stored.sessions.length > 0) {
			this.sessions = stored.sessions;
			this.activeSessionId = stored.activeId && this.sessions.some(s => s.id === stored.activeId)
				? stored.activeId
				: this.sessions[0].id;
		} else {
			this.sessions = [];
			this.activeSessionId = null;
			this._createSession();
		}
	}

	_createSession() {
		const session = {
			id: crypto.randomUUID(),
			title: 'Neue Sitzung',
			createdAt: Date.now(),
			updatedAt: Date.now(),
			items: [],
			history: []
		};
		this.sessions.unshift(session);
		const max = vscode.workspace.getConfiguration('vscodiumAgent').get('sessions.max', 20);
		if (this.sessions.length > max) {
			this.sessions = this.sessions
				.slice()
				.sort((a, b) => b.updatedAt - a.updatedAt)
				.slice(0, max);
		}
		this.activeSessionId = session.id;
		this._scheduleSave();
		return session;
	}

	get session() {
		let s = this.sessions.find(x => x.id === this.activeSessionId);
		if (!s) { s = this._createSession(); }
		return s;
	}

	get items() { return this.session.items; }
	get history() { return this.session.history; }
	set history(value) { this.session.history = value; }

	_scheduleSave() {
		if (this._saveTimer) { clearTimeout(this._saveTimer); }
		this._saveTimer = setTimeout(() => {
			this._saveTimer = null;
			void this.context.workspaceState.update(STATE_KEY, {
				sessions: this.sessions,
				activeId: this.activeSessionId
			});
		}, 400);
	}

	sessionSummaries() {
		return this.sessions
			.slice()
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.map(s => ({ id: s.id, title: s.title, updatedAt: s.updatedAt }));
	}

	newSession() {
		if (this.running) {
			void vscode.window.showWarningMessage('Bitte zuerst den laufenden Agenten stoppen.');
			return;
		}
		this._rejectAllPending();
		// Leere aktive Sitzung wiederverwenden statt Duplikate anzulegen.
		if (this.session.items.length > 0) {
			this._createSession();
		}
		void this._sendInit();
	}

	switchSession(id) {
		if (this.running) {
			void vscode.window.showWarningMessage('Sitzungswechsel erst nach Stopp des laufenden Agenten.');
			void this._sendInit();
			return;
		}
		if (this.sessions.some(s => s.id === id)) {
			this._rejectAllPending();
			this.activeSessionId = id;
			this._scheduleSave();
		}
		void this._sendInit();
	}

	deleteSession(id) {
		if (this.running && id === this.activeSessionId) {
			void vscode.window.showWarningMessage('Aktive Sitzung erst nach Stopp löschbar.');
			return;
		}
		this.sessions = this.sessions.filter(s => s.id !== id);
		if (this.activeSessionId === id) {
			this.activeSessionId = this.sessions.length > 0 ? this.sessions[0].id : null;
			if (!this.activeSessionId) { this._createSession(); }
		}
		this._scheduleSave();
		void this._sendInit();
	}

	// ── Konfiguration ─────────────────────────────────────────────────────────

	config() {
		const cfg = vscode.workspace.getConfiguration('vscodiumAgent');
		return {
			projectId: cfg.get('firebase.projectId', 'controlling-man'),
			appId: cfg.get('firebase.appId', ''),
			backend: cfg.get('firebase.backend', 'googleAI'),
			location: cfg.get('firebase.location', 'us-central1'),
			model: cfg.get('model', 'gemini-2.5-flash'),
			inlineEditModel: cfg.get('inlineEdit.model', 'gemini-2.5-flash'),
			approvalMode: cfg.get('approvalMode', 'review'),
			terminalMode: cfg.get('terminal.mode', 'captured'),
			maxIterations: cfg.get('maxIterations', 24),
			commandTimeoutSec: cfg.get('commandTimeoutSec', 180),
			maxTreeEntries: cfg.get('context.maxTreeEntries', 250)
		};
	}

	async getApiKey() {
		return this.context.secrets.get(SECRET_KEY);
	}

	/** @param {string} [modelOverride]  z. B. das Inline-Edit-Modell. */
	async buildClient(modelOverride) {
		const cfg = this.config();
		const apiKey = await this.getApiKey();
		const model = modelOverride || cfg.model;
		// Auto-Routing: Modelle mit festem Standort übersteuern die Location-Einstellung.
		const route = resolveRoute(model, cfg);
		if (route.pinned) {
			this.log.info(`Standort automatisch gesetzt: ${route.location} (Modell ${model} erlaubt "${cfg.location}" nicht)`);
		}
		return new FirebaseAiLogicClient({
			apiKey,
			projectId: cfg.projectId,
			appId: cfg.appId,
			backend: route.backend,
			location: route.location,
			model
		});
	}

	getHost() {
		const cfg = this.config();
		const options = {
			approvalMode: cfg.approvalMode,
			terminalMode: cfg.terminalMode,
			commandTimeoutSec: cfg.commandTimeoutSec,
			maxTreeEntries: cfg.maxTreeEntries,
			logger: this.log
		};
		if (!this.host) {
			this.host = new WorkspaceHost(this._approvals(), options);
		} else {
			this.host.options = options;
		}
		if (this.activity) {
			this.host.onAgentWrite = (p) => this.activity.noteAgentWrite(p);
			this.host.activityCallback = () => {
				const since = this.context.workspaceState.get(CAPTURE_KEY, 0);
				return this.activity.summary(8, since);
			};
		}
		return this.host;
	}

	// ── WebviewViewProvider ───────────────────────────────────────────────────

	/** @param {vscode.WebviewView} view */
	resolveWebviewView(view) {
		this.view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
		};
		view.webview.html = this._html(view.webview);

		view.webview.onDidReceiveMessage(async (msg) => {
			try {
				await this._onMessage(msg);
			} catch (err) {
				this._post({ type: 'append', item: this._pushItem({ kind: 'error', text: String(err.message || err) }) });
			}
		});
	}

	async _onMessage(msg) {
		switch (msg.type) {
			case 'ready':
				await this._sendInit();
				break;
			case 'sendTask':
				void this.runTask(String(msg.text || '').trim());
				break;
			case 'stop':
				if (this.abort) { this.abort.abort(); }
				this._rejectAllPending();
				break;
			case 'editDecision': {
				const resolve = this.pendingDecisions.get(msg.id);
				if (resolve) {
					this.pendingDecisions.delete(msg.id);
					resolve(Boolean(msg.accept));
				}
				break;
			}
			case 'commandDecision': {
				const resolve = this.pendingDecisions.get(msg.id);
				if (resolve) {
					this.pendingDecisions.delete(msg.id);
					resolve({
						accept: Boolean(msg.accept),
						command: typeof msg.command === 'string' ? msg.command : undefined
					});
				}
				break;
			}
			case 'setModel': {
				const model = String(msg.model || '').trim();
				if (model) {
					const cfg = vscode.workspace.getConfiguration('vscodiumAgent');
					// Ein Workspace-Wert überschattet Global – dorthin schreiben, wo der Wert wirkt,
					// sonst springt der Picker still auf das alte Modell zurück.
					const info = cfg.inspect('model');
					const target = info && info.workspaceValue !== undefined
						? vscode.ConfigurationTarget.Workspace
						: vscode.ConfigurationTarget.Global;
					await cfg.update('model', model, target);
					this.log.info(`Modell umgestellt: ${model}`);
				}
				break;
			}
			case 'showDiff':
				if (this.host) { await this.host.openDiff(msg.changeId); }
				break;
			case 'applyCode':
				void this.applyCodeBlock(String(msg.code || ''));
				break;
			case 'newSession':
				this.newSession();
				break;
			case 'switchSession':
				this.switchSession(String(msg.id || ''));
				break;
			case 'deleteSession':
				this.deleteSession(String(msg.id || ''));
				break;
			case 'openSettings':
				void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:vscodium.vscodium-agent');
				break;
			case 'authClick': {
				if (this.auth && await this.auth.isSignedIn()) {
					const choice = await vscode.window.showQuickPick(
						[{ label: '$(plug) Proxy-Verbindung testen', action: 'vscodiumAgent.testProxy' },
						{ label: '$(sign-out) Abmelden', action: 'vscodiumAgent.signOut' }],
						{ title: `Angemeldet als ${await this.auth.email()}` }
					);
					if (choice) { void vscode.commands.executeCommand(choice.action); }
				} else {
					void vscode.commands.executeCommand('vscodiumAgent.signIn');
				}
				break;
			}
			case 'setApiKey':
				void vscode.commands.executeCommand('vscodiumAgent.setApiKey');
				break;
		}
	}

	async _sendInit() {
		const cfg = this.config();
		const apiKey = await this.getApiKey();
		// Normalisiert, damit Schreibweisen wie "models/x" den Katalog-Eintrag treffen;
		// unbekannte Modelle aus den Einstellungen erhalten hier ihren Eintrag samt
		// festem Standort (z. B. 3.x-Previews → global), statt im Webview ohne
		// Regions-Anzeige synthetisiert zu werden.
		const model = normalizeModelName(cfg.model);
		const models = pickerModels();
		if (model && !models.some(m => m.id === model)) {
			models.push({ id: model, label: `${model} (aus den Einstellungen)`, region: fixedLocation(model) });
		}
		const auth = this.auth
			? { signedIn: await this.auth.isSignedIn(), email: await this.auth.email() }
			: undefined;
		this._post({
			type: 'init',
			state: {
				configured: Boolean(apiKey),
				projectId: cfg.projectId,
				model,
				models,
				auth,
				approvalMode: cfg.approvalMode,
				running: this.running,
				items: this.items,
				sessions: this.sessionSummaries(),
				activeSessionId: this.activeSessionId
			}
		});
	}

	// ── Aufgaben-Ausführung ───────────────────────────────────────────────────

	async runTask(text) {
		if (!text) { return; }
		// Auch eine laufende Codeblock-Übernahme blockiert: Ein paralleler Lauf würde deren
		// offene Review-Karte in seinem finally per _rejectAllPending() stillschweigend ablehnen.
		if (this.running || this._applying) {
			this._post({ type: 'append', item: this._pushItem({ kind: 'info', text: 'Es läuft bereits ein Vorgang. Erst stoppen oder warten.' }) });
			return;
		}
		const apiKey = await this.getApiKey();
		if (!apiKey) {
			this._post({ type: 'append', item: this._pushItem({ kind: 'error', text: 'Kein Firebase API-Key gesetzt. Über „API-Key setzen" den Web-API-Key des Projekts eintragen.' }) });
			return;
		}

		const session = this.session;
		if (session.title === 'Neue Sitzung') {
			session.title = text.length > 48 ? text.slice(0, 48) + '…' : text;
			this._post({ type: 'sessions', sessions: this.sessionSummaries(), activeSessionId: this.activeSessionId });
		}

		this._pushAndSend({ kind: 'user', text });
		this.running = true;
		this.abort = new AbortController();
		this._post({ type: 'running', value: true });

		try {
			const cfg = this.config();
			this.log.info(`Agent-Lauf gestartet (Modell: ${cfg.model}, Modus: ${cfg.approvalMode}, Backend: ${cfg.backend})`);
			const client = await this.buildClient();
			const host = this.getHost();

			const fileTree = await host.listProjectFiles(cfg.maxTreeEntries);
			const lastCaptureAt = this.context.workspaceState.get(CAPTURE_KEY, 0);
			const activityText = this.activity ? this.activity.summary(8, lastCaptureAt) : undefined;
			const systemPrompt = buildSystemPrompt({
				rootName: host.rootName,
				platform: `${process.platform} (${process.arch})`,
				fileTree,
				approvalMode: cfg.approvalMode,
				shell: process.platform === 'win32' ? 'cmd/PowerShell' : 'sh',
				activity: activityText,
				today: new Date().toLocaleDateString('de-DE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
			});
			// Erfassungszeitpunkt merken: Deltas beziehen sich künftig hierauf.
			void this.context.workspaceState.update(CAPTURE_KEY, Date.now());

			const self = this;
			const run = new AgentRun({
				client,
				host,
				systemPrompt,
				maxIterations: cfg.maxIterations,
				signal: this.abort.signal,
				history: this.history,
				ui: {
					assistantText: (t) => self._pushAndSend({ kind: 'assistant', text: t }),
					toolStart: (id, name, args) => self._pushAndSend({ kind: 'tool', id, name, detail: describeToolCall(name, args), status: 'running' }),
					toolEnd: (id, name, summary, ok) => {
						const item = self.items.find(i => i.kind === 'tool' && i.id === id);
						if (item) { item.status = ok ? 'ok' : 'warn'; item.result = summary; }
						self._post({ type: 'toolUpdate', id, status: ok ? 'ok' : 'warn', result: summary });
						self._scheduleSave();
					},
					info: (t) => self._pushAndSend({ kind: 'info', text: t }),
					error: (t) => {
						self.log.error(`Agent meldet: ${t}`);
						self._pushAndSend({ kind: 'error', text: t });
					}
				}
			});

			const result = await run.run(text);
			this.history = run.contents;
			this.log.info(`Agent-Lauf beendet (Status: ${result.status}, geänderte Dateien: ${run.filesChanged.size})`);

			if (result.status === 'completed' && result.summary) {
				this._pushAndSend({ kind: 'done', text: result.summary, success: result.success !== false });
			} else if (result.status === 'stopped') {
				this._pushAndSend({ kind: 'info', text: 'Lauf gestoppt.' });
			}
			if (run.filesChanged.size > 0) {
				this._pushAndSend({ kind: 'info', text: `Geänderte Dateien: ${[...run.filesChanged].join(', ')}` });
			}
		} catch (err) {
			this.log.error('Agent-Lauf fehlgeschlagen', err);
			const hint = err && err.hint ? `\n${err.hint}` : '';
			this._pushAndSend({ kind: 'error', text: `${err.message || err}${hint}` });
		} finally {
			this.running = false;
			this.abort = null;
			this._rejectAllPending();
			this._post({ type: 'running', value: false });
			this._scheduleSave();
		}
	}

	// ── „In Datei übernehmen“ (Codeblock aus dem Chat) ───────────────────────

	/**
	 * Integriert einen Chat-Codeblock per Modell in die aktive Datei;
	 * die Änderung läuft über den normalen Review-Flow (Karte + Diff + Undo-sicher).
	 */
	async applyCodeBlock(code) {
		if (!code.trim()) { return; }
		if (this.running || this._applying) {
			this._pushAndSend({ kind: 'info', text: 'Bitte warten, bis der laufende Vorgang abgeschlossen ist.' });
			return;
		}
		const apiKey = await this.getApiKey();
		if (!apiKey) {
			this._pushAndSend({ kind: 'error', text: 'Kein Firebase API-Key gesetzt.' });
			return;
		}
		const editor = vscode.window.activeTextEditor
			|| vscode.window.visibleTextEditors.find(e => e.document.uri.scheme === 'file');
		if (!editor || editor.document.uri.scheme !== 'file') {
			this._pushAndSend({ kind: 'error', text: 'Keine aktive Datei, auf die der Codeblock angewendet werden kann. Bitte Ziel-Datei im Editor öffnen.' });
			return;
		}
		const doc = editor.document;
		if (doc.lineCount > APPLY_MAX_LINES) {
			this._pushAndSend({ kind: 'error', text: `Datei zu groß für automatisches Übernehmen (${doc.lineCount} Zeilen, Limit ${APPLY_MAX_LINES}). Bitte Zielstelle markieren und Inline-Edit (Strg+I) nutzen.` });
			return;
		}

		this._applying = true;
		const rel = vscode.workspace.asRelativePath(doc.uri, false).replace(/\\/g, '/');
		this._pushAndSend({ kind: 'info', text: `Integriere Codeblock in ${rel} …` });
		try {
			const cfg = this.config();
			const client = await this.buildClient(cfg.inlineEditModel);
			const fileContent = doc.getText();
			const response = await client.generateContent(buildApplyRequest({
				code,
				fileContent,
				relPath: rel,
				languageId: doc.languageId
			}));
			const blocked = extractBlockReason(response);
			if (blocked) { throw new Error(blocked); }
			let newContent = extractCode(extractText(response));
			if (!newContent) { throw new Error('Leere Modellantwort.'); }
			if (fileContent.endsWith('\n') && !newContent.endsWith('\n')) { newContent += '\n'; }
			if (newContent === fileContent) {
				this._pushAndSend({ kind: 'info', text: 'Das Modell hat keine sinnvolle Integrationsstelle gefunden – Datei unverändert.' });
				return;
			}
			// Review-Flow: Karte im Chat, Diff-Vorschau, Undo-sichere Anwendung.
			await this.getHost().applyChange({
				kind: 'write',
				path: rel,
				newContent,
				summary: 'Codeblock aus dem Chat in die Datei integriert'
			});
		} catch (err) {
			this.log.error('Codeblock-Übernahme fehlgeschlagen', err);
			const hint = err && err.hint ? `\n${err.hint}` : '';
			this._pushAndSend({ kind: 'error', text: `Übernehmen fehlgeschlagen: ${err.message || err}${hint}` });
		} finally {
			this._applying = false;
		}
	}

	// ── Approvals (vom WorkspaceHost aufgerufen) ─────────────────────────────

	_approvals() {
		const self = this;
		return {
			async requestEditApproval(info) {
				const auto = self.config().approvalMode === 'auto';
				const item = self._pushAndSend({
					kind: 'edit',
					id: info.id,
					action: info.action,
					path: info.path,
					summary: info.summary,
					lines: `${info.oldLines} → ${info.newLines} Zeilen`,
					status: auto ? 'accepted' : 'pending'
				});
				if (auto) { return true; }
				if (self.host) { void self.host.openDiff(info.id); }
				const accepted = await self._awaitDecision(info.id);
				item.status = accepted ? 'accepted' : 'rejected';
				self._post({ type: 'decision', id: info.id, status: item.status });
				self._scheduleSave();
				return accepted;
			},
			async requestCommandApproval(info) {
				const auto = self.config().approvalMode === 'auto';
				const id = `cmd-${crypto.randomUUID()}`;
				const item = self._pushAndSend({
					kind: 'command',
					id,
					command: info.command,
					cwd: info.cwd,
					purpose: info.purpose,
					status: auto ? 'accepted' : 'pending'
				});
				if (auto) { return { approved: true, command: info.command }; }
				const decision = await self._awaitDecision(id);
				const accepted = decision === true || Boolean(decision && decision.accept);
				const edited = decision && typeof decision.command === 'string' && decision.command.trim()
					? decision.command.trim()
					: info.command;
				if (accepted && edited !== info.command) {
					item.command = edited; // Persistenz: die Karte zeigt das tatsächlich ausgeführte Kommando
				}
				item.status = accepted ? 'accepted' : 'rejected';
				self._post({ type: 'decision', id, status: item.status, command: item.command });
				self._scheduleSave();
				return { approved: accepted, command: edited };
			}
		};
	}

	_awaitDecision(id) {
		return new Promise((resolve) => {
			this.pendingDecisions.set(id, resolve);
			if (this.abort) {
				this.abort.signal.addEventListener('abort', () => {
					if (this.pendingDecisions.delete(id)) { resolve(false); }
				}, { once: true });
			}
		});
	}

	_rejectAllPending() {
		for (const [, resolve] of this.pendingDecisions) { resolve(false); }
		this.pendingDecisions.clear();
	}

	// ── Webview-Hilfen ────────────────────────────────────────────────────────

	_pushItem(item) {
		this.items.push(item);
		this.session.updatedAt = Date.now();
		this._scheduleSave();
		return item;
	}

	_pushAndSend(item) {
		this._pushItem(item);
		this._post({ type: 'append', item });
		return item;
	}

	_post(message) {
		if (this.view) {
			void this.view.webview.postMessage(message);
		}
	}

	_html(webview) {
		const nonce = crypto.randomBytes(16).toString('base64');
		const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.css'));
		const js = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.js'));
		return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Agent</title>
</head>
<body>
	<div id="sessionbar">
		<select id="session-select" title="Sitzung wählen"></select>
		<button id="btn-new-session" class="secondary" title="Neue Sitzung">＋</button>
		<button id="btn-del-session" class="secondary" title="Sitzung löschen">🗑</button>
	</div>
	<div id="setup" class="hidden">
		<p><strong>Firebase AI Logic ist noch nicht verbunden.</strong></p>
		<p>Web-API-Key des Firebase-Projekts hinterlegen (Console → Projekteinstellungen → Allgemein).</p>
		<button id="btn-setkey">API-Key setzen</button>
		<button id="btn-settings" class="secondary">Einstellungen</button>
	</div>
	<div id="messages"></div>
	<div id="composer">
		<div id="statusline"><span id="status-project"></span><select id="model-select" title="Gemini-Modell wählen"></select><span id="status-mode"></span><span id="status-auth" title="Anmeldestatus – klicken für Anmelden/Abmelden"></span></div>
		<textarea id="input" rows="3" placeholder="Aufgabe beschreiben … (Enter = Senden, Shift+Enter = Zeile)"></textarea>
		<div id="actions">
			<button id="btn-send">Senden</button>
			<button id="btn-stop" class="danger hidden">Stopp</button>
		</div>
	</div>
	<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
	}
}

function describeToolCall(name, args) {
	switch (name) {
		case 'list_files': return 'Projektstruktur lesen';
		case 'read_file': return `Lese ${args.path}${args.start_line ? ` (Zeilen ${args.start_line}–${args.end_line || 'Ende'})` : ''}`;
		case 'search_project': return `Suche „${truncate(args.query, 60)}“${args.file_glob ? ` in ${args.file_glob}` : ''}`;
		case 'write_file': return `Schreibe ${args.path}`;
		case 'replace_in_file': return `Ändere ${args.path}`;
		case 'delete_file': return `Lösche ${args.path}`;
		case 'run_command': return `$ ${truncate(args.command, 80)}`;
		case 'get_recent_activity': return 'Nutzeraktivität abrufen';
		case 'get_diagnostics': return `Diagnostics${args.path ? ` für ${args.path}` : ' (gesamter Workspace)'}`;
		case 'task_complete': return 'Abschluss';
		default: return name;
	}
}

function truncate(s, n) {
	s = String(s || '');
	return s.length > n ? s.slice(0, n) + '…' : s;
}

module.exports = { ChatViewProvider, SECRET_KEY };
