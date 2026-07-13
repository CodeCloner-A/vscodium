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
│  │  lib/tools.js   lib/proxyClient.js ─────► Agent-Proxy    │  │
│  │  (Tool-Schema,  (REST/SSE, Bearer-        (Cloud Run)    │  │
│  │   Dispatch)      ID-Token, Retry)              │         │  │
│  │        │        lib/authManager.js ───────────┤         │  │
│  │        ▼        (Login, Token-Refresh          ▼         │  │
│  │  lib/workspaceHost.js    via Auth-Relay)   Vertex AI     │  │
│  │  (Pfad-Sandbox, Review-                    (Gemini)      │  │
│  │   Gating, Diff-Provider)                                 │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

Seit v0.9.0 (BYOK-Rückbau) läuft **alle** KI-Kommunikation über den Agent-Proxy:
IDE → Cloud Run (`agent-proxy/`, prüft Firebase-ID-Token, Allowlist, Quoten) →
Vertex AI. Auch Anmeldung und Token-Erneuerung gehen über den Proxy (Auth-Relay) —
die Extension enthält keinerlei Schlüssel, nur die öffentliche OAuth-Client-ID.
Seit v0.10.0 synchronisiert der Proxy zusätzlich die Chat-Sitzungen nach Firestore
(`/v1/sessions…`, pro Nutzer und Projekt; `workspaceState` bleibt Offline-Cache).

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

## Modell-Anbindung (Agent-Proxy)

`proxyClient.js` spricht `{proxy.url}/v1/models/{model}:generateContent|streamGenerateContent` per `fetch` an — dependency-frei, `Authorization: Bearer <Firebase-ID-Token>` (pro Anfrage frisch vom `authManager`, Auto-Erneuerung über das Auth-Relay des Proxys). Standort-Routing und Modell-Allowlist liegen serverseitig (`agent-proxy/lib/catalog.js`). Eingebaut: Retry bei 429/5xx (Quota-429 mit `reason: quota` bewusst ohne Retry), präzise deutsche Fehlerbilder (401 → Anmelde-Hinweis, 404 → Katalog-Hinweis, 429 → Kontingent). `firebaseClient.js` enthält nur noch die geteilten Gemini-Format-Helfer (SSE-Parser, Chunk-Merge, Antwort-Auswertung); der frühere BYOK-Direktpfad (`x-goog-api-key` gegen firebasevertexai.googleapis.com) wurde mit v0.9.0 entfernt.

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
│   ├── proxyClient.js      REST/SSE-Client zum Agent-Proxy (einziger Modell-Transport)
│   ├── authManager.js      Anmeldung, ID-Token-Cache, Refresh via Auth-Relay
│   ├── firebaseAuth.js     Browser-Login (PKCE + Loopback), Relay-Aufrufe
│   ├── saasConfig.js       Öffentliche OAuth-Client-ID (fest eingebaut)
│   ├── firebaseClient.js   Gemini-Format-Helfer (SSE-Parser, Merge, Auswertung)
│   ├── sessionSync.js      Chat-Sync-Logik: Workspace-Schlüssel, Abgleichplan (LWW)
│   └── workspaceHost.js    VS-Code-Host: FS, Suche, Diff, Exec, Diagnostics
├── ui/chatViewProvider.js  Webview-Provider, Sitzung, Freigabe-Vermittlung
├── media/                  chat.js, chat.css, agent.svg (Webview-Assets)
└── test/run.js             Headless-Tests mit Mock-LLM und Mock-Host
```

<!-- ENDE PRO_DOCU -->
