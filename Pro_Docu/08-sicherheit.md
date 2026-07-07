# 08 – Sicherheit

## Schutzmechanismen im Überblick

**API-Key-Verwahrung.** Der Firebase-Web-API-Key wird ausschließlich über die VS-Code-SecretStorage gespeichert (unter Windows: Anmeldeinformationsverwaltung, verschlüsselt pro Benutzerkonto). Er landet nie in Einstellungsdateien, im Repository oder in Logs. Entfernen: Kommando „Agent: Firebase API-Key löschen".

**Workspace-Sandbox.** Alle Dateizugriffe des Agenten werden gegen den geöffneten Projektordner validiert. Absolute Pfade, Laufwerksbuchstaben und `..`-Ausbrüche werden abgewiesen. Der Agent kann außerhalb des Projekts nichts lesen oder schreiben.

**Workspace Trust.** In nicht vertrauenswürdigen Ordnern (VS-Code-Vertrauensdialog verneint) ist die Extension vollständig deaktiviert — ein fremdes, heruntergeladenes Projekt kann den Agenten also nicht „mitbringen und benutzen".

**Review-Gating.** Im Standardmodus wird keine Datei geschrieben/gelöscht und kein Kommando gestartet, bevor Du es auf der jeweiligen Karte freigibst. Die Diff-Vorschau arbeitet mit virtuellen Dokumenten — bis zur Freigabe ändert sich auf der Festplatte nichts. Gelöschte Dateien wandern in den Papierkorb, nicht ins Nirwana.

**Kommando-Ausführung.** Kommandos laufen ohne Interaktivität (`CI=1`), mit Timeout (Standard 180 s) und Prozessbaum-Abbruch bei Überschreitung. Sie laufen allerdings mit **Deinen Benutzerrechten** — genau deshalb existiert die Freigabepflicht im Review-Modus.

**Drift-Begrenzung.** Schrittlimit pro Aufgabe, periodische Ziel-Erinnerung im Modellkontext, Stopp-Knopf, transparentes Werkzeugprotokoll.

## Was verlässt Deinen Rechner?

An Firebase AI Logic (Google) gesendet werden: Deine Aufgabentexte, der (gekürzte) Projektdateibaum, vom Agenten gelesene Dateiinhalte, Suchtreffer, Diagnostics sowie Ausgaben freigegebener Kommandos — also genau das, was das Modell zum Arbeiten braucht. Nicht gesendet werden Dateien, die der Agent nie liest, sowie der API-Key im Klartext an Dritte (er dient nur als Auth-Header gegenüber Google).

Konsequenz: Für Projekte mit sensiblen Daten (Kundendaten, Geheimhaltung) vorher klären, ob Googles Datenverarbeitung (Gemini Developer API bzw. Vertex AI, je nach Backend) den eigenen Anforderungen genügt. Vertex AI bietet vertraglich andere Zusicherungen als die Developer API.

## Restrisiken und Gegenmaßnahmen

| Risiko | Einordnung | Gegenmaßnahme |
|---|---|---|
| Fehlerhafte Änderungen durch das Modell | mittel | Review-Modus, Versionskontrolle, Tests laufen lassen |
| Destruktives Kommando (z. B. Löschbefehle) | im Review-Modus gering | Kommandos vor Freigabe lesen; Auto-Modus nur in Wegwerf-Umgebungen |
| Prompt-Injection aus Projektdateien (Datei enthält Anweisungen ans Modell) | real, branchenweit ungelöst | Review-Modus lässt nichts Ungeprüftes wirksam werden; bei fremdem Code besonders aufmerksam freigeben |
| API-Key-Missbrauch bei Rechnerzugriff Dritter | wie bei jedem lokalen Secret | OS-Konto schützen; Key in der Google Cloud Console auf die API `firebasevertexai.googleapis.com` einschränken |
| Kosten-/Kontingentüberraschungen | gering (Flash, Free Tier) | Budget-Alarme im Google-Konto; `maxIterations` begrenzen |

## Härtungsempfehlungen

1. Den API-Key in der Google Cloud Console auf die Firebase-AI-Logic-API einschränken (Application restrictions/API restrictions).
2. Projekte unter Git halten — jede Agent-Sitzung ist dann trivial rückrollbar.
3. Auto-Modus nur mit sauberem `git status` starten.
4. Für vertrauliche Codebasen das Vertex-AI-Backend erwägen und Datenverarbeitungsbedingungen prüfen.

<!-- ENDE PRO_DOCU -->
