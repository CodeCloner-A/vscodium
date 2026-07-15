# 03 – Benutzerhandbuch

## Das Agent-Panel

Das Panel öffnet sich über das Roboter-Symbol in der linken Symbolleiste. Es besteht aus dem Nachrichtenverlauf (oben), der Statuszeile mit Projekt/Modell und Modus sowie dem Eingabefeld. **Enter** sendet, **Shift+Enter** macht eine neue Zeile. Während einer laufenden Aufgabe wird „Senden" durch **„Stopp"** ersetzt.

In der Titelleiste des Panels: **＋** startet eine neue Sitzung (leert Verlauf und Gesprächsgedächtnis), das **Zahnrad** öffnet die Agent-Einstellungen.

## Nachrichtentypen im Verlauf

| Element | Bedeutung |
|---|---|
| Blaue Sprechblase | Deine Aufgabe |
| Graue Sprechblase | Antwort/Plan des Agenten |
| Zeile mit Punkt | Werkzeugaufruf (pulsierend = läuft, grün = ok, gelb = Hinweis/Fehler) |
| Karte „Änderung/Neue Datei/Löschen" | Dateiänderung, wartet ggf. auf Deine Entscheidung |
| Karte „Kommando" | Shell-Kommando, wartet ggf. auf Freigabe |
| ✔ Abgeschlossen | Abschlussbericht des Agenten |

## Review-Modus (Standard)

Bei jeder Dateiänderung öffnet sich automatisch ein **Diff** (links alt, rechts neu). Entscheide auf der Karte: **Übernehmen** wendet die Änderung an, **Ablehnen** verwirft sie — der Agent sieht die Ablehnung und passt sein Vorgehen an, statt es stumpf erneut zu versuchen. Kommandos zeigen Befehl, Zweck und Arbeitsverzeichnis und laufen erst nach **Ausführen**; **Überspringen** lehnt ab.

„Diff anzeigen" funktioniert auch nachträglich, solange die Sitzung läuft.

## Auto-Modus

In den Einstellungen (`vscodiumAgent.approvalMode` → `auto`) wendet der Agent Änderungen sofort an und führt Kommandos ohne Rückfrage aus. Empfohlen nur für Wegwerf-Projekte, Experimente oder unter Versionskontrolle mit sauberem Arbeitsstand — dann lässt sich alles per Git zurückdrehen.

## Gute Aufgaben stellen

Der Agent arbeitet am besten mit klaren, abgegrenzten Aufträgen samt Erfolgskriterium:

> Benenne die Funktion `calcPrice` in `berechnePreis` um — überall im Projekt — und lass danach `npm test` laufen.

> In src/api/client.js werden Fehler verschluckt. Finde die Stelle, wirf stattdessen eine aussagekräftige Exception und ergänze einen Test.

Weniger gut: „Mach den Code besser." Bei großen Vorhaben (z. B. „stelle das Projekt auf TypeScript um") in Etappen arbeiten — eine Etappe pro Aufgabe, dazwischen prüfen und committen.

## Umgang mit Agent-Drift

Anzeichen: Der Agent ändert Dinge, die mit der Aufgabe nichts zu tun haben, oder dreht Schleifen ohne Fortschritt. Gegenmittel: **Stopp** drücken, Aufgabe präziser neu stellen (gern mit „Ändere ausschließlich …"), oder eine neue Sitzung beginnen. Eingebaut sind zusätzlich ein Schrittlimit (`maxIterations`, Standard 24) und automatische Ziel-Erinnerungen an das Modell.

## Sitzungen und Gedächtnis

Innerhalb einer Sitzung erinnert sich der Agent an den bisherigen Verlauf (Folgeaufgaben wie „und jetzt dasselbe für die Login-Seite" funktionieren). **＋ Neue Sitzung** beginnt einen frischen Verlauf; über das Dropdown in der Panel-Titelzeile lassen sich frühere Sitzungen wieder öffnen oder löschen. Sitzungen bleiben pro Projekt gespeichert und überleben IDE-Neustarts.

Angemeldet synchronisieren sich die Sitzungen zusätzlich **geräteübergreifend** (pro Google-Konto und Projekt, seit v0.10.0): Dasselbe Repo auf einem anderen Rechner zeigt nach dem Öffnen des Chats die dort noch fehlenden Sitzungen. Ohne Netz funktioniert alles wie bisher — lokal geht nichts verloren. Abschaltbar über die Einstellung `vscodiumAgent.sessions.sync`.

## Modellwahl

Standard ist `gemini-2.5-flash` (schnell, günstig). Für anspruchsvolle Refactorings lohnt `gemini-2.5-pro` — oder eines der **Claude-Modelle von Anthropic** (`claude-opus-4-8`, `claude-sonnet-5`, `claude-opus-4-6`), die seit v0.11.0 im Modell-Picker stehen. Die Modellwahl gilt ab der nächsten Aufgabe. Beachte: Claude-Modelle sind deutlich teurer und verbrauchen die Monats-Quote entsprechend schneller (gewichtete Zählung; Opus grob mit Faktor 10–18 gegenüber Gemini Flash).

## Tastatur-Schnellreferenz

| Aktion | Weg |
|---|---|
| Kommandopalette | Strg+Shift+P |
| Agent-Panel | Roboter-Symbol, Aktivitätsleiste |
| Senden / Zeilenumbruch | Enter / Shift+Enter |
| Anmelden/Abmelden, Verbindungstest, Verbrauch | Kommandopalette → „Agent: …" |

<!-- ENDE PRO_DOCU -->
