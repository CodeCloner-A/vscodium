/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – Lokaler Modell-Katalog (Offline-Fallback des Pickers).
 *
 * Das maßgebliche Angebot liefert der Agent-Proxy (GET /v1/models, serverseitige Allowlist
 * samt Standort-Routing in agent-proxy/lib/catalog.js). Dieser lokale Katalog springt nur
 * ein, wenn der Proxy nicht erreichbar ist oder niemand angemeldet ist – damit der Picker
 * nie leer dasteht. Das frühere Client-Routing (resolveRoute) fiel mit dem BYOK-Rückbau
 * (v0.9.0) weg.
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
	{ id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash · neueste Generation', vertexLocations: ['global'] },
	{ id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash · stark & schnell', vertexLocations: ['global'] },
	{ id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite · flink & günstig', vertexLocations: ['global'] },
	{ id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro · Vorschau, komplexe Aufgaben', vertexLocations: ['global'] },
	// Fremd-Anbieter (Z.ai/Moonshot) – Routing macht der Proxy; hier nur fürs
	// Picker-Label, falls der Server-Katalog einmal nicht erreichbar ist.
	{ id: 'glm-5.2', label: 'GLM 5.2 · Z.ai, 1 Mio. Kontext', vertexLocations: ['global'] },
	{ id: 'kimi-k3', label: 'Kimi K3 · Moonshot, 1 Mio. Kontext', vertexLocations: ['global'] }
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

module.exports = { MODEL_CATALOG, pickerModels, fixedLocation };
