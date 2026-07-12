/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – zeilenbasierter Diff für das partielle Annehmen von Inline-Edits.
 *
 * Bewusst ohne require('vscode'): reine Funktionen, headless testbar.
 * Zeilenenden werden logisch behandelt (\n und \r\n gleichwertig); wer Hunks in ein
 * Dokument zurückschreibt, fügt die Zeilen mit dem EOL des Dokuments wieder zusammen.
 *--------------------------------------------------------------------------------------------*/

'use strict';

/** Ab dieser Tabellengröße (alt × neu) fällt der Diff auf einen einzigen Hunk zurück. */
const MAX_CELLS = 4000000;

/** @param {string} s */
function splitLines(s) {
	return String(s ?? '').split(/\r?\n/);
}

/**
 * Hunks zwischen altem und neuem Text, positioniert im NEUEN Text.
 *
 * Ein Hunk beschreibt ein Zeilenfenster im neuen Text (`newStart`, `newCount`,
 * 0-basiert relativ zum Textanfang) und die alten Zeilen (`oldLines`), die es ersetzt.
 * `newCount === 0` ist eine reine Löschung (Einfügepunkt vor Zeile `newStart`),
 * `oldLines.length === 0` eine reine Einfügung.
 *
 * Invariante: Ersetzt man im neuen Text alle Fenster (von hinten nach vorn)
 * durch ihre `oldLines`, entsteht wieder der alte Text.
 *
 * @param {string} oldText
 * @param {string} newText
 * @returns {{newStart: number, newCount: number, oldLines: string[]}[]}
 */
function computeLineHunks(oldText, newText) {
	if (oldText === newText) { return []; }
	const oldLines = splitLines(oldText);
	const newLines = splitLines(newText);
	const n = oldLines.length;
	const m = newLines.length;
	if (n * m > MAX_CELLS) {
		return [{ newStart: 0, newCount: m, oldLines }];
	}

	// LCS-Tabelle: dp[i][j] = Länge der längsten gemeinsamen Teilfolge von old[i:] und new[j:].
	const dp = [];
	for (let i = 0; i <= n; i++) { dp.push(new Int32Array(m + 1)); }
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] = oldLines[i] === newLines[j]
				? dp[i + 1][j + 1] + 1
				: Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}

	// Rückverfolgung: zusammenhängende Nicht-Übereinstimmungen zu Hunks bündeln.
	const hunks = [];
	let i = 0;
	let j = 0;
	let current = null;
	const open = () => {
		if (!current) { current = { newStart: j, newCount: 0, oldLines: [] }; }
	};
	const close = () => {
		if (current) { hunks.push(current); current = null; }
	};
	while (i < n && j < m) {
		if (oldLines[i] === newLines[j]) {
			close();
			i++; j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			open();
			current.oldLines.push(oldLines[i]);
			i++;
		} else {
			open();
			current.newCount++;
			j++;
		}
	}
	if (i < n || j < m) {
		open();
		while (i < n) { current.oldLines.push(oldLines[i++]); }
		while (j < m) { current.newCount++; j++; }
	}
	close();
	return hunks;
}

/**
 * Einen Hunk im neuen Zeilen-Array rückgängig machen (Fenster durch alte Zeilen ersetzen).
 * Gibt die Zeilenverschiebung zurück, um die sich nachfolgende Hunks verschieben.
 * @param {string[]} lines  wird in-place verändert
 * @param {{newStart: number, newCount: number, oldLines: string[]}} hunk
 * @returns {number} Delta in Zeilen (oldLines.length - newCount)
 */
function revertHunkInLines(lines, hunk) {
	lines.splice(hunk.newStart, hunk.newCount, ...hunk.oldLines);
	return hunk.oldLines.length - hunk.newCount;
}

module.exports = { computeLineHunks, revertHunkInLines, splitLines };
