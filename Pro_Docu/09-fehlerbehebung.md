# 09 – Fehlerbehebung & FAQ

## Verbindung / Firebase

**„Die Firebase AI Logic API ist für dieses Projekt nicht aktiviert" (403, SERVICE_DISABLED).**
In der Firebase Console https://console.firebase.google.com/project/controlling-man/ailogic/ auf „Get started" klicken, dann einige Minuten warten und erneut testen.

**401/403 – Authentifizierung fehlgeschlagen.**
Key prüfen: Firebase Console → Projekteinstellungen → Allgemein → Web-App → `apiKey` (beginnt mit `AIza`). Kommando „Agent: Firebase API-Key setzen" erneut ausführen. Falls der Key in der Google Cloud Console eingeschränkt wurde: `firebasevertexai.googleapis.com` muss in den erlaubten APIs stehen.

**404 – Modell nicht gefunden.**
Einstellung `vscodiumAgent.model` prüfen (z. B. `gemini-2.5-flash`). Beim Backend `vertexAI` zusätzlich Region prüfen; im Zweifel auf `googleAI` zurückstellen.

**429 / Kontingent erschöpft.**
Free-Tier-Limit der Gemini Developer API erreicht. Kurz warten (der Client wiederholt automatisch), auf `gemini-2.5-flash-lite` wechseln oder im Google-Konto Abrechnung/Kontingent erhöhen.

**Netzwerkfehler.**
Firmen-Proxy/Firewall? `firebasevertexai.googleapis.com` (Port 443) muss erreichbar sein.

## Agent-Verhalten

**Kein Agent-Symbol in der Seitenleiste.**
1. Workspace-Vertrauen erteilt? (Kommandopalette → „Workspaces: Workspace-Vertrauen verwalten") 2. Wirklich der eigene Build bzw. VSIX installiert? 3. Rechtsklick auf die Aktivitätsleiste → „Agent" anhaken (Ansicht kann ausgeblendet sein).

**Agent startet nicht: „Kein Workspace-Ordner geöffnet."**
Datei → Ordner öffnen. Der Agent braucht ein Projektverzeichnis als Arbeitsraum.

**Karten bleiben auf „wartet auf Freigabe" stehen.**
Das ist der Review-Modus: Entscheidung auf der Karte treffen. Läufe mit offenen Karten lassen sich jederzeit mit „Stopp" beenden (offene Anfragen gelten dann als abgelehnt).

**Agent macht Dinge außerhalb der Aufgabe / dreht Schleifen.**
Stopp drücken, Aufgabe enger formulieren („Ändere ausschließlich …"), ggf. neue Sitzung. `maxIterations` begrenzt Schleifen hart.

**„Maximale Schrittzahl erreicht."**
Aufgabe war zu groß für das Limit. In Teilaufgaben zerlegen oder `vscodiumAgent.maxIterations` erhöhen.

**Kommando läuft in den Timeout.**
`vscodiumAgent.commandTimeoutSec` erhöhen. Wichtig: Der Agent darf keine Dauerläufer starten (Watcher, Dev-Server) — solche Aufgaben anders formulieren („einmalig bauen statt watchen").

## Build / GitHub Actions

**Unter „Artifacts" steht nur „vscode" (groß, ~400 MB), kein `bin-x64`.**
Das war ein push-getriggerter Lauf ohne Assets. Workflow manuell starten: Actions → „CI - Build - Windows" → „Run workflow" → Haken „Generate assets".

**Push abgelehnt: „GH007: … private email address".**
GitHubs E-Mail-Schutz. Lösung: Commit mit der Noreply-Adresse verfassen (`git config user.email "CodeCloner-A@users.noreply.github.com"`, dann `git commit --amend --reset-author --no-edit`) und erneut pushen.

**„Prepare assets" bricht mit Exit-Code 10 ab / WiX-Fehler CNDL0006 (leere Produktversion).**
Bekannter Workflow-Fehler des Originals: Der `build`-Job las Versions-Variablen aus einem nicht existierenden Job. Im Fork behoben (Outputs aus `compile`, MSI deaktiviert). Bei Wiederauftreten: `.github/workflows/ci-build-windows.yml` gegen [05-Build & Release](05-build-und-release.md) prüfen.

**Lint-Job „zizmor" ist rot.**
Reiner Workflow-Linter; er baut nichts und blockiert nichts. Meldungen bei Gelegenheit beheben, für den Installer irrelevant.

**`build (arm64)` rot, `build (x64)` grün.**
Für Windows-x64-Nutzer unerheblich; das x64-Artefakt ist vollständig.

## Installation / Windows

**SmartScreen warnt beim Installer.**
Erwartbar: Der Installer ist nicht code-signiert. „Weitere Informationen" → „Trotzdem ausführen". (Signieren wäre ein möglicher späterer Ausbau, benötigt ein Zertifikat.)

**`codium` wird in PowerShell nicht erkannt.**
IDE nicht installiert oder ohne PATH-Option. Entweder GUI-Wege nutzen oder vollständigen Pfad aufrufen: `"$env:LOCALAPPDATA\Programs\VSCodium\bin\codium.cmd"` bzw. `C:\Program Files\VSCodium\bin\codium.cmd`.

## FAQ

**Kostet die Nutzung etwas?** Der Gemini-Free-Tier reicht für Erprobung; darüber hinaus gelten Googles Preise pro Token. GitHub Actions ist für öffentliche Repos kostenlos.

**Funktioniert der Agent offline?** Nein — das Modell läuft in der Cloud. Die IDE selbst funktioniert offline normal weiter.

**Kann ich den Agenten in normalem VS Code nutzen?** Ja, als VSIX (siehe [05](05-build-und-release.md)) — die Core-Integration ist für die eigene IDE, technisch ist es dieselbe Extension.

**Wie deinstalliere ich alles?** IDE über Windows-Apps deinstallieren; der API-Key verschwindet mit „Agent: Firebase API-Key löschen" bzw. mit dem Benutzerprofil der Anmeldeinformationsverwaltung.

<!-- ENDE PRO_DOCU -->
