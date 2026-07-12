/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – Inline-Edit im Editor (Strg+I).
 *
 * Ablauf: Auswahl (oder Auto-Block um den Cursor) + Instruktion → Gemini streamt die neue
 * Region live in den Editor (eine einzige Undo-Gruppe). Danach zeigt ein Zeilen-Diff die
 * geänderten Blöcke: grün markiert, pro Block per CodeLens verwerfbar (partielles Annehmen),
 * dazu „Alles behalten / Anpassen… / Alles verwerfen“. „Anpassen…“ startet einen Follow-up
 * auf dem aktuellen Stand; Verwerfen stellt immer den Zustand vor dem ERSTEN Edit wieder her.
 * Alle Verwerfen-Pfade sind durch Text-Vergleiche abgesichert: Wurde die Stelle
 * zwischenzeitlich weiterbearbeitet, wird nichts zerstört (dann hilft Strg+Z).
 * Wird auch von den Quick-Fix-Aktionen („Mit KI beheben“) genutzt.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const vscode = require('vscode');
const path = require('path');
const { buildInlineEditRequest, extractCode, sanitizeStreamText } = require('../lib/inlineEdit');
const { extractText, extractBlockReason, FirebaseAiError } = require('../lib/firebaseClient');
const { ProxyError } = require('../lib/proxyClient');
const { computeLineHunks, revertHunkInLines, splitLines } = require('../lib/lineDiff');

const CONTEXT_LINES = 40;

class InlineEditController {
	/**
	 * @param {import('./chatViewProvider').ChatViewProvider} provider
	 * @param {ReturnType<import('../lib/logger').createLogger>} logger
	 */
	constructor(provider, logger) {
		this.provider = provider;
		this.log = logger;
		this._busy = false;
		this._token = 0;
		/**
		 * Offener Vorschlag. `lines` ist der erwartete aktuelle Regioninhalt (logische Zeilen),
		 * `originalText` der Stand vor dem ERSTEN Edit (bleibt über Follow-ups erhalten).
		 * @type {{
		 *   token: number, uriString: string, baseLine: number, originalText: string,
		 *   lines: string[], hunks: {newStart: number, newCount: number, oldLines: string[]}[],
		 *   relPath: string
		 * }|null}
		 */
		this._pending = null;
		this.decorationType = vscode.window.createTextEditorDecorationType({
			backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
			isWholeLine: true
		});
		this._lensEmitter = new vscode.EventEmitter();
		const self = this;
		this._disposables = [
			this._lensEmitter,
			vscode.languages.registerCodeLensProvider({ scheme: 'file' }, {
				onDidChangeCodeLenses: this._lensEmitter.event,
				provideCodeLenses(document) { return self._provideLenses(document); }
			}),
			vscode.commands.registerCommand('vscodiumAgent.inlineEdit.keepAll', (token) => this._keepAll(token)),
			vscode.commands.registerCommand('vscodiumAgent.inlineEdit.discardAll', (token) => this._discardAll(token)),
			vscode.commands.registerCommand('vscodiumAgent.inlineEdit.revertHunk', (index, token) => this._revertHunk(index, token)),
			vscode.commands.registerCommand('vscodiumAgent.inlineEdit.followUp', (token) => this._followUp(token))
		];
	}

	dispose() {
		for (const d of this._disposables) { d.dispose(); }
		this.decorationType.dispose();
	}

	/**
	 * Inline-Edit starten.
	 * @param {string} [presetInstruction]  Vorgefertigte Instruktion (Quick-Fix); sonst InputBox.
	 * @param {vscode.Range} [rangeOverride] Fester Bereich (Quick-Fix); sonst Auswahl/Auto-Block.
	 * @param {vscode.TextEditor} [editorArg]
	 */
	async run(presetInstruction, rangeOverride, editorArg) {
		const editor = editorArg || vscode.window.activeTextEditor;
		if (!editor || editor.document.uri.scheme !== 'file') {
			void vscode.window.showInformationMessage('Inline-Edit: kein Datei-Editor aktiv.');
			return;
		}
		if (this._busy) {
			void vscode.window.showInformationMessage('Inline-Edit läuft bereits.');
			return;
		}
		// Offener Vorschlag aus dem letzten Lauf → behalten und weitermachen (Strg+Z bleibt möglich).
		if (this._pending) { this._clearPending('behalten (neuer Lauf)'); }

		const doc = editor.document;
		const range = rangeOverride
			? toFullLines(doc, rangeOverride)
			: determineRange(editor);

		const instruction = presetInstruction || await vscode.window.showInputBox({
			title: 'Inline-Edit (KI)',
			prompt: `Was soll mit ${rangeLabel(range)} passieren?`,
			placeHolder: 'z. B. „Fehlerbehandlung ergänzen“, „in einzelne Funktionen aufteilen“, „auf async/await umstellen“',
			ignoreFocusOut: true
		});
		if (!instruction || !instruction.trim()) { return; }

		await this._execute(editor, range, instruction.trim(), null);
	}

	/** Quick-Fix: Diagnostic-Bereich mit vorgefertigter Instruktion umschreiben. */
	async fixDiagnostic(uri, diagnostic) {
		const doc = await vscode.workspace.openTextDocument(uri);
		const editor = await vscode.window.showTextDocument(doc, { preserveFocus: false });
		const source = diagnostic.source ? ` (${diagnostic.source})` : '';
		const instruction = `Behebe dieses Problem${source}: ${diagnostic.message}`;
		await this.run(instruction, diagnostic.range, editor);
	}

	// ── Kernablauf: Anfrage bauen, streamen, Vorschlag präsentieren ──────────

	/**
	 * @param {vscode.TextEditor} editor
	 * @param {vscode.Range} range           Region (ganze Zeilen)
	 * @param {string} instruction
	 * @param {string|null} baseOriginalText Bei Follow-ups: Originalstand vor dem ersten Edit.
	 */
	async _execute(editor, range, instruction, baseOriginalText) {
		const doc = editor.document;
		const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
		this._busy = true;
		try {
			const cfg = this.provider.config();
			const client = await this.provider.buildClient(cfg.inlineEditModel);
			const relPath = vscode.workspace.asRelativePath(doc.uri, false).replace(/\\/g, '/');
			const selection = doc.getText(range);
			const originalText = baseOriginalText !== null ? baseOriginalText : selection;

			const request = buildInlineEditRequest({
				instruction,
				languageId: doc.languageId,
				relPath,
				before: contextBefore(doc, range),
				selection,
				after: contextAfter(doc, range)
			});

			const abort = new AbortController();
			const outcome = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: 'Inline-Edit: KI arbeitet…', cancellable: true },
				async (progress, token) => {
					token.onCancellationRequested(() => abort.abort());
					return this._streamProposal(editor, range, selection, client, request, abort.signal, progress, eol);
				}
			);
			if (!outcome) { return; } // abgebrochen, Ausgangszustand wiederhergestellt

			const { newCode, startLine } = outcome;
			const hunks = computeLineHunks(originalText, newCode);
			if (hunks.length === 0) {
				// Zeilenweise identisch mit dem Original (ggf. nur EOL-Kosmetik) → sauber zurücksetzen.
				await this._replaceRegion(editor, startLine, splitLines(newCode).length, originalText);
				void vscode.window.showInformationMessage('Inline-Edit: Das Modell schlägt keine Änderung vor.');
				return;
			}
			this._present(doc, startLine, originalText, newCode, hunks, relPath);
		} catch (err) {
			if (err && err.name === 'AbortError') { return; }
			this.log.error('Inline-Edit fehlgeschlagen', err);
			const hint = err && err.hint ? ` – ${err.hint}` : '';
			void vscode.window.showErrorMessage(`Inline-Edit fehlgeschlagen: ${err.message || err}${hint}`);
		} finally {
			this._busy = false;
		}
	}

	/**
	 * Antwort streamen und live in die Region schreiben. Alle Zwischenstände plus finale
	 * Ersetzung bilden EINE Undo-Gruppe (undoStop nur vor dem ersten und nach dem letzten Edit).
	 * Fällt auf den nicht-streamenden Aufruf zurück, wenn der Stream scheitert, bevor
	 * etwas gemalt wurde. Bei Abbruch wird der Ausgangszustand wiederhergestellt.
	 * @returns {Promise<{newCode: string, startLine: number}|null>} null bei Nutzer-Abbruch
	 */
	async _streamProposal(editor, range, selection, client, request, signal, progress, eol) {
		const doc = editor.document;
		const startLine = range.start.line;
		const originalLines = splitLines(selection);
		const state = { shownCount: originalLines.length, painted: false, failed: false };
		let queued = null;
		let pump = Promise.resolve();

		const paint = async (text) => {
			if (state.failed) { return; }
			const recvLines = splitLines(text);
			const shownLines = recvLines.length >= originalLines.length
				? recvLines
				: recvLines.concat(originalLines.slice(recvLines.length));
			let ok = false;
			try {
				ok = await this._replaceRegion(editor, startLine, state.shownCount, shownLines.join(eol), {
					undoStopBefore: !state.painted,
					undoStopAfter: false
				});
			} catch (_e) { /* Editor weg oder Edit nicht anwendbar */ }
			if (!ok) { state.failed = true; return; }
			state.painted = true;
			state.shownCount = shownLines.length;
		};

		let received = '';
		let response;
		try {
			response = await client.generateContentStream(request, signal, (text) => {
				received += text;
				queued = sanitizeStreamText(received);
				pump = pump.then(async () => {
					if (queued === null) { return; }
					const next = queued;
					queued = null;
					await paint(next);
				});
				progress.report({ message: `${splitLines(received).length} Zeilen empfangen…` });
			});
		} catch (err) {
			await pump;
			if (err && err.name === 'AbortError') {
				if (state.painted) {
					await this._replaceRegion(editor, startLine, state.shownCount, selection, { undoStopBefore: false, undoStopAfter: true });
				}
				return null;
			}
			if (!state.painted && received === '' && (err instanceof FirebaseAiError || err instanceof ProxyError)) {
				// Stream kam gar nicht zustande (z. B. Endpoint/Proxy ohne SSE) → normaler Aufruf.
				// Gilt für beide Wege: Key-Pfad (FirebaseAiError) und SaaS-Proxy (ProxyError).
				this.log.warn('Streaming nicht verfügbar, Fallback auf generateContent', err);
				response = await client.generateContent(request, signal);
			} else {
				if (state.painted) {
					await this._replaceRegion(editor, startLine, state.shownCount, selection, { undoStopBefore: false, undoStopAfter: true });
				}
				throw err;
			}
		}
		await pump;
		if (state.failed) {
			throw new Error('Das Dokument wurde während des Streamings verändert – Inline-Edit abgebrochen (Strg+Z stellt den Ausgangszustand her).');
		}

		const blocked = extractBlockReason(response);
		if (blocked) {
			if (state.painted) {
				await this._replaceRegion(editor, startLine, state.shownCount, selection, { undoStopBefore: false, undoStopAfter: true });
			}
			throw new Error(blocked);
		}
		const raw = extractCode(extractText(response));
		if (!raw) {
			if (state.painted) {
				await this._replaceRegion(editor, startLine, state.shownCount, selection, { undoStopBefore: false, undoStopAfter: true });
			}
			throw new Error('Das Modell hat keinen Code geliefert.');
		}
		const newCode = splitLines(raw).join(eol); // EOL des Dokuments erzwingen

		const ok = await this._replaceRegion(editor, startLine, state.shownCount, newCode, {
			undoStopBefore: !state.painted,
			undoStopAfter: true
		});
		if (!ok) {
			throw new Error('Änderung konnte nicht angewendet werden.');
		}
		return { newCode, startLine };
	}

	/** Region [startLine, startLine + lineCount) komplett durch text ersetzen. */
	async _replaceRegion(editor, startLine, lineCount, text, undoStops) {
		const doc = editor.document;
		const endLine = Math.min(startLine + Math.max(lineCount, 1) - 1, doc.lineCount - 1);
		const target = new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).range.end.character);
		return editor.edit(
			(builder) => builder.replace(target, text),
			undoStops || { undoStopBefore: true, undoStopAfter: true }
		);
	}

	// ── Vorschlag präsentieren: Markierung, CodeLens, Benachrichtigung ───────

	_present(doc, baseLine, originalText, newCode, hunks, relPath) {
		const token = ++this._token;
		this._pending = {
			token,
			uriString: doc.uri.toString(),
			baseLine,
			originalText,
			lines: splitLines(newCode),
			hunks,
			relPath
		};
		this._refreshUi();
		this.log.info(`Inline-Edit angewendet: ${relPath} (${hunks.length} Block/Blöcke ab Zeile ${baseLine + 1})`);

		void vscode.window.showInformationMessage(
			`Inline-Edit auf ${path.basename(relPath)}: ${hunks.length} geänderte${hunks.length === 1 ? 'r Block' : ' Blöcke'} (nicht gespeichert). Einzelne Blöcke lassen sich über die CodeLens verwerfen.`,
			'Behalten', 'Anpassen…', 'Verwerfen'
		).then((choice) => {
			if (choice === 'Behalten') { this._keepAll(token); }
			else if (choice === 'Anpassen…') { void this._followUp(token); }
			else if (choice === 'Verwerfen') { void this._discardAll(token); }
		});
	}

	/** Prüft, ob der Vorschlag mit diesem Token noch aktuell ist. */
	_current(token) {
		if (!this._pending) { return null; }
		if (typeof token === 'number' && this._pending.token !== token) { return null; }
		return this._pending;
	}

	_document(pending) {
		return vscode.workspace.textDocuments.find(d => d.uri.toString() === pending.uriString);
	}

	_eolOf(doc) {
		return doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
	}

	/** Absolute Range der gesamten Region laut erwartetem Zustand (oder null bei Überlauf). */
	_regionRange(doc, pending) {
		const endLine = pending.baseLine + pending.lines.length - 1;
		if (endLine >= doc.lineCount) { return null; }
		return new vscode.Range(pending.baseLine, 0, endLine, doc.lineAt(endLine).range.end.character);
	}

	/** Stimmt der Dokumentinhalt der Region noch mit dem erwarteten Zustand überein? */
	_regionIntact(doc, pending) {
		const range = this._regionRange(doc, pending);
		if (!range) { return null; }
		return doc.getText(range) === pending.lines.join(this._eolOf(doc)) ? range : null;
	}

	_refreshUi() {
		const pending = this._pending;
		this._lensEmitter.fire();
		const editors = vscode.window.visibleTextEditors.filter(e => pending && e.document.uri.toString() === pending.uriString);
		if (!pending) { return; }
		const doc = editors.length > 0 ? editors[0].document : undefined;
		const ranges = [];
		if (doc) {
			for (const h of pending.hunks) {
				if (h.newCount === 0) { continue; }
				const endLine = Math.min(pending.baseLine + h.newStart + h.newCount - 1, doc.lineCount - 1);
				ranges.push(new vscode.Range(pending.baseLine + h.newStart, 0, endLine, doc.lineAt(endLine).range.end.character));
			}
		}
		for (const e of editors) { e.setDecorations(this.decorationType, ranges); }
	}

	_clearPending(reason) {
		const pending = this._pending;
		this._pending = null;
		if (pending) {
			for (const e of vscode.window.visibleTextEditors) {
				if (e.document.uri.toString() === pending.uriString) { e.setDecorations(this.decorationType, []); }
			}
			if (reason) { this.log.info(`Inline-Edit ${reason}: ${pending.relPath}`); }
		}
		this._lensEmitter.fire();
	}

	_provideLenses(document) {
		const pending = this._pending;
		if (!pending || document.uri.toString() !== pending.uriString) { return []; }
		const lenses = [];
		const headRange = new vscode.Range(pending.baseLine, 0, pending.baseLine, 0);
		lenses.push(new vscode.CodeLens(headRange, {
			title: '✓ Alles behalten', command: 'vscodiumAgent.inlineEdit.keepAll', arguments: [pending.token]
		}));
		lenses.push(new vscode.CodeLens(headRange, {
			title: '✎ Anpassen…', command: 'vscodiumAgent.inlineEdit.followUp', arguments: [pending.token]
		}));
		lenses.push(new vscode.CodeLens(headRange, {
			title: '↩ Alles verwerfen', command: 'vscodiumAgent.inlineEdit.discardAll', arguments: [pending.token]
		}));
		pending.hunks.forEach((hunk, index) => {
			const line = Math.min(pending.baseLine + hunk.newStart, document.lineCount - 1);
			const title = hunk.newCount === 0
				? `↩ ${hunk.oldLines.length} entfernte Zeile${hunk.oldLines.length === 1 ? '' : 'n'} wiederherstellen`
				: '↩ Block verwerfen';
			lenses.push(new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
				title, command: 'vscodiumAgent.inlineEdit.revertHunk', arguments: [index, pending.token]
			}));
		});
		return lenses;
	}

	// ── Aktionen: Behalten / Alles verwerfen / Block verwerfen / Follow-up ───

	_keepAll(token) {
		if (!this._current(token)) { return; }
		this._clearPending('behalten');
	}

	async _discardAll(token) {
		const pending = this._current(token);
		if (!pending) { return; }
		const doc = this._document(pending);
		if (!doc) { this._clearPending('Dokument geschlossen'); return; }
		const range = this._regionIntact(doc, pending);
		if (!range) {
			void vscode.window.showWarningMessage('Die Stelle wurde inzwischen weiterbearbeitet – bitte mit Strg+Z rückgängig machen.');
			this._clearPending();
			return;
		}
		const revert = new vscode.WorkspaceEdit();
		revert.replace(doc.uri, range, pending.originalText);
		await vscode.workspace.applyEdit(revert);
		this._clearPending('verworfen');
	}

	async _revertHunk(index, token) {
		const pending = this._current(token);
		if (!pending || !pending.hunks[index]) { return; }
		const doc = this._document(pending);
		if (!doc) { this._clearPending('Dokument geschlossen'); return; }
		const hunk = pending.hunks[index];
		const eol = this._eolOf(doc);

		// Guard: das Fenster dieses Hunks muss noch dem erwarteten Stand entsprechen.
		if (!this._regionIntact(doc, pending)) {
			void vscode.window.showWarningMessage('Die Stelle wurde inzwischen weiterbearbeitet – blockweises Verwerfen nicht mehr möglich (Strg+Z hilft).');
			this._clearPending();
			return;
		}

		const edit = new vscode.WorkspaceEdit();
		const first = pending.baseLine + hunk.newStart;
		if (hunk.newCount === 0) {
			// Reine Löschung rückgängig machen: alte Zeilen vor `first` wieder einfügen.
			if (first <= doc.lineCount - 1) {
				edit.insert(doc.uri, new vscode.Position(first, 0), hunk.oldLines.join(eol) + eol);
			} else {
				edit.insert(doc.uri, doc.lineAt(doc.lineCount - 1).range.end, eol + hunk.oldLines.join(eol));
			}
		} else {
			const last = first + hunk.newCount - 1;
			if (hunk.oldLines.length === 0) {
				// Reine Einfügung verwerfen: Zeilen samt einem Zeilenumbruch entfernen.
				const delRange = last < doc.lineCount - 1
					? new vscode.Range(first, 0, last + 1, 0)
					: (first > 0
						? new vscode.Range(doc.lineAt(first - 1).range.end, doc.lineAt(last).range.end)
						: new vscode.Range(0, 0, last, doc.lineAt(last).range.end.character));
				edit.delete(doc.uri, delRange);
			} else {
				edit.replace(doc.uri, new vscode.Range(first, 0, last, doc.lineAt(last).range.end.character), hunk.oldLines.join(eol));
			}
		}
		if (!(await vscode.workspace.applyEdit(edit))) {
			void vscode.window.showWarningMessage('Block konnte nicht zurückgesetzt werden.');
			return;
		}

		// Erwarteten Zustand nachziehen und Folge-Hunks verschieben.
		const delta = revertHunkInLines(pending.lines, hunk);
		pending.hunks.splice(index, 1);
		for (const h of pending.hunks) {
			if (h.newStart > hunk.newStart) { h.newStart += delta; }
		}
		this.log.info(`Inline-Edit: Block ${index + 1} verworfen (${pending.relPath})`);
		if (pending.hunks.length === 0) {
			this._clearPending('vollständig blockweise verworfen');
			return;
		}
		this._refreshUi();
	}

	async _followUp(token) {
		const pending = this._current(token);
		if (!pending || this._busy) { return; }
		const doc = this._document(pending);
		if (!doc) { this._clearPending('Dokument geschlossen'); return; }

		const instruction = await vscode.window.showInputBox({
			title: 'Inline-Edit anpassen (Follow-up)',
			prompt: 'Wie soll der Vorschlag geändert werden? („Verwerfen“ stellt weiterhin den Ausgangszustand wieder her.)',
			placeHolder: 'z. B. „kürzer“, „ohne Kommentare“, „nutze die bestehende Hilfsfunktion“',
			ignoreFocusOut: true
		});
		if (!instruction || !instruction.trim()) { return; } // Vorschlag bleibt offen

		const range = this._regionIntact(doc, pending);
		if (!range) {
			void vscode.window.showWarningMessage('Die Stelle wurde inzwischen weiterbearbeitet – Follow-up nicht möglich.');
			return;
		}
		const editor = await vscode.window.showTextDocument(doc, { preserveFocus: false });
		const originalText = pending.originalText;
		this._clearPending('Follow-up gestartet');
		await this._execute(editor, range, instruction.trim(), originalText);
	}
}

// ── Bereichs-Helfer ─────────────────────────────────────────────────────────

/** Auswahl auf ganze Zeilen erweitern; ohne Auswahl: zusammenhängender Block um den Cursor. */
function determineRange(editor) {
	const doc = editor.document;
	if (!editor.selection.isEmpty) {
		return toFullLines(doc, editor.selection);
	}
	const line = editor.selection.active.line;
	if (doc.lineAt(line).isEmptyOrWhitespace) {
		return doc.lineAt(line).range; // leere Zeile = Einfügepunkt
	}
	let start = line;
	while (start > 0 && !doc.lineAt(start - 1).isEmptyOrWhitespace) { start--; }
	let end = line;
	while (end < doc.lineCount - 1 && !doc.lineAt(end + 1).isEmptyOrWhitespace) { end++; }
	return new vscode.Range(start, 0, end, doc.lineAt(end).range.end.character);
}

function toFullLines(doc, range) {
	const start = new vscode.Position(range.start.line, 0);
	const endLine = Math.min(range.end.line, doc.lineCount - 1);
	return new vscode.Range(start, doc.lineAt(endLine).range.end);
}

function contextBefore(doc, range) {
	const from = Math.max(0, range.start.line - CONTEXT_LINES);
	if (from >= range.start.line) { return ''; }
	return doc.getText(new vscode.Range(from, 0, range.start.line, 0)).replace(/\r?\n$/, '');
}

function contextAfter(doc, range) {
	const from = range.end.line + 1;
	if (from >= doc.lineCount) { return ''; }
	const to = Math.min(doc.lineCount - 1, range.end.line + CONTEXT_LINES);
	return doc.getText(new vscode.Range(from, 0, to, doc.lineAt(to).range.end.character));
}

function rangeLabel(range) {
	return range.start.line === range.end.line
		? `Zeile ${range.start.line + 1}`
		: `den Zeilen ${range.start.line + 1}–${range.end.line + 1}`;
}

module.exports = { InlineEditController };
