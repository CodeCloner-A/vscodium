/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – Modell-Katalog mit automatischem Standort-Routing.
 *
 * Der Nutzer wählt nur das Modell; den Standort löst die Extension auf (das Backend bestimmt
 * weiterhin die Einstellung `firebase.backend`). Hintergrund (verifiziert 07/2026): Firebase
 * AI Logic erlaubt für alle Gemini-3.x-Modelle über das vertexAI-Backend ausschließlich
 * location='global' – regionale Standorte gibt es für 3.x nur über Vertex AI direkt (kommt
 * mit dem Proxy-Backend, Phase S der Roadmap). Die 2.5-Familie bleibt regional pinnbar,
 * dort gilt weiter die Location-Einstellung.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const { normalizeModelName } = require('./firebaseClient');

/**
 * Kuratierte Auswahl für den Modell-Picker – ausschließlich Gemini (Leitplanke der Roadmap;
 * Claude via MaaS ist erst über das Proxy-Backend erreichbar).
 *
 * `vertexLocations`: erlaubte Standorte über das vertexAI-Backend. Fehlt das Feld, ist das
 * Modell regional frei und die Location-Einstellung gilt unverändert.
 */
const MODEL_CATALOG = [
	{ id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash · neueste Generation', vertexLocations: ['global'] },
	{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash · Standard' },
	{ id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro · komplexe Aufgaben' },
	{ id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite · schnell & einfach' }
];

/**
 * Erlaubte vertexAI-Standorte eines Modells (null = regional frei). Gemeinsame Regel für
 * Picker-Anzeige und Routing – inkl. Heuristik für unbekannte 3.x-Modelle (z. B. Previews
 * aus den Einstellungen): via AI Logic nur global.
 */
function fixedVertexLocations(model) {
	const id = normalizeModelName(model);
	const entry = MODEL_CATALOG.find(m => m.id === id);
	if (entry && Array.isArray(entry.vertexLocations)) { return entry.vertexLocations; }
	return /^gemini-3/.test(id) ? ['global'] : null;
}

/** Fester Standort eines Modells für die Anzeige (undefined = regional frei). */
function fixedLocation(model) {
	const allowed = fixedVertexLocations(model);
	return allowed && allowed.length === 1 ? allowed[0] : undefined;
}

/**
 * Einträge für den Picker im Webview: {id, label, region}.
 * `region` ist nur gesetzt, wenn der Standort fest ist (Anzeige als Suffix/Tooltip).
 */
function pickerModels() {
	return MODEL_CATALOG.map(m => ({ id: m.id, label: m.label, region: fixedLocation(m.id) }));
}

/**
 * Löst Backend und Standort für ein Modell auf.
 *
 * @param {string} model Modellname (roh, wird normalisiert)
 * @param {{ backend?: string, location?: string }} cfg Werte aus den Einstellungen
 * @returns {{ backend: string, location: string, pinned: boolean }}
 *          `pinned` = die Location-Einstellung wurde modellbedingt übersteuert.
 */
function resolveRoute(model, cfg) {
	const backend = cfg && cfg.backend === 'vertexAI' ? 'vertexAI' : 'googleAI';
	const location = (cfg && cfg.location) || 'us-central1';
	// Das googleAI-Backend (Gemini Developer API) kennt keinen Standort.
	if (backend !== 'vertexAI') {
		return { backend, location, pinned: false };
	}
	const allowed = fixedVertexLocations(model);
	if (allowed && !allowed.includes(location)) {
		return { backend, location: allowed[0], pinned: true };
	}
	return { backend, location, pinned: false };
}

module.exports = { MODEL_CATALOG, pickerModels, resolveRoute, fixedLocation };
