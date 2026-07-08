# Changelog

Alle nennenswerten Änderungen am VSCodium Agent. Format nach [Keep a Changelog](https://keepachangelog.com/de/), Versionierung nach [SemVer](https://semver.org/lang/de/) (Fixes = Patch, Features = Minor).

## [Unreleased]

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
