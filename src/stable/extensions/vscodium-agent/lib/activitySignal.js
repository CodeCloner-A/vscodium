/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – Signalzentrale für Aktivitäts-Anzeigen (KEEP IT SIMPLE: „da passiert was“).
 *
 * Headless testbar, bewusst ohne vscode-Import. Zwei Signalquellen:
 *   - terminal: irgendwo läuft ein Kommando (Shell-Integration-Events, z. B. flutter run)
 *   - agent:    ein Agent-/Plan-Lauf ist aktiv (der Agent liest/ändert gerade den Workspace)
 *
 * Die Optik (Stufe 1, ohne Core-Patch): Statusleisten-Puls + farbige Rahmen über
 * workbench.colorCustomizations. Die Merge-/Strip-Helfer hier garantieren, dass
 * NUR unsere Signalfarben gesetzt und wieder entfernt werden – eigene Farb-
 * Anpassungen des Nutzers bleiben unangetastet (fremdbelegte Schlüssel werden
 * nie überschrieben). Stufe 2 (echtes Pulsieren per CSS-Patch) folgt in der
 * Produkt-Identitäts-Runde.
 *--------------------------------------------------------------------------------------------*/

'use strict';

/**
 * Signalfarben je Quelle – Werte aus der PHI47-Palette (Gold für laufende Kommandos,
 * Blau für den arbeitenden Agenten). Die Werte sind zugleich Marker: Nur exakt diese
 * werden beim Aufräumen wieder entfernt.
 */
const SIGNAL_COLORS = {
	terminal: {
		'terminal.border': '#E0B84AAA',
		'panel.border': '#E0B84AAA'
	},
	agent: {
		'editorGroup.border': '#7FB2E5AA',
		'tab.activeBorder': '#7FB2E5AA',
		'sideBar.border': '#7FB2E5AA'
	}
};

const SIGNAL_VALUES = new Set(
	Object.values(SIGNAL_COLORS).flatMap(colors => Object.values(colors))
);

/** Zählt parallele Aktivitäten (mehrere Terminals, überlappende Läufe). */
class ActivitySignal {
	constructor() {
		this.terminalCount = 0;
		this.agentCount = 0;
	}
	terminalStarted() { this.terminalCount++; return this.state(); }
	terminalEnded() { this.terminalCount = Math.max(0, this.terminalCount - 1); return this.state(); }
	agentStarted() { this.agentCount++; return this.state(); }
	agentEnded() { this.agentCount = Math.max(0, this.agentCount - 1); return this.state(); }
	state() {
		return { terminal: this.terminalCount > 0, agent: this.agentCount > 0 };
	}
}

/** Gewünschte Farb-Overrides für einen Zustand. */
function colorOverrides(state) {
	const out = {};
	if (state && state.terminal) { Object.assign(out, SIGNAL_COLORS.terminal); }
	if (state && state.agent) { Object.assign(out, SIGNAL_COLORS.agent); }
	return out;
}

/**
 * Unsere Signalfarben aus bestehenden colorCustomizations entfernen.
 * Entfernt einen Schlüssel NUR, wenn er exakt einen unserer Signalwerte trägt –
 * eigene Nutzer-Farben bleiben erhalten.
 */
function stripSignalColors(existing) {
	const out = {};
	for (const [key, value] of Object.entries(existing || {})) {
		if (!SIGNAL_VALUES.has(value)) { out[key] = value; }
	}
	return out;
}

/**
 * Zustand in colorCustomizations einmischen. Fremdbelegte Schlüssel (Nutzer hat
 * z. B. selbst eine terminal.border gesetzt) werden respektiert und NICHT überschrieben.
 * @returns {{ colors: object, changed: boolean }}
 */
function applySignalColors(existing, state) {
	const base = stripSignalColors(existing);
	const overrides = colorOverrides(state);
	const out = { ...base };
	for (const [key, value] of Object.entries(overrides)) {
		if (!(key in base)) { out[key] = value; }
	}
	const changed = JSON.stringify(out) !== JSON.stringify(existing || {});
	return { colors: out, changed };
}

/** Text für die Statusleiste (Agent-Signal gewinnt); null = ausblenden. */
function statusText(state) {
	if (state && state.agent) { return '$(loading~spin) Agent arbeitet …'; }
	if (state && state.terminal) { return '$(terminal) Kommando läuft …'; }
	return null;
}

module.exports = { ActivitySignal, SIGNAL_COLORS, colorOverrides, stripSignalColors, applySignalColors, statusText };
