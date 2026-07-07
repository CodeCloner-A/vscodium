/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – Aktivitäts-Index.
 *
 * Beobachtet, WO der Benutzer arbeitet (nicht was er tippt): zuletzt bearbeitete,
 * gespeicherte, betrachtete und extern geänderte Dateien. Daraus entsteht pro
 * Aufgabe eine frische Kontext-Zusammenfassung für das Modell – inklusive der
 * Delta-Liste "was wurde seit der letzten Erfassung durch den Agenten angefasst".
 *
 * Scoring: "Frecency" – Frequenz × Aktualität mit exponentiellem Zeitverfall
 * (Halbwertszeit 30 Minuten). Bearbeiten wiegt stärker als Speichern, Speichern
 * stärker als Betrachten. Agent-eigene Schreibvorgänge werden getrennt geführt,
 * damit sie die Nutzer-Spur nicht verfälschen.
 *
 * Diese Klasse ist bewusst frei von VS-Code-APIs (headless testbar);
 * das Event-Wiring passiert in extension.js.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const HALF_LIFE_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 200;

const WEIGHTS = { edit: 5, save: 3, view: 1, fs: 1 };

class ActivityIndex {
	/** @param {() => number} [clock] Zeitquelle (für Tests injizierbar). */
	constructor(clock) {
		this.clock = clock || Date.now;
		/** @type {Map<string, {lastEdit:number, lastSave:number, lastView:number, lastFsChange:number, lastAgentWrite:number, editCount:number, saveCount:number, viewCount:number, fsCount:number}>} */
		this.files = new Map();
		/** @type {{path:string, line:number}|null} */
		this.activeFile = null;
		this.dirty = false;
	}

	_record(path) {
		let r = this.files.get(path);
		if (!r) {
			r = { lastEdit: 0, lastSave: 0, lastView: 0, lastFsChange: 0, lastAgentWrite: 0, editCount: 0, saveCount: 0, viewCount: 0, fsCount: 0 };
			this.files.set(path, r);
			this._prune();
		}
		return r;
	}

	_prune() {
		if (this.files.size <= MAX_ENTRIES) { return; }
		const now = this.clock();
		const scored = [...this.files.entries()]
			.map(([path, r]) => ({ path, score: this._score(r, now) }))
			.sort((a, b) => a.score - b.score);
		for (const { path } of scored.slice(0, this.files.size - MAX_ENTRIES)) {
			this.files.delete(path);
		}
	}

	noteEdit(path) {
		const r = this._record(path);
		r.lastEdit = this.clock();
		r.editCount++;
		this.dirty = true;
	}

	noteSave(path) {
		const r = this._record(path);
		r.lastSave = this.clock();
		r.saveCount++;
		this.dirty = true;
	}

	noteView(path, line) {
		const r = this._record(path);
		r.lastView = this.clock();
		r.viewCount++;
		this.activeFile = { path, line: line || 0 };
		this.dirty = true;
	}

	/** Änderung im Dateisystem außerhalb des Editors (git, andere Tools). */
	noteFsChange(path) {
		const r = this._record(path);
		r.lastFsChange = this.clock();
		r.fsCount++;
		this.dirty = true;
	}

	noteAgentWrite(path) {
		const r = this._record(path);
		r.lastAgentWrite = this.clock();
		this.dirty = true;
	}

	noteRemoved(path) {
		this.files.delete(path);
		if (this.activeFile && this.activeFile.path === path) { this.activeFile = null; }
		this.dirty = true;
	}

	noteRenamed(oldPath, newPath) {
		const r = this.files.get(oldPath);
		if (r) {
			this.files.delete(oldPath);
			this.files.set(newPath, r);
		}
		if (this.activeFile && this.activeFile.path === oldPath) { this.activeFile.path = newPath; }
		this.dirty = true;
	}

	/** Frecency-Score eines Eintrags. */
	_score(r, now) {
		const decayed = (last, count, weight) => {
			if (!last || !count) { return 0; }
			const decay = Math.pow(0.5, (now - last) / HALF_LIFE_MS);
			return weight * decay * Math.min(count, 50);
		};
		return decayed(r.lastEdit, r.editCount, WEIGHTS.edit)
			+ decayed(r.lastSave, r.saveCount, WEIGHTS.save)
			+ decayed(r.lastView, r.viewCount, WEIGHTS.view)
			+ decayed(r.lastFsChange, r.fsCount, WEIGHTS.fs);
	}

	/** Letzter nutzer- oder systemseitiger Berührungszeitpunkt (ohne reine Agent-Writes). */
	_lastTouched(r) {
		return Math.max(r.lastEdit, r.lastSave, r.lastFsChange);
	}

	/**
	 * Dateien, die seit einem Zeitpunkt angefasst wurden (z. B. seit der letzten
	 * Kontext-Erfassung durch den Agenten). Reine Agent-Writes werden markiert.
	 * @param {number} sinceTs
	 * @returns {Array<{path:string, when:number, kind:string, byAgent:boolean}>}
	 */
	changedSince(sinceTs) {
		const out = [];
		for (const [path, r] of this.files) {
			const touched = Math.max(this._lastTouched(r), r.lastAgentWrite);
			if (touched <= sinceTs) { continue; }
			let kind = 'changed';
			if (r.lastEdit === touched) { kind = 'edited'; }
			else if (r.lastSave === touched) { kind = 'saved'; }
			else if (r.lastAgentWrite === touched) { kind = 'written'; }
			out.push({
				path,
				when: touched,
				kind,
				byAgent: r.lastAgentWrite === touched && r.lastAgentWrite > this._lastTouched(r)
			});
		}
		return out.sort((a, b) => b.when - a.when);
	}

	/**
	 * Zusammenfassung für den Modell-Kontext (englisch, da Systemprompt englisch).
	 * @param {number} [max] max. Dateieinträge je Abschnitt
	 * @param {number} [sinceTs] Zeitpunkt der letzten Agent-Erfassung (0 = keine)
	 */
	summary(max = 8, sinceTs = 0) {
		const now = this.clock();
		const lines = [];

		if (this.activeFile) {
			lines.push(`Active file in editor: ${this.activeFile.path}${this.activeFile.line ? ` (around line ${this.activeFile.line})` : ''}`);
		}

		if (sinceTs > 0) {
			const delta = this.changedSince(sinceTs).slice(0, max);
			if (delta.length > 0) {
				lines.push(`Touched since your last context capture (${ago(now, sinceTs)}):`);
				for (const d of delta) {
					lines.push(`- ${d.path} — ${d.kind} ${ago(now, d.when)}${d.byAgent ? ' (by you, the agent)' : ''}`);
				}
			} else {
				lines.push(`No files were touched since your last context capture (${ago(now, sinceTs)}).`);
			}
		}

		const ranked = [...this.files.entries()]
			.map(([path, r]) => ({ path, r, score: this._score(r, now) }))
			.filter(x => x.score > 0.05)
			.sort((a, b) => b.score - a.score)
			.slice(0, max);

		if (ranked.length > 0) {
			lines.push('Files the user worked on recently (most relevant first):');
			for (const { path, r } of ranked) {
				const parts = [];
				if (r.lastEdit) { parts.push(`edited ${ago(now, r.lastEdit)} (${r.editCount}x)`); }
				else if (r.lastSave) { parts.push(`saved ${ago(now, r.lastSave)}`); }
				else if (r.lastFsChange) { parts.push(`changed on disk ${ago(now, r.lastFsChange)}`); }
				else if (r.lastView) { parts.push(`viewed ${ago(now, r.lastView)}`); }
				if (r.lastAgentWrite && r.lastAgentWrite > (r.lastEdit || 0)) { parts.push('last write by agent'); }
				lines.push(`- ${path} — ${parts.join(', ')}`);
			}
		}

		return lines.length > 0 ? lines.join('\n') : '(no recorded user activity yet)';
	}

	toJSON() {
		return {
			activeFile: this.activeFile,
			files: [...this.files.entries()]
		};
	}

	static fromJSON(data, clock) {
		const idx = new ActivityIndex(clock);
		if (data && Array.isArray(data.files)) {
			for (const [path, r] of data.files) {
				if (typeof path === 'string' && r && typeof r === 'object') {
					idx.files.set(path, {
						lastEdit: r.lastEdit || 0,
						lastSave: r.lastSave || 0,
						lastView: r.lastView || 0,
						lastFsChange: r.lastFsChange || 0,
						lastAgentWrite: r.lastAgentWrite || 0,
						editCount: r.editCount || 0,
						saveCount: r.saveCount || 0,
						viewCount: r.viewCount || 0,
						fsCount: r.fsCount || 0
					});
				}
			}
			idx.activeFile = data.activeFile || null;
		}
		return idx;
	}
}

function ago(now, then) {
	const s = Math.max(0, Math.round((now - then) / 1000));
	if (s < 60) { return 'just now'; }
	const m = Math.round(s / 60);
	if (m < 60) { return `${m} min ago`; }
	const h = Math.round(m / 60);
	if (h < 48) { return `${h} h ago`; }
	return `${Math.round(h / 24)} days ago`;
}

module.exports = { ActivityIndex, HALF_LIFE_MS };
