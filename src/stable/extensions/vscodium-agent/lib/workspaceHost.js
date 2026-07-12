/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – Workspace-Host: implementiert das Tool-Host-Interface mit VS-Code-APIs.
 * Enthält Review-Gating (Diff-Vorschau + Bestätigung) und Kommando-Ausführung.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');
const { NOOP_LOGGER } = require('./logger');
const { stripAnsi, normalizeCommandApproval, capText } = require('./terminalExec');

const DIFF_SCHEME = 'vscodium-agent-diff';

const EXCLUDED_DIRS = [
	'node_modules', '.git', 'dist', 'out', 'build', '.next', '.nuxt', '.venv', 'venv',
	'__pycache__', 'coverage', '.vscode-test', 'target', 'bin', 'obj', '.idea', '.gradle'
];
const BINARY_EXTENSIONS = new Set([
	'.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns', '.pdf', '.zip', '.gz', '.tar',
	'.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.node', '.woff', '.woff2', '.ttf', '.eot',
	'.mp3', '.mp4', '.mov', '.avi', '.class', '.jar', '.bin', '.wasm'
]);
const MAX_SEARCH_FILE_SIZE = 512 * 1024;

class WorkspaceHost {
	/**
	 * @param {{
	 *   requestEditApproval(change): Promise<boolean>,
	 *   requestCommandApproval(cmd): Promise<boolean>
	 * }} approvals  – im Auto-Modus können beide sofort true liefern.
	 * @param {{ approvalMode: 'review'|'auto', commandTimeoutSec: number, maxTreeEntries: number, logger?: object }} options
	 */
	constructor(approvals, options) {
		this.approvals = approvals;
		this.options = options;
		this.log = (options && options.logger) || NOOP_LOGGER;
		/** @type {Map<string, {kind:string, path:string, oldContent:string, newContent:string, summary:string}>} */
		this.changes = new Map();
		this._changeCounter = 0;
		/** Optional: Callback nach angewendetem Agent-Write (Pfad). */
		this.onAgentWrite = null;
		/** Optional: liefert Aktivitäts-Zusammenfassung (vom Provider gesetzt). */
		this.activityCallback = null;
	}

	get rootUri() {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0) {
			throw new Error('Kein Workspace-Ordner geöffnet. Bitte zuerst einen Ordner öffnen.');
		}
		return folders[0].uri;
	}

	get rootName() {
		return path.basename(this.rootUri.fsPath);
	}

	/** Relativen Pfad validieren und als Uri auflösen (kein Ausbruch aus dem Workspace). */
	resolve(relPath) {
		const cleaned = String(relPath || '').replace(/\\/g, '/').replace(/^\.\//, '');
		if (!cleaned || cleaned.startsWith('/') || /^[a-zA-Z]:/.test(cleaned)) {
			throw new Error(`Nur Pfade relativ zum Workspace-Root sind erlaubt: "${relPath}"`);
		}
		const abs = path.resolve(this.rootUri.fsPath, cleaned);
		const root = path.resolve(this.rootUri.fsPath);
		if (abs !== root && !abs.startsWith(root + path.sep)) {
			throw new Error(`Pfad verlässt den Workspace: "${relPath}"`);
		}
		return vscode.Uri.file(abs);
	}

	relFromUri(uri) {
		return path.relative(this.rootUri.fsPath, uri.fsPath).replace(/\\/g, '/');
	}

	// ── Lesen / Suchen ────────────────────────────────────────────────────────

	async listProjectFiles(maxEntries) {
		const cap = maxEntries || this.options.maxTreeEntries || 250;
		const exclude = `{${EXCLUDED_DIRS.map(d => `**/${d}/**`).join(',')}}`;
		const uris = await vscode.workspace.findFiles('**/*', exclude, cap * 4);
		const rels = uris.map(u => this.relFromUri(u)).sort();
		const shown = rels.slice(0, cap);
		const lines = renderTree(shown);
		if (rels.length > cap) {
			lines.push(`… ${rels.length - cap}+ weitere Dateien (search_project/list_files nutzen)`);
		}
		return lines.join('\n');
	}

	async fileExists(relPath) {
		try {
			await vscode.workspace.fs.stat(this.resolve(relPath));
			return true;
		} catch (_e) {
			return false;
		}
	}

	async readFile(relPath) {
		const uri = this.resolve(relPath);
		if (BINARY_EXTENSIONS.has(path.extname(uri.fsPath).toLowerCase())) {
			throw new Error(`"${relPath}" ist eine Binärdatei.`);
		}
		const bytes = await vscode.workspace.fs.readFile(uri);
		if (looksBinary(bytes)) {
			throw new Error(`"${relPath}" scheint binär zu sein.`);
		}
		return Buffer.from(bytes).toString('utf8');
	}

	async searchText(query, { isRegex, fileGlob, maxResults }) {
		let regex;
		try {
			regex = isRegex ? new RegExp(query, 'g') : new RegExp(escapeRegExp(query), 'g');
		} catch (err) {
			throw new Error(`Ungültiger regulärer Ausdruck: ${err.message}`);
		}
		const globRegex = fileGlob ? globToRegExp(fileGlob) : null;
		const exclude = `{${EXCLUDED_DIRS.map(d => `**/${d}/**`).join(',')}}`;
		const uris = await vscode.workspace.findFiles('**/*', exclude, 5000);
		const results = [];
		for (const uri of uris) {
			if (results.length >= maxResults) { break; }
			const rel = this.relFromUri(uri);
			if (globRegex && !globRegex.test(rel) && !(fileGlob.indexOf('/') === -1 && globRegex.test(path.basename(rel)))) {
				continue;
			}
			if (BINARY_EXTENSIONS.has(path.extname(rel).toLowerCase())) { continue; }
			let bytes;
			try {
				const stat = await vscode.workspace.fs.stat(uri);
				if (stat.size > MAX_SEARCH_FILE_SIZE) { continue; }
				bytes = await vscode.workspace.fs.readFile(uri);
			} catch (_e) { continue; }
			if (looksBinary(bytes)) { continue; }
			const text = Buffer.from(bytes).toString('utf8');
			const lines = text.split(/\r?\n/);
			for (let i = 0; i < lines.length && results.length < maxResults; i++) {
				regex.lastIndex = 0;
				if (regex.test(lines[i])) {
					results.push({ path: rel, line: i + 1, text: lines[i].trim() });
				}
			}
		}
		return results;
	}

	// ── Änderungen (Review-gated) ─────────────────────────────────────────────

	/**
	 * @param {{kind:'write'|'delete', path:string, newContent?:string, summary:string}} change
	 * @returns {Promise<{status:'applied'|'rejected', message?:string, changeId?:string}>}
	 */
	async applyChange(change) {
		const uri = this.resolve(change.path);
		let oldContent = '';
		let exists = false;
		try {
			oldContent = await this.readFile(change.path);
			exists = true;
		} catch (_e) {
			try {
				await vscode.workspace.fs.stat(uri);
				exists = true; // existiert, aber binär/unlesbar
			} catch (_e2) { exists = false; }
		}

		if (change.kind === 'delete' && !exists) {
			return { status: 'rejected', message: 'Datei existiert nicht.' };
		}

		const id = `chg-${++this._changeCounter}`;
		const record = {
			kind: change.kind === 'delete' ? 'delete' : (exists ? 'modify' : 'create'),
			path: change.path,
			oldContent,
			newContent: change.kind === 'delete' ? '' : String(change.newContent ?? ''),
			summary: change.summary || ''
		};
		this.changes.set(id, record);

		const approved = await this.approvals.requestEditApproval({
			id,
			action: record.kind,
			path: record.path,
			summary: record.summary,
			oldLines: record.oldContent ? record.oldContent.split(/\r?\n/).length : 0,
			newLines: record.newContent ? record.newContent.split(/\r?\n/).length : 0
		});

		if (!approved) {
			this.log.info(`Änderung abgelehnt: ${record.kind} ${record.path}`);
			return { status: 'rejected', message: 'Vom Benutzer abgelehnt. Nicht identisch erneut versuchen.', changeId: id };
		}

		if (this.onAgentWrite) { this.onAgentWrite(record.path); }

		if (record.kind === 'delete') {
			await vscode.workspace.fs.delete(uri, { useTrash: true });
			this.log.info(`Gelöscht (Papierkorb): ${record.path}`);
			return { status: 'applied', changeId: id };
		}

		await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
		const dirty = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString() && d.isDirty);

		// Undo-Sicherheit: bevorzugt über WorkspaceEdit schreiben, damit die Änderung
		// im Undo-Stack des Editors landet (Strg+Z stellt den alten Stand wieder her).
		// Fällt nur bei nicht als Text öffenbaren Dateien auf fs.writeFile zurück.
		const viaEdit = record.kind === 'modify'
			? await this._replaceViaWorkspaceEdit(uri, record.newContent)
			: await this._createViaWorkspaceEdit(uri, record.newContent);
		if (!viaEdit) {
			await vscode.workspace.fs.writeFile(uri, Buffer.from(record.newContent, 'utf8'));
			this.log.warn(`FS-Fallback (kein Editor-Undo möglich): ${record.path}`);
		}

		this.log.info(`Angewendet: ${record.kind} ${record.path}${viaEdit ? '' : ' [fs-fallback]'}`);
		const message = dirty
			? 'Übernommen. Hinweis: Die Datei hatte ungespeicherte Änderungen im Editor – der vorherige Stand ist über Rückgängig (Strg+Z) erreichbar.'
			: undefined;
		return { status: 'applied', message, changeId: id };
	}

	/**
	 * Bestehende Datei per WorkspaceEdit vollständig ersetzen und speichern.
	 * @returns {Promise<boolean>} true, wenn angewendet (Undo-fähig); false → Fallback nötig.
	 */
	async _replaceViaWorkspaceEdit(uri, newContent) {
		let doc;
		try {
			doc = await vscode.workspace.openTextDocument(uri);
		} catch (_e) {
			return false; // binär oder nicht als Text öffenbar
		}
		const edit = new vscode.WorkspaceEdit();
		const fullRange = new vscode.Range(
			new vscode.Position(0, 0),
			doc.lineAt(Math.max(doc.lineCount - 1, 0)).range.end
		);
		edit.replace(uri, fullRange, newContent);
		if (!(await vscode.workspace.applyEdit(edit))) {
			return false;
		}
		// Auf Platte speichern, damit read_file/Kommandos den neuen Stand sehen.
		// Undo bleibt erhalten: Strg+Z stellt den alten Inhalt wieder her (Datei wird dirty).
		return doc.isDirty ? doc.save() : true;
	}

	/**
	 * Neue Datei per WorkspaceEdit anlegen (inkl. Inhalt).
	 * @returns {Promise<boolean>} true, wenn angelegt; false → Fallback nötig.
	 */
	async _createViaWorkspaceEdit(uri, newContent) {
		try {
			const edit = new vscode.WorkspaceEdit();
			edit.createFile(uri, { overwrite: true, contents: Buffer.from(newContent, 'utf8') });
			return await vscode.workspace.applyEdit(edit);
		} catch (_e) {
			return false;
		}
	}

	/** Diff-Vorschau für eine (auch bereits entschiedene) Änderung öffnen. */
	async openDiff(changeId) {
		const record = this.changes.get(changeId);
		if (!record) {
			void vscode.window.showWarningMessage('Änderung nicht mehr verfügbar.');
			return;
		}
		const base = path.posix.basename(record.path.replace(/\\/g, '/'));
		const left = vscode.Uri.parse(`${DIFF_SCHEME}:/${changeId}/left/${base}`);
		const right = vscode.Uri.parse(`${DIFF_SCHEME}:/${changeId}/right/${base}`);
		const label = { create: 'Neu', modify: 'Änderung', delete: 'Löschen' }[record.kind] || 'Änderung';
		await vscode.commands.executeCommand('vscode.diff', left, right, `Agent · ${label}: ${record.path}`);
	}

	/** TextDocumentContentProvider für die Diff-Vorschau. */
	createDiffContentProvider() {
		const changes = this.changes;
		return {
			provideTextDocumentContent(uri) {
				const parts = uri.path.split('/').filter(Boolean); // [id, side, name]
				const record = changes.get(parts[0]);
				if (!record) { return ''; }
				return parts[1] === 'left' ? record.oldContent : record.newContent;
			}
		};
	}

	// ── Kommandos ─────────────────────────────────────────────────────────────

	/**
	 * @returns {Promise<{status:'ran'|'skipped', exitCode?:number, stdout?:string, stderr?:string, durationMs?:number, message?:string}>}
	 */
	async runCommand(command, { cwd, timeoutSec, purpose }) {
		let workDir = this.rootUri.fsPath;
		if (cwd) {
			workDir = this.resolve(cwd).fsPath;
		}

		const approval = await this.approvals.requestCommandApproval({ command, cwd: cwd || '.', purpose: purpose || '' });
		const { approved, command: finalCommand } = normalizeCommandApproval(approval, command);
		if (!approved) {
			this.log.info(`Kommando abgelehnt: ${command}`);
			return { status: 'skipped', message: 'Vom Benutzer abgelehnt.' };
		}
		if (finalCommand !== command) {
			this.log.info(`Kommando vom Benutzer angepasst: ${command} → ${finalCommand}`);
		}
		this.log.info(`Kommando gestartet: ${finalCommand} (cwd: ${cwd || '.'})`);

		const timeoutMs = (timeoutSec || this.options.commandTimeoutSec || 180) * 1000;

		// Sichtbares Agent-Terminal (Shell-Integration): Nutzer sieht live, was passiert.
		if (this.options.terminalMode === 'terminal') {
			const viaTerminal = await this._runInTerminal(finalCommand, workDir, timeoutMs);
			if (viaTerminal) { return viaTerminal; }
			this.log.warn('Keine Shell-Integration im Agent-Terminal – Fallback auf gecapturten Lauf.');
		}

		const started = Date.now();
		return new Promise((resolvePromise) => {
			const child = cp.spawn(finalCommand, {
				shell: true,
				cwd: workDir,
				env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' }
			});
			let stdout = '';
			let stderr = '';
			let finished = false;

			const cap = (s, chunk) => (s.length < 400000 ? s + chunk.toString('utf8') : s);
			child.stdout.on('data', c => { stdout = cap(stdout, c); });
			child.stderr.on('data', c => { stderr = cap(stderr, c); });

			const timer = setTimeout(() => {
				if (finished) { return; }
				killTree(child.pid);
				stderr += `\n[Agent] Timeout nach ${timeoutMs / 1000}s – Prozess beendet.`;
			}, timeoutMs);

			const done = (exitCode) => {
				if (finished) { return; }
				finished = true;
				clearTimeout(timer);
				const code = typeof exitCode === 'number' ? exitCode : -1;
				const durationMs = Date.now() - started;
				const logFn = code === 0 ? 'info' : 'warn';
				this.log[logFn](`Kommando beendet (Exit ${code}, ${durationMs} ms): ${finalCommand}`);
				resolvePromise({ status: 'ran', exitCode: code, stdout, stderr, durationMs });
			};
			child.on('error', (err) => {
				stderr += `\n[Agent] Startfehler: ${err.message}`;
				done(-1);
			});
			child.on('close', done);
		});
	}

	/**
	 * Kommando sichtbar im „Agent“-Terminal ausführen (Shell-Integration-API, VS Code ≥1.93).
	 * Liefert null, wenn kein Terminal mit Shell-Integration verfügbar ist (→ Fallback).
	 * Hinweis: Im PTY gibt es keine stdout/stderr-Trennung; alles landet in stdout.
	 * @returns {Promise<{status:'ran', exitCode:number, stdout:string, stderr:string, durationMs:number}|null>}
	 */
	async _runInTerminal(command, workDir, timeoutMs) {
		if (typeof vscode.window.onDidEndTerminalShellExecution !== 'function') {
			return null; // API nicht vorhanden (ältere Basis)
		}
		let terminal = this._agentTerminal;
		const stale = !terminal || terminal.exitStatus !== undefined || this._agentTerminalCwd !== workDir;
		if (stale) {
			if (terminal && terminal.exitStatus === undefined) { terminal.dispose(); }
			terminal = vscode.window.createTerminal({ name: 'Agent', cwd: workDir, isTransient: true });
			this._agentTerminal = terminal;
			this._agentTerminalCwd = workDir;
		}
		terminal.show(true);

		const shellIntegration = await waitForShellIntegration(terminal, 5000);
		if (!shellIntegration) { return null; }

		const started = Date.now();
		const execution = shellIntegration.executeCommand(command);

		let output = '';
		const readDone = (async () => {
			try {
				for await (const data of execution.read()) {
					output = capText(output, stripAnsi(data));
				}
			} catch (_e) { /* Stream endet mit dem Kommando */ }
		})();

		const exitCode = await new Promise((resolve) => {
			const timer = setTimeout(() => { sub.dispose(); resolve('timeout'); }, timeoutMs);
			const sub = vscode.window.onDidEndTerminalShellExecution((e) => {
				if (e.execution === execution) {
					clearTimeout(timer);
					sub.dispose();
					resolve(typeof e.exitCode === 'number' ? e.exitCode : -1);
				}
			});
		});

		if (exitCode === 'timeout') {
			terminal.dispose();
			this._agentTerminal = undefined;
			this.log.warn(`Terminal-Kommando nach ${timeoutMs / 1000}s abgebrochen: ${command}`);
			return {
				status: 'ran',
				exitCode: -1,
				stdout: output,
				stderr: `[Agent] Timeout nach ${timeoutMs / 1000}s – Terminal beendet.`,
				durationMs: Date.now() - started
			};
		}

		// Restausgabe einsammeln (der read-Stream endet kurz nach dem Exit-Event).
		await Promise.race([readDone, new Promise(r => setTimeout(r, 1500))]);
		const durationMs = Date.now() - started;
		const logFn = exitCode === 0 ? 'info' : 'warn';
		this.log[logFn](`Terminal-Kommando beendet (Exit ${exitCode}, ${durationMs} ms): ${command}`);
		return { status: 'ran', exitCode, stdout: output, stderr: '', durationMs };
	}

	// ── Aktivitäts-Index ──────────────────────────────────────────────────────

	/** Vom Provider gesetzter Callback; liefert die aktuelle Aktivitäts-Zusammenfassung. */
	async getRecentActivity() {
		if (this.activityCallback) {
			return this.activityCallback();
		}
		return '(activity tracking unavailable)';
	}

	// ── Diagnostics ───────────────────────────────────────────────────────────

	async getDiagnostics(relPath) {
		const severityNames = ['Error', 'Warning', 'Info', 'Hint'];
		const all = relPath
			? [[this.resolve(relPath), vscode.languages.getDiagnostics(this.resolve(relPath))]]
			: vscode.languages.getDiagnostics();
		const out = [];
		for (const [uri, diags] of all) {
			if (!diags || diags.length === 0) { continue; }
			const rel = this.relFromUri(uri);
			if (rel.startsWith('..')) { continue; }
			for (const d of diags) {
				if (d.severity > vscode.DiagnosticSeverity.Warning) { continue; } // nur Errors + Warnings
				out.push({
					path: rel,
					line: d.range.start.line + 1,
					severity: severityNames[d.severity] || String(d.severity),
					message: d.message,
					source: d.source
				});
			}
		}
		out.sort((a, b) => a.severity.localeCompare(b.severity) || a.path.localeCompare(b.path) || a.line - b.line);
		return out;
	}
}

// ── Hilfsfunktionen ─────────────────────────────────────────────────────────

function renderTree(relPaths) {
	const lines = [];
	const seenDirs = new Set();
	for (const rel of relPaths) {
		const segments = rel.split('/');
		for (let i = 0; i < segments.length - 1; i++) {
			const dir = segments.slice(0, i + 1).join('/');
			if (!seenDirs.has(dir)) {
				seenDirs.add(dir);
				lines.push(`${'  '.repeat(i)}${segments[i]}/`);
			}
		}
		lines.push(`${'  '.repeat(segments.length - 1)}${segments[segments.length - 1]}`);
	}
	return lines;
}

function looksBinary(bytes) {
	const len = Math.min(bytes.length, 4096);
	for (let i = 0; i < len; i++) {
		if (bytes[i] === 0) { return true; }
	}
	return false;
}

function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Kleiner Glob→RegExp-Konverter: **, *, ?, {a,b}. */
function globToRegExp(glob) {
	let out = '^';
	let i = 0;
	const g = String(glob).replace(/\\/g, '/');
	while (i < g.length) {
		const c = g[i];
		if (c === '*') {
			if (g[i + 1] === '*') {
				out += '(?:.*)';
				i += 2;
				if (g[i] === '/') { i++; }
				continue;
			}
			out += '[^/]*';
			i++;
		} else if (c === '?') {
			out += '[^/]';
			i++;
		} else if (c === '{') {
			const end = g.indexOf('}', i);
			if (end === -1) { out += '\\{'; i++; continue; }
			const alts = g.slice(i + 1, end).split(',').map(escapeRegExp).join('|');
			out += `(?:${alts})`;
			i = end + 1;
		} else {
			out += escapeRegExp(c);
			i++;
		}
	}
	return new RegExp(out + '$');
}

/**
 * Auf die Shell-Integration eines Terminals warten (undefined nach Timeout –
 * z. B. Shell ohne Integration oder sehr langsamer Start).
 * @param {vscode.Terminal} terminal
 * @param {number} timeoutMs
 */
function waitForShellIntegration(terminal, timeoutMs) {
	if (terminal.shellIntegration) {
		return Promise.resolve(terminal.shellIntegration);
	}
	return new Promise((resolve) => {
		const timer = setTimeout(() => { sub.dispose(); resolve(undefined); }, timeoutMs);
		const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
			if (e.terminal === terminal) {
				clearTimeout(timer);
				sub.dispose();
				resolve(e.shellIntegration);
			}
		});
	});
}

function killTree(pid) {
	if (!pid) { return; }
	try {
		if (process.platform === 'win32') {
			cp.spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
		} else {
			process.kill(-pid, 'SIGKILL');
		}
	} catch (_e) {
		try { process.kill(pid, 'SIGKILL'); } catch (_e2) { /* weg ist weg */ }
	}
}

module.exports = { WorkspaceHost, DIFF_SCHEME, EXCLUDED_DIRS, globToRegExp, renderTree };
