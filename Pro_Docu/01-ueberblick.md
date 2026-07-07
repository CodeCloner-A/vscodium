# 01 – Überblick & Konzepte

## Was ist dieses Projekt?

Dieses Projekt ist eine **eigene Entwicklungsumgebung (IDE)** nach dem Vorbild agentischer IDEs wie Cursor, Windsurf oder Antigravity. Sie basiert auf VSCodium (dem quelloffenen VS Code ohne Microsoft-Branding und -Telemetrie) und enthält fest im Core einen **KI-Agenten**, der über Firebase AI Logic mit Googles Gemini-Modellen spricht.

Der entscheidende Unterschied zu klassischen Code-Assistenten: Der Agent liefert nicht nur Autovervollständigung, sondern arbeitet **ganze Entwicklungsaufgaben in mehreren Schritten** ab — er plant, liest Dateien im Projektkontext, ändert sie, führt Tests aus und bessert auf Basis der Ergebnisse nach.

## Fähigkeiten des Agenten

Der Agent kann Code generieren und ergänzen, bestehenden Code refactoren, Fehler suchen und beheben (auch anhand der Fehlermeldungen der IDE-Sprachdienste), mehrere Dateien konsistent anpassen sowie Kommandos und Tests ausführen und bei Fehlschlägen iterieren, bis das Ergebnis stimmt oder er begründet abbricht.

## Leitprinzip: Mensch behält die Kontrolle

Ein Agent ist nicht automatisch fehlerfrei. Das Projekt setzt deshalb auf Aufsicht durch Design:

- **Review-Modus (Standard):** Jede Dateiänderung erscheint als Diff-Vorschau mit „Übernehmen/Ablehnen"; jedes Kommando (z. B. `npm test`) braucht eine Freigabe.
- **Transparenz:** Jeder Werkzeugaufruf des Agenten ist live im Protokoll sichtbar.
- **Drift-Schutz:** Ein Schrittlimit, periodische Ziel-Erinnerungen an das Modell und ein Stopp-Knopf verhindern, dass sich der Agent bei langen Aufgaben vom eigentlichen Ziel entfernt („Agent-Drift").

## Die drei Bausteine des Projekts

**1. Der VSCodium-Fork (dieses Repository).** Das Build-System, das aus dem offiziellen VS-Code-Quellcode eine eigene, umbenannte IDE baut. Eigene Dateien werden über `src/stable/` in den Quellbaum injiziert, Änderungen über `patches/` eingespielt.

**2. Die Agent-Extension (`src/stable/extensions/vscodium-agent/`).** Der eigentliche Agent als Built-in-Extension — beim Build wird sie fest in die IDE eingebacken, genau wie die mitgelieferten Git- oder Terminal-Funktionen. Sie ist bewusst ohne Abhängigkeiten in reinem JavaScript geschrieben, damit der Build robust bleibt.

**3. Firebase AI Logic (Projekt `controlling-man`).** Die Brücke zu Googles Gemini-Modellen. Die IDE spricht die Firebase-REST-Schnittstelle direkt an; authentifiziert wird mit dem Web-API-Key des Firebase-Projekts, der verschlüsselt im Betriebssystem-Schlüsselbund liegt.

## Wie eine Aufgabe abläuft (vereinfacht)

1. Du beschreibst im Chat eine Aufgabe („Behebe den Fehler in der Preisberechnung und lass die Tests laufen").
2. Der Agent erhält den Projektbaum als Kontext, plant kurz und ruft dann Werkzeuge auf: Dateien suchen, lesen, ändern, Tests starten.
3. Jede Änderung/jedes Kommando läuft (im Review-Modus) über Deine Freigabe.
4. Schlagen Tests fehl, analysiert der Agent die Ausgabe und bessert nach.
5. Am Ende fasst er zusammen: Was wurde geändert, welche Dateien, Testergebnis.

## Grenzen

Der Agent arbeitet nur innerhalb des geöffneten Projektordners, führt Kommandos mit Deinen Benutzerrechten aus und ist auf die Qualität des Modells angewiesen. Menschliche Prüfung bleibt wichtig — insbesondere bei großen, langlaufenden Aufgaben empfiehlt sich das Zerlegen in Teilaufgaben. Details: [08-Sicherheit](08-sicherheit.md).

<!-- ENDE PRO_DOCU -->
