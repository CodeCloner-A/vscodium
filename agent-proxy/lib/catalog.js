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
 * ANGEBOT seit 28.07.2026: nur noch die 3er-Generation (die 2.5er sind raus – ein
 * Modell weniger im Picker ist ein Gedanke weniger für Einsteiger, Leitsatz KEEP IT SIMPLE).
 *
 * quotaFactor gewichtet die Tokens für die Monats-Quote (lib/metering.js), damit teure
 * Modelle die Quote entsprechend schneller verbrauchen. Basiseinheit bleibt der Preis von
 * gemini-2.5-flash (Input $0,30 / Output $2,50 pro Mio. Tokens) – als reine Rechengröße,
 * auch wenn das Modell selbst nicht mehr angeboten wird.
 * Gecachte Eingabe-Tokens zählen nur zu 10 % (Google-Cache-Preis, siehe lib/metering.js). Herleitung = Modellpreis ÷ Flash-Preis,
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
	moonshot: { label: 'Moonshot', baseUrl: 'https://api.moonshot.ai/v1', keyEnv: 'MOONSHOT_API_KEY' },
	deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', keyEnv: 'DEEPSEEK_API_KEY' }
};

/**
 * Kontext-Metadaten je Modell (maxInput/maxOutput in Tokens): Quelle für die
 * Modellkarte im Picker – der Client zeigt „Max context“ aus genau diesen Werten.
 * Konservativ angesetzt, wo Anbieter-Doku unklar ist; die harte Grenze zieht ohnehin
 * der Anbieter. `vision` speist die Bild-Fähigkeit der Karte (imageInput).
 */

const MODELS = [
	// 3.6-Flash (neu 07/2026): laut Google-Doku NUR global verfügbar (Stand 20.07.2026,
	// Nutzer-Verifikation) – keine EU-Datenresidenz möglich; der Picker zeigt die Region.
	// Preise noch nicht gelistet → konservativ wie 3.5-Flash; nach Preisliste nachziehen.
	{
		id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash · neueste Generation', location: 'global',
		quotaFactor: { input: 6, output: 6 }, maxInputTokens: 1000000, maxOutputTokens: 128000, vision: true
	},
	// 3.5-Flash-Lite (neu 07/2026): in der eu-Multiregion verfügbar (Nutzer-Verifikation
	// 20.07.2026). Preis unbekannt → konservativ zwischen 2.5-Lite (1) und 3.5-Flash (6).
	{
		id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite · flink & günstig', location: 'eu',
		quotaFactor: { input: 2, output: 2 }, maxInputTokens: 1000000, maxOutputTokens: 64000, vision: true
	},
	// 3.5-Flash: Input 1,65/0,30 = 5,5 → 6; Output unbekannt → wie Input (konservativ).
	{
		id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash · stark & schnell', location: 'eu',
		quotaFactor: { input: 6, output: 6 }, maxInputTokens: 1000000, maxOutputTokens: 128000, vision: true
	},
	// 3.1 Pro (Vorschau, 28.07.2026): laut Nutzer-Verifikation nur `global`; Preise noch
	// nicht gelistet → deutlich über Flash angesetzt (Pro-Klasse), nach Preisliste nachziehen.
	{
		id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro · Vorschau, komplexe Aufgaben', location: 'global',
		quotaFactor: { input: 8, output: 6 }, maxInputTokens: 1000000, maxOutputTokens: 64000, vision: true
	},
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
		provider: 'zai', quotaFactor: { input: 3, output: 2 },
		maxInputTokens: 1000000, maxOutputTokens: 128000
	},
	// Kimi K3 über Moonshot (OpenAI-kompatibel). Listenpreise (Stand 28.07.2026):
	// Eingabe $3, Ausgabe $15 pro Mio. Tokens ⇒ Input 3/0,30 = 10; Output 15/2,50 = 6.
	// Cache-Treffer kosten dort $0,30 – der Rabatt greift automatisch (siehe capabilities).
	{
		id: 'kimi-k3', label: 'Kimi K3 · Moonshot, 1 Mio. Kontext', location: 'global (Moonshot)',
		provider: 'moonshot', quotaFactor: { input: 10, output: 6 },
		maxInputTokens: 1000000, maxOutputTokens: 64000, vision: true,
		capabilities: { dynamicTools: true, vision: true }
	},
	// DeepSeek (Produktentscheid 28.07.2026: Frische-Signal „wir sind up to date“).
	// OpenAI-kompatibel inkl. Tool Calls; Modell-ID beim Anbieter: deepseek-chat.
	// Listenpreise ~$0,27/$1,10 pro Mio. ⇒ unter der Basiseinheit → Faktor 1/1 (nie < 1);
	// nach Preisliste nachziehen. Kein Vision-Support im Chat-Modell.
	{
		id: 'deepseek-chat', label: 'DeepSeek · Code-Preisbrecher', location: 'global (DeepSeek)',
		provider: 'deepseek', quotaFactor: { input: 1, output: 1 },
		maxInputTokens: 128000, maxOutputTokens: 8000
	}
];

/**
 * Fähigkeiten je Modell – der Übersetzer (lib/openaiCompat.js) schickt nur, was das
 * Modell auch versteht. Fehlt ein Eintrag, gelten diese Vorgaben.
 *
 * Hintergrund: Ein Anbieter quittiert unbekannte Felder gern mit 400 statt sie zu
 * ignorieren (Kimi z. B. bei dynamischen Tools auf älteren Modellen: „tokenization failed“).
 */
const DEFAULT_CAPABILITIES = {
	temperature: true,
	topP: true,
	toolChoice: true,
	streamUsage: true,   // stream_options.include_usage – ohne das zählt kein Streaming-Metering
	dynamicTools: false, // Werkzeuge per system-Nachricht nachladen (nur kimi-k3)
	vision: false        // Bilder als Nachrichteninhalt
};

function capabilitiesOf(model) {
	return { ...DEFAULT_CAPABILITIES, ...(model && model.capabilities ? model.capabilities : {}) };
}

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
		.map(m => ({
			id: m.id,
			label: m.label,
			location: m.location,
			// Metadaten für die Modellkarte des Pickers (Client rendert daraus
			// „Max context“, Bild-Fähigkeit und Preisklasse).
			maxInputTokens: m.maxInputTokens,
			maxOutputTokens: m.maxOutputTokens,
			vision: m.vision === true,
			priceTier: priceTierOf(m)
		}));
}

/**
 * Preisklasse aus der Quoten-Gewichtung (Basiseinheit = gemini-2.5-flash-Preis):
 * € (≤2) günstig, €€ (≤7) mittel, €€€ (>7) Premium. Reine Orientierung für die Karte.
 */
function priceTierOf(model) {
	const f = model && model.quotaFactor ? Math.max(model.quotaFactor.input || 1, model.quotaFactor.output || 1) : 1;
	return f <= 2 ? '€' : f <= 7 ? '€€' : '€€€';
}

module.exports = { MODELS, PROVIDERS, DEFAULT_CAPABILITIES, findModel, publicCatalog, capabilitiesOf, priceTierOf };
