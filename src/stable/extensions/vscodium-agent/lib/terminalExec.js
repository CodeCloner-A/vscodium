/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – Helfer für die sichtbare Terminal-Ausführung von Agent-Kommandos.
 *
 * Bewusst ohne require('vscode'): reine Funktionen, headless testbar.
 * Die vscode-abhängige Ausführung (Shell-Integration) liegt in lib/workspaceHost.js.
 *--------------------------------------------------------------------------------------------*/

'use strict';

/** Ausgabe-Deckel, identisch zum gecapturten Lauf. */
const OUTPUT_CAP = 400000;

/**
 * ANSI-/VT-Steuersequenzen aus Terminal-Rohdaten entfernen (CSI, OSC, einfache ESC-Folgen)
 * sowie Carriage-Return-Übermalungen auflösen.
 * @param {string} text
 */
function stripAnsi(text) {
	return String(text || '')
		// OSC: ESC ] … BEL oder ESC ] … ESC \  (u. a. Shell-Integration-Marker)
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
		// CSI: ESC [ Parameter/Zwischenzeichen + Endzeichen (Farben, Cursor …)
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
		// Übrige 2-Zeichen-ESC-Folgen (ESC =, ESC >, ESC 7 …)
		.replace(/\x1b[@-_=><~78]/g, '')
		// \r\n normalisieren, dann verbleibende \r als „Zeile übermalt“ interpretieren
		.replace(/\r+\n/g, '\n')
		.replace(/^.*\r(?=[^\n])/gm, '');
}

/**
 * Ergebnis einer Kommando-Freigabe normalisieren. Die Freigabe kann ein einfaches
 * Boolean sein (Alt-/Auto-Pfad) oder ein Objekt mit ggf. vom Benutzer editiertem Kommando.
 * @param {boolean|{approved?: boolean, accept?: boolean, command?: string}} result
 * @param {string} fallbackCommand
 * @returns {{approved: boolean, command: string}}
 */
function normalizeCommandApproval(result, fallbackCommand) {
	if (result === true) { return { approved: true, command: fallbackCommand }; }
	if (!result || typeof result !== 'object') { return { approved: false, command: fallbackCommand }; }
	const approved = Boolean(result.approved !== undefined ? result.approved : result.accept);
	const edited = typeof result.command === 'string' ? result.command.trim() : '';
	return { approved, command: approved && edited ? edited : fallbackCommand };
}

/** Text an den Ausgabe-Deckel anpassen (hinten anfügen, solange Platz ist). */
function capText(existing, chunk) {
	return existing.length < OUTPUT_CAP ? existing + chunk : existing;
}

module.exports = { stripAnsi, normalizeCommandApproval, capText, OUTPUT_CAP };
