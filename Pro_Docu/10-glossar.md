# 10 – Glossar

**Agent / agentische IDE** – KI-System, das nicht nur Text vorschlägt, sondern selbstständig Werkzeuge benutzt (Dateien lesen/ändern, Kommandos ausführen), um eine Aufgabe in mehreren Schritten zu erledigen. Agentische IDEs (Cursor, Windsurf, Antigravity, dieses Projekt) betten so einen Agenten in die Entwicklungsumgebung ein.

**Agent-Drift** – Schleichendes Abweichen eines Agenten vom ursprünglichen Ziel bei langen Aufgaben. Gegenmittel hier: Schrittlimit, Ziel-Erinnerungen, Review-Modus, Stopp-Knopf.

**Artifact (GitHub Actions)** – Datei-Paket, das ein Build-Lauf zum Download bereitstellt; hier `bin-x64` mit den Installern.

**Built-in-Extension** – Erweiterung, die fest mit der IDE ausgeliefert wird (wie Git-Support oder Terminal). Der Agent ist eine solche — deshalb „im Core".

**Commit / Push** – Git-Begriffe: Ein Commit ist ein gespeicherter Änderungsstand im Repository; Push überträgt Commits zum Server (GitHub).

**Diff** – Gegenüberstellung Alt/Neu einer Datei; Grundlage der Review-Entscheidung.

**Extension Host** – Der Prozess der IDE, in dem Erweiterungen laufen (Node.js-Umgebung).

**Firebase / Firebase AI Logic** – Googles App-Plattform; AI Logic ist ihr Dienst, der App-Zugriff auf Gemini-Modelle bereitstellt. Dieses Projekt nutzt das Firebase-Projekt `controlling-man`.

**Fork** – Eigene Kopie eines fremden Repositories (hier: `CodeCloner-A/vscodium` als Kopie von `VSCodium/vscodium`), die man unabhängig weiterentwickelt.

**Function Calling** – Fähigkeit eines Sprachmodells, strukturierte Werkzeugaufrufe zurückzugeben („rufe read_file mit path=… auf") statt nur Text — das technische Herz des Agenten.

**Gemini** – Googles Familie großer Sprachmodelle (hier: `gemini-2.5-flash` / `gemini-2.5-pro`).

**GitHub Actions / Workflow / Runner** – GitHubs Build-Automatisierung: Ein Workflow (YAML-Datei) beschreibt Jobs, die auf gemieteten Maschinen (Runnern) laufen — hier der Windows-Build der IDE.

**IDE** – Integrated Development Environment, Entwicklungsumgebung: Editor + Terminal + Versionskontrolle + Erweiterungen in einer Anwendung.

**Repository (Repo)** – Von Git verwaltetes Projektverzeichnis inklusive kompletter Änderungshistorie.

**Review-Modus** – Betriebsart des Agenten, in der jede Dateiänderung und jedes Kommando Deine ausdrückliche Freigabe braucht.

**SecretStorage** – Verschlüsselter Geheimnisspeicher der IDE (unter Windows in der Anmeldeinformationsverwaltung); Ablageort des Firebase-API-Keys.

**Systemprompt** – Unsichtbare Grundinstruktion an das Modell (Rolle, Regeln, Projektbaum), die jeder Aufgabe vorangestellt wird.

**Token** – Abrechnungs- und Verarbeitungseinheit von Sprachmodellen (~¾ Wort). Modellpreise und Limits werden in Tokens gemessen.

**VSIX** – Dateiformat zum Installieren einzelner VS-Code-Erweiterungen („Aus VSIX installieren…").

**VSCodium** – Community-Build von VS Code aus dem offiziellen Quellcode, ohne Microsoft-Branding/-Telemetrie; Basis dieses Forks.

**Webview** – In die IDE eingebettete Browser-Oberfläche; so ist das Chat-Panel des Agenten gebaut.

**Workspace / Workspace Trust** – Der geöffnete Projektordner / VS Codes Vertrauensmodell dafür. Ohne Vertrauen bleibt der Agent deaktiviert.

<!-- ENDE PRO_DOCU -->
