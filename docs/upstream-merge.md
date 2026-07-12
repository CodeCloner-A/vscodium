# Upstream-Merge-Checkliste

Prozess, um den Fork regelmäßig auf den neuesten Stand von VSCodium (und damit VS Code) zu bringen. Ziel-Kadenz: **alle 1–2 Monate** — VS Code released monatlich; je länger gewartet wird, desto schmerzhafter der Merge. Treiber sind Extension-API-Kompatibilität (Extensions verlangen Mindest-VS-Code-Versionen) und Upstream-Sicherheitsfixes.

## Architektur-Erinnerung

Dieser Fork ist ein Fork des VSCodium-**Build-Repos**, nicht des VS-Code-Quellcodes. Die VS-Code-Version kommt über `upstream/stable.json` (Tag + Commit); `prepare_vscode.sh` checkt den VS-Code-Quellcode aus, wendet `patches/` an und kopiert das Overlay `src/stable/*` hinein — dort liegt unsere Extension (`src/stable/extensions/vscodium-agent`). Eigene Änderungen bleiben dadurch weitgehend konfliktfrei.

## Checkliste pro Merge

### Vorbereitung

- [ ] Sauberen Stand sicherstellen: `git status` leer, aktueller Branch gepusht.
- [ ] Upstream-Remote vorhanden? Falls nein: `git remote add upstream https://github.com/VSCodium/vscodium.git`
- [ ] `git fetch upstream`
- [ ] Release Notes überfliegen: [VSCodium Releases](https://github.com/VSCodium/vscodium/releases) und [VS Code Release Notes](https://code.visualstudio.com/updates) — auf Breaking Changes bei Extension-APIs achten (Sektion "Extension authoring").

### Merge

- [ ] Arbeitsbranch: `git checkout -b merge/upstream-$(date +%Y-%m)`
- [ ] `git merge upstream/master`
- [ ] Konflikte lösen. Erwartbare Konfliktstellen:
  - `patches/` — upstream-eigene Patches wurden angepasst; unsere eigenen Patches (z. B. Copilot-Entfernung) auf neue Zeilennummern prüfen.
  - `prepare_vscode.sh` / Build-Skripte — unsere Overlay-Kopie (`src/stable/*`) muss erhalten bleiben.
  - `.github/workflows/` — eigener Workflow `extension-test.yml` darf nicht verloren gehen.
- [ ] `upstream/stable.json` zeigt auf das neue VS-Code-Tag (macht der Merge automatisch).

### Verifikation

- [ ] Extension-Tests: `cd src/stable/extensions/vscodium-agent && node test/run.js`
- [ ] `engines.vscode` in der Extension-`package.json` gegen die neue Basis prüfen (aktuell `^1.90.0` — muss ≤ neuer Basis bleiben, i. d. R. keine Änderung nötig).
- [ ] Kompletten Build laufen lassen (CI oder lokal) — prüft, ob alle Patches noch anwendbar sind.
- [ ] Smoke-Test im gebauten Editor:
  - [ ] Agent-View öffnet sich, `Agent: Verbindung testen` grün.
  - [ ] Eine kleine Agent-Aufgabe im Review-Modus: Diff-Vorschau, Accept, **Strg+Z macht die Änderung rückgängig**.
  - [ ] `Agent: Log anzeigen` zeigt Einträge.
  - [ ] Genutzte Extension-APIs deprecated? Output/DevTools-Konsole auf Warnungen prüfen.

### Abschluss

- [ ] Changelog-Eintrag: "Basiert jetzt auf VS Code x.y.z" + relevante Neuerungen.
- [ ] Merge-Branch per PR/direkt nach `master`, Tag setzen wenn Release.
- [ ] Notieren, was Konflikte verursacht hat → diese Liste aktualisieren.

## Wenn ein Merge zu lange liegen blieb

Bei >3 Monaten Rückstand: nicht alle Versionen auf einmal. Stattdessen von Release-Tag zu Release-Tag mergen (`git merge <tag>`), nach jedem Schritt Tests + Build. Das isoliert Konfliktursachen.
