# 05 – Build & Release

## Übersicht der Build-Wege

| Weg | Dauer | Ergebnis | Wofür |
|---|---|---|---|
| GitHub Actions (empfohlen) | ~35–60 min | Windows-Installer (EXE) + ZIP | Die „echte" eigene IDE |
| VSIX-Paket | ~1 min | Erweiterung zum Nachinstallieren | Schnelltest des Agenten in jedem VS Code/VSCodium |
| Extension-Dev-Modus | Sekunden | Live-Start ohne Paketierung | Entwicklung am Agenten |

## Weg 1: GitHub Actions (der Standard-Release-Prozess)

### Ablauf

1. Änderungen lokal committen und nach `master` pushen (`git push origin master`).
2. Auf github.com/CodeCloner-A/vscodium → **Actions** → **„CI - Build - Windows"** → **„Run workflow"** → Haken **„Generate assets"** → starten.
3. Nach Abschluss (grüner Haken) den Lauf öffnen → **Artifacts** → **`bin-x64`** herunterladen.

Inhalt von `bin-x64`: `VSCodiumSetup-x64-<version>.exe` (System-Installer, empfohlen), `VSCodiumUserSetup-x64-<version>.exe` (Installation ohne Admin-Rechte) und `VSCodium-win32-x64-<version>.zip` (portabel). Dazu `.sha256`-Prüfsummen.

### Wichtig zu wissen

- **Ohne den Haken „Generate assets" entsteht kein Installer.** Push-getriggerte Läufe bauen nur zur Kontrolle durch (Artefakt „vscode" ist ein internes Zwischenprodukt und kann ignoriert werden).
- Der Job `build (arm64)` betrifft ARM-Geräte; schlägt er fehl, ist das für x64 unerheblich (`fail-fast` ist deaktiviert).
- Artefakte werden nach 3 Tagen automatisch gelöscht — Installer lokal sichern.
- Das Repo muss öffentlich sein, damit die Build-Minuten kostenlos sind.

### Was die Pipeline intern tut

Job `compile`: klont den VS-Code-Quellcode (Version aus `upstream/stable.json`), kopiert `src/stable/*` hinein (→ Agent), wendet `patches/*` an, kompiliert alles und lädt das Ergebnis als Zwischenartefakt hoch. Job `build` (je Architektur): paketiert Electron-App und erzeugt mit „Generate assets" die Installer via Inno Setup.

### Fork-spezifische Anpassungen (gegenüber Original-VSCodium)

In `.github/workflows/ci-build-windows.yml` wurden zwei Korrekturen vorgenommen: Die Versions-Variablen des `build`-Jobs lesen aus `needs.compile.outputs.*` (der referenzierte `check`-Job existiert in diesem Workflow nicht — Ursache leerer Versionsnummern und des MSI-Abbruchs), und im Schritt „Prepare assets" ist der MSI-Bau deaktiviert (`SHOULD_BUILD_MSI(_NOUP): no`), da er ein bestimmtes Windows-SDK auf den Runnern voraussetzt. EXE-Installer und ZIP sind davon unberührt.

## Weg 2: VSIX

```bash
cd src/stable/extensions/vscodium-agent
npx @vscode/vsce package --allow-missing-repository
```

Ergebnis `vscodium-agent-<version>.vsix` → in VS Code/VSCodium über Extensions-Ansicht → „···" → „Aus VSIX installieren…".

**Wichtige Einschränkung:** In der eigenen IDE (Stable-Qualität) lässt sich die **eingebaute** Agent-Extension nicht per VSIX überschreiben — VS Code blockt Updates von Built-ins in Stable-Produkten („not allowed to be updated in the current product quality 'stable'"). Das VSIX eignet sich daher für fremde Installationen (Stock-VS-Code/VSCodium ohne eingebauten Agenten). Für die eigene IDE gilt: dauerhafte Updates über den CI-Build (Weg 1), schnelles Ausprobieren über den Entwicklungsmodus (Weg 3) — dort ersetzt die Dev-Version die Built-in im Testfenster.

## Weg 3: Extension-Entwicklungsmodus

```bash
codium --extensionDevelopmentPath="<Repo>\src\stable\extensions\vscodium-agent" "<Testprojekt>"
```

Startet eine IDE-Instanz mit der Extension direkt aus dem Quellordner.

## Versionierung & Upstream-Pflege

Die IDE-Version folgt VS Code (aktuell 1.121.0, festgelegt in `upstream/stable.json`). Um Upstream-Neuerungen zu übernehmen:

```bash
git remote add upstream https://github.com/VSCodium/vscodium.git   # einmalig
git fetch upstream
git merge upstream/master    # Konflikte wären v. a. in eigenen Dateien selten
git push origin master
```

Da der Agent ausschließlich in **neuen** Dateien lebt (`src/stable/extensions/vscodium-agent/`, `docs/vscodium-agent.md`, `Pro_Docu/`) und nur eine Workflow-Datei angepasst wurde, sind Merge-Konflikte unwahrscheinlich und klein.

## Release-Checkliste

1. Headless-Tests grün: `node src/stable/extensions/vscodium-agent/test/run.js`
2. Version in `src/stable/extensions/vscodium-agent/package.json` erhöhen (SemVer: Fixes = Patch, Features = Minor).
3. Commit + Push, Actions-Lauf mit „Generate assets".
4. `bin-x64` laden, Installer auf einem sauberen System testen (Installation, Key setzen, Verbindungstest, eine kleine Aufgabe).
5. Installer + Prüfsummen archivieren; optional als GitHub-Release veröffentlichen.

<!-- ENDE PRO_DOCU -->
