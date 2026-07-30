/*---------------------------------------------------------------------------------------------
 * PHI47 – Kern-Dienst der Extension (Motor-Schicht ohne eigene Oberfläche).
 *
 * Hervorgegangen aus dem Chat-Webview (bis v0.16.0 `ui/chatViewProvider.js`), das mit dem
 * Rückbau der doppelten Chat-UI entfallen ist: Die Oberfläche stellt seit v0.17.0
 * ausschließlich der native Core-Chat. Übrig bleibt, was alle Aufrufer brauchen –
 * Einstellungen, Proxy-Client, Anmeldung, Modell-Katalog und der Workspace-Host.
 *
 * Nutzer: ui/nativeChatController.js (Chat/Plan-Modi, Modell-Picker), ui/inlineEditController.js
 * (Strg+I, Quick-Fixes), extension.js (Kommandos).
 *--------------------------------------------------------------------------------------------*/

'use strict';

const vscode = require('vscode');
const { ProxyClient, ProxyError } = require('../lib/proxyClient');
const { WorkspaceHost } = require('../lib/workspaceHost');

/** Zeitpunkt der letzten Kontext-Erfassung des Agenten (für Aktivitäts-Deltas). */
const CAPTURE_KEY = 'vscodiumAgent.lastCapture.v1';

class AgentService {
	/**
	 * @param {import('vscode').ExtensionContext} context
	 * @param {import('../lib/activityIndex').ActivityIndex|null} activity
	 * @param {{ info: Function, warn: Function, error: Function }} logger
	 */
	constructor(context, activity, logger) {
		this.context = context;
		this.activity = activity;
		this.log = logger;
		/** @type {import('../lib/authManager').AuthManager|null} von extension.js gesetzt */
		this.auth = null;
		/** @type {WorkspaceHost|null} */
		this.host = null;
		/** @type {{url: string, models: Array|null, fetchedAt: number, ttlMs: number}|null} */
		this._proxyCatalog = null;
	}

	/** Alle Einstellungen an einer Stelle – Aufrufer lesen nie direkt aus der Konfiguration. */
	config() {
		const cfg = vscode.workspace.getConfiguration('vscodiumAgent');
		return {
			proxyUrl: String(cfg.get('proxy.url', '')).replace(/\/+$/, ''),
			// Standard: EU-Route bevorzugt (Datenresidenz), fürs Inline-Edit die schnelle Lite-Variante.
			model: cfg.get('model', 'gemini-3.5-flash'),
			inlineEditModel: cfg.get('inlineEdit.model', 'gemini-3.5-flash-lite'),
			approvalMode: cfg.get('approvalMode', 'review'),
			terminalMode: cfg.get('terminal.mode', 'captured'),
			maxIterations: cfg.get('maxIterations', 24),
			commandTimeoutSec: cfg.get('commandTimeoutSec', 180),
			maxTreeEntries: cfg.get('context.maxTreeEntries', 250)
		};
	}

	/**
	 * Proxy-Client für einen Lauf. Zugangsdaten hat der Client keine – nur das
	 * ID-Token des angemeldeten Kontos; Modell-Allowlist und Standort-Routing
	 * entscheidet der Proxy.
	 * @param {string} [modelOverride] z. B. das Inline-Edit-Modell
	 */
	async buildClient(modelOverride) {
		const cfg = this.config();
		const model = modelOverride || cfg.model;
		if (!cfg.proxyUrl) {
			throw new ProxyError('Keine Proxy-URL konfiguriert (Einstellung vscodiumAgent.proxy.url).');
		}
		if (!this.auth || !await this.auth.isSignedIn()) {
			throw new ProxyError('Nicht angemeldet.', {
				hint: 'Kommando „Agent: Mit Google anmelden“ ausführen.'
			});
		}
		const auth = this.auth;
		return new ProxyClient({
			baseUrl: cfg.proxyUrl,
			model,
			getIdToken: () => auth.getIdToken(cfg.proxyUrl)
		});
	}

	/**
	 * Modell-Angebot des Proxys für den Picker (5 Minuten gecacht; Fehler kurz gecacht,
	 * damit ein nicht erreichbarer Proxy den Picker nicht bei jedem Öffnen blockiert).
	 * @returns {Promise<Array<{id: string, label: string, region?: string}>|null>}
	 */
	async _proxyModels() {
		const now = Date.now();
		const url = this.config().proxyUrl;
		const cache = this._proxyCatalog;
		if (cache && cache.url === url && now - cache.fetchedAt < cache.ttlMs) {
			return cache.models;
		}
		try {
			const client = await this.buildClient();
			// Hartes Timeout: Ein hängender Proxy darf den Modell-Picker nicht blockieren.
			const list = await client.listModels(AbortSignal.timeout(5000));
			const models = list.map(m => ({ id: m.id, label: m.label || m.id, region: m.location }));
			this._proxyCatalog = { url, models, fetchedAt: now, ttlMs: 5 * 60 * 1000 };
			return models;
		} catch (err) {
			this.log.warn('Proxy-Katalog nicht abrufbar – lokaler Katalog bleibt aktiv', err);
			this._proxyCatalog = { url, models: null, fetchedAt: now, ttlMs: 60 * 1000 };
			return null;
		}
	}

	/** Katalog-Cache verwerfen (z. B. nach An-/Abmeldung in einem anderen Fenster). */
	invalidateCatalog() {
		this._proxyCatalog = null;
	}

	/**
	 * Workspace-Host für Läufe ohne eigene Review-Oberfläche (Inline-Edit, Quick-Fixes).
	 * Freigaben erteilt hier niemand mehr per Karte – die Rückfragen rendert der
	 * native Chat über die Tool-Freigaben; deshalb winkt dieser Host durch.
	 * Der native Agent-Lauf nutzt stattdessen `NativeRunHost` (ui/nativeTools.js),
	 * der Änderungen ins Chat-Editing streamt.
	 */
	getHost() {
		const cfg = this.config();
		const options = {
			approvalMode: cfg.approvalMode,
			terminalMode: cfg.terminalMode,
			commandTimeoutSec: cfg.commandTimeoutSec,
			maxTreeEntries: cfg.maxTreeEntries,
			logger: this.log
		};
		if (!this.host) {
			this.host = new WorkspaceHost({
				requestEditApproval: async () => true,
				requestCommandApproval: async () => true
			}, options);
		} else {
			this.host.options = options;
		}
		if (this.activity) {
			this.host.onAgentWrite = (p) => this.activity.noteAgentWrite(p);
			this.host.activityCallback = () => {
				const since = this.context.workspaceState.get(CAPTURE_KEY, 0);
				return this.activity.summary(8, since);
			};
		}
		return this.host;
	}
}

module.exports = { AgentService, CAPTURE_KEY };
