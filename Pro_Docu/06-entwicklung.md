# 06 – Entwicklerhandbuch

## Entwicklungsumgebung

Benötigt werden nur Node.js (Version gemäß `.nvmrc` im Repo-Root oder neuer) und Git. Die Extension selbst hat keine npm-Abhängigkeiten — `npm install` ist nicht nötig.

Schnellster Zyklus: Änderung im Extension-Code → Start via `--extensionDevelopmentPath` (siehe [05](05-build-und-release.md)) → in der Dev-Instanz testen → Headless-Tests laufen lassen.

## Code-Konventionen

CommonJS (`require`/`module.exports`), `'use strict'`, Tabs wie im VS-Code-Umfeld üblich, deutschsprachige Benutzertexte, englischsprachige Modell-Prompts (bessere Modellleistung), JSDoc-Typkommentare statt TypeScript. Keine neuen npm-Abhängigkeiten einführen — das ist eine bewusste Robustheitsentscheidung für den Core-Build; wer eine Bibliothek braucht, begründet sie und prüft die Auswirkung auf `build/npm/postinstall` und `vsce.listFiles`.

## Tests

```bash
node src/stable/extensions/vscodium-agent/test/run.js
```

Die Tests decken ab: Tool-Grundfunktionen (Zeilenbereiche, Suche, Fehlerpfade), `replace_in_file`-Eindeutigkeitsprüfung, den kompletten Bug-Fix-Workflow (lesen → Test rot → Fix → Test grün → Abschluss), den Ablehnungspfad im Review-Modus und den `maxIterations`-Schutz. Neue Tools oder Loop-Änderungen bitte immer mit einem Testfall absichern — das Muster (geskriptetes Mock-LLM + In-Memory-Host) steht in `test/run.js`.

## Ein neues Tool hinzufügen (Kochrezept)

1. **Deklaration** in `lib/tools.js` zu `TOOL_DECLARATIONS` hinzufügen (Name, Beschreibung auf Englisch, Parameter im Gemini-Schema — Typnamen groß: `STRING`, `OBJECT`, …).
2. **Ausführung** im `switch` von `executeTool()` implementieren. Regeln: nie werfen (Fehler als `{ error: '…' }` zurückgeben, damit das Modell reagieren kann), Ausgaben kappen, Pfade nur über den Host.
3. Braucht das Tool IDE-Funktionen, die Methode im **Host-Interface** ergänzen: produktiv in `lib/workspaceHost.js`, für Tests im Mock-Host in `test/run.js`.
4. Verändert das Tool Dateien oder führt es etwas aus → durch die **Freigabe-Mechanik** leiten (`host.applyChange` / eigenes Approval analog `runCommand`).
5. UI-Feinschliff: Beschriftung in `describeToolCall()` (`ui/chatViewProvider.js`) und Ergebnis-Zusammenfassung in `summarizeResult()` (`lib/agentController.js`).
6. Testfall schreiben, Systemprompt (`lib/prompts.js`) nur anpassen, wenn das Tool besondere Regeln braucht.

## Webview-Protokoll (UI ↔ Extension)

Nachrichten Webview → Extension: `ready`, `sendTask{text}`, `stop`, `editDecision{id,accept}`, `commandDecision{id,accept}`, `showDiff{changeId}`, `newSession`, `openSettings`, `authClick` (Anmelden bzw. Konto-Menü — der API-Key-Pfad ist mit dem BYOK-Rückbau v0.9.0 entfallen). Extension → Webview: `init{state}`, `append{item}`, `toolUpdate{id,status,result}`, `decision{id,status}`, `running{value}`. Der Verlauf wird extensionseitig gehalten (`items`) und bei `ready` komplett neu gerendert — die Webview ist damit jederzeit rekonstruierbar.

## Debugging

- **Extension-Host-Log:** Hilfe → Toggle Developer Tools (Konsole der IDE) bzw. `console.log` in der Extension.
- **Webview:** Kommandopalette → „Developer: Open Webview Developer Tools".
- **LLM-Verkehr:** In `firebaseClient.js#_post` temporär Request/Response loggen — Vorsicht, enthält Dateiinhalte; nie committen.
- **Agent dreht durch:** `maxIterations` klein stellen (z. B. 4) und die Historie (`run.contents`) inspizieren.

## Qualitätsleitplanken vor jedem Commit

`node --check` über geänderte JS-Dateien (oder kurz die Dev-Instanz starten), Headless-Tests grün, keine Secrets/Logs im Diff, Benutzertexte deutsch, `package.json`-Manifest valide (ein VSIX-Probelauf validiert es mit).

<!-- ENDE PRO_DOCU -->
