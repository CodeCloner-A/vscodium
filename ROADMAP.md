# Roadmap — VSCodium Agent

Abgeleitet aus der Feature-Chronologie von Cursor (Changelog 2023–2025), gemappt auf den Ist-Zustand dieses Forks (Stand: 20. Juli 2026, Extension v0.14.0, Basis VS Code 1.121.0). Cursor-Referenzen in Klammern zeigen, wann Cursor das jeweilige Feature gebaut hat — als Beleg für die Reihenfolge, nicht als Kopiervorlage.

> **Kurswechsel 07/2026 — SaaS:** Der Fork wird als Dienst betrieben. Firebase bleibt das Rückgrat: Auth für den Login, Firestore für Chatverläufe, Nutzerdaten, Tarife und Metering. Nur die KI-Kommunikation läuft über einen Cloud-Run-Proxy als Türsteher (Vertex AI direkt: Gemini plus Claude via MaaS, SSE-Streaming). Der bisherige API-Key-Pfad (BYOK) entfällt ersatzlos, sobald der Proxy produktiv ist. Die früheren Leitplanken „Kein Login-Zwang“ und „kein SaaS-Modell“ sind damit bewusst aufgehoben — siehe Phase S.

> **Richtungsentscheid 07/2026 — Core-Integration (Phase K):** VS Code 1.121 enthält die komplette Chat/Agent-Oberfläche bereits im Workbench-Core; unser Build entfernt bisher nur die Copilot-Extension und lässt die Core-UI deaktiviert, während das eigene Webview sie nachbaut. Ab Phase K wird die Core-UI übernommen und gebrandet; die Built-in-Extension bleibt als Motor dahinter und hängt sich als Default-ChatParticipant ein. *(Korrektur 15.07.2026 nach Quellcode-Verifikation: Der ursprünglich geplante `defaultChatAgent`-Eintrag in product.json entfällt bewusst — ohne ihn bleibt Microsofts Copilot-förmiger Setup-/Entitlement-Apparat komplett inaktiv, und die Chat-View erscheint trotzdem, weil der Default-Participant den Kontextschlüssel `panelParticipantRegistered` setzt.)* Webview-Chat, eigener Diff-/Review-Mechanismus und Inline-Edit-Controller entfallen nach Paritätsnachweis.

**Zeitschätzungen** gehen von einem Entwickler mit KI-Unterstützung aus. Die Phasen sind sequenziell gedacht, Phase S schiebt sich vor Phase 2 und Phase K zwischen S und 2 (parallel zu den offenen S-Restpunkten startbar); der Infrastruktur-Track läuft parallel.

---

## Leitplanken (Non-Goals)

- **Keine Azure-Anmeldung, keine Azure-Integration.** (Cursor 0.2.33 wird bewusst NICHT übernommen)
- **Keine GPT-/OpenAI-Modelle.** Einzige Bezugsquelle: Google Vertex AI — Gemini-Familie plus Partner-Modelle über MaaS (Anthropic Claude, z. B. `claude-opus-4-6`). Ein Cloud-Konto, eine Rechnung, ein Proxy. Übergangsweise noch Firebase AI Logic (nur Gemini), bis der Proxy steht.
- **Login gehört zum Produkt (SaaS, seit 07/2026).** Anmeldung über Firebase Auth, Abrechnung pro Nutzer. Kein BYOK (Zielbild): Nutzer verwalten weder API-Keys noch Regionen — Modell wählen, loslegen. Bis zum Proxy-Go-live läuft übergangsweise der bisherige Key-Pfad. *(Hebt die frühere Leitplanke „Kein Login-Zwang / API-Key genügt“ auf.)*
- **Datensparsamkeit statt Telemetrie.** Der Frecency-Aktivitätsindex bleibt lokal. Chatverläufe und Nutzerdaten liegen in Firestore, strikt pro Nutzer isoliert (Security Rules); der Proxy selbst loggt keine Prompt- oder Code-Inhalte, die Abrechnung speichert nur Zähler (Nutzer-ID, Modell, Tokenzahlen, Zeitstempel). Kein Produkt-Tracking (vgl. Cursors „Ghost Mode", 0.2.4 — bei uns Default).

---

## Ist-Zustand (bereits gebaut)

| Bereich | Status |
|---|---|
| Chat-Sidebar mit persistenten Sessions pro Projekt (seit v0.10.0 geräteübergreifend synchronisiert) | ✅ (`ui/chatViewProvider.js`) |
| Agent-Loop mit Gemini Function Calling, 10 Tools | ✅ (`lib/agentController.js`, `lib/tools.js`) |
| Review-Modus: Diff-Vorschau + Accept/Reject pro Änderung/Kommando | ✅ (`lib/workspaceHost.js`) |
| Auto-Modus (`approvalMode: auto`) | ✅ |
| Aktivitätsindex (Frecency) + Projektbaum im System-Prompt | ✅ (`lib/activityIndex.js`) |
| Kommando-Ausführung mit Timeout/Output-Capping | ✅ |
| Diagnostics-Zugriff (`get_diagnostics`) | ✅ |
| Editor-Integration: Inline-Edit (Strg+I, Streaming-Diff, partielles Annehmen), Apply-Button, Quick-Fixes, Terminal-Debug | ✅ v0.4.0 (`lib/inlineEdit.js`, `ui/codeActions.js`) |
| Modell-Picker in der Chat-Statusleiste | ✅ v0.4.0 (`ui/chatViewProvider.js`) |
| 16 Settings, SecretStorage, `testConnection` | ✅ |
| Headless-Test | ✅ lokal + CI (`.github/workflows/extension-test.yml`) |
| Nativer Core-Chat: Agent-Modus end-to-end (Probefahrt 17.–20.07. bestanden), Plan + Erweiterter Plan als Custom Agents, 9 Tools als LanguageModelTools mit Core-Freigaben, Edits ins native Multi-File-Review, Server-Katalog im nativen Modell-Picker | ✅ v0.12.0–v0.14.0 (`ui/nativeChatController.js`, `ui/nativeTools.js`, `lib/nativeChat.js`, `agents/*.agent.md`, Patch 85) |

Damit ist der Fork agent-first — Cursor erreichte vergleichbare Agent-Fähigkeiten erst Ende 2024 (0.43/0.44). Was fehlt, sind die Komfort- und Kontext-Schichten, die Cursor 2023 zuerst gebaut hat. Genau die adressieren Phasen 2–3 — nach dem SaaS-Fundament (Phase S).

---

## Phasenübersicht

| Phase | Thema | Schätzung | Status |
|---|---|---|---|
| 0 | Fundament härten | 2–3 Wochen | ✅ abgeschlossen (esbuild bewusst zurückgestellt) |
| 1 | Editor-Integration (Inline-Edit, Fix-Flows) | 4–6 Wochen | ✅ abgeschlossen (v0.4.0) |
| **S** | **SaaS-Fundament (Auth, Proxy, Abrechnung)** | 6–8 Wochen | in Arbeit — 8/11 erledigt (Modell-Katalog v0.5.0, Proxy v1, Auth-Login v0.6.0, Proxy-Verkehr v0.7.0, Metering & Quoten v0.8.0, BYOK-Rückbau + Auth-Relay v0.9.0, Chat-Sync v0.10.0, Claude/Proxy v2 v0.11.0) |
| **K** | **Core-Integration: native Chat-UI statt Webview** | 4–6 Wochen | in Arbeit — Verdrahtung + Motor ✅ (v0.12.0/v0.13.0: alle 3 Modi, 9 Tools nativ, Multi-File-Review); offen: Review-Parität (echter Build), Chat-Sync, Produkt-Identität, Webview-Rückbau |
| 2 | Kontext-System (@-Mentions, Indexing, Ignore) | 6–8 Wochen | offen — setzt Phase S voraus; UI-Anteile kommen nach Phase K aus dem Core-Chat |
| 3 | Regeln & Steuerung (Rules, Modi, Modell-Picker) | 3–4 Wochen | Modell-Picker vorgezogen (v0.4.0), Rest offen |
| 4 | Agent-Ausbau (Checkpoints, Queue, MCP) | 6–8 Wochen | offen |
| 5 | Multimodal & Docs (Bilder, @docs) | 3–4 Wochen | offen |
| ∞ | Infrastruktur-Track (parallel) | laufend | laufend |

Gesamt bis Ende Phase 5: grob **7–9 Monate**, davon Phasen 0–1 bereits abgeschlossen. Phase S geht vor Phase 2: Das Kontext-System (Embeddings) baut auf dem Proxy auf. Phase K ist netto annähernd aufwandsneutral: 4–6 Wochen Umbau, dafür entfallen Eigenbau-Anteile in Phase 2 (@-Mentions, Slash-Commands, Kontext-Chips) und Phase 4 (Checkpoints, Queue, To-do-Anzeige).

---

## Phase 0 — Fundament härten (2–3 Wochen)

Lektion aus Cursors Changelog: Die meisten Hotfixes drehten sich um Diff/Undo und Editor-Zustand. Erst stabilisieren, dann ausbauen.

- [x] **Undo-Sicherheit:** Jede per `applyChange` geschriebene Änderung muss mit Strg+Z im Editor sauber rückgängig zu machen sein — via `WorkspaceEdit` statt direktem FS-Write, wo möglich. (Cursors Dauerbaustelle, u. a. 0.2.4, 0.15.x) *(07/2026: `_replaceViaWorkspaceEdit`/`_createViaWorkspaceEdit` in `lib/workspaceHost.js`, FS-Fallback für Binärdateien)*
- [x] **Extension-Test in CI:** `test/run.js` in die GitHub-Workflows einhängen (eigener Job vor dem Build). *(07/2026: `.github/workflows/extension-test.yml` — Syntax-Check, package.json-Validierung, Headless-Tests)*
- [ ] **Build-Step für die Extension:** esbuild-Bundle statt rohem JS. *(Zurückgestellt: Extension ist dependency-frei, Bundling bringt aktuell wenig; Syntax-Absicherung übernimmt der CI-Check. Wird relevant, sobald npm-Abhängigkeiten dazukommen.)*
- [x] **Lokales Fehler-Logging:** Output-Channel mit strukturierten Fehlern (API-Fehler, Tool-Failures) — Diagnose ohne Telemetrie. (Cursor 0.14.0 „besseres Error-Logging") *(07/2026: `lib/logger.js` + LogOutputChannel „VSCodium Agent“, Kommando `Agent: Log anzeigen`)*
- [x] **Upstream-Merge-Prozess dokumentieren:** Checkliste für den Rebase auf neue VS-Code-Tags (siehe Infrastruktur-Track). *(07/2026: `docs/upstream-merge.md`)*

## Phase 1 — Editor-Integration (4–6 Wochen)

Cursors erste Monate (0.1–0.2, März–Juni 2023): der Weg vom „Chat neben dem Editor" zum „KI im Editor".

- [x] **Inline-Edit v1 (Strg+I):** Eingabeleiste im Editor, Auswahl (oder Auto-Block um den Cursor) als Kontext, Undo-sichere Anwendung mit grüner Markierung und Behalten/Verwerfen. Modell konfigurierbar (`vscodiumAgent.inlineEdit.model`, Default `gemini-2.5-flash`). *(07/2026: `lib/inlineEdit.js` + `ui/inlineEditController.js`. v0.4.0: Streaming-Diff (SSE, eine Undo-Gruppe), partielles Annehmen über Zeilen-Diff-Hunks mit CodeLens (`lib/lineDiff.js`), Follow-ups („Anpassen…“). Noch offen aus dem Cursor-Vorbild: Auto-Auswahl per Smart-Select (0.33).)*
- [x] **Apply-Button an Chat-Codeblöcken:** „In Datei übernehmen" an jedem Codeblock; Modell integriert den Snippet, Übernahme über den bestehenden Review-Flow (Karte + Diff). Limit 400 Zeilen wie Cursors /edit. (0.15.0 „Play-Button", 0.36 „Instant Apply") *(07/2026)*
- [x] **Fehler-Hover-Aktionen:** Quick-Fix „Mit KI beheben" (Inline-Edit-Pfad) und „Mit KI erklären" (Chat-Task) an Diagnostics (0.2.3). *(07/2026: `ui/codeActions.js`)*
- [x] **Terminal-Debug:** Terminal-Kontextmenü „Terminal-Ausgabe mit KI debuggen" — letzte Kommando-Ausgabe (Shell-Integration, Clipboard-Fallback) als Debug-Task an den Agenten (0.2.11 Cmd+D). *(07/2026)*
- [x] **Integriertes Terminal für den Agent:** `run_command` optional sichtbar im Terminal-Panel statt nur gecaptured — Nutzer sieht live, was passiert; Befehle vor Ausführung editierbar (0.49). *(07/2026, v0.4.0: Einstellung `vscodiumAgent.terminal.mode`, Shell-Integration-API mit `execution.read()` + ANSI-Bereinigung (`lib/terminalExec.js`), automatischer Fallback auf gecapturten Lauf; Kommando in der Freigabe-Karte editierbar; engines auf ^1.93 angehoben.)*

## Phase S — SaaS-Fundament (6–8 Wochen)

Kurswechsel 07/2026: Aus dem BYOK-Werkzeug wird ein Dienst. Zwei Befunde (Firebase-/Google-Cloud-Doku, verifiziert 07/2026) erzwingen dieselbe Architektur:

1. **Modellwahl ohne Regions-Konfiguration:** Firebase AI Logic erlaubt für alle Gemini-3.x-Modelle ausschließlich `location='global'` — die EU-Standorte von `gemini-3.5-flash` (`eu`-Multiregion, `europe-west2`; Achtung: London = UK, zählt nicht als EU-Datenresidenz) sind nur über Vertex AI direkt erreichbar, also serverseitig.
2. **Abrechnung pro Nutzer:** AI Logic bietet kein Per-User-Metering/-Billing (Quoten gelten für alle Nutzer identisch), und App Check hat keinen Attestation-Provider für Desktop-Apps — ein im Client ausgelieferter Key wäre extrahierbar und liefe auf Projektkosten.

Beides löst ein schlankes Proxy-Backend, das Vertex AI direkt spricht. Firebase bleibt dabei das Rückgrat — Auth für die Identität, Firestore für Chatverläufe, Nutzerdaten, Entitlements und Metering; Cloud Run ist ausschließlich der Türsteher für die KI-Kommunikation und das SSE-Streaming, das Firestore nicht leisten kann. Der Nutzer wählt nur das Modell; Region und Backend entscheidet der Dienst.

- [x] **Modell-Katalog + Auto-Routing (Client, sofort lieferbar):** `GEMINI_MODELS` um Metadaten erweitern, `buildClient()` löst die Region automatisch pro Modell auf; `gemini-3.5-flash` in den Picker (über AI Logic zwingend `global`, Anzeige als Suffix + Tooltip); `firebase.location` wird zum Experten-Override degradiert. Läuft übergangsweise noch über den Key-Pfad; das Routing wandert später in den Proxy. *(07/2026, v0.5.0: `lib/modelCatalog.js` — Katalog mit `vertexLocations`-Metadaten, `resolveRoute()` in `buildClient()` (greift auch für Inline-Edit und `testConnection`), Global-Heuristik für unbekannte 3.x-Modelle, Headless-Tests.)*
- [x] **Proxy-Backend v1 (Cloud Run):** Endpunkte für `generateContent`/`streamGenerateContent` (SSE-Durchleitung), Vertex AI direkt mit Service-Account; Modell→Region-Routing serverseitig (`gemini-3.5-flash` → `eu`-Multiregion, 2.5er → EU-Einzelregion); Modell-Katalog kommt vom Server, der Picker zeigt, was der Dienst anbietet. *(07/2026: implementiert in `agent-proxy/` — dependency-freier Node-Server; Firebase-ID-Token-Prüfung (RS256, auth_time, Cert-Cache mit Timeout/Dedup), Allowlist-Katalog, rep-Host für `eu` (europe-west2 gemieden: Allowlist-/PT-Gate, UK ≠ EU), Nutzer- und Gesamt-Rate-Limit fail-closed, Metering-Logs ohne Inhalte; Headless-Tests, Dockerfile, Anleitung `docs/agent-proxy.md`. Deployt auf Cloud Run europe-west1, Auth-Gate live verifiziert; Liveness-Pfad ist `/health`, weil Googles Frontend `/healthz` auf `*.run.app` abfängt.)*
- [x] **Proxy v2 — Partner-Modelle (Claude via MaaS):** Drei Anthropic-Modelle im Angebot — `claude-opus-4-8` und `claude-sonnet-5` (eu-Multiregion), `claude-opus-4-6` (europe-west1). Der Client spricht weiterhin genau ein Protokoll (Gemini `generateContent`): Der Proxy übersetzt Requests (Rollen, Tool-Schemata, synthetische tool_use-IDs, `anthropic_version`, `max_tokens`-Pflicht), Antworten (stop_reason→finishReason, usage→usageMetadata) und SSE-Streams (Anthropic-Events → Gemini-Chunks) verlustfrei in beide Richtungen. *(07/2026, Extension v0.11.0 + Proxy v0.5.0: `agent-proxy/lib/anthropic.js` + Publisher-Umschaltung in `lib/vertex.js` (`rawPredict`/`streamRawPredict`); Monats-Quote zählt seitdem GEWICHTET per `quotaFactor` aus dem Katalog (Basis Gemini 2.5 Flash, Herleitung aus Listenpreisen als Kommentar) — Gate auf `max(weightedTokens, totalTokens)`; thinking auf Claude bewusst deaktiviert (Signatur-Roundtrip nicht Gemini-transportierbar); Headless-Tests beidseitig inkl. SSE-Zerteilung. Manuell nachziehen: Claude-Modelle im Model Garden aktivieren (EULA), Deploy, Smoke-Test pro Region.)*
- [x] **Firebase-Auth-Login in der Extension:** Browser-Redirect + Loopback (localhost) → Refresh-Token in SecretStorage (kurzlebiges ID-Token nur im Speicher, Auto-Erneuerung); Anmeldestatus im Chat-Panel; Logout-Kommando.
- [x] **Agent-Verkehr über den Proxy:** Angemeldete Nutzer sprechen mit Chat/Inline-Edit/Apply automatisch den Proxy (ID-Token statt API-Key, Routing serverseitig); der Modell-Picker zeigt das Server-Angebot (`GET /v1/models`, gecacht). Ohne Anmeldung bleibt übergangsweise der Key-Pfad. *(07/2026, v0.7.0: `lib/proxyClient.js` mit identischem Client-Interface inkl. SSE-Streaming und Retry; Weiche in `buildClient()`, gilt damit auch für Inline-Edit und den Verbindungstest.)* *(07/2026, v0.6.0: `lib/firebaseAuth.js` — OAuth für installierte Apps mit PKCE + Loopback, `signInWithIdp`, Refresh mit Rotations-Persistenz; `lib/authManager.js` — SecretStorage + Auto-Erneuerung; Statusanzeige in der Chat-Statusleiste, Kommandos Anmelden/Abmelden/„Proxy-Verbindung testen“; Einstellungen `proxy.url`, `auth.googleClientId/-Secret` (Desktop-App-OAuth-Client). Headless-Tests inkl. state-Prüfung.)*
- [x] **Nutzerdaten & Chat-Sync (Firestore):** Sitzungen synchronisieren sich geräteübergreifend — pro Nutzer UND pro Projekt (Workspace-Ordnername als Schlüssel); `workspaceState` bleibt Offline-Cache. Architektur-Anpassung gegenüber dem ursprünglichen Plan: Seit dem BYOK-Rückbau hat der Client keinen direkten Firebase-Zugang mehr — der Sync läuft wie das Metering über den Proxy (`GET/PUT/DELETE /v1/sessions…`, Service-Account), die Nutzer-Isolation erzwingt der Proxy über die verifizierte Token-uid statt über Security Rules. *(07/2026, Extension v0.10.0 + Proxy v0.4.0: `agent-proxy/lib/sessions.js` — Firestore `sessions/{uid}/workspaces/{ws}/items/{id}`, Metadaten-Liste per Projektion, ~900-KiB-Deckel (413), Logs ohne Inhalte; `lib/sessionSync.js` — last-write-wins über `updatedAt`, leere Sitzungen werden nie hochgeladen; Pull beim Panel-Init, Push huckepack auf dem entprellten Speichern, Löschen wirkt remote; Einstellung `sessions.sync`; Headless-Tests beidseitig. Bewusste Grenze: Eine remote gelöschte Sitzung kann von einem Gerät wiederkehren, das sie offline weiter bearbeitet hat.)*
- [x] **Metering & Quoten:** Tokenzahlen aus `usageMetadata` pro Nutzer in Firestore; Monatsbudget pro Nutzer (Default `FREE_MONTHLY_TOKENS`, übersteuerbar per `entitlements/{uid}` — Vorarbeit für Stripe-Tarife); harte Limits im Proxy (429 mit `reason: quota` und verständlicher Meldung im Chat). *(07/2026, Proxy v0.2.0 + Extension v0.8.0: `agent-proxy/lib/metering.js` — Firestore REST mit atomaren Increments, 60-s-Cache mit Sofort-Mitschrift eigener Antworten, fail-open bei Firestore-Ausfall (Rate-Limits deckeln weiter), Konto-Sperre via `disabled`; `GET /v1/usage` + Kommando „Agent: Verbrauch anzeigen“; Quota-429 wird im Client bewusst nicht retryt. Bewusste Grenze: abgebrochene Streams zählen nicht.)*
- [ ] **Abrechnung (Stripe):** Checkout + Customer Portal, Webhooks → Entitlements in Firestore; Free-Tier mit knappem Kontingent zum Ausprobieren.
- [ ] **Missbrauchsschutz & Betrieb:** Rate-Limits pro Nutzer/IP, Cloud-Billing-Alerts, strukturierte Proxy-Logs ohne Prompt-Inhalte, verständliche Fehlerzustände im Client (offline, abgemeldet, Kontingent erschöpft).
- [ ] **Rechtliches:** AGB, Datenschutzerklärung (Auftragsverarbeitung Google Cloud, Zahlungsdaten Stripe), Impressum; aus der App verlinkt.
- [x] **BYOK-Rückbau + Auth-Relay:** Kommandos `setApiKey`/`clearApiKey` entfernt, `testConnection` auf Proxy-Ping umgestellt, Settings `firebase.*` und `auth.googleClientId/-Secret` ausgebaut, gespeicherter Key wird beim Start aus der SecretStorage gelöscht. Vorgezogen (Nutzer-Entscheid: kein BYOK-Fallback) und erweitert um das **Auth-Relay**: Anmeldung (`signInWithIdp`) und Token-Refresh laufen über den Proxy (`POST /v1/auth/exchange|refresh`, per-IP-Rate-Limit) — OAuth-Client-Secret und Firebase-Web-API-Key liegen NUR noch in Secret-Manager-Env-Vars des Proxys, im Client verbleibt die öffentliche OAuth-Client-ID (`lib/saasConfig.js`; Wert vor dem Release eintragen). Bestehende Anmeldungen überleben das Update. *(07/2026, Extension v0.9.0 + Proxy v0.3.0: `agent-proxy/lib/authRelay.js`, `lib/firebaseClient.js` auf Format-Helfer eingedampft, `resolveRoute` entfällt clientseitig; Headless-Tests beidseitig. Manuell nachziehen: Secrets anlegen + deployen, Web-API-Key in der GCP-Konsole auf die Identity-Toolkit-API beschränken.)*

## Phase K — Core-Integration: native Chat-UI (4–6 Wochen)

Richtungsentscheid 15.07.2026, Befund aus der Fork-Analyse: Die Basis VS Code 1.121 bringt die komplette Chat/Agent-Oberfläche im Workbench-Core mit (`src/vs/workbench/contrib/chat` — Chat-Sidebar, Agent-Mode mit Tool-Freigaben, Inline-Chat, Chat-Editing mit Multi-File-Review, Modell-Picker, @/#-Kontext, Slash-Commands, Checkpoints). Unser Build entfernt davon nur die gebündelte Copilot-Extension (Patches 51/52) und lässt die Core-UI deaktiviert (`chat.disableAIFeatures`, kein `defaultChatAgent` in product.json) — während das eigene Webview genau diese Oberfläche nachbaut. Phase K dreht das um: Core-UI übernehmen und branden; die Built-in-Extension wird vom UI-Träger zum Motor dahinter — eingehängt als Default-ChatParticipant; Microsofts `defaultChatAgent`-Apparat (Setup, Entitlements, Sign-in) bleibt bewusst ungenutzt und damit inaktiv (Befund v0.12.0, Belege in `docs/phase-k-verdrahtung.md`). Die Motor-Schicht (Agent-Loop, Tools, Proxy, Auth, Metering, Firestore) bleibt unverändert.

**Migrationszuordnung** (bleibt / wird ersetzt / braucht Patch):

| Baustein heute | Phase K |
|---|---|
| Agent-Loop (`lib/agentController.js`), 10 Tools (`lib/tools.js`) | **bleibt** — Tools zusätzlich als `LanguageModelTool`s registriert, Freigaben über den Core-Approval-Flow |
| `lib/proxyClient.js`, Auth (`lib/firebaseAuth.js`, `lib/authManager.js`), Modell-Katalog | **bleibt** — Katalog speist einen `LanguageModelChatProvider`, Modelle erscheinen im nativen Picker |
| Cloud-Run-Proxy `agent-proxy/` (Vertex, Auth-Relay, Metering, Sessions) | **bleibt unverändert** |
| Frecency-Index (`lib/activityIndex.js`) | **bleibt** — Kontextquelle für Chat-Requests |
| Chat-Webview (`ui/chatViewProvider.js`, `media/chat.*`, eigener viewsContainer) | **wird ersetzt** — `ChatParticipant` (default) in der nativen Chat-View |
| Review-Modus (`lib/workspaceHost.js`: Freigabe-Karten, `vscodium-agent-diff`-Schema) | **wird ersetzt** — natives Chat-Editing (Multi-File-Review, Accept/Reject im Editor); die Produktentscheidungen (Freigabe pro Änderung, Hunk-weises Annehmen, editierbare Kommandos) werden Abnahmekriterien |
| Inline-Edit (`ui/inlineEditController.js`, CodeLens-Hunks aus `lib/lineDiff.js`) | **wird ersetzt** — nativer Inline-Chat auf Strg+I; `inlineEdit.model`-Zuordnung bleibt |
| Code-Actions (`ui/codeActions.js`), Terminal-Debug | **bleibt** — Ziel wechselt vom Webview auf native Chat-/Inline-Chat-Kommandos |
| Chat-Sync (`lib/sessionSync.js` ↔ Firestore) | **bleibt, wird angepasst** — muss an die Core-Chat-Sessions andocken; größtes technisches Risiko der Phase |
| product.json, `patches/` | **braucht Patch** — siehe Arbeitspakete |

- [x] **product.json verdrahten:** Gegen den 1.121-Quellcode verifiziert — und dabei die Annahme korrigiert: `defaultChatAgent` bleibt bewusst WEG. Das Interface ist Copilot-förmig (Entitlement-URLs, Sign-in-Provider, Quota-Kontexte); ohne den Eintrag bricht der gesamte Setup-/Entitlement-Apparat früh ab (`chatEntitlementService.ts:411`) und muss nicht entbrandet werden, während die Chat-View über `panelParticipantRegistered` (gesetzt durch unseren Default-Participant) sichtbar wird. Nötig ist nur `extensionEnabledApiProposals["vscodium.vscodium-agent"] = ["defaultChatParticipant"]`; `trustedExtensionAuthAccess` entfällt (eigene Auth nutzt keine VS-Code-Auth-Provider). *(07/2026: umgesetzt; Belege mit Datei:Zeile in `docs/phase-k-verdrahtung.md`.)*
- [ ] **Chat-UI aktivieren + entbranden (Patches):** `chat.disableAIFeatures`-Default kippen; Copilot-Removal-Patches (51/52) bleiben — sie entfernen nur die MS-Extension, nicht die UI; verbleibende Copilot-Strings (z. B. Beschreibung von `chat.disableAIFeatures`) aufs eigene Branding umschreiben. *(07/2026: Aktivierung umgesetzt — `patches/85-chat-enable-native-agent.patch` kippt nur den von VSCodiums 00er-Patch gesetzten Default zurück auf `false`, alle Abschalt-Guards bleiben funktional; Reihenfolge 00 → 85 gegen 1.121 per `git apply` verifiziert. Der befürchtete „heikelste Teil“ ist durch den Minimalpfad ohne `defaultChatAgent` weitgehend entfallen: Setup-/Entitlement-Flows bleiben inaktiv, offen ist nur String-Kosmetik.)*
- [x] **Extension als Motor:** `ChatParticipant` (default) implementieren — der Agent-Loop bedient Chat-Requests inkl. Tool-Calls und SSE-Streaming; `LanguageModelChatProvider` über den ProxyClient (Server-Katalog → nativer Modell-Picker); die 10 Tools als `LanguageModelTool`s mit Freigabe-Metadaten. *(07/2026, v0.12.0 — erster Schritt: Default-Participant im Ask-Modus + `LanguageModelChatProvider` (stabile API) in `ui/nativeChatController.js`, Kernlogik headless getestet in `lib/nativeChat.js`; Feature-Detection hält fremde Basen sauber.)* *(v0.13.0 — zweiter Schritt: alle drei Modi über je einen Default-Participant (der Modus steht nicht im Request — Muster der Core-Setup-Agents, Beleg in `docs/phase-k-verdrahtung.md`); 9 Tools als `languageModelTools` + `lm.registerTool` (`ui/nativeTools.js`), Freigaben über `prepareInvocation.confirmationMessages` (Review) bzw. durchgewinkt (Auto), Ablehnung → „abgelehnt“ ans Modell; Edits als `textEdit`-/`workspaceEdit`-Parts ins native Chat-Editing (Proposal `chatParticipantAdditions` in package.json + product.json); Edit-Modus mit Tool-Teilmenge ohne Kommandos/Löschen; nativer Tool-Picker filtert die Deklarationen. Bewusste Grenzen: Tool-Verkehr alter Runden wird nicht rekonstruiert (wartet auf Chat-Sync-Andockung), Loop-Antworten streamen pro Modellschritt statt SSE-feingranular.)*
- [x] **Modus-Angebot: Agent / Plan / Erweiterter Plan (Entscheid 17.07.2026):** Upstream hat die Builtin-Modi Ask/Edit abgekündigt — der Picker zeigt nur noch „Agent" + Custom Agents (Beleg: Befund 8 in `docs/phase-k-verdrahtung.md`). Nutzer-Entscheid: KEIN Edit-Comeback, stattdessen zwei Plan-Modi. **Plan** = wenige gebündelte Klärungsfragen mit Empfehlung, nur Lese-Tools, Abschluss ist ein bestätigter Plan. **Erweiterter Plan** = unerbittliches Interview nach GrillMe-Vorbild: exakt eine Frage pro Runde mit Empfehlung, Entscheidungsbaum Zweig für Zweig, Fakten via Lese-Tools selbst nachgeschlagen, gebaut erst nach bestätigtem Verständnis. *(07/2026, v0.14.0: ausgeliefert als `agents/*.agent.md` über den STABILEN Extension-Point `contributes.chatAgents` (kein Proposal — Befund 9); Lese-Tool-Grenze serverseitig hart erzwungen über Marker in den Mode-Instructions (`parseModeMarker`), Frontmatter-`tools:`-Liste nur als UI-Komfort; Prompts headless in `lib/prompts.js` (`buildPlanPrompt`); ask/edit-Participants zurückgebaut, `vscodium-agent.agent` trägt die Chat-View; nutzereigene `.agent.md` ohne Marker laufen generisch als Agent + Zusatz-Instructions. Dazu aus der Probefahrt-Fixliste: Anmelde-Platzhalter-Modell mit Sign-in-Button, 1×-Netz-Retry im Loop, `canBeReferencedInPrompt`+`toolReferenceName` für alle 9 Tools, verschärfte Deutsch-Regel. Headless-Tests decken Toolsets, Marker↔Dateien-Sync und Retry ab. Offen für den echten Build: Sichtbarkeit der zwei Einträge im Picker, Frage-für-Frage-Verhalten, Platzhalter-Flow.)*
- [ ] **Review-Parität nachweisen:** Chat-Editing gegen die heutigen Abnahmekriterien testen (Freigabe pro Änderung, Hunk-weises Annehmen, editierbares Kommando vor Ausführung, sichtbares Agent-Terminal); `approvalMode: auto` auf die Core-Auto-Approve-Einstellungen mappen. Lücken zuerst per Konfiguration schließen, erst dann per Patch. *(Teilbefund Probefahrt 17.07.2026: Agent-Modus end-to-end funktionsfähig — Tool-Cards, Edits mit Review, Löschen inkl. Wiederherstellen, Modell-Picker nach `toolCalling`-Fix.)*
- [ ] **Chat-Sync andocken:** Firestore-Sync (`/v1/sessions`) auf Core-Chat-Sessions umstellen (Session-Serialisierung bzw. Session-Provider-Proposal in 1.121 prüfen); Migration der Bestandssitzungen aus dem `workspaceState`-Cache.
- [ ] **Produkt-Identität:** Default-Layout mit sichtbarem Chat (Secondary Sidebar), eigene Welcome-/Walkthrough-Seite statt deaktiviertem Onboarding (Patches 80/81 anpassen), Keybindings (Strg+L Chat-Fokus u. ä.), Erststart mit Login-Aufforderung.
- [ ] **Webview-Rückbau:** `ui/chatViewProvider.js`, `media/chat.*`, eigener viewsContainer und `vscodium-agent-diff`-Schema entfernen; Kommandos/Settings auf die neuen Ziele mappen; Headless-Tests umziehen. Bis zum Paritätsnachweis bleibt das Webview hinter einem Feature-Flag als Fallback.
- [ ] **Exit-Kriterium:** Ein Build ohne Webview, in dem Chat, Agent-Mode mit allen 10 Tools, natives Multi-File-Review und Inline-Chat unter eigenem Branding laufen — und eine Upstream-Merge-Probe auf ein neueres 1.12x-Tag einmal durchexerziert ist.

Risiken: Die Chat-Proposed-APIs sind der volatilste Teil von VS Code — Signaturen ändern sich zwischen Tags, deshalb pro Upstream-Merge zuerst die Proposals diffen. Teile des Core-Chat-Setups sind Copilot-förmig (Entitlements, Sign-in) und müssen vollständig neutralisiert werden, sonst wirkt das Produkt halbfertig. Der Chat-Sync ist der einzige Baustein, dessen Datenmodell sich ändert.

## Phase 2 — Kontext-System (6–8 Wochen)

Cursors eigentlicher Differenzierer war nie das Modell, sondern der Kontextaufbau (0.2.26 bis 0.12, Juni–Okt 2023). Setzt Phase S voraus: Embeddings laufen über den Proxy. Nach Phase K liefert die native Chat-UI @-Mentions, Kontext-Chips und Slash-Commands mit — hier verbleiben Datenquellen und Backend: Indexing, `.agentignore`, `semantic_search`.

- [ ] **@-Mentions im Chat:** `@file`, `@folder` (0.16.4), später `@git` (0.12). Gepinnter Kontext ergänzt den automatischen Aktivitätsindex.
- [ ] **Kontext-Transparenz:** Chips an jeder Nachricht, die zeigen, was das Modell gesehen hat (0.9.0, 0.35) — passt zur Review-Philosophie des Projekts.
- [ ] **`.agentignore`:** Ignore-Datei mit `.gitignore`-Syntax; schließt Dateien aus Prompt UND Indexing aus (0.12 `.cursorignore`, verschärft in 0.46). Sinnvolle Defaults: `node_modules`, Build-Artefakte, `.env`/Secrets.
- [ ] **Semantisches Codebase-Indexing:** Embeddings über das Proxy-Backend (Vertex AI `embedContent`, Modell `gemini-embedding-001`), lokaler Vektor-Store (z. B. sqlite-vec oder JSON-Shards im `globalStorage`). Inkrementell, mit Fortschrittsanzeige und Abschaltmöglichkeit (0.2.26–0.12: drei Anläufe bis stabil — klein anfangen, ≥80 %-indexiert-genügt-Ansatz aus 0.12.1 übernehmen).
- [ ] **Neues Agent-Tool `semantic_search`:** ergänzt das bestehende Regex-`search_project`.
- [ ] **Slash-Commands:** `/fix`, `/edit` (ganze Datei, 0.12), `/test`.

## Phase 3 — Regeln & Steuerung (3–4 Wochen)

- [ ] **Projekt-Regeln:** `.agent/rules/`-Verzeichnis (Cursor: `.cursorrules` 0.32 → `.cursor/rules` 0.45 → verschachtelt 0.47). Agent wählt passende Regel automatisch; UI zeigt an, wann Regeln aktiv sind (0.46).
- [ ] **Regel-Generierung aus Konversation:** `/generate-rules` übernimmt Erkenntnisse einer Session in eine Regel-Datei (0.49).
- [x] **Modell-Picker in der UI:** Dropdown statt nur Setting — Gemini-Familie: `gemini-2.5-flash` (Standard), `gemini-2.5-pro` (komplexe Aufgaben), `gemini-2.5-flash-lite` (Apply/Hilfsaufgaben). Neuere Gemini-Versionen bei Verfügbarkeit prüfen. (0.30, 0.42 Modellsuche) *(Vorgezogen 07/2026, v0.4.0: Dropdown in der Chat-Statusleiste, schreibt `vscodiumAgent.model` (Global); nur Gemini, abweichende Setting-Werte erscheinen zusätzlich. Fortführung — Katalog-Metadaten, Auto-Routing, 3.5-Familie, Katalog vom Server — in Phase S.)*
- [ ] ~~**Modi:** Ask (nur lesen), Agent-Review (heute Default), Agent-Auto (heute `auto`) als sichtbare Modi mit eigenen Kürzeln; später benutzerdefinierte Modi (0.48).~~ *(Überholt durch Entscheid 17.07.2026 — Modus-Angebot ist jetzt Agent/Plan/Erweiterter Plan, siehe Phase K; Review/Auto bleiben als Freigabe-Einstellung, nicht als Modus.)*
- [ ] **Chat-Export als Markdown** und Chat-Duplizieren (0.50).

## Phase 4 — Agent-Ausbau (6–8 Wochen)

Cursors Agent-Reifung (0.43–1.2, Ende 2024–Mitte 2025) — hier hat der Fork Vorsprung, es geht um Robustheit. Nach Phase K decken die Core-Chat-Funktionen Checkpoints, To-do-Anzeige und Nachrichten-Queue bereits ab — diese Punkte schrumpfen auf Prüfen/Konfigurieren.

- [ ] **Checkpoints & Rollback:** Snapshot vor jeder Agent-Änderungsserie, Wiederherstellung über den Papierkorb hinaus; Checkpoints überleben Reload (0.44).
- [ ] **To-do-Planung sichtbar im Chat:** Agent zerlegt Aufgaben in eine live aktualisierte Liste (1.2) — ergänzt den vorhandenen Drift-Schutz.
- [ ] **Nachrichten-Warteschlange:** Folge-Prompts einreihen, während der Agent arbeitet (1.2).
- [ ] **Lint-Fix-Loop:** Agent liest nach Edits automatisch Diagnostics und behebt selbst verursachte Fehler (0.44).
- [ ] **Auto-Modus-Guardrails:** Kommando-Blockliste/Allowlist für `run_command` im Auto-Modus (0.44 „Yolo Mode" + 0.45 Blocklisten).
- [ ] **MCP-Unterstützung:** Konfiguration über `.agent/mcp.json` (Projekt) und global (0.45–0.47); Tools des MCP-Servers erscheinen im Agent-Loop. Später 1-Klick-Install/OAuth (1.0).
- [ ] **Merge-Konflikte lösen:** „Resolve in Chat"-Aktion (1.2).
- [ ] **Suchen-und-Ersetzen-Edit-Tool:** gezielte Edits in langen Dateien statt Komplett-Rewrite (0.50) — `replace_in_file` existiert, um Fuzzy-Matching/Recovery erweitern.

## Phase 5 — Multimodal & Docs (3–4 Wochen)

- [ ] **Bilder im Chat:** Drag-and-drop von Screenshots/Mockups (0.16.2/0.17) — Gemini ist nativ multimodal, geringer Aufwand über bestehenden `generateContent`-Pfad.
- [ ] **Bilder in Inline-Edit** (0.25).
- [ ] **@docs:** URLs einfügen/crawlen, Doku indexieren, Antworten mit Quellenangaben (0.2.30–0.10). Crawling lokal, Index im `globalStorage`.
- [ ] **@web (optional, Beta):** Websuche als Agent-Tool (0.24) — erfordert Such-API; nur wenn ohne zusätzliche Konten/Provider sauber lösbar.

## Infrastruktur-Track (parallel, laufend)

- [ ] **Upstream-Merge-Kadenz:** Alle 1–2 Monate auf das neueste VS-Code-Tag rebasen (Cursor: 1.79 → 1.83 → … im 1–2-Monats-Takt). Treiber: Extension-API-Kompatibilität und Upstream-CVEs (vgl. CVE-2024-43601 bei Cursor). Da die eigene Logik als Builtin-Extension gekapselt ist, bleiben Konflikte klein — Overlay (`prepare_vscode.sh`) und `patches/` pro Merge prüfen. **Ab Phase K gilt das nur eingeschränkt:** Chat-Patches und die product.json-Chat-Keys liegen im volatilsten Upstream-Bereich; pro Merge zuerst Chat-Proposed-APIs und die Chat-Verdrahtung diffen (Proposal-Allowlist in product.json, Kontextschlüssel `panelParticipantRegistered`, Patch 85).
- [ ] **Insider/Nightly-Kanal nutzen:** Die geerbten `publish-insider-*`-Workflows als Kanal für experimentelle Features (Cursor testete Agents, Interpreter, Indexing monatelang nightly, bevor sie stable wurden).
- [ ] **Feedback-Kanal in der App:** Button im Chat-Panel → GitHub-Issue vorausgefüllt (0.2.17) — ohne Telemetrie.
- [ ] **Changelog pflegen:** Pro Release Stichpunkte (eigene Texte!). Diszipliniert wie Cursors Anfangszeit: klein, ehrlich, häufig.
- [ ] **Open VSX prüfen:** VSCodium nutzt Open VSX als Marketplace-Default — für die Zielgruppe dokumentieren, welche wichtigen Extensions dort fehlen (Cursor musste 2023 einen eigenen Marketplace aufsetzen, 0.10.6).
- [ ] **Sound-/Benachrichtigung bei Agent-Fertigstellung** (0.48) — Kleinigkeit, große Wirkung bei langen Agent-Läufen.

---

## Bewusst verworfen (aus dem Cursor-Changelog)

| Cursor-Feature | Grund |
|---|---|
| Azure-OpenAI-Support (0.2.33) | Leitplanke: kein Azure |
| GPT-4/o-Serie/gpt-*-Modelle | Leitplanke: keine GPT-Modelle |
| ~~Login-Zwang (0.1.12), Pro/Pro++-Tarife~~ | **aufgehoben 07/2026** — SaaS-Pivot: Login und Tarife kommen (Phase S); dafür entfällt der BYOK-/API-Key-Pfad ersatzlos |
| Server-seitiges Indexing/Sync (0.2.27) | Vektor-Store bleibt lokal (die Embedding-Berechnung selbst läuft ab Phase 2 über den Proxy) |
| Eigenes trainiertes Tab-Modell (cursor-fast, Cursor Tab) | nicht realistisch für Teamgröße; ggf. später Inline-Completions via `gemini-2.5-flash-lite` evaluieren |
| Background Agents in Slack (1.1) | außerhalb des Scopes einer lokalen IDE |

---

*Hinweis: Zeitschätzungen sind Richtwerte. Reihenfolge innerhalb einer Phase ist flexibel; Phasen bauen aufeinander auf. Cursor-Versionsangaben dienen nur als Herkunftsnachweis der Idee — alle Texte, UI und Implementierungen entstehen eigenständig.*
