# VSCodium Agent

Integrierter KI-Agent für VSCodium auf Basis von **Firebase AI Logic** (Gemini). Der Agent arbeitet mit Projektkontext statt einzelner Dateien: Er plant Entwicklungsaufgaben in mehreren Schritten, liest und ändert Dateien, führt Tests aus und bessert auf Basis der Resultate nach.

Fähigkeiten: Code generieren und ergänzen, bestehenden Code refactoren, Fehler suchen und beheben (inkl. IDE-Diagnostics), mehrere Dateien konsistent anpassen, Kommandos/Tests ausführen und iterieren.

## Schnellstart

1. Agent-Icon in der Activity Bar öffnen.
2. Kommando **„Agent: Firebase API-Key setzen"** ausführen (Web-API-Key aus der Firebase Console, Projekt `controlling-man`).
3. **„Agent: Verbindung zu Firebase AI Logic testen"** ausführen.
4. Aufgabe in den Chat schreiben, z. B. *„Refactore die Fehlerbehandlung in src/api/ auf ein einheitliches Result-Objekt und lass die Tests laufen."*

## Aufsicht (Review-Modus)

Standardmäßig zeigt der Agent jede Dateiänderung als Diff und wartet auf **Übernehmen/Ablehnen**; Kommandos (z. B. `npm test`) erfordern ebenfalls eine Freigabe. Umschaltbar über die Einstellung `vscodiumAgent.approvalMode` (`review`/`auto`). Gegen Agent-Drift: sichtbares Tool-Protokoll, periodische Ziel-Erinnerung, `maxIterations`-Limit und Stopp-Knopf.

Ausführliche Doku: `docs/vscodium-agent.md` im VSCodium-Build-Repo.

## Entwicklung

Headless-Tests (ohne VS Code): `node test/run.js`
