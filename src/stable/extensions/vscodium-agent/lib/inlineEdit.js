/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – Inline-Edit-Kernlogik (Prompt-Aufbau + Antwort-Parsing).
 *
 * Bewusst ohne require('vscode'): reine Funktionen, headless testbar.
 * Verwendet vom Inline-Edit-Controller (Strg+I), den Quick-Fixes und dem
 * „In Datei übernehmen“-Button an Chat-Codeblöcken.
 *--------------------------------------------------------------------------------------------*/

'use strict';

/** Zeilenlimit für „ganze Datei anwenden“ (vgl. Cursors /edit-Limit). */
const APPLY_MAX_LINES = 400;

/**
 * GenerateContentRequest für einen Inline-Edit (Region einer Datei umschreiben).
 * @param {{
 *   instruction: string,
 *   languageId: string,
 *   relPath: string,
 *   before: string,
 *   selection: string,
 *   after: string
 * }} p
 */
function buildInlineEditRequest(p) {
	const system = [
		'You are the inline code editing engine of the VSCodium IDE.',
		'You receive one code REGION from a file plus an instruction. Rewrite the REGION according to the instruction.',
		'Rules:',
		'1. Output ONLY the replacement code for the REGION - no explanations, no markdown fences, no line numbers.',
		'2. Do not repeat the surrounding context; it is shown for reference only.',
		'3. Preserve the file\'s indentation style (tabs vs. spaces) and its formatting conventions.',
		'4. Keep the change minimal: touch only what the instruction requires.',
		'5. If the instruction is a question rather than an edit request, return the REGION unchanged.'
	].join('\n');

	const user = [
		`File: ${p.relPath} (language: ${p.languageId})`,
		'',
		'--- Context before region ---',
		p.before || '(start of file)',
		'--- REGION to rewrite ---',
		p.selection,
		'--- Context after region ---',
		p.after || '(end of file)',
		'',
		'--- Instruction ---',
		p.instruction
	].join('\n');

	return {
		systemInstruction: { parts: [{ text: system }] },
		contents: [{ role: 'user', parts: [{ text: user }] }],
		generationConfig: { temperature: 0.2, maxOutputTokens: 8192 }
	};
}

/**
 * GenerateContentRequest, um einen Chat-Codeblock in eine Datei zu integrieren
 * (Modell liefert den kompletten neuen Dateiinhalt).
 * @param {{ code: string, fileContent: string, relPath: string, languageId: string }} p
 */
function buildApplyRequest(p) {
	const system = [
		'You are the code merge engine of the VSCodium IDE.',
		'You receive the full content of a file and a code snippet suggested in a chat.',
		'Integrate the snippet into the file at the correct place: replace the code it is meant to replace, or insert it where it belongs.',
		'Rules:',
		'1. Output ONLY the complete new file content - no explanations, no markdown fences.',
		'2. Keep every part of the file that is unrelated to the snippet byte-identical.',
		'3. Preserve the file\'s indentation style and formatting conventions.',
		'4. If the snippet clearly does not belong into this file, return the file content unchanged.'
	].join('\n');

	const user = [
		`File: ${p.relPath} (language: ${p.languageId})`,
		'',
		'--- Current file content ---',
		p.fileContent,
		'--- Snippet to integrate ---',
		p.code
	].join('\n');

	return {
		systemInstruction: { parts: [{ text: system }] },
		contents: [{ role: 'user', parts: [{ text: user }] }],
		generationConfig: { temperature: 0.1, maxOutputTokens: 16384 }
	};
}

/**
 * Code aus einer Modellantwort extrahieren.
 * Bevorzugt den ersten Markdown-Fence-Block (Modelle ignorieren „keine Fences“ gern);
 * ohne Fences wird der Rohtext nur von Leerzeilen am Rand befreit.
 * Einrückung der ersten Zeile bleibt erhalten.
 * @param {string} text
 * @returns {string}
 */
function extractCode(text) {
	const raw = String(text || '');
	const fence = /```[^\n`]*\n([\s\S]*?)```/.exec(raw);
	if (fence) {
		return trimEdges(fence[1]);
	}
	return trimEdges(raw);
}

/** Leerzeilen am Anfang und Whitespace am Ende entfernen – Einrückung unangetastet. */
function trimEdges(s) {
	return String(s).replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '');
}

/**
 * Teilantwort während des Streamings säubern: öffnende Fence-Zeile am Anfang und
 * (ggf. unvollständige) schließende Fence am Ende entfernen, führende Leerzeilen kappen.
 * Kein trimEdges am Ende – während des Streams wächst der Text noch.
 * @param {string} text
 */
function sanitizeStreamText(text) {
	let s = String(text || '');
	s = s.replace(/^\s*```[^\n]*\n?/, '');       // öffnende Fence (inkl. Sprach-Tag)
	s = s.replace(/\n`{1,3}\s*$/, '');           // schließende Fence, auch erst teilweise empfangen
	return s.replace(/^(?:[ \t]*\r?\n)+/, '');
}

module.exports = { buildInlineEditRequest, buildApplyRequest, extractCode, sanitizeStreamText, APPLY_MAX_LINES };
