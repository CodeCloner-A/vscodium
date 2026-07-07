/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – Chat-Sidebar (WebviewViewProvider) inkl. Review-Karten und Orchestrierung.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const { FirebaseAiLogicClient } = require('../lib/firebaseClient');
const { AgentRun } = require('../lib/agentController');
const { WorkspaceHost } = require('../lib/workspaceHost');
const { buildSystemPrompt } = require('../lib/prompts');

const SECRET_KEY = 'vscodiumAgent.firebaseApiKey';

class ChatViewProvider {
	static viewType = 'vscodiumAgent.chatView';

	/** @param {vscode.ExtensionContext} context */
	constructor(context) {
		this.context = context;
		/** @type {vscode.WebviewView|undefined} */
		this.view = undefined;
		/** @type {Array<object>} Transkript-Items für Re-Render. */
		this.items = [];
		/** @type {Array<object>} Gemini-contents-Historie der Sitzung. */
		this.history = [];
		this.running = false;
		/** @type {AbortController|null} */
		this.abort = null;
		/** @type {Map<string, (accept: boolean) => void>} */
		this.pendingDecisions = new Map();
		/** @type {WorkspaceHost|null} */
		this.host = null;
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
			approvalMode: cfg.get('approvalMode', 'review'),
			maxIterations: cfg.get('maxIterations', 24),
			commandTimeoutSec: cfg.get('commandTimeoutSec', 180),
			maxTreeEntries: cfg.get('context.maxTreeEntries', 250)
		};
	}

	async getApiKey() {
		return this.context.secrets.get(SECRET_KEY);
	}

	async buildClient() {
		const cfg = this.config();
		const apiKey = await this.getApiKey();
		return new FirebaseAiLogicClient({
			apiKey,
			projectId: cfg.projectId,
			appId: cfg.appId,
			backend: cfg.backend,
			location: cfg.location,
			model: cfg.model
		});
	}

	getHost() {
		const cfg = this.config();
		if (!this.host) {
			this.host = new WorkspaceHost(this._approvals(), {
				approvalMode: cfg.approvalMode,
				commandTimeoutSec: cfg.commandTimeoutSec,
				maxTreeEntries: cfg.maxTreeEntries
			});
		} else {
			this.host.options = {
				approvalMode: cfg.approvalMode,
				commandTimeoutSec: cfg.commandTimeoutSec,
				maxTreeEntries: cfg.maxTreeEntries
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
			case 'editDecision':
			case 'commandDecision': {
				const resolve = this.pendingDecisions.get(msg.id);
				if (resolve) {
					this.pendingDecisions.delete(msg.id);
					resolve(Boolean(msg.accept));
				}
				break;
			}
			case 'showDiff':
				if (this.host) { await this.host.openDiff(msg.changeId); }
				break;
			case 'newSession':
				this.newSession();
				break;
			case 'openSettings':
				void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:vscodium.vscodium-agent');
				break;
			case 'setApiKey':
				void vscode.commands.executeCommand('vscodiumAgent.setApiKey');
				break;
		}
	}

	async _sendInit() {
		const cfg = this.config();
		const apiKey = await this.getApiKey();
		this._post({
			type: 'init',
			state: {
				configured: Boolean(apiKey),
				projectId: cfg.projectId,
				model: cfg.model,
				approvalMode: cfg.approvalMode,
				running: this.running,
				items: this.items
			}
		});
	}

	// ── Sitzungs-Steuerung ────────────────────────────────────────────────────

	newSession() {
		if (this.abort) { this.abort.abort(); }
		this._rejectAllPending();
		this.items = [];
		this.history = [];
		this.running = false;
		if (this.host) { this.host.changes.clear(); }
		void this._sendInit();
	}

	async runTask(text) {
		if (!text) { return; }
		if (this.running) {
			this._post({ type: 'append', item: this._pushItem({ kind: 'info', text: 'Es läuft bereits eine Aufgabe. Erst stoppen oder warten.' }) });
			return;
		}
		const apiKey = await this.getApiKey();
		if (!apiKey) {
			this._post({ type: 'append', item: this._pushItem({ kind: 'error', text: 'Kein Firebase API-Key gesetzt. Über „API-Key setzen" den Web-API-Key des Projekts eintragen.' }) });
			return;
		}

		this._pushAndSend({ kind: 'user', text });
		this.running = true;
		this.abort = new AbortController();
		this._post({ type: 'running', value: true });

		try {
			const cfg = this.config();
			const client = await this.buildClient();
			const host = this.getHost();

			const fileTree = await host.listProjectFiles(cfg.maxTreeEntries);
			const systemPrompt = buildSystemPrompt({
				rootName: host.rootName,
				platform: `${process.platform} (${process.arch})`,
				fileTree,
				approvalMode: cfg.approvalMode,
				shell: process.platform === 'win32' ? 'cmd/PowerShell' : 'sh'
			});

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
					},
					info: (t) => self._pushAndSend({ kind: 'info', text: t }),
					error: (t) => self._pushAndSend({ kind: 'error', text: t })
				}
			});

			const result = await run.run(text);
			this.history = run.contents;

			if (result.status === 'completed' && result.summary) {
				this._pushAndSend({ kind: 'done', text: result.summary, success: result.success !== false });
			} else if (result.status === 'stopped') {
				this._pushAndSend({ kind: 'info', text: 'Lauf gestoppt.' });
			}
			if (run.filesChanged.size > 0) {
				this._pushAndSend({ kind: 'info', text: `Geänderte Dateien: ${[...run.filesChanged].join(', ')}` });
			}
		} catch (err) {
			const hint = err && err.hint ? `\n${err.hint}` : '';
			this._pushAndSend({ kind: 'error', text: `${err.message || err}${hint}` });
		} finally {
			this.running = false;
			this.abort = null;
			this._rejectAllPending();
			this._post({ type: 'running', value: false });
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
				if (auto) { return true; }
				const accepted = await self._awaitDecision(id);
				item.status = accepted ? 'accepted' : 'rejected';
				self._post({ type: 'decision', id, status: item.status });
				return accepted;
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
	<div id="setup" class="hidden">
		<p><strong>Firebase AI Logic ist noch nicht verbunden.</strong></p>
		<p>Web-API-Key des Firebase-Projekts hinterlegen (Console → Projekteinstellungen → Allgemein → Web-App).</p>
		<button id="btn-setkey">API-Key setzen</button>
		<button id="btn-settings" class="secondary">Einstellungen</button>
	</div>
	<div id="messages"></div>
	<div id="composer">
		<div id="statusline"><span id="status-model"></span><span id="status-mode"></span></div>
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
