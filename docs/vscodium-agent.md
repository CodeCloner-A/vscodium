# VSCodium Agent – Agentische IDE mit Firebase AI Logic

Dieser Fork enthält eine Built-in-Extension **`vscodium-agent`**, die VSCodium um einen integrierten KI-Agenten erweitert (vergleichbar mit dem Agent-Ansatz von Cursor/Windsurf/Antigravity). Der Agent nutzt **Firebase AI Logic** (Gemini) über Dein Firebase-Projekt **`controlling-man`**.

## Was der Agent kann

Der Agent arbeitet in einem Plan-→-Werkzeug-→-Iterations-Loop mit Projektkontext (Dateibaum, Suche, Diagnostics) statt isolierter Dateien. Er kann Code generieren und ergänzen, bestehenden Code refactoren, Fehler suchen und beheben, mehrere Dateien konsistent anpassen sowie Tests und Kommandos ausführen und auf Basis der Ausgabe nachbessern, bis sie grün sind.

Werkzeuge des Agenten: `list_files`, `read_file`, `search_project`, `write_file`, `replace_in_file`, `delete_file`, `run_command`, `get_recent_activity`, `get_diagnostics`, `task_complete`.

## Wo der Code liegt (Build-Integration)

Die Extension liegt unter `src/stable/extensions/vscodium-agent/`. `prepare_vscode.sh` kopiert `src/stable/*` vor dem Patchen in den VS-Code-Quellbaum – die Extension landet dadurch in `vscode/extensions/vscodium-agent/` und wird vom VS-Code-Build **automatisch** als Built-in-Extension mitgepackt (der Build sammelt alle `extensions/*/package.json` ein; verifiziert gegen VS Code 1.121.0, `build/lib/extensions.ts`).

Bewusste Design-Entscheidungen für einen robusten Build: reines JavaScript (kein Compile-Schritt, kein tsconfig), **null npm-Abhängigkeiten** (Firebase AI Logic wird per REST/fetch angesprochen, Wire-Format identisch zum offiziellen `firebase-js-sdk`), keine Proposed APIs. Für Insider-Builds bei Bedarf denselben Ordner nach `src/insider/extensions/` kopieren.

## Einrichtung (einmalig)

### 1. Firebase AI Logic im Projekt aktivieren

1. [Firebase Console](https://console.firebase.google.com/project/controlling-man/ailogic/) öffnen (Projekt `controlling-man` → **AI Logic**).
2. **Get started** klicken und als API die **Gemini Developer API** wählen (Standard, kostenloser Einstieg). Alternativ Vertex AI (erfordert Blaze-Tarif).
3. Falls noch keine **Web-App** im Projekt existiert: Projekteinstellungen → Allgemein → „App hinzufügen" → Web.

### 2. Zugangsdaten in VSCodium hinterlegen

Aus der Firebase Console (Projekteinstellungen → Allgemein → Deine Web-App → `firebaseConfig`) brauchst Du:

- `apiKey` → Kommandopalette: **„Agent: Firebase API-Key setzen"** (wird verschlüsselt in der SecretStorage abgelegt, nicht in den Settings)
- optional `appId` → Einstellung `vscodiumAgent.firebase.appId`

Die Projekt-ID ist als `controlling-man` voreingestellt (`vscodiumAgent.firebase.projectId`).

### 3. Verbindung testen

Kommandopalette: **„Agent: Verbindung zu Firebase AI Logic testen"**. Bei „API not enabled" den Link aus der Fehlermeldung öffnen und AI Logic aktivieren, ein paar Minuten warten.

## Einstellungen

| Einstellung | Default | Bedeutung |
|---|---|---|
| `vscodiumAgent.firebase.projectId` | `controlling-man` | Firebase-Projekt |
| `vscodiumAgent.firebase.backend` | `googleAI` | `googleAI` (Gemini Developer API) oder `vertexAI` |
| `vscodiumAgent.firebase.location` | `us-central1` | Experten-Override: Region (nur Vertex). Modelle mit festem Standort (Gemini 3.x → `global`) übersteuern sie automatisch |
| `vscodiumAgent.model` | `gemini-2.5-flash` | z. B. `gemini-3.5-flash` (neueste Generation) oder `gemini-2.5-pro` für schwierige Aufgaben; bequem per Dropdown in der Chat-Statusleiste — den Standort löst die Extension pro Modell automatisch auf |
| `vscodiumAgent.inlineEdit.model` | `gemini-2.5-flash` | Modell für Inline-Edit (Strg+I), Quick-Fixes, „In Datei übernehmen“ |
| `vscodiumAgent.approvalMode` | `review` | `review` = Diffs bestätigen, `auto` = direkt anwenden |
| `vscodiumAgent.terminal.mode` | `captured` | `terminal` = Agent-Kommandos sichtbar im „Agent“-Terminal (Shell-Integration nötig) |
| `vscodiumAgent.maxIterations` | `24` | Schrittlimit pro Aufgabe (Drift-Schutz) |
| `vscodiumAgent.commandTimeoutSec` | `180` | Timeout für Test-/Buildläufe |
| `vscodiumAgent.proxy.url` | Cloud-Run-URL | Agent-Proxy für den SaaS-Betrieb (siehe `docs/agent-proxy.md`) |
| `vscodiumAgent.auth.googleClientId` / `…Secret` | – | OAuth-Client (Typ „Desktop-App“) für die Google-Anmeldung |

## SaaS-Login (Phase S)

Einmalige Einrichtung: Zuerst den **Firebase Web-API-Key** hinterlegen (Kommando
„Agent: Firebase API-Key setzen“ — ohne ihn bricht die Anmeldung sofort ab). Dann in der
Firebase Console **Authentication → Sign-in method → Google** aktivieren; in der GCP
Console **APIs & Dienste → Anmeldedaten → OAuth-Client-ID → Desktop-App** anlegen und
ID + Secret in die Einstellungen eintragen (Desktop-Client-Secrets gelten laut Google-Doku
nicht als vertraulich — die Sicherheit liefern PKCE + Loopback).

Danach: Kommando **„Agent: Mit Google anmelden“** (oder Klick auf den Status in der
Chat-Statusleiste) → Browser-Anmeldung → fertig. Die Anmeldung wartet maximal 5 Minuten
auf die Browser-Antwort und lässt sich über die Fortschritts-Benachrichtigung abbrechen.
**„Agent: Proxy-Verbindung testen“** prüft die komplette Kette IDE → Proxy →
Modell-Katalog. Der Refresh-Token liegt in der SecretStorage (das kurzlebige ID-Token
nur im Speicher); „Agent: Abmelden“ löscht ihn. Ein Wechsel des Web-API-Keys
(= Projektwechsel) meldet automatisch ab.

## Bedienung

Agent-Icon in der Activity Bar → Aufgabe beschreiben. Der Agent zeigt seinen Plan, jedes Werkzeug als Protokollzeile und liefert am Ende eine Zusammenfassung.

Im **Review-Modus** erscheint für jede Dateiänderung eine Karte mit **Diff anzeigen / Übernehmen / Ablehnen** (der Diff öffnet sich automatisch im Editor). Kommandos wie `npm test` erscheinen als Karte mit **Ausführen / Überspringen**. Abgelehnte Aktionen sieht das Modell als Ablehnung und passt sein Vorgehen an.

Grenzen im Blick behalten: Der Agent ist nicht automatisch fehlerfrei – menschliche Aufsicht bleibt wichtig. Gegen **Agent-Drift** wirken das Schrittlimit, eine periodisch injizierte Ziel-Erinnerung, das transparente Tool-Protokoll und der Stopp-Knopf; bei langen Aufgaben lieber in Teilaufgaben schneiden.

## Testen ohne Voll-Build (empfohlen zuerst)

Der komplette VSCodium-Build dauert Stunden. Die Extension ist aber eine normale VS-Code-Extension und läuft sofort in jedem VSCodium/VS Code:

```bash
codium --extensionDevelopmentPath="C:\Users\ergin\Desktop\VSCode-Fork\vscodium\src\stable\extensions\vscodium-agent" "C:\Pfad\zu\einem\Testprojekt"
```

Alternativ als VSIX paketieren und regulär installieren:

```bash
cd src/stable/extensions/vscodium-agent
npx @vscode/vsce package --allow-missing-repository
codium --install-extension vscodium-agent-0.1.0.vsix
```

Headless-Logiktests (ohne VS Code, ohne API-Key): `node test/run.js`

## Voll-Build mit integrierter Extension

Wie gehabt über die Build-Skripte des Repos (unter Windows in Git Bash/MSYS2, siehe `docs/howto-build.md`):

```bash
export SHOULD_BUILD=yes
export VSCODE_QUALITY=stable
export OS_NAME=windows   # bzw. linux/osx
export CI_BUILD=no
./get_repo.sh && ./build.sh
```

`prepare_vscode.sh` übernimmt die Extension automatisch; im fertigen VSCodium erscheint der Agent als Built-in-Extension in der Activity Bar.

## Sicherheit

Der API-Key liegt in der VS-Code-SecretStorage (OS-Schlüsselbund), nie im Repo oder in den Settings. Der Agent kann nur Pfade innerhalb des geöffneten Workspace lesen/schreiben; in nicht vertrauenswürdigen Workspaces (Workspace Trust) ist die Extension deaktiviert. Kommandos laufen mit Deinen Benutzerrechten – im Review-Modus erst nach Freigabe.
