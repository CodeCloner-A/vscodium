/*---------------------------------------------------------------------------------------------
 * VSCodium Agent Proxy – Modell-Katalog mit serverseitigem Standort-Routing (Vertex AI direkt).
 *
 * Anders als über Firebase AI Logic sind hier auch für Gemini 3.x europäische Standorte
 * möglich. gemini-3.5-flash läuft über die jurisdiktionale eu-Multiregion (EU-Datenresidenz;
 * europe-west2/London wäre laut Google-Doku allowlist-/Provisioned-Throughput-beschränkt
 * und zählt nicht zur EU). Der Katalog ist zugleich Allowlist: Nur gelistete Modelle
 * bedient der Proxy (Kostenkontrolle) – der Client-Picker bezieht sein Angebot über
 * GET /v1/models von hier.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const MODELS = [
	{ id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash · neueste Generation', location: 'eu' },
	{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash · Standard', location: 'europe-west1' },
	{ id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro · komplexe Aufgaben', location: 'europe-west1' },
	{ id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite · schnell & einfach', location: 'europe-west1' }
];

function findModel(id) {
	return MODELS.find(m => m.id === id) || null;
}

/** Für GET /v1/models – das Angebot für den Modell-Picker des Clients. */
function publicCatalog() {
	return MODELS.map(m => ({ id: m.id, label: m.label, location: m.location }));
}

module.exports = { MODELS, findModel, publicCatalog };
