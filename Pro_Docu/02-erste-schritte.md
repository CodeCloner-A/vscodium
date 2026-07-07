# 02 – Erste Schritte (Tutorial)

Dieses Tutorial führt Dich von null zur ersten erledigten Agenten-Aufgabe. Dauer: ca. 15 Minuten (plus Build-Wartezeit, falls noch kein Installer vorliegt).

## Voraussetzungen

- Windows-PC mit Internetzugang
- GitHub-Account (für den Build), Google-Account (für Firebase)
- Der fertige Installer aus dem Build — falls noch nicht vorhanden, siehe [05-Build & Release](05-build-und-release.md)

## Schritt 1: IDE installieren

1. Auf GitHub den erfolgreichen Lauf von „CI - Build - Windows" öffnen (mit gesetztem „Generate assets").
2. Unten unter **Artifacts** das Paket **`bin-x64`** herunterladen und entpacken.
3. **`VSCodiumSetup-x64-<version>.exe`** starten und den Installationsassistenten durchklicken. (Die `…UserSetup…`-Variante installiert ohne Admin-Rechte nur für Deinen Benutzer; das ZIP ist die portable Variante ohne Installation.)
4. Die IDE starten. Sie meldet sich als VSCodium — Dein eigener Build.

## Schritt 2: Firebase AI Logic aktivieren (einmalig)

1. Öffne https://console.firebase.google.com/project/controlling-man/ailogic/
2. Klicke **„Get started"** und wähle die **Gemini Developer API** (kostenloser Einstieg, keine Kreditkarte nötig).
3. Falls das Projekt noch keine Web-App hat: Zahnrad → **Projekteinstellungen** → Tab **Allgemein** → „Meine Apps" → **App hinzufügen** → Symbol **`</>`** (Web) → beliebigen Namen vergeben → registrieren.
4. Im angezeigten `firebaseConfig`-Block den Wert von **`apiKey`** kopieren (beginnt mit `AIza…`, ohne Anführungszeichen).

## Schritt 3: IDE mit Firebase verbinden

1. In der IDE **Strg+Shift+P** drücken (Kommandopalette).
2. **„Agent: Firebase API-Key setzen"** wählen → Key einfügen → Enter. (Der Key wandert in den verschlüsselten Systemspeicher, nicht in eine Konfigurationsdatei.)
3. Strg+Shift+P → **„Agent: Verbindung zu Firebase AI Logic testen"**. Erwartet: grüne Erfolgsmeldung. Bei Fehlern: [09-Fehlerbehebung](09-fehlerbehebung.md).

## Schritt 4: Projekt öffnen und Agent finden

1. **Datei → Ordner öffnen** → einen Projektordner wählen (der Agent arbeitet immer im geöffneten Ordner).
2. Die Vertrauensfrage mit **„Ja, ich vertraue den Autoren"** beantworten — ohne Workspace-Vertrauen bleibt der Agent deaktiviert.
3. In der linken Symbolleiste das **Roboter-Symbol „Agent"** anklicken → das Chat-Panel öffnet sich.

## Schritt 5: Erste Aufgabe

Tippe unten in das Eingabefeld eine ungefährliche Erkundungsaufgabe, z. B.:

> Erkläre mir kurz, was dieses Projekt macht und wie es aufgebaut ist.

Der Agent liest daraufhin Projektbaum und Schlüsseldateien (jede Aktion erscheint als Protokollzeile) und antwortet mit einer Zusammenfassung. Es wird nichts verändert.

## Schritt 6: Erste Änderung mit Review

Stelle nun eine kleine Änderungsaufgabe, z. B.:

> Lege eine Datei NOTIZ.md an mit einer Zeile: Hallo von meinem Agenten.

Es erscheint eine **Änderungs-Karte** mit „Diff anzeigen / Übernehmen / Ablehnen" — der Diff öffnet sich automatisch im Editor. Klicke **Übernehmen**. Der Agent meldet den Abschluss. Damit hast Du den kompletten Arbeitszyklus gesehen: Aufgabe → Plan → Werkzeug → Freigabe → Ergebnis.

## Wie es weitergeht

- Alltagstipps und alle Bedienelemente: [03-Benutzerhandbuch](03-benutzerhandbuch.md)
- Alle Einstellungen und Kommandos: [07-Referenz](07-referenz.md)

<!-- ENDE PRO_DOCU -->
