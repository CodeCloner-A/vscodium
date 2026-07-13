# VSCodium Agent – Agentische IDE (Gemini über den Agent-Proxy)

Dieser Fork enthält eine Built-in-Extension **`vscodium-agent`**, die VSCodium um einen integrierten KI-Agenten erweitert (vergleichbar mit dem Agent-Ansatz von Cursor/Windsurf/Antigravity). Der Agent spricht **Gemini über den Agent-Proxy** (Cloud Run, siehe `docs/agent-proxy.md`) — Anmeldung per Google-Konto, keinerlei Schlüssel im Client. Der frühere BYOK-Pfad (eigener Firebase-API-Key) wurde mit v0.9.0 entfernt.

## Was der Agent kann

Der Agent arbeitet in einem Plan-→-Werkzeug-→-Iterations-Loop mit Projektkontext (Dateibaum, Suche, Diagnostics) statt isolierter Dateien. Er kann Code generieren und ergänzen, bestehenden Code refactoren, Fehler suchen und beheben, mehrere Dateien konsistent anpassen sowie Tests und Kommandos ausführen und auf Basis der Ausgabe nachbessern, bis sie grün sind.

Werkzeuge des Agenten: `list_files`, `read_file`, `search_project`, `write_file`, `replace_in_file`, `delete_file`, `run_command`, `get_recent_activity`, `get_diagnostics`, `task_complete`.

## Wo der Code liegt (Build-Integration)

Die Extension liegt unter `src/stable/extensions/vscodium-agent/`. `prepare_vscode.sh` kopiert `src/stable/*` vor dem Patchen in den VS-Code-Quellbaum – die Extension landet dadurch in `vscode/extensions/vscodium-agent/` und wird vom VS-Code-Build **automatisch** als Built-in-Extension mitgepackt (der Build sammelt alle `extensions/*/package.json` ein; verifiziert gegen VS Code 1.121.0, `build/lib/extensions.ts`).

Bewusste Design-Entscheidungen für einen robusten Build: reines JavaScript (kein Compile-Schritt, kein tsconfig), **null npm-Abhängigkeiten** (der Proxy wird per REST/fetch angesprochen, Gemini-Wire-Format), keine Proposed APIs. Für Insider-Builds bei Bedarf denselben Ordner nach `src/insider/extensions/` kopieren.

## Einrichtung

Für Nutzer: **„Agent: Mit Google anmelden“** — das ist alles. Kein API-Key, keine
OAuth-Einstellungen, kein Firebase-Setup; sämtliche Geheimnisse hält der Agent-Proxy
serverseitig (Auth-Relay, siehe `docs/agent-proxy.md`).

Für Betreiber (einmalig, serverseitig): Firebase **Authentication → Sign-in method →
Google** aktivieren; in der GCP Console einen OAuth-Client vom Typ **Desktop-App**
anlegen; Client-Secret und Web-API-Key als Secrets in den Proxy deployen
(`docs/agent-proxy.md`, Schritt 3c). Die öffentliche OAuth-Client-ID ist in der
Extension fest eingebaut (`lib/saasConfig.js` — vor dem Release eintragen).

**„Agent: Verbindung testen“** prüft die Kette IDE → Proxy → Modell-Katalog.

## Einstellungen

| Einstellung | Default | Bedeutung |
|---|---|---|
| `vscodiumAgent.proxy.url` | Cloud-Run-URL | Agent-Proxy: Anmeldung, Modell-Allowlist, Standort-Routing, Metering (siehe `docs/agent-proxy.md`) |
| `vscodiumAgent.model` | `gemini-2.5-flash` | z. B. `gemini-3.5-flash` (neueste Generation) oder `gemini-2.5-pro` für schwierige Aufgaben; bequem per Dropdown in der Chat-Statusleiste — Standort und Angebot bestimmt der Proxy |
| `vscodiumAgent.inlineEdit.model` | `gemini-2.5-flash` | Modell für Inline-Edit (Strg+I), Quick-Fixes, „In Datei übernehmen“ |
| `vscodiumAgent.approvalMode` | `review` | `review` = Diffs bestätigen, `auto` = direkt anwenden |
| `vscodiumAgent.terminal.mode` | `captured` | `terminal` = Agent-Kommandos sichtbar im „Agent“-Terminal (Shell-Integration nötig) |
| `vscodiumAgent.maxIterations` | `24` | Schrittlimit pro Aufgabe (Drift-Schutz) |
| `vscodiumAgent.commandTimeoutSec` | `180` | Timeout für Test-/Buildläufe |

## SaaS-Login (Phase S)

Kommando **„Agent: Mit Google anmelden“** (oder Klick auf den Status in der
Chat-Statusleiste) → Browser-Anmeldung → fertig. Die Anmeldung wartet maximal 5 Minuten
auf die Browser-Antwort und lässt sich über die Fortschritts-Benachrichtigung abbrechen.
Der Code-Tausch und jede Token-Erneuerung laufen über das Auth-Relay des Proxys —
die Extension enthält keine Geheimnisse. Der Refresh-Token liegt in der SecretStorage
(das kurzlebige ID-Token nur im Speicher); „Agent: Abmelden“ löscht ihn.
**„Agent: Proxy-Verbindung testen“** prüft die komplette Kette IDE → Proxy →
Modell-Katalog.

**Chat, Inline-Edit und „In Datei übernehmen“ setzen die Anmeldung voraus** und laufen
vollständig über den Proxy (Standort-Routing serverseitig, Modell-Picker zeigt das
Server-Angebot). Ohne Anmeldung zeigt der Chat eine klare Meldung mit Anmelden-Aktion.

Für jeden Nutzer gilt ein monatliches Token-Kontingent (Details in `docs/agent-proxy.md`).
**„Agent: Verbrauch anzeigen“** (auch im Konto-Menü der Chat-Statusleiste) zeigt den
aktuellen Monatsverbrauch samt Limit. Ist das Kontingent erschöpft, meldet der Agent das
klar als Fehler — erneutes Versuchen hilft dann erst im Folgemonat bzw. nach einer
Limit-Erhöhung.

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

Headless-Logiktests (ohne VS Code, ohne Anmeldung): `node test/run.js`

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

Die Extension enthält keinerlei Schlüsselmaterial: OAuth-Client-Secret und Firebase-Web-API-Key leben ausschließlich im Agent-Proxy (Secret Manager); lokal liegt nur der Refresh-Token des angemeldeten Kontos in der VS-Code-SecretStorage (OS-Schlüsselbund), nie im Repo oder in den Settings. Der Agent kann nur Pfade innerhalb des geöffneten Workspace lesen/schreiben; in nicht vertrauenswürdigen Workspaces (Workspace Trust) ist die Extension deaktiviert. Kommandos laufen mit Deinen Benutzerrechten – im Review-Modus erst nach Freigabe.
