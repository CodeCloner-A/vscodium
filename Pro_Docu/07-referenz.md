# 07 – Referenz

## Einstellungen (`vscodiumAgent.*`)

| Einstellung | Typ / Default | Beschreibung |
|---|---|---|
| `firebase.projectId` | string / `controlling-man` | Firebase-Projekt-ID für AI Logic |
| `firebase.appId` | string / leer | Optionale Firebase App-ID (`1:…:web:…`), wird als `X-Firebase-Appid` gesendet |
| `firebase.backend` | `googleAI` \| `vertexAI` / `googleAI` | Gemini Developer API oder Vertex AI |
| `firebase.location` | string / `us-central1` | Vertex-Region (nur bei `vertexAI`) |
| `model` | string / `gemini-2.5-flash` | Gemini-Modellname, z. B. `gemini-2.5-pro` |
| `approvalMode` | `review` \| `auto` / `review` | Freigaben für Änderungen/Kommandos |
| `maxIterations` | number / 24 (2–100) | Max. Modell-Schritte pro Aufgabe |
| `commandTimeoutSec` | number / 180 (5–1800) | Timeout für Agent-Kommandos |
| `context.maxTreeEntries` | number / 250 | Max. Einträge des Projektbaums im Kontext |

## Kommandos (Kommandopalette, Präfix „Agent:")

| Kommando | Wirkung |
|---|---|
| Firebase API-Key setzen | Key abfragen und in SecretStorage speichern |
| Firebase API-Key löschen | Key aus SecretStorage entfernen |
| Verbindung zu Firebase AI Logic testen | Mini-Anfrage senden, Ergebnis melden |
| Neue Sitzung | Verlauf + Gesprächsgedächtnis zurücksetzen |
| Agent-Einstellungen öffnen | Einstellungen gefiltert öffnen |

## Werkzeuge des Agenten (Function-Calling-API)

| Tool | Parameter (Pflicht fett) | Ergebnis (Kurzform) |
|---|---|---|
| `list_files` | max_entries | `{tree}` |
| `read_file` | **path**, start_line, end_line | `{totalLines, shownRange, content}` (nummeriert, gekappt) |
| `search_project` | **query**, is_regex, file_glob | `{matchCount, matches[]}` (max. 60) |
| `write_file` | **path**, **content**, **summary** | `{status: applied\|rejected}` |
| `replace_in_file` | **path**, **old_text**, **new_text**, **summary** | wie oben; Fehler bei 0 oder >1 Treffern |
| `delete_file` | **path**, **summary** | `{status: applied\|rejected}` (Papierkorb) |
| `run_command` | **command**, **purpose**, cwd, timeout_sec | `{exitCode, stdout, stderr, durationMs}` oder `{skipped}` |
| `get_diagnostics` | path | `{count, diagnostics[]}` (nur Errors/Warnings) |
| `task_complete` | **summary**, success | beendet den Lauf |

Alle Pfade sind relativ zum Workspace-Root; `..`, absolute Pfade und Laufwerksangaben werden abgewiesen. Ausgeschlossene Ordner bei Baum/Suche: `node_modules`, `.git`, `dist`, `out`, `build`, `coverage`, `target`, `venv/.venv`, `__pycache__` u. a.

## Firebase-AI-Logic-Schnittstelle (Wire-Format)

Endpunkt (Backend `googleAI`):

```
POST https://firebasevertexai.googleapis.com/v1beta/projects/{projectId}/models/{model}:generateContent
Header: Content-Type: application/json
        x-goog-api-key: <Firebase-Web-API-Key>
        [X-Firebase-Appid: <appId>]
```

Backend `vertexAI` nutzt stattdessen den Pfad `…/projects/{projectId}/locations/{location}/publishers/google/models/{model}:generateContent`.

Request-Körper (Auszug): `systemInstruction{role:'system',parts[]}`, `contents[]` (Rollen `user`/`model`; Tool-Ergebnisse als `functionResponse`-Parts in `user`-Content), `tools[{functionDeclarations}]`, `toolConfig{functionCallingConfig{mode:'AUTO'}}`, `generationConfig{temperature:0.2}`. Retry bei HTTP 429/5xx (2 Wiederholungen mit Backoff).

## Dateien & Orte

| Was | Wo |
|---|---|
| Extension-Quellcode | `src/stable/extensions/vscodium-agent/` |
| Kurz-Doku der Extension | `docs/vscodium-agent.md`, `…/vscodium-agent/README.md` |
| Diese Dokumentation | `Pro_Docu/` |
| Build-Workflow Windows | `.github/workflows/ci-build-windows.yml` |
| VS-Code-Zielversion | `upstream/stable.json` |
| API-Key (installierte IDE) | SecretStorage → Windows-Anmeldeinformationsverwaltung |

## Exit-/Statuscodes des Agenten-Laufs

| Status | Bedeutung |
|---|---|
| `completed` | Aufgabe abgeschlossen (`task_complete` oder konversationelles Ende) |
| `stopped` | Vom Benutzer gestoppt |
| `max-iterations` | Schrittlimit erreicht (Drift-Schutz) |
| `error` | API-/Netzwerkfehler; Details im Chat |

<!-- ENDE PRO_DOCU -->
