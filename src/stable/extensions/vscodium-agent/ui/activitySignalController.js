/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – Editor-Glue der Aktivitäts-Signale (Stufe 1, ohne Core-Patch).
 *
 * Terminal-Signal: stabile Shell-Integration-Events (onDidStart/EndTerminalShellExecution)
 * decken JEDES Terminal ab – auch flutter run/npm run dev des Nutzers.
 * Agent-Signal: handleAgentRequest meldet Läufe über das Modul-Singleton (agentActivity).
 *
 * Wirkung: Statusleisten-Puls (animiertes Spinner-Icon) + farbige Rahmen über
 * workbench.colorCustomizations (Merge-/Strip-Logik in lib/activitySignal.js schützt
 * eigene Nutzer-Farben; beim Start werden Crash-Reste aufgeräumt).
 * Einstellung: vscodiumAgent.activitySignal (an/aus, wirkt sofort).
 *--------------------------------------------------------------------------------------------*/

'use strict';

const vscode = require('vscode');
const { ActivitySignal, applySignalColors, stripSignalColors, statusText } = require('../lib/activitySignal');

/** Modul-Singleton: erlaubt anderen Teilen (nativeChatController) das Agent-Signal. */
const agentActivity = {
	_impl: null,
	started() { if (this._impl) { this._impl.agentStarted(); } },
	ended() { if (this._impl) { this._impl.agentEnded(); } }
};

function isEnabled() {
	return vscode.workspace.getConfiguration('vscodiumAgent').get('activitySignal', true);
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {{ info: Function, warn: Function }} logger
 */
function registerActivitySignal(context, logger) {
	const signal = new ActivitySignal();
	const statusItem = vscode.window.createStatusBarItem('vscodiumAgent.activity', vscode.StatusBarAlignment.Left, 10000);
	statusItem.name = 'Agent-Aktivität';
	context.subscriptions.push(statusItem);

	let writing = Promise.resolve();
	const syncColors = (state) => {
		// Schreibvorgänge serialisieren – Settings-Updates dürfen sich nicht überholen.
		writing = writing.then(async () => {
			try {
				const workbench = vscode.workspace.getConfiguration('workbench');
				const current = workbench.get('colorCustomizations') || {};
				const effective = isEnabled() ? state : { terminal: false, agent: false };
				const { colors, changed } = applySignalColors(current, effective);
				if (changed) {
					await workbench.update('colorCustomizations', Object.keys(colors).length > 0 ? colors : undefined, vscode.ConfigurationTarget.Global);
				}
			} catch (err) {
				logger.warn('Aktivitäts-Signal: Farb-Update nicht möglich.', err);
			}
		});
		return writing;
	};

	const update = () => {
		const state = signal.state();
		const text = isEnabled() ? statusText(state) : null;
		if (text) {
			statusItem.text = text;
			statusItem.tooltip = state.agent
				? 'Der Agent liest oder ändert gerade Dateien in deinem Projekt.'
				: 'Im Terminal läuft gerade ein Kommando.';
			statusItem.show();
		} else {
			statusItem.hide();
		}
		void syncColors(state);
	};

	// Crash-Reste früherer Sitzungen aufräumen (hängengebliebene Signalfarben).
	void syncColors({ terminal: false, agent: false });

	// Terminal-Signal (Feature-Detection für fremde/ältere Basen).
	if (typeof vscode.window.onDidStartTerminalShellExecution === 'function') {
		context.subscriptions.push(
			vscode.window.onDidStartTerminalShellExecution(() => { signal.terminalStarted(); update(); }),
			vscode.window.onDidEndTerminalShellExecution(() => { signal.terminalEnded(); update(); })
		);
	} else {
		logger.info('Aktivitäts-Signal: Shell-Integration-Events nicht verfügbar – Terminal-Signal bleibt aus.');
	}

	// Setting-Wechsel wirkt sofort (an → beim nächsten Ereignis; aus → sofort aufräumen).
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
		if (e.affectsConfiguration('vscodiumAgent.activitySignal')) { update(); }
	}));

	// Beim Beenden alles zurücksetzen.
	context.subscriptions.push({ dispose: () => { statusItem.hide(); void syncColors({ terminal: false, agent: false }); } });

	agentActivity._impl = {
		agentStarted() { signal.agentStarted(); update(); },
		agentEnded() { signal.agentEnded(); update(); }
	};
	logger.info('Aktivitäts-Signal aktiv (Statusleiste + Rahmenfarben; Einstellung vscodiumAgent.activitySignal).');
}

module.exports = { registerActivitySignal, agentActivity };
