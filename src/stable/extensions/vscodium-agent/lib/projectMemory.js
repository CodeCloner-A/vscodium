/*---------------------------------------------------------------------------------------------
 * PHI47 – Projekt-Gedächtnis (pur, ohne vscode-Abhängigkeit).
 *
 * Idee: Was dauerhaft gilt, gehört ins Projekt – nicht in eine Cloud-Datenbank.
 * Der Agent liest zu Beginn jedes Laufs eine Markdown-Datei im Projektordner und
 * darf sie mit Freigabe des Nutzers ergänzen (Werkzeug `remember`). Damit weiß er
 * beim nächsten Öffnen wieder, welche Technik das Projekt nutzt, welche
 * Entscheidungen gefallen sind und was der Nutzer NICHT will.
 *
 * Datensparsamkeit: Die Datei liegt im Projekt (versionierbar, einsehbar, löschbar).
 * Es geht nichts an den Dienst, was nicht ohnehin im Prompt stünde.
 *
 * Kompatibilität: Existiert die eigene Datei nicht, werden verbreitete
 * Agenten-Dateien anderer Werkzeuge gelesen (AGENTS.md, CLAUDE.md) – geschrieben
 * wird immer nur in die eigene.
 *--------------------------------------------------------------------------------------------*/

'use strict';

/** Eigene Gedächtnis-Datei (relativ zum Projekt-Root). */
const MEMORY_PATH = '.phi47/projekt.md';

/** Nur-Lese-Kompatibilität mit anderen Agenten-Werkzeugen (Reihenfolge = Vorrang). */
const COMPAT_PATHS = ['AGENTS.md', 'CLAUDE.md'];

/** Deckel für den Prompt-Anteil: Gedächtnis darf den Kontext nicht auffressen. */
const MAX_MEMORY_CHARS = 8000;

const HEADER = [
	'# Projekt-Gedächtnis',
	'',
	'Was PHI47 über dieses Projekt dauerhaft wissen soll. Der Agent liest diese Datei zu',
	'Beginn jedes Laufs und ergänzt sie nur mit Deiner Freigabe. Du kannst sie jederzeit',
	'von Hand bearbeiten oder löschen.',
	''
].join('\n');

/** Überschrift, unter der neue Einträge landen. */
const FACTS_HEADING = '## Gemerkt';

/**
 * Gedächtnis-Text für den System-Prompt aufbereiten (gekappt, ohne leere Hülle).
 * @param {string|null|undefined} text Inhalt der Gedächtnis-Datei
 * @param {string} [source] Herkunft (Dateiname) – hilft dem Modell beim Einordnen
 * @returns {string} Prompt-Abschnitt oder '' (dann nichts einfügen)
 */
function buildMemorySection(text, source = MEMORY_PATH) {
	const content = String(text || '').trim();
	if (!content) { return ''; }
	const capped = content.length > MAX_MEMORY_CHARS
		? `${content.slice(0, MAX_MEMORY_CHARS)}\n[… gekürzt – ältere Einträge stehen in ${source}]`
		: content;
	return [
		`== Project memory (${source}) ==`,
		'Durable knowledge about THIS project, written earlier by the user or by you with their approval.',
		'Treat it as established context: follow these decisions and preferences instead of re-asking.',
		'If something here contradicts what you see in the code, trust the code and point out the discrepancy.',
		'',
		capped
	].join('\n');
}

/** Einen Eintrag normalisieren: eine Zeile, keine Aufzählungszeichen, getrimmt. */
function normalizeFact(fact) {
	// Reihenfolge zählt: erst trimmen, dann Aufzählungszeichen abstreifen
	// (sonst steht bei „  * Text“ noch ein Leerzeichen vor dem Sternchen).
	return String(fact || '')
		.trim()
		.replace(/^[-*•]\s*/, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Steht der Fakt sinngemäß schon drin? (Vergleich ohne Groß-/Kleinschreibung,
 * Satzzeichen und Datumspräfix – verhindert, dass dieselbe Erkenntnis mehrfach landet.)
 */
function containsFact(existing, fact) {
	const key = (s) => String(s || '')
		.toLowerCase()
		.replace(/^\s*[-*]\s*/, '')
		.replace(/^\(\d{4}-\d{2}-\d{2}\)\s*/, '')
		.replace(/[.,;:!?"'`()]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	const needle = key(normalizeFact(fact));
	if (!needle) { return true; }
	return String(existing || '').split('\n').some(line => {
		const l = key(line);
		return l.length > 0 && (l === needle || (l.length > 24 && needle.length > 24 && (l.includes(needle) || needle.includes(l))));
	});
}

/**
 * Fakt in den Gedächtnis-Text einfügen. Legt Kopf und Abschnitt bei Bedarf an,
 * hängt neue Einträge unten an die Liste (Chronologie bleibt lesbar).
 * @param {string|null|undefined} existing bisheriger Dateiinhalt
 * @param {string} fact
 * @param {{ today?: string }} [options] today = YYYY-MM-DD (Test-Injektion)
 * @returns {{ content: string, changed: boolean, entry: string }}
 */
function appendFact(existing, fact, options = {}) {
	const clean = normalizeFact(fact);
	const current = String(existing || '');
	if (!clean) { return { content: current, changed: false, entry: '' }; }
	if (containsFact(current, clean)) { return { content: current, changed: false, entry: clean }; }

	const today = options.today || new Date().toISOString().slice(0, 10);
	const entry = `- (${today}) ${clean}`;

	let base = current.trim() ? current.replace(/\s*$/, '') : HEADER.trimEnd();
	if (!base.includes(FACTS_HEADING)) {
		base += `\n\n${FACTS_HEADING}\n`;
	}
	// Neuer Eintrag ans Ende des Gemerkt-Abschnitts (bzw. der Datei, wenn er zuletzt steht).
	const idx = base.indexOf(FACTS_HEADING);
	const nextHeading = base.indexOf('\n## ', idx + FACTS_HEADING.length);
	if (nextHeading === -1) {
		base = `${base.replace(/\s*$/, '')}\n${entry}`;
	} else {
		const head = base.slice(0, nextHeading).replace(/\s*$/, '');
		base = `${head}\n${entry}\n${base.slice(nextHeading)}`;
	}
	return { content: `${base.replace(/\s*$/, '')}\n`, changed: true, entry };
}

/** Prompt-Regeln fürs Merken (kommen in den System-Prompt, wenn das Werkzeug verfügbar ist). */
const MEMORY_RULES = [
	'== Project memory rules ==',
	`Use the tool "remember" to store durable knowledge about this project in ${MEMORY_PATH}: chosen stack and versions, architecture decisions, naming and style preferences, deployment facts, and explicit user preferences ("always use X", "never do Y").`,
	'Store it the moment such a decision becomes clear – one short, self-contained sentence per fact, in German.',
	'Do NOT store: transient task status, code you just wrote, anything obvious from the code itself, and NEVER secrets, tokens, passwords or personal data.',
	'The user approves every entry, so ask yourself: will this still matter next week?'
].join('\n');

module.exports = {
	MEMORY_PATH,
	COMPAT_PATHS,
	MAX_MEMORY_CHARS,
	HEADER,
	FACTS_HEADING,
	MEMORY_RULES,
	buildMemorySection,
	normalizeFact,
	containsFact,
	appendFact
};
