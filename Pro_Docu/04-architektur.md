# 04 – Architektur

## Gesamtbild

```
┌────────────────────────────────────────────────────────────────┐
│  Eigene IDE (VSCodium-Fork, Windows-Build aus GitHub Actions)  │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Built-in-Extension „vscodium-agent"                     │  │
│  │                                                          │  │
│  │  ui/chatViewProvider.js      media/chat.{js,css}         │  │
│  │  (Webview-Chat, Karten,  ◄──►  (Browser-Seite der UI)    │  │
│  │   Freigaben, Sitzung)                                    │  │
│  │        │                                                 │  │
│  │        ▼                                                 │  │
│  │  lib/agentController.js   ── Agent-Loop, Drift-Schutz    │  │
│  │        │            │                                    │  │
│  │        ▼            ▼                                    │  │
│  │  lib/tools.js   lib/firebaseClient.js ──► Firebase       │  │
│  │  (Tool-Schema,  (REST, Retry,             AI Logic       │  │
│  │   Dispatch)      Fehlerbilder)            (Gemini)       │  │
│  │        │                                                 │  │
│  │        ▼                                                 │  │
│  │  lib/workspaceHost.js ── VS-Code-APIs: Dateien, Suche,   │  │
│  │  (Pfad-Sandbox, Review-  Diagnostics, child_process      │  │
│  │   Gating, Diff-Provider)                                 │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

## Der Agent-Loop

Kern ist ein klassischer Function-Calling-Loop (`lib/agentController.js`):

1. Anfrage an Gemini mit Systemprompt (enthält Arbeitsregeln, Freigabemodus und den gekürzten Projektbaum), bisheriger Historie und den Tool-Deklarationen.
2. Antwort enthält Text (→ Chat) und/oder Funktionsaufrufe.
3. Jeder Funktionsaufruf wird über `tools.js` gegen den Host ausgeführt; das Ergebnis geht als `functionResponse` zurück in die Historie.
4. Weiter bei 1 — bis das Modell `task_complete` aufruft, konversationell endet, das Schrittlimit greift oder der Benutzer stoppt.

Drei Details sind wichtig für Korrektheit: Die Modell-Antwort wird **unverändert** in die Historie übernommen (Gemini-2.5-Modelle hängen an Funktionsaufrufe „thought signatures", die zurückgereicht werden müssen). Tool-Ergebnisse gehen als `role: "user"`-Content zurück (Wire-Format des offiziellen firebase-js-sdk). Und alle Tool-Ausgaben sind größenbegrenzt (Datei-Reads, Suchtreffer, Kommando-Output), damit der Kontext nicht explodiert.

## Trennung von Logik und IDE (Testbarkeit)

`agentController.js`, `tools.js`, `prompts.js` und `firebaseClient.js` kennen **kein** `vscode`-Modul. Alle IDE-Wirkungen laufen über ein Host-Interface, das produktiv `workspaceHost.js` (VS-Code-APIs) implementiert und im Test ein In-Memory-Mock (`test/run.js`). Dadurch ist der komplette Agenten-Workflow headless testbar: `node test/run.js`.

## Review-Gating

`workspaceHost.applyChange()` und `runCommand()` blockieren im Review-Modus auf einer Promise, die erst die Benutzerentscheidung aus der Webview auflöst. Für das Modell ist eine Ablehnung ein normales Tool-Ergebnis (`status: "rejected"`), auf das es reagieren kann. Diff-Vorschau: Alt/Neu-Inhalte werden über einen virtuellen `TextDocumentContentProvider` (Schema `vscodium-agent-diff`) an `vscode.diff` gereicht — es wird nichts auf Platte geschrieben, bevor Du zustimmst.

## Firebase-Anbindung

`firebaseClient.js` spricht `https://firebasevertexai.googleapis.com/v1beta/…:generateContent` direkt per `fetch` an — dependency-frei, Header `x-goog-api-key`. Beide AI-Logic-Backends werden unterstützt (Gemini Developer API als Standard, Vertex AI mit Region per Einstellung). Eingebaut: Retry bei 429/5xx, präzise deutsche Fehlerbilder (API nicht aktiviert → Console-Link, 401/403 → Key-Hinweise, 404 → Modellname).

## Integration in den IDE-Build

Der VSCodium-Build kopiert `src/stable/*` in den VS-Code-Quellbaum, **bevor** Patches und Build laufen. Die Extension liegt deshalb unter `src/stable/extensions/vscodium-agent/` und landet so in `vscode/extensions/`. Der VS-Code-Build packt automatisch jede dort liegende Extension mit `package.json` als Built-in (verifiziert an `build/lib/extensions.ts`, Tag 1.121.0). Bewusste Entscheidungen für Build-Robustheit: reines CommonJS-JavaScript (kein Compile-Schritt), null npm-Abhängigkeiten, keine Proposed APIs.

## Verzeichnisstruktur der Extension

```
src/stable/extensions/vscodium-agent/
├── package.json          Manifest: View-Container, Kommandos, Einstellungen
├── extension.js          Aktivierung, Kommando- und Provider-Registrierung
├── lib/
│   ├── agentController.js  Loop, Iterationslimit, Drift-Erinnerung
│   ├── tools.js            Tool-Deklarationen (Gemini-Schema) + Dispatch
│   ├── prompts.js          Systemprompt, Drift-Reminder
│   ├── firebaseClient.js   REST-Client Firebase AI Logic
│   └── workspaceHost.js    VS-Code-Host: FS, Suche, Diff, Exec, Diagnostics
├── ui/chatViewProvider.js  Webview-Provider, Sitzung, Freigabe-Vermittlung
├── media/                  chat.js, chat.css, agent.svg (Webview-Assets)
└── test/run.js             Headless-Tests mit Mock-LLM und Mock-Host
```

<!-- ENDE PRO_DOCU -->
