# Changelog

Alle nennenswerten Änderungen am VSCodium Agent. Format nach [Keep a Changelog](https://keepachangelog.com/de/), Versionierung nach [SemVer](https://semver.org/lang/de/) (Fixes = Patch, Features = Minor).

## [Unreleased]

## [0.9.0] – 2026-07-13

### Entfernt
- **BYOK-Rückbau (Phase S, Roadmap-Punkt 10):** Der direkte API-Key-Pfad zu Firebase AI Logic ist komplett weg — Kommandos „Firebase API-Key setzen/löschen“, die Einstellungen `firebase.projectId`/`appId`/`backend`/`location` und `auth.googleClientId`/`googleClientSecret` sowie der `FirebaseAiLogicClient` (übrig bleiben die geteilten Gemini-Format-Helfer). Ein noch gespeicherter API-Key wird beim ersten Start gelöscht. Das Standort-Routing (`resolveRoute`) entfällt clientseitig — es liegt vollständig beim Proxy.

### Geändert
- **Anmeldung und Token-Erneuerung laufen über das Auth-Relay des Proxys** (`POST /v1/auth/exchange` bzw. `/v1/auth/refresh`, Proxy v0.3.0): Die Extension trägt keinerlei Geheimnisse mehr — OAuth-Client-Secret und Firebase-Web-API-Key leben ausschließlich im Cloud-Run-Proxy (Secret Manager). Im Client verbleibt nur die öffentliche OAuth-Client-ID (fest eingebaut, `lib/saasConfig.js`); der Browser-Flow (PKCE + Loopback + state-Prüfung) bleibt unverändert. Bestehende Anmeldungen überleben das Update (gleicher Refresh-Token, neuer Erneuerungs-Weg).
- Chat, Inline-Edit und „In Datei übernehmen“ setzen jetzt die Anmeldung voraus; das Setup-Panel bietet direkt „Mit Google anmelden“ statt der API-Key-Eingabe. „Agent: Verbindung testen“ prüft den Agent-Proxy.

### Sicherheit
- Kein Schlüsselmaterial mehr im ausgelieferten Client oder in den Einstellungen; empfohlen: den Web-API-Key in der GCP-Konsole zusätzlich auf die Identity-Toolkit-API beschränken (siehe `docs/agent-proxy.md`).
- Die (unauthentifizierten) Auth-Endpunkte des Proxys haben einen **eigenen** Rate-Limit-Eimer (getrennt vom Modell-Verkehr) und prüfen das per-IP-Limit zuerst — ein Anmelde-Flood aus einer IP kann den bezahlten Modell-Verkehr nicht mehr über den geteilten Gesamtdeckel aussperren (aus dem Security-Review).
- Ein harter Anmelde-/Erneuerungsfehler (Refresh-Token abgelaufen/widerrufen) wird im Client nicht mehr als retrybarer Netzwerkfehler behandelt: kein dreifacher Wiederholversuch, der eigentliche Anmelde-Hinweis bleibt sichtbar (aus dem Security-Review).

## [0.8.0] – 2026-07-12

### Hinzugefügt
- **Verbrauchsanzeige (Metering, Phase S):** Kommando „Agent: Verbrauch anzeigen“ (auch im Konto-Menü der Chat-Statusleiste) zeigt den Monatsverbrauch des angemeldeten Nutzers — Tokens, Limit, Prozent, Anfragen, Tarif (`GET /v1/usage` des Proxys). Serverseitig zählt der Proxy jetzt pro Nutzer und Monat in Firestore mit und setzt harte Monats-Quoten durch (Proxy v0.2.0, siehe `docs/agent-proxy.md`).

### Geändert
- Ein erschöpftes Monatskontingent (429 mit `reason: quota`) wird nicht mehr wie ein Rate-Limit behandelt: kein automatischer Retry (Warten hilft bis Monatsende nicht), stattdessen ein klarer Hinweis auf die Verbrauchsanzeige.

## [0.7.0] – 2026-07-12

### Hinzugefügt
- **Agent-Verkehr über den Proxy (SaaS-Pfad):** Wer angemeldet ist, spricht mit Chat, Inline-Edit und „In Datei übernehmen“ automatisch den Cloud-Run-Proxy (`lib/proxyClient.js` — gleiches Interface wie der bisherige Client, Authentifizierung per ID-Token, SSE-Streaming, Retry bei 429/5xx, verständliche Hinweise bei 401/404/429). Ohne Anmeldung gilt übergangsweise weiter der API-Key-Pfad.
- **Modell-Picker zeigt das Server-Angebot:** Angemeldet bezieht der Picker die Modellliste vom Proxy (`GET /v1/models`, 5 Minuten gecacht) — der Dienst bestimmt das Angebot, inklusive Standort-Anzeige; bei nicht erreichbarem Proxy greift der lokale Katalog.
- Der Verbindungstest nutzt beim Proxy-Pfad den Katalog-Endpunkt und verbraucht keine Modell-Tokens; das Log nennt pro Lauf den Weg („Proxy“ vs. „AI Logic“).

## [0.6.0] – 2026-07-12

### Hinzugefügt
- **Google-Anmeldung (SaaS-Login, Phase S):** Kommando „Agent: Mit Google anmelden“ öffnet den Browser (OAuth für installierte Apps: PKCE + Loopback-Redirect auf 127.0.0.1); das Google-Konto wird per `signInWithIdp` bei Firebase Auth eingelöst. Der Refresh-Token liegt in der SecretStorage, das kurzlebige ID-Token wird automatisch erneuert (Token-Rotation wird persistiert). Anmeldestatus in der Chat-Statusleiste — Klick meldet an bzw. öffnet das Konto-Menü (Abmelden, Proxy-Test). Neue Kommandos: „Abmelden“, „Proxy-Verbindung testen“ (End-to-End-Probe gegen den Cloud-Run-Proxy).
- Neue Einstellungen: `vscodiumAgent.proxy.url` (Standard: der Cloud-Run-Proxy des Projekts) sowie `vscodiumAgent.auth.googleClientId`/`googleClientSecret` (OAuth-Client vom Typ „Desktop-App“).
- Robustheit der Anmeldung (aus dem Security-Review): Anmeldung ist abbrechbar (Fortschritts-Benachrichtigung; ein neuer Versuch beendet den alten statt parallel zu laufen); der Loopback-Server schließt auch bei Browser-Fehlern sofort; Abmelden während einer laufenden Token-Erneuerung bleibt endgültig (kein Zurückschreiben rotierter Tokens); Anmeldestatus synchronisiert sich zwischen mehreren Fenstern; ein Wechsel oder Löschen des Web-API-Keys (Projektwechsel) meldet automatisch ab; transiente Keyring-Fehler werden beim nächsten Zugriff erneut versucht statt die Sitzung dauerhaft abzumelden.

## [0.5.0] – 2026-07-12

### Hinzugefügt
- **Modell-Katalog mit Auto-Routing:** `gemini-3.5-flash` steht im Modell-Picker zur Wahl. Den Standort löst die Extension pro Modell automatisch auf (das Backend bestimmt weiterhin `vscodiumAgent.firebase.backend`) — Gemini-3.x-Modelle sind über Firebase AI Logic nur mit Standort `global` erreichbar (gilt per Heuristik auch für 3.x-Modelle, die manuell in den Einstellungen stehen); die 2.5-Familie bleibt regional pinnbar. Der Picker zeigt feste Standorte als Suffix samt Tooltip; wird die Location-Einstellung übersteuert, steht das im Log.

### Geändert
- `vscodiumAgent.firebase.location` ist jetzt ein Experten-Override: Modelle mit festem Standort übersteuern die Einstellung automatisch (erster Schritt von Phase S der Roadmap; das Routing wandert später in das Proxy-Backend).
- Der 404-Fehlerhinweis erklärt die Standort-Regel für Gemini 3.x.

### Behoben
- **Codeblöcke:** „Kopieren“ und „In Datei übernehmen“ verloren bei mehrzeiligen Blöcken alle Zeilenumbrüche (Umbrüche wurden im Rendering zu `<br>` und fehlten beim Auslesen).
- **Modell-Picker:** Die Auswahl schrieb immer in die globalen Einstellungen; ein Workspace-Wert von `vscodiumAgent.model` überstimmte sie stillschweigend und der Picker sprang zurück. Jetzt wird dorthin geschrieben, wo der Wert wirkt.
- Modellnamen mit abschließendem Schrägstrich (z. B. `gemini-3.5-flash/`) wurden still auf das Default-Modell umgeleitet, statt als Tippfehler sichtbar zu werden (404-Hinweis).
- Während einer laufenden Codeblock-Übernahme kann kein Agent-Lauf mehr starten, der die offene Review-Karte der Übernahme stillschweigend abgelehnt hätte.
- Settings-Änderungen mitten in einer Kommando-Freigabe verwerfen nicht mehr den bereits editierten Kommando-Text in der Karte.
- Der Picker zeigt den festen Standort auch für Modelle, die nur in den Einstellungen stehen (z. B. 3.x-Previews); Schreibweisen wie `models/gemini-3.5-flash` erzeugen keinen Duplikat-Eintrag mehr.

## [0.4.0] – 2026-07-08

### Hinzugefügt
- **Streaming-Diff im Inline-Edit:** Die Modellantwort wird live in die Editor-Region gestreamt – als eine einzige Undo-Gruppe (Strg+Z stellt den Ausgangszustand her). Abbruch über die Fortschritts-Benachrichtigung setzt die Region sauber zurück; ohne SSE-Unterstützung automatischer Rückfall auf den nicht-streamenden Aufruf.
- **Partielles Annehmen:** Nach dem Inline-Edit zeigt ein Zeilen-Diff die geänderten Blöcke (grün markiert). Jeder Block lässt sich per CodeLens einzeln verwerfen; am Blockanfang stehen „Alles behalten“, „Anpassen…“ und „Alles verwerfen“. Alle Verwerfen-Pfade sind gegen zwischenzeitliche Benutzereingaben abgesichert.
- **Follow-ups:** „Anpassen…“ verfeinert den offenen Vorschlag mit einer weiteren Instruktion auf dem aktuellen Stand; „Verwerfen“ stellt weiterhin den Zustand vor dem ersten Edit wieder her.
- **Sichtbares Agent-Terminal:** Mit `vscodiumAgent.terminal.mode` = `terminal` laufen freigegebene Kommandos sichtbar im „Agent“-Terminal (Shell-Integration-API, VS Code ≥ 1.93). Die Ausgabe wird ANSI-bereinigt an das Modell gegeben; ohne Shell-Integration automatischer Rückfall auf den unsichtbaren Hintergrund-Lauf.
- **Editierbare Kommandos:** Im Review-Modus lässt sich das Kommando in der Freigabe-Karte vor dem Ausführen anpassen; ausgeführt, angezeigt und protokolliert wird der angepasste Text.
- **Modell-Picker im Chat:** Dropdown in der Statusleiste des Chat-Panels (ausschließlich Gemini: 2.5 Flash, 2.5 Pro, 2.5 Flash-Lite; ein abweichender Wert aus den Einstellungen erscheint zusätzlich). Aus Phase 3 der Roadmap vorgezogen.

### Geändert
- Mindestanforderung an die VS-Code-Basis: `engines.vscode` von `^1.90.0` auf `^1.93.0` (Shell-Integration-API `onDidEndTerminalShellExecution`/`execution.read()`).

## [0.3.0] – 2026-07-07

### Hinzugefügt
- **Aktivitäts-Index:** Die IDE verfolgt, wo der Benutzer arbeitet (bearbeitete, gespeicherte, betrachtete und extern geänderte Dateien; Frecency-Scoring mit 30-Minuten-Halbwertszeit). Das Modell erhält bei jedem Aufgabenstart eine frische Zusammenfassung inklusive aktiver Datei.
- **Delta seit letzter Erfassung:** Liste aller Dateien, die seit der letzten Kontext-Erfassung des Agenten angefasst wurden; Agent-eigene Schreibvorgänge werden getrennt markiert.
- Neues Tool `get_recent_activity`, mit dem sich das Modell während langer Aufgaben selbst aktualisiert.
- Persistenz des Index pro Projekt (`workspaceState`).

## [0.2.0] – 2026-07-07

### Hinzugefügt
- **Auto-Start:** Der Agent-Chat öffnet sich automatisch beim Laden der IDE (Einstellung `vscodiumAgent.openOnStartup`).
- **Mehrfach-Sitzungen:** Sitzungen werden pro Projekt gespeichert und überleben Neustarts; Sitzungsleiste mit Dropdown, Neu- und Löschen-Knopf; Titel aus der ersten Aufgabe; Limit über `vscodiumAgent.sessions.max`.

## [0.1.0] – 2026-07-07

Erste Version.

### Hinzugefügt
- Chat-Sidebar (Webview) mit Plan-, Tool- und Ergebnisprotokoll.
- Agent-Loop mit Gemini Function Calling über Firebase AI Logic (REST, dependency-frei; Standard-Projekt `controlling-man`, Backends Gemini Developer API und Vertex AI).
- Werkzeuge: `list_files`, `read_file`, `search_project`, `write_file`, `replace_in_file`, `delete_file`, `run_command`, `get_diagnostics`, `task_complete`.
- Review-Modus: Diff-Vorschau mit Übernehmen/Ablehnen je Dateiänderung, Freigabe-Gate für Kommandos; Auto-Modus zuschaltbar.
- Drift-Schutz: Schrittlimit (`maxIterations`), periodische Ziel-Erinnerung, Stopp-Knopf.
- API-Key-Verwaltung über SecretStorage, Verbindungstest-Kommando, Workspace-Pfad-Sandbox, deaktiviert in nicht vertrauenswürdigen Workspaces.
- Headless-Testsuite (`node test/run.js`) mit Mock-LLM und Mock-Host.
