/*---------------------------------------------------------------------------------------------
 * VSCodium Agent Proxy – Modell-Katalog mit serverseitigem Standort-Routing (Vertex AI direkt).
 *
 * Anders als über Firebase AI Logic sind hier auch für Gemini 3.x europäische Standorte
 * möglich. gemini-3.5-flash läuft über die jurisdiktionale eu-Multiregion (EU-Datenresidenz;
 * europe-west2/London wäre laut Google-Doku allowlist-/Provisioned-Throughput-beschränkt
 * und zählt nicht zur EU). Der Katalog ist zugleich Allowlist: Nur gelistete Modelle
 * bedient der Proxy (Kostenkontrolle) – der Client-Picker bezieht sein Angebot über
 * GET /v1/models von hier.
 *
 * publisher: 'anthropic' markiert Claude-Modelle (Vertex AI MaaS) – lib/vertex.js schaltet
 * dann auf publishers/anthropic + rawPredict/streamRawPredict um und lib/anthropic.js
 * übersetzt die Formate. Fehlender publisher = Google/Gemini.
 *
 * quotaFactor gewichtet die Tokens für die Monats-Quote (lib/metering.js), damit teure
 * Modelle die Quote entsprechend schneller verbrauchen. Basiseinheit ist gemini-2.5-flash
 * (Input $0,30 / Output $2,50 pro Mio. Tokens). Herleitung = Modellpreis ÷ Flash-Preis,
 * eu-Multiregion +10 % (Nicht-Global-Aufschlag), kaufmännisch gerundet, nie < 1.
 * Preisstand 15.07.2026: Gemini-Preisseite (2.5-Pro $1,25/$10; 2.5-Flash-Lite $0,10/$0,40;
 * 3.5-Flash Input global $1,50 – Output dort nicht gelistet, konservativ mit demselben
 * Faktor wie Input angesetzt) und Anthropic-Listenpreise (Opus 4.6/4.8 $5/$25;
 * Sonnet 5 $3/$15 – Listenpreis, nicht der Einführungsrabatt). Bei Preisänderungen
 * hier nachziehen.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const MODELS = [
	// 3.5-Flash: Input 1,65/0,30 = 5,5 → 6; Output unbekannt → wie Input (konservativ).
	{ id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash · neueste Generation', location: 'eu', quotaFactor: { input: 6, output: 6 } },
	{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash · Standard', location: 'europe-west1', quotaFactor: { input: 1, output: 1 } },
	// 2.5-Pro: 1,25/0,30 = 4,2 → 4; 10/2,5 = 4.
	{ id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro · komplexe Aufgaben', location: 'europe-west1', quotaFactor: { input: 4, output: 4 } },
	// Flash-Lite ist billiger als die Basiseinheit → auf 1 aufgerundet (nie < 1).
	{ id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite · schnell & einfach', location: 'europe-west1', quotaFactor: { input: 1, output: 1 } },
	// Opus 4.8 (eu, +10 %): Input 5,5/0,30 = 18,3 → 18; Output 27,5/2,5 = 11.
	{ id: 'claude-opus-4-8', label: 'Claude Opus 4.8 · Anthropic-Spitzenmodell', location: 'eu', publisher: 'anthropic', quotaFactor: { input: 18, output: 11 } },
	// Sonnet 5 (eu, +10 %): Input 3,3/0,30 = 11; Output 16,5/2,5 = 6,6 → 7.
	{ id: 'claude-sonnet-5', label: 'Claude Sonnet 5 · Anthropic-Allrounder', location: 'eu', publisher: 'anthropic', quotaFactor: { input: 11, output: 7 } },
	// Opus 4.6 (europe-west1, regional ohne Aufschlag): Input 5/0,30 = 16,7 → 17; Output 25/2,5 = 10.
	{ id: 'claude-opus-4-6', label: 'Claude Opus 4.6 · Anthropic, bewährt', location: 'europe-west1', publisher: 'anthropic', quotaFactor: { input: 17, output: 10 } }
];

function findModel(id) {
	return MODELS.find(m => m.id === id) || null;
}

/** Für GET /v1/models – das Angebot für den Modell-Picker des Clients. */
function publicCatalog() {
	return MODELS.map(m => ({ id: m.id, label: m.label, location: m.location }));
}

module.exports = { MODELS, findModel, publicCatalog };
