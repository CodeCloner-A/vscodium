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

/**
 * Anbieter außerhalb von Vertex AI (OpenAI-kompatible Chat-Completions-API, siehe
 * lib/openaiCompat.js). Der Schlüssel liegt im Secret Manager und kommt als Env-Variable
 * an den Dienst – Nutzer brauchen keinen eigenen (Abo-Modell). Fehlt der Schlüssel,
 * blendet der Server die zugehörigen Modelle aus (keine toten Picker-Einträge).
 *
 * ACHTUNG Datenresidenz: Diese Anbieter verarbeiten außerhalb der EU (Betreiber in
 * China). Prompt-Inhalte verlassen damit den EU-Raum – in der Datenschutzerklärung
 * ausweisen; siehe ROADMAP-Leitplanken.
 */
const PROVIDERS = {
	zai: { label: 'Z.ai', baseUrl: 'https://api.z.ai/api/paas/v4', keyEnv: 'ZAI_API_KEY' },
	moonshot: { label: 'Moonshot', baseUrl: 'https://api.moonshot.ai/v1', keyEnv: 'MOONSHOT_API_KEY' }
};

const MODELS = [
	// 3.6-Flash (neu 07/2026): laut Google-Doku NUR global verfügbar (Stand 20.07.2026,
	// Nutzer-Verifikation) – keine EU-Datenresidenz möglich; der Picker zeigt die Region.
	// Preise noch nicht gelistet → konservativ wie 3.5-Flash; nach Preisliste nachziehen.
	{ id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash · neueste Generation', location: 'global', quotaFactor: { input: 6, output: 6 } },
	// 3.5-Flash-Lite (neu 07/2026): in der eu-Multiregion verfügbar (Nutzer-Verifikation
	// 20.07.2026). Preis unbekannt → konservativ zwischen 2.5-Lite (1) und 3.5-Flash (6).
	{ id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite · flink & günstig', location: 'eu', quotaFactor: { input: 2, output: 2 } },
	// 3.5-Flash: Input 1,65/0,30 = 5,5 → 6; Output unbekannt → wie Input (konservativ).
	{ id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash · stark & schnell', location: 'eu', quotaFactor: { input: 6, output: 6 } },
	{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash · Standard', location: 'europe-west1', quotaFactor: { input: 1, output: 1 } },
	// 2.5-Pro: 1,25/0,30 = 4,2 → 4; 10/2,5 = 4.
	{ id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro · komplexe Aufgaben', location: 'europe-west1', quotaFactor: { input: 4, output: 4 } },
	// Flash-Lite ist billiger als die Basiseinheit → auf 1 aufgerundet (nie < 1).
	{ id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite · schnell & einfach', location: 'europe-west1', quotaFactor: { input: 1, output: 1 } },
	// Claude via Vertex MaaS: Übersetzungsschicht (lib/anthropic.js) ist fertig und getestet,
	// aber die Model-Garden-Freischaltung verlangt Firmendaten (EULA-Fragebogen: Name,
	// Website, Branche …) – bis zur Firmengründung sind die Einträge `hidden` (KEEP IT
	// SIMPLE: keine toten Picker-Einträge). Nach der Freischaltung: hidden entfernen,
	// deployen, Smoke-Test pro Region.
	// Opus 4.8 (eu, +10 %): Input 5,5/0,30 = 18,3 → 18; Output 27,5/2,5 = 11.
	{ id: 'claude-opus-4-8', label: 'Claude Opus 4.8 · Anthropic-Spitzenmodell', location: 'eu', publisher: 'anthropic', hidden: true, quotaFactor: { input: 18, output: 11 } },
	// Sonnet 5 (eu, +10 %): Input 3,3/0,30 = 11; Output 16,5/2,5 = 6,6 → 7.
	{ id: 'claude-sonnet-5', label: 'Claude Sonnet 5 · Anthropic-Allrounder', location: 'eu', publisher: 'anthropic', hidden: true, quotaFactor: { input: 11, output: 7 } },
	// Opus 4.6 (europe-west1, regional ohne Aufschlag): Input 5/0,30 = 16,7 → 17; Output 25/2,5 = 10.
	{ id: 'claude-opus-4-6', label: 'Claude Opus 4.6 · Anthropic, bewährt', location: 'europe-west1', publisher: 'anthropic', hidden: true, quotaFactor: { input: 17, output: 10 } },
	// GLM 5.2 über Z.ai (OpenAI-kompatibel, NICHT Vertex): `location` ist hier reine
	// Anzeige (der Picker zeigt sie), es findet kein Vertex-Routing statt.
	// quotaFactor konservativ geschätzt, bis Listenpreise bestätigt sind (Stand 20.07.2026);
	// nach Preisprüfung nachziehen – Basiseinheit bleibt gemini-2.5-flash ($0,30/$2,50).
	{
		id: 'glm-5.2', label: 'GLM 5.2 · Z.ai, 1 Mio. Kontext', location: 'global (Z.ai)',
		provider: 'zai', quotaFactor: { input: 3, output: 2 }
	}
];

function findModel(id) {
	return MODELS.find(m => m.id === id) || null;
}

/**
 * Für GET /v1/models – das Angebot für den Modell-Picker des Clients.
 * Ohne `hidden`-Modelle und ohne Fremd-Anbieter, für die kein Schlüssel konfiguriert ist.
 * @param {Set<string>|Array<string>} [availableProviders] konfigurierte Fremd-Anbieter
 */
function publicCatalog(availableProviders) {
	const available = availableProviders instanceof Set
		? availableProviders
		: new Set(Array.isArray(availableProviders) ? availableProviders : []);
	return MODELS
		.filter(m => !m.hidden)
		.filter(m => !m.provider || available.has(m.provider))
		.map(m => ({ id: m.id, label: m.label, location: m.location }));
}

module.exports = { MODELS, PROVIDERS, findModel, publicCatalog };
