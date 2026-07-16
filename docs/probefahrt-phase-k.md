# Probefahrt: Der neue native Chat (v0.13.0)

Diese Anleitung ist für dich als Nicht-Programmierer geschrieben. Sie führt dich einmal komplett durch: **Spielstand sichern → Werkzeuge installieren → Programm bauen → neue Chat-Oberfläche durchtesten.** Du musst nichts verstehen, was hier nicht erklärt wird — einfach der Reihe nach abarbeiten. Wenn irgendwo etwas anderes passiert als beschrieben: nicht schlimm, notiere kurz was (am besten Screenshot) und gib es an Claude weiter.

**Zeitbedarf:** Vorbereitung ca. 30 Minuten, der Bau selbst 1–3 Stunden (läuft von allein), die Probefahrt ca. 30–45 Minuten.
**Voraussetzungen:** Internet, ca. 30 GB freier Speicherplatz, Laptop am Strom.

---

## Schritt 0 — Spielstand sichern (2 Minuten)

Bevor gebaut wird, halten wir den aktuellen Stand in Git fest (das ist wie ein Speicherpunkt im Spiel — man kann jederzeit dahin zurück).

1. Öffne den Ordner `C:\Users\ergin\Desktop\VSCode-Fork\vscodium` in deinem normalen VSCodium/VS Code (Datei → Ordner öffnen).
2. Klicke links in der Symbolleiste auf das Symbol mit den **drei verbundenen Punkten** (Quellcodeverwaltung). Dort siehst du eine Liste geänderter Dateien.
3. Tippe oben in das Nachrichtenfeld: `feat(agent): nativer Chat mit Modi, Tools und Review (v0.12.0/v0.13.0, Phase K)`
4. Klicke auf das **Häkchen (Commit)**. Falls gefragt wird, ob alle Änderungen einbezogen werden sollen: **Ja**.

Fertig. (Alternative für später: das Programm „GitHub Desktop" macht dasselbe mit noch weniger Klicks.)

---

## Schritt 1 — Werkzeuge installieren (einmalig, ca. 20 Minuten)

Der Bau braucht ein paar kostenlose Helfer. Öffne die **Eingabeaufforderung** (Startmenü → „cmd" tippen → Enter) und füge diese Zeilen **einzeln** ein (jeweils Enter, kurz warten):

```
winget install --id Git.Git -e
winget install --id jqlang.jq -e
winget install --id 7zip.7zip -e
winget install --id Python.Python.3.11 -e
winget install --id Rustlang.Rustup -e
```

Dann noch **Node.js** (das Herzstück): Gehe auf [nodejs.org](https://nodejs.org/), lade **Version 22** herunter und starte die Installation. **Wichtig:** Setze im Installer das Häkchen bei **„Automatically install the necessary tools"** — das installiert die Bau-Werkzeuge gleich mit.

Danach: **Rechner neu starten** (damit alle Werkzeuge gefunden werden).

### Kurzer Funktionstest

Öffne **Git Bash** (Startmenü → „Git Bash" tippen — wurde eben mitinstalliert, schwarzes Fenster mit buntem Text). Füge ein:

```bash
node --version && jq --version && python3 --version && cargo --version && git --version
```

Wenn fünf Versionsnummern erscheinen (Node sollte mit `v22` beginnen, Python mit `3.11`): alles gut. Wenn eine Zeile „command not found" sagt: Screenshot machen, an Claude geben.

---

## Schritt 2 — Bauen (1 Befehl, dann warten)

1. Öffne **Git Bash** (falls nicht noch offen).
2. Füge diese zwei Zeilen ein (Enter nach jeder):

```bash
cd /c/Users/ergin/Desktop/VSCode-Fork/vscodium
./dev/build.sh
```

3. Jetzt heißt es warten (1–3 Stunden). Das Skript lädt den VS-Code-Quellcode herunter, verpasst ihm unsere Änderungen (die „Patches") und backt daraus das fertige Programm. Es scrollt dabei SEHR viel Text durch — das ist normal. Laptop am Strom lassen, Deckel offen lassen.

**Woran du Erfolg erkennst:** Das Skript läuft bis zum Ende durch und im Ordner `vscodium` liegt danach ein neuer Ordner **`VSCode-win32-x64`**.

**Woran du ein Problem erkennst:** Das Skript bricht ab und die letzten Zeilen enthalten Wörter wie `error`, `failed` oder `patch`. Dann: die letzten ~30 Zeilen kopieren (markieren, Rechtsklick → Copy) und an Claude geben. Besonders wichtig wäre eine Meldung rund um `85-chat-enable-native-agent.patch` — das ist unser eigener Patch.

---

## Schritt 3 — Das gebaute Programm starten

1. Öffne im Windows-Explorer: `C:\Users\ergin\Desktop\VSCode-Fork\vscodium\VSCode-win32-x64`
2. **Bevor** du etwas startest: Lege in diesem Ordner einen neuen, leeren Ordner namens **`data`** an (Rechtsklick → Neu → Ordner). Dadurch läuft die Test-Version „portabel" — sie speichert alles bei sich und funkt deiner normalen Installation nicht dazwischen.
3. Doppelklick auf **`VSCodium.exe`** (falls die Datei minimal anders heißt: die eine große .exe im Ordner).
4. Lege dir eine **Spielwiese** an: einen neuen Ordner `C:\Users\ergin\Desktop\probefahrt-spielwiese` (leer ist okay). Öffne ihn in der Test-Version: Datei → Ordner öffnen.
5. Es kommt eine Frage, ob du dem Ordner **vertraust** → **„Ja, ich vertraue den Autoren"**. (Ohne Vertrauen darf der Agent keine Dateien anfassen — das ist Absicht.)

**Orientierung — es gibt jetzt ZWEI Chats:** Links in der Seitenleiste das Roboter-Symbol „Agent" — das ist der **alte** selbstgebaute Chat (bleibt vorerst als Fallback). **Getestet wird der NEUE:** Drücke **Strg+Alt+I** — rechts öffnet sich der native Chat mit einem Eingabefeld, das unten zwei kleine Auswahlfelder hat (Modus und Modell). Um den geht es in allen folgenden Tests.

---

## Schritt 4 — Die Probefahrt (Checkliste)

Arbeite die Punkte der Reihe nach ab. Hinter jedem Punkt steht, **was passieren soll**. Trifft es zu → Haken dran. Trifft es nicht zu → kurz notieren, was stattdessen passiert ist (+ Screenshot), weitermachen.

### A — Erster Eindruck (noch OHNE Anmeldung)

- [ ] **A1:** Der neue Chat (Strg+Alt+I) ist sichtbar und hat unten links ein Modus-Auswahlfeld mit **drei Einträgen: Ask, Edit, Agent**.
- [ ] **A2:** Das Modell-Auswahlfeld daneben ist **leer** oder zeigt nichts Brauchbares (logisch: du bist noch nicht angemeldet).
- [ ] **A3:** Schicke im Modus **Ask** eine Nachricht („Hallo"). Es soll ein **verständlicher Hinweis** kommen, dass du nicht verbunden/angemeldet bist — kein Absturz, keine kryptische Fehlermeldung.

### B — Anmelden

- [ ] **B1:** Drücke **Strg+Umschalt+P**, tippe „Agent", wähle **„Agent: Mit Google anmelden"**. Der Browser öffnet sich, Google-Konto wählen, zurück zur IDE. Unten in der Statusleiste sollte dein Anmeldestatus auftauchen.
- [ ] **B2:** Öffne im neuen Chat das **Modell-Auswahlfeld**: Jetzt sollen dort unsere Modelle stehen (mehrere **Gemini** und **Claude**). Wähle `gemini-2.5-flash`.

### C — Ask-Modus (nur reden, nichts anfassen)

- [ ] **C1:** Frage im Modus **Ask**: „Was für Dateien enthält dieser Ordner?" → Eine Antwort **baut sich flüssig Stück für Stück auf** (Streaming) und ist inhaltlich sinnvoll.
- [ ] **C2:** Stelle eine längere Frage („Erkläre mir ausführlich, was ein Dateisystem ist") und klicke während der Antwort auf **Stopp** → die Antwort **bricht sofort ab**, die IDE bleibt normal bedienbar.

### D — Agent-Modus mit Sicherheitsnetz (Review)

- [ ] **D1:** Wechsle in den Modus **Agent**. Schreibe: „Lege eine Datei hallo.txt an mit dem Inhalt: Hallo Probefahrt!" → Es erscheint eine **Werkzeug-Karte** mit einer **Nachfrage** (Weiter/Abbrechen o. ä.), bevor irgendetwas passiert.
- [ ] **D2:** Klicke **Abbrechen/Ablehnen** → Der Agent stürzt NICHT ab, sondern reagiert im Chat sinnvoll darauf (z. B. „wurde abgelehnt").
- [ ] **D3:** Gleiche Aufgabe nochmal, diesmal **erlauben** → Die Datei taucht als **ausstehende Änderung** auf (Review-Ansicht: Datei mit Annehmen/Verwerfen). **Verwirf** sie → die Datei ist danach **nicht** im Ordner. Nochmal, diesmal **annehmen** → jetzt liegt `hallo.txt` im Ordner.
- [ ] **D4:** „Ändere hallo.txt: häng eine zweite Zeile mit dem heutigen Datum an, und zeig mir danach den Dateiinhalt mit dem Kommando `type hallo.txt`." → Erst Edit-Freigabe, dann **Kommando-Freigabe** (der Befehl ist vorher sichtbar), und die angezeigte Ausgabe enthält **beide Zeilen** (wichtig: das Kommando muss den NEUEN Inhalt sehen).
- [ ] **D5:** „Lösche hallo.txt." → Nachfrage, und die **Löschung erscheint im Review** (annehmen → Datei weg).

### E — Agent-Modus ohne Sicherheitsnetz (Auto)

- [ ] **E1:** Öffne die Einstellungen (**Strg+,**), suche `approvalMode`, stelle auf **auto**. Sag dem Agenten: „Lege drei Dateien an: a.txt, b.txt, c.txt, jeweils mit einer Zeile Inhalt." → Es kommen **keine Nachfragen** mehr; die Werkzeug-Karten laufen einfach durch.
- [ ] **E2:** Stelle die Einstellung danach **zurück auf review**.

### F — Werkzeuge an-/abschalten

- [ ] **F1:** Im Chat-Eingabefeld gibt es ein **Werkzeug-Symbol** (Tool-Picker). Öffne es — unsere 9 Werkzeuge sollten dort gelistet sein (Datei lesen, schreiben, Kommando ausführen, …).
- [ ] **F2:** Schalte **„Kommando ausführen"** ab und bitte den Agenten: „Führe dir aus." → Er führt **kein** Kommando aus (er erklärt stattdessen, dass er es nicht kann, oder löst es anders). Danach Werkzeug wieder einschalten.

### G — Edit-Modus (der kleine Bruder)

- [ ] **G1:** Wechsle in den Modus **Edit**. „Ergänze in a.txt eine zweite Zeile: Edit-Modus war hier." → Funktioniert mit Review wie im Agent-Modus.
- [ ] **G2:** Bitte im Edit-Modus: „Führe den Befehl dir aus." → Er tut es **nicht** und verweist sinngemäß auf den Agent-Modus (im Edit-Modus gibt es absichtlich keine Kommandos und kein Löschen).

### H — Blick unter die Haube (2 Minuten, nur gucken)

- [ ] **H1:** Menü **Ansicht → Ausgabe**. Wähle rechts im Dropdown den Kanal **„VSCodium Agent"** → Dort sollten Zeilen stehen wie „Default-Participant registriert" (dreimal: ask/edit/agent) und „Native Tools: 9/9 Tools registriert".
- [ ] **H2:** Wechsle im selben Dropdown auf **„Extension Host"** und suche mit Strg+F nach `CANNOT` → **kein Treffer** (hieße: eine Freischaltung fehlt).

### I — Schönheitsfehler sammeln (kein Muss, nur Augen auf)

- [ ] **I1:** Steht irgendwo im Chat **„Copilot"**, ein Anmelde-/Kauf-Hinweis von Microsoft oder englisch-kryptischer Willkommenstext? → Screenshot.
- [ ] **I2 (Kür):** Öffne ein **zweites Fenster** (Datei → Neues Fenster) mit einem anderen Ordner und lass BEIDE gleichzeitig eine Agent-Aufgabe machen → beide arbeiten sauber getrennt.

> Ein Punkt der offiziellen Checkliste (Upstream-Merge-Probe, Punkt 7 in `docs/phase-k-verdrahtung.md`) ist reine Entwicklerarbeit — den übernimmt Claude in einer späteren Session.

---

## Schritt 5 — Ergebnis zurückmelden

Schreib Claude einfach formlos, z. B.:

> „A–C ok. D4: Ausgabe zeigte nur die erste Zeile. F2: er hat trotzdem ein Kommando ausgeführt. Screenshots anbei."

Daraus wird dann die Fixliste für die nächste Session. Wenn alles grün ist: Glückwunsch — dann ist der native Chat offiziell fahrtauglich, und als Nächstes docken wir die Chat-Verläufe (Sync) an die neue Oberfläche an.

## Falls gar nichts geht

- Test-Version startet nicht / Chat fehlt komplett → Screenshot + die Ausgabe-Kanäle aus H1/H2 kopieren.
- Der Bau bricht ab → letzte ~30 Zeilen aus Git Bash kopieren.
- Du willst zurück zum alten Stand → dank Schritt 0 jederzeit möglich (Claude macht das dann mit dir).
