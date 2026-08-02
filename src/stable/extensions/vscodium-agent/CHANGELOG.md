# Changelog

Alle nennenswerten Änderungen am VSCodium Agent. Format nach [Keep a Changelog](https://keepachangelog.com/de/), Versionierung nach [SemVer](https://semver.org/lang/de/) (Fixes = Patch, Features = Minor).

## [Unreleased]

## [0.22.0] – 2026-07-28

### Hinzugefügt
- **Modellkarte mit echten Fähigkeiten:** Der Modell-Picker zeigt pro Modell jetzt die Wahrheit statt Platzhalter — echter Maximal-Kontext (z. B. „1 Mio." bei Gemini 3.x/GLM/Kimi, ehrliche 128k bei DeepSeek), Ausgabe-Limit, Bild-Verständnis und eine Preisklasse (€/€€/€€€, abgeleitet aus der Kontingent-Gewichtung). Die Kurzinfo rechts fasst es kompakt zusammen („eu · 1 Mio. Kontext · Bilder · €€"), der Tooltip erklärt die Details. Quelle ist der Dienst-Katalog (Proxy v0.10.0); die eingebaute Rückfall-Liste trägt dieselben Werte.
- **DeepSeek im Angebot** („DeepSeek · Code-Preisbrecher", 128k Kontext, Preisklasse €): dritter OpenAI-kompatibler Anbieter über die bestehende Übersetzungsschicht — Produktentscheid fürs Frische-Signal. Erscheint wie üblich erst, wenn der Schlüssel im Tresor liegt (`DEEPSEEK_API_KEY`); ohne Schlüssel bleibt der Eintrag unsichtbar.

## [0.21.4] – 2026-07-28

### Geändert
- **Modell-Katalog wird beim Start vorgewärmt:** Die Chat-Oberfläche zeigt nach dem Start zunächst ihre gemerkte Modell-Liste und fragt erst bei Bedarf frisch nach — nach einem Katalogwechsel wirkte der Picker dadurch kurzzeitig veraltet (2er sichtbar, Kimi fehlte, bis zur ersten Nachricht). Jetzt holt die Extension die Liste kurz nach dem Start im Hintergrund, sodass die erste Abfrage sofort den aktuellen Server-Stand liefert.

## [0.21.3] – 2026-07-28

### Behoben
- **Kimi K3 und GLM 5.2 stehen jetzt auch in der Rückfall-Liste des Pickers** — bisher fehlte Kimi dort, sodass es ohne erreichbaren Dienst-Katalog „verschwand".
- **`/health` des Dienstes zeigt Version und Modell-Angebot (Proxy v0.9.1):** Ein Browser-Aufruf der Dienst-Adresse mit `/health` beantwortet ab sofort die Frage „welcher Stand läuft wirklich?" — statt Deploy-Fehler an Symptomen zu raten.

## [0.21.2] – 2026-07-28

### Behoben
- **Modelle sind jetzt immer sichtbar.** Bisher füllte sich der Modell-Picker erst nach der ersten Antwort und blieb ohne Anmeldung leer; jetzt zeigt er sofort das Angebot — angemeldet den Katalog des Dienstes, sonst die im Build hinterlegte Liste.
- **„Anmelden erforderlich" ist aus dem Modell-Picker verschwunden.** Der Hinweis gehört dorthin, wo die Unterhaltung stattfindet: Wer ohne Anmeldung schreibt, bekommt den Dialog („Mit Google anmelden" / „Überspringen") und im Chat den Hinweis mit Anmelde-Knopf — nicht ein Pseudo-Modell zum Auswählen.

## [0.21.1] – 2026-07-28

### Behoben
- **Anmeldung und Modelle waren tot: „Keine Proxy-URL konfiguriert".** Ursache war das Verbergen der Experten-Einstellungen in v0.18.0: `included: false` nimmt eine Einstellung komplett aus der Registry — damit greift auch ihr Standardwert aus der `package.json` nicht mehr. Die Adresse des PHI47-Dienstes fiel dadurch auf einen leeren Wert zurück, und ohne Adresse gibt es weder Modell-Katalog noch Anmeldung. Die Adresse steht jetzt als Produkt-Konstante im Code (`lib/saasConfig.js`); die Einstellung überschreibt sie weiterhin, wenn jemand sie in der `settings.json` setzt. Alle Kommandos (Anmelden, Verbindungstest, Verbrauch) holen sie über den Kern-Dienst statt selbst aus der Konfiguration.
- Neuer Testwächter: Verborgene Einstellungen müssen einen echten Rückfallwert im Code haben, und der Produkt-Standard muss mit der `package.json` übereinstimmen.

## [0.21.0] – 2026-07-28

### Behoben
- **Cache-Präfix repariert (spart bares Geld):** Der System-Prompt begann bisher mit Datum und letzter Editor-Aktivität — beides ändert sich bei *jedem* Lauf. Da Anbieter den unveränderten **Anfang** einer Anfrage cachen (Gemini 2.5+/3.x und Kimi automatisch, Cache-Tokens kosten ~10 %), war der Präfix damit jedes Mal wertlos: praktisch keine Treffer. Jetzt ist der Prompt strikt nach Beständigkeit sortiert — Identität und Regeln → Gedächtnis → Projektbaum → Aktivität → Datum. Gilt für Agent- und Plan-Modi und wirkt bei allen Anbietern gleichermaßen.

### Hinzugefügt
- **Kimi K3 im Angebot** (Moonshot, 1 Mio. Kontext) — der Schlüssel liegt im Tresor, der Rest lief über die vorhandene Übersetzungsschicht.
- **Fähigkeits-Profile je Modell (Proxy v0.9.0):** Der Übersetzer schickt nur noch, was das Zielmodell wirklich versteht (Temperatur, top_p, tool_choice, Stream-Tokenzählung, Bilder, dynamische Tools). Das verhindert 400er-Fehler bei Anbietern, die unbekannte Felder nicht ignorieren.
- **Bilder im Chat (Vision):** Screenshots und Mockups lassen sich anhängen und werden bis zum Modell durchgereicht (PNG, JPEG, WebP, GIF bis 4 MB; Proposal `chatReferenceBinaryData`). Modelle ohne Bild-Fähigkeit bekommen den Text ohne Bild statt einer Fehlermeldung; übersprungene Anhänge werden im Chat benannt.
- **Dynamische Werkzeug-Ladung vorbereitet:** Ab 20 Werkzeugen wandern die Definitionen als nachgestellte `system`-Nachricht in die Anfrage statt in den Kopf (Kimi-K3-Funktion; hält den Cache-Präfix stabil). Mit unseren 10 Werkzeugen bleibt vorerst alles beim Alten — die Mechanik steht für MCP-Server bereit.

## [0.20.0] – 2026-07-28

### Hinzugefügt
- **Token-Anzeige im Chat:** Unter jeder Antwort steht jetzt, was sie gekostet hat — „Tokens · Lauf 12,4k (Anfrage 9,8k · Antwort 2,6k)" — und ab der zweiten Antwort zusätzlich die **Summe der ganzen Sitzung**. Gecachte Eingaben werden ausgewiesen („davon 8,0k aus dem Cache"), weil sie nur einen Bruchteil kosten. Gezählt wird über alle Modell-Schritte eines Laufs, aus den echten Zahlen des Anbieters (`usageMetadata`) — nichts geschätzt.

### Geändert
- **Nur noch die 3er-Generation im Angebot:** Die Gemini-2.5er sind aus Katalog und Standardwerten verschwunden; neu dabei ist **Gemini 3.1 Pro (Vorschau)** für komplexe Aufgaben (Standort `global`). Standardmodell ist jetzt `gemini-3.5-flash` (EU-Route), fürs Inline-Edit `gemini-3.5-flash-lite`.
- **Kontext-Caching kommt dem Nutzer zugute (Proxy v0.8.0):** Google cached bei Gemini 2.5+/3.x automatisch (nichts einzuschalten, Mindestgröße 4096 Tokens bei den 3ern) — gecachte Eingabe-Tokens kosten nur 10 %. Der Proxy zählt sie jetzt getrennt (`cachedContentTokenCount`) und gewichtet sie in der Monats-Quote entsprechend günstiger, statt sie voll zu berechnen.

## [0.19.0] – 2026-07-28

### Hinzugefügt
- **Projekt-Gedächtnis:** PHI47 merkt sich jetzt dauerhaft, was zu Deinem Projekt gehört — welche Technik es nutzt, welche Entscheidungen gefallen sind, was Du ausdrücklich (nicht) willst. Das Wissen steht in `.phi47/projekt.md` **im Projekt selbst**: einsehbar, bearbeitbar, versionierbar, löschbar — nichts davon liegt in einer Cloud-Datenbank.
  - **Lesen:** Zu Beginn jedes Laufs (Agent- und Plan-Modi) landet die Datei im System-Prompt; widerspricht sie dem Code, gilt der Code und der Agent sagt Bescheid. Vorhandene `AGENTS.md` oder `CLAUDE.md` anderer Werkzeuge werden ebenfalls gelesen (nur lesend).
  - **Schreiben:** Das neue Werkzeug **`remember`** hält einen Fakt fest — mit derselben Freigabe-Karte wie jede Dateiänderung („Ins Projekt-Gedächtnis aufnehmen"). Doppelte Einträge erkennt es und lässt sie weg; Geheimnisse und Tagesgeschäft sind per Prompt-Regel ausgeschlossen.
  - Auch die Plan-Modi dürfen sich erinnern (aber weiterhin nichts am Projekt ändern) — Erkenntnisse aus einem Interview überleben so das Gespräch.
  - Neues Kommando **„Agent: Projekt-Gedächtnis öffnen"** legt die Datei bei Bedarf an und öffnet sie zum Nachlesen.

## [0.18.0] – 2026-07-28

### Hinzugefügt
- **Eigene Willkommensseite:** Statt der leer wirkenden Standardseite führt jetzt ein PHI47-Walkthrough in vier Schritten durch den Start — Anmelden, Projekt öffnen, „Sag, was entstehen soll", „Du behältst die Kontrolle". Jeder Schritt hat einen echten Knopf (Anmelden, Ordner anlegen/öffnen, Chat öffnen, Einstellungen) und eine kurze Erklärung im Markenton.
- **Erststart führt zur Anmeldung:** Beim ersten Start nach der Installation öffnet sich die Willkommensseite; ist niemand angemeldet, lädt eine einmalige Meldung mit „Jetzt anmelden" dazu ein (Merker im globalen Zustand — die Einladung kommt nicht bei jedem Start).
- **Anmelde-Dialog direkt aus dem Chat:** Wer ohne Anmeldung einfach drauflosschreibt, bekommt jetzt ein echtes Dialogfenster mit **„Mit Google anmelden"** und **„Überspringen"** — statt nur eines Hinweistexts. Nach erfolgreicher Anmeldung läuft die eben getippte Frage automatisch weiter; wer überspringt, sieht künftig nur noch den kurzen Hinweis mit Anmelde-Knopf im Chat (kein Dialog bei jeder Nachricht).

- **App-Icon:** Das VSCodium-Icon in Fenster, Taskleiste und Installer ist durch die PHI47-Marke ersetzt (φ in Gold auf dunklem Grund, dezente Goldkante). Erzeugt für alle Plattformen: `win32/code.ico` (9 Größen von 16 bis 256 px) samt Windows-Kacheln, `linux/code.png` + `code.svg`, `server/code-192|512.png`, `server/favicon.ico`, `darwin/code.icns`. Vektor-Quelle für spätere Änderungen: `icons/stable/phi47.svg`.

### Geändert
- **Einstellungen aufgeräumt (KEEP IT SIMPLE):** In der Oberfläche stehen nur noch **vier** Einstellungen, in sinnvoller Reihenfolge: Modell, Freigabe-Modus, Aktivitäts-Signal, Chat beim Start öffnen. Die sechs Experten-Schalter (Dienst-URL, Inline-Edit-Modell, maximale Schritte, Kommando-Timeout, Terminal-Modus, Projektbaum-Größe) sind ausgeblendet (`included: false`), lassen sich aber weiterhin in der `settings.json` setzen — ihre Beschreibungen sagen das ausdrücklich.
- Formulierungen der sichtbaren Einstellungen auf Einsteiger umgeschrieben („Nachfragen" statt „Review-Modus", „Durcharbeiten" statt „Auto-Modus").

## [0.17.0] – 2026-07-28

### Entfernt
- **Das eigene Chat-Webview ist weg — es gibt nur noch eine Chat-Oberfläche.** Zwei parallele Chat-UIs (natives Core-Chat und eigenes Webview) waren technische Schuld, die bei jedem Upstream-Merge Pflege gekostet hätte. Gelöscht: `ui/chatViewProvider.js`, `media/chat.js`, `media/chat.css`, die Aktivitätsleisten-Ansicht („Agent"-Symbol samt View), das Kommando „Neue Sitzung", die Einstellungen `sessions.sync`/`sessions.max` sowie das eigene Diff-Schema `vscodium-agent-diff` (Freigaben und Diffs liefert das native Chat-Editing). Der Chat wohnt jetzt ausschließlich im Core-Chat (Strg+Alt+I).

### Geändert
- **Motor-Schicht herausgelöst:** Einstellungen, Proxy-Client, Anmeldung, Modell-Katalog und Workspace-Host leben jetzt in `ui/agentService.js` — genutzt von nativem Chat, Inline-Edit, Quick-Fixes und den Kommandos.
- **„Mit KI erklären" und „Terminal-Ausgabe debuggen"** öffnen den nativen Chat mit vorbelegter Frage (`workbench.action.chat.open`) statt des früheren Webviews; ebenso das automatische Öffnen beim IDE-Start.
- `lib/sessionSync.js` bleibt samt Tests erhalten, ist aber vorerst **nicht verdrahtet** — Grundlage für den offenen Roadmap-Punkt „Chat-Sync andocken" (die Proxy-Endpunkte `/v1/sessions…` laufen unverändert weiter).

### Hinzugefügt
- Regressionswächter in den Tests: Kehren Webview-Dateien, `views`-Contributions, das Diff-Schema oder die toten Sitzungs-Einstellungen zurück, schlägt die Suite fehl.

## [0.16.0] – 2026-07-28

### Hinzugefügt
- **PHI47-Branding nach dem Design-Entwurf:** Das Produkt heißt jetzt **PHI47** — Fenstertitel, Anwendungsname (`phi47`), Windows-Bezeichner und Datenordner kommen aus der `product.json` des Forks (sie wird beim Build zuletzt gemerged und überschreibt die VSCodium-Namen — kein Patch nötig).
- **Farbthema „PHI47 Dark" (Standard):** 289 Oberflächenfarben plus Syntax- und Semantik-Token aus dem Entwurf — Gold `#E0B84A` als Akzent (aktiver Tab, Aktivitätsleiste, Knöpfe, Fortschritt), Flächen `#0F1115` / `#14161B`, Rahmen `#23262E`, Terminal-Palette mit Grün `#8FBF6F`, Blau `#7FB2E5`, Rot `#E5646E`. Wird per `configurationDefaults` als Standard gesetzt und ist im Theme-Picker wählbar.
- **φ-Marke:** Das Agent-Icon ist jetzt das PHI47-Zeichen (φ im Kreis, goldener Schnitt als Leitmotiv) statt des generischen Roboter-Symbols.
- **Typografie:** IBM Plex Mono als Standard für Editor und Terminal (mit Rückfallkette auf Consolas/monospace, falls die Schrift nicht installiert ist).
- **Leerer Chat spricht PHI47:** Willkommenstext in der Tonalität des Entwurfs („Wohin soll's gehen? … ich plane die Route, schreibe den Code und führe ihn aus") mit drei Startpunkten; dazu ein Beispiel-Prompt am Agent-Participant.

### Geändert
- Aktivitäts-Signale nutzen die Markenpalette: Gold für laufende Kommandos, Blau für den arbeitenden Agenten.

## [0.15.0] – 2026-07-20

### Hinzugefügt
- **Sichtbare Aktivität (KEEP IT SIMPLE, Stufe 1):** Solange im Terminal ein Kommando läuft (`flutter run`, `npm run dev`, `gcloud` … – erkannt über die stabilen Shell-Integration-Events, in jedem Terminal) oder ein Agent-/Plan-Lauf aktiv ist, zeigt die Statusleiste einen animierten Hinweis („Agent arbeitet …" / „Kommando läuft …") und die Rahmen färben sich dezent: Terminal-/Panel-Rahmen bei Kommandos, Editor-/Tab-Rahmen, wenn der Agent im Projekt liest oder schreibt. „Da passiert was" – auf einen Blick. Eigene Farbanpassungen des Nutzers werden nie überschrieben und beim Ende sauber zurückgesetzt (`lib/activitySignal.js`, headless getestet). Neue Einstellung `vscodiumAgent.activitySignal` (Standard: an). Stufe 2 (echtes Pulsieren per CSS-Patch) folgt mit der Produkt-Identitäts-Runde.
- **Frischer Modell-Katalog (Proxy v0.6.0):** `gemini-3.6-flash` („neueste Generation") und `gemini-3.5-flash-lite` („flink & günstig") sind im Angebot; die Claude-Einträge sind vorerst ausgeblendet — die Anthropic-Freischaltung im Model Garden verlangt Firmendaten, und tote Picker-Einträge widersprechen KEEP IT SIMPLE (Übersetzungsschicht bleibt eingebaut und getestet; nach Firmengründung wird nur das `hidden`-Flag entfernt). Kontingent-Gewichte für die neuen Modelle konservativ, bis Listenpreise vorliegen.
- **„Dateien vom Computer …" im Anhang-Menü:** Der Plus-/Büroklammer-Weg des Chats bekommt einen Eintrag, der das normale „Öffnen"-Fenster öffnet (Mehrfachauswahl) und die gewählten Dateien an den Chat hängt – statt Einsteiger in den Quick-Access zu schicken (Vorbild Antigravity/Cursor; `contributes.chatContext` + Proposal `chatContextProvider` + Core-Kommando `workbench.action.chat.attachFile`; product.json-Allowlist erweitert). Zusätzlich als Kommando „Agent: Dateien vom Computer zum Chat hinzufügen" verfügbar.

## [0.14.0] – 2026-07-20

### Hinzugefügt
- **Plan-Modi (Roadmap Phase K, Entscheid 17.07.2026):** Das Auswahlfeld des nativen Chats bietet neben „Agent" jetzt **„Plan"** und **„Erweiterter Plan"** – ausgeliefert als Custom Agents über den stabilen `contributes.chatAgents`-Extension-Point (`agents/*.agent.md`). „Plan" erkundet das Projekt selbst, stellt nur die nötigsten Klärungsfragen (gebündelt, je mit Empfehlung) und liefert einen bestätigungsfähigen Plan. „Erweiterter Plan" interviewt unerbittlich nach GrillMe-Vorbild: exakt EINE Frage pro Runde mit empfohlener Antwort, Entscheidungsbaum Zweig für Zweig, Fakten werden über Lese-Tools selbst nachgeschlagen, gebaut wird erst nach ausdrücklich bestätigtem gemeinsamem Verständnis. Beide Modi sind hart auf Lese-Tools beschränkt – erzwungen serverseitig über einen Marker in den Mode-Instructions (`lib/nativeChat.js`), unabhängig von der Tool-Mechanik der UI. Eigene `.agent.md` des Nutzers ohne Marker laufen generisch: Agent-Modus + angehängte Zusatz-Instructions. **Plan → Agent per Klick:** Beide Plan-Modi deklarieren einen nativen Handoff („Plan umsetzen", `send: true`) – nach der Plan-Bestätigung genügt ein Klick auf den Knopf unter dem Chat: Er wechselt in den Agent-Modus und startet die Umsetzung automatisch (Probefahrt-Wunsch 20.07.).
- **Anmelde-Hinweis statt „Language model unavailable":** Ohne Anmeldung liefert der Modell-Provider einen Platzhalter-Eintrag („Anmelden erforderlich"), sodass Anfragen unseren Participant erreichen und mit verständlichem Hinweis plus **„Mit Google anmelden"-Knopf** beantwortet werden (Probefahrt-Befund 2).
- **Netz-Resilienz im Agent-Loop:** Ein einzelner Modell-Aufruf-Fehler ohne HTTP-Status (z. B. `fetch failed` mitten im Lauf) wird nach kurzer Pause genau einmal wiederholt statt den Lauf zu beenden; Server-Antworten wie Quota-429 werden weiterhin nicht wiederholt (Probefahrt-Befund: Lauf-Abbruch bei der Abschlussantwort).
- **Tools im Tool-Picker steuerbar:** Alle 9 Werkzeuge tragen jetzt `canBeReferencedInPrompt` + `toolReferenceName` – sie erscheinen in der Werkzeug-Auswahl der UI (und sind per `#name` referenzierbar); ohne das Flag nahm die Enablement-Mechanik der UI sie gar nicht erst auf.

### Behoben
- **Doppelte Antwort im nativen Chat:** Rein konversationelle Antworten (ohne Werkzeug-Einsatz) erschienen zweimal – der Lauf streamte den Text und gab ihn am Ende nochmals als Zusammenfassung aus (`viaText`-Kennzeichen in `AgentRun`; Probefahrt-Befund 20.07., „Hallo! …" ×2).
- **Chat ohne Projektordner funktioniert jetzt** (Probefahrt-Befund 20.07.): Statt des harten Fehlers „Kein Workspace-Ordner geöffnet" läuft die Unterhaltung normal weiter – Fragen, Erklärungen, Code-Beispiele –, nur eben ohne Datei-/Kommando-Werkzeuge (der Modell-Request lässt das tools-Feld dann komplett weg). Erst wenn der Nutzer an Dateien arbeiten will, erklärt der Agent einsteigerfreundlich den Weg – ohne Fachbegriffe wie „Workspace" vorauszusetzen – und unter der Antwort erscheinen zwei Knöpfe: **„Neuen Projektordner anlegen"** (fragt nur nach einem Namen, legt den Ordner unter `Dokumente\VSCodium-Projekte\` an und öffnet ihn – neues Kommando `vscodiumAgent.createWorkspace`, läuft ausschließlich auf Klick) und **„Vorhandenen Ordner öffnen…"**.

### Geändert
- **Ruhige obere Leiste:** Das Command Center (Quick-Access-Suchfeld in der Titelleiste) ist standardmäßig aus (`window.commandCenter: false` via configurationDefaults) — Leitsatz KEEP IT SIMPLE, Vorbild Antigravity/Cursor; Strg+P/Strg+Umschalt+P funktionieren unverändert.
- **Sessions-Liste legt sich über den Chat statt nach außen:** Produkt-Default `chat.viewSessions.orientation: "stacked"` (per `configurationDefaults`, kein Core-Patch) — die „Agent Sessions"-Übersicht erscheint gestapelt im Chat-Bereich; wer es anders mag, stellt das Setting um.
- **Ask- und Edit-Participants entfernt:** Upstream hat die Builtin-Modi Ask/Edit abgekündigt (Picker zeigt sie nicht mehr an); der Agent-Participant (`vscodium-agent.agent`) trägt allein die Chat-View. Ask-Verhalten deckt der Agent-Modus ab, den Edit-Platz nehmen die Plan-Modi ein (Nutzer-Entscheid: kein Edit-Comeback).
- **Sprachregel verschärft:** Alle sichtbaren Texte – auch Ein-Satz-Ankündigungen vor Tool-Aufrufen – müssen deutsch sein (Probefahrt-Befund: englische Zwischentexte bei Gemini).

## [0.13.0] – 2026-07-15

### Hinzugefügt
- **Nativer Agent- und Edit-Modus (Roadmap Phase K, zweiter Schritt):** Die native Chat-UI bietet jetzt alle drei Modi an – pro Modus ein eigener Default-Participant (`vscodium-agent.default`/`.edit`/`.agent`), dem Muster der Core-Setup-Agents folgend, weil der Request den Modus nicht transportiert (Beleg in `docs/phase-k-verdrahtung.md`). Im Agent-Modus bedient der bestehende Agent-Loop die Anfrage mit allen Tools, im Edit-Modus mit der Edit-Teilmenge (lesen, suchen, editieren, Diagnosen – keine Kommandos, kein Löschen).
- **Die Agent-Tools als native LanguageModelTools:** 9 der 10 Tools sind als `languageModelTools` beigesteuert und über `vscode.lm.registerTool` registriert (`ui/nativeTools.js`); `task_complete` bleibt Loop-intern. Der Core rendert die Tool-Cards und holt im Review-Modus die Freigabe über `confirmationMessages` ein (Auto-Modus fragt nicht); eine Ablehnung wird dem Modell wie bisher als „abgelehnt“ gemeldet, nicht als Fehler. Im Agent-Modus wirkt zusätzlich der native Tool-Picker: abgewählte Tools erreichen das Modell gar nicht erst.
- **Datei-Änderungen laufen ins native Multi-File-Review:** Schreib-/Ersetz-Edits streamt der Lauf als `textEdit`-Parts, Löschungen als `workspaceEdit`-Part in das Chat-Editing des Cores (Annehmen/Verwerfen pro Datei im Editor) statt direkt auf die Platte (`NativeRunHost`; gelesen wird bevorzugt aus offenen Dokumenten, damit der Agent seine eigenen ungespeicherten Edits sieht). Braucht das Proposal `chatParticipantAdditions` (package.json + product.json-Allowlist ergänzt).

### Geändert
- Der Ask-Participant heißt im @-Mention-Namensraum jetzt `ask` (statt `agent`); `agent` trägt der neue Agent-Modus-Participant. IDs und gespeicherte Sitzungen sind nicht betroffen.
- `AgentRun` akzeptiert je Lauf eine Tool-Teilmenge (`toolDeclarations`) und eine austauschbare Tool-Ausführung (`invokeTool`) – Grundlage für die native Tool-Route; Webview-Verhalten unverändert.

### Behoben
- **„Language model unavailable" im nativen Agent-Modus:** Der native Modell-Picker filtert im Agent-Modus (und Inline-Chat) auf die Fähigkeit `toolCalling` – unser `LanguageModelChatProvider` meldete sie fälschlich als `false`, wodurch die Modell-Liste leer blieb und Anfragen vor dem Participant scheiterten. Jetzt `toolCalling: true` (sachlich korrekt: der Proxy beherrscht Function Calling; gefunden beim ersten Praxistest gegen einen echten Core). Bewusste Grenze: `options.tools` fremder Konsumenten wird im Provider-Pfad noch nicht durchgeleitet – unser eigener Agent-Loop nutzt diesen Pfad nicht.

### Bekannte Grenzen
- Tool-Verkehr vergangener Runden wird im nativen Chat nicht in Folge-Requests rekonstruiert (nur Text-Historie); die Chat-Sync-Andockung folgt in einem späteren Phase-K-Schritt.
- Das Kommando-Editieren vor der Ausführung (Webview-Feature) hat im nativen Freigabe-Dialog noch kein Gegenstück – Punkt der Review-Paritätsliste.

## [0.12.0] – 2026-07-15

### Hinzugefügt
- **Nativer Core-Chat, erster Schritt (Roadmap Phase K):** Die Extension registriert einen Default-ChatParticipant für die native Chat-UI von VS Code 1.121 (Ask-Modus mit Projektbaum- und Aktivitätskontext, SSE-Streaming über den Agent-Proxy) sowie einen `LanguageModelChatProvider`, der das Proxy-Angebot (Gemini & Claude) in den nativen Modell-Picker speist (`ui/nativeChatController.js`, Kernlogik headless testbar in `lib/nativeChat.js`). Funktioniert nur auf dem gepatchten Fork: `isDefault` braucht das Proposal `defaultChatParticipant` (product.json-Allowlist) und die per Patch `85-chat-enable-native-agent.patch` aktivierte Chat-UI; auf fremden Basen scheitert die Registrierung kontrolliert und die Webview bleibt alleiniger Träger. Verdrahtungs-Beleg: `docs/phase-k-verdrahtung.md`. Agent-/Edit-Modus, Tools und Chat-Sync auf der nativen Oberfläche folgen in späteren Phase-K-Schritten.

## [0.11.0] – 2026-07-15

### Hinzugefügt
- **Claude-Modelle (Proxy v2, Roadmap Phase S):** Der Modell-Picker bietet zusätzlich zu Gemini drei Anthropic-Modelle über Vertex AI MaaS an — `claude-opus-4-8` und `claude-sonnet-5` (EU-Multiregion) sowie `claude-opus-4-6` (europe-west1). Der Client bleibt beim Gemini-Wire-Format; die komplette Format-Übersetzung (Messages-Format, Tool-Use-IDs, SSE-Events, Tokenzählung) übernimmt der Proxy (`agent-proxy/lib/anthropic.js`, Proxy v0.5.0). Chat mit allen 11 Agent-Tools, Inline-Edit und „In Datei übernehmen“ funktionieren unverändert.

### Geändert
- **Gewichtete Monats-Quote:** Teure Modelle verbrauchen die Quote entsprechend schneller (Faktoren aus den Listenpreisen, Basiseinheit Gemini 2.5 Flash; z. B. Opus-Ausgabetokens ×11). „Agent: Verbrauch anzeigen“ zeigt gewichtete Tokens, sobald der Proxy sie liefert; ältere Proxys zeigen wie bisher Rohtokens.

## [0.10.0] – 2026-07-13

### Hinzugefügt
- **Chat-Sync (Phase S, Roadmap-Punkt „Nutzerdaten & Chat-Sync“):** Chat-Sitzungen synchronisieren sich geräteübergreifend — pro Google-Konto und Projekt (Workspace-Ordnername als Schlüssel). Da der Client seit dem BYOK-Rückbau keinen direkten Firebase-Zugang mehr hat, läuft der Sync wie das Metering über den Proxy (`GET/PUT/DELETE /v1/sessions…`, Proxy v0.4.0; Firestore `sessions/{uid}/workspaces/{ws}/items/{id}`, Isolation strikt über die verifizierte Nutzer-ID). Beim Öffnen des Chats werden neuere Stände anderer Geräte übernommen (last-write-wins pro Sitzung über `updatedAt`), Änderungen wandern huckepack auf dem entprellten Speichern nach oben, Löschen wirkt auch remote. `workspaceState` bleibt als Offline-Cache immer erhalten — ein nicht erreichbarer Proxy kostet nur den Abgleich, nie Sitzungen.
- Neue Einstellung `vscodiumAgent.sessions.sync` (Standard: an) schaltet den Sync ab, ohne die lokale Persistenz zu berühren.

### Sicherheit
- Sitzungs-Endpunkte des Proxys validieren Nutzer-ID, Workspace-Schlüssel und Sitzungs-ID, bevor daraus Firestore-Pfade werden; die Nutzer-ID stammt ausschließlich aus dem verifizierten ID-Token, die Sitzungs-ID aus dem URL-Pfad — Body-Werte können beides nicht übersteuern. Dokumente sind auf ~900 KiB gedeckelt (413 statt Firestore-Fehler); Proxy-Logs tragen nur Pfadform, Status und Dauer, nie Titel oder Chat-Inhalte.

## [0.9.0] – 2026-07-13

### Entfernt
- **BYOK-Rückbau (Phase S, Roadmap-Punkt 10):** Der direkte API-Key-Pfad zu Firebase AI Logic ist komplett weg — Kommandos „Firebase API-Key setzen/löschen“, die Einstellungen `firebase.projectId`/`appId`/`backend`/`location` und `auth.googleClientId`/`googleClientSecret` sowie der `FirebaseAiLogicClient` (übrig bleiben die geteilten Gemini-Format-Helfer). Ein noch gespeicherter API-Key wird beim ersten Start gelöscht. Das Standort-Routing (`resolveRoute`) entfällt clientseitig — es liegt vollständig beim Proxy.

### Geändert
- **Anmeldung und Token-Erneuerung laufen über das Auth-Relay des Proxys** (`POST /v1/auth/exchange` bzw. `/v1/auth/refresh`, Proxy v0.3.0): Die Extension trägt keinerlei Geheimnisse mehr — OAuth-Client-Secret und Firebase-Web-API-Key leben ausschließlich im Cloud-Run-Proxy (Secret Manager). Im Client verbleibt nur die öffentliche OAuth-Client-ID (fest eingebaut, `lib/saasConfig.js`); der Browser-Flow (PKCE + Loopback + state-Prüfung) bleibt unverändert. Bestehende Anmeldungen überleben das Update (gleicher Refresh-Token, neuer Erneuerungs-Weg).
- Chat, Inline-Edit und „In Datei übernehmen“ setzen jetzt die Anmeldung voraus; das Setup-Panel bietet direkt „Mit Google anmelden“ statt der API-Key-Eingabe. „Agent: Verbindung testen“ prüft den Agent-Proxy.

### Sicherheit
- Kein Schlüsselmaterial mehr im ausgelieferten Client oder in den Einstellungen; empfohlen: den Web-API-Key in der GCP-Konsole zusätzlich auf die Identity-Toolkit-API beschränken (siehe `docs/agent-proxy.md`).
- Die (unauthentifizierten) Auth-Endpunkte des Proxys haben einen **eigenen** Rate-Limit-Eimer (getrennt vom Modell-Verkehr) und prüfen das per-IP-Limit zuerst — ein Anmelde-Flood aus einer IP kann den bezahlten Modell-Verkehr nicht mehr über den geteilten Gesamtdeckel aussperren (aus dem Security-Review).
- Ein harter Anmelde-/Erneuerungsfehler (Refresh-Token abgelaufen/widerrufen) wird im Client nicht mehr als retrybarer Netzwerkfehler behandelt: kein dreifacher Wiederholversuch, der eigentliche Anmelde-Hinweis bleibt sichtbar (aus dem Security-Review).

## [0.8.0] – 2026-07-12

### Hinzugefügt
- **Verbrauchsanzeige (Metering, Phase S):** Kommando „Agent: Verbrauch anzeigen“ (auch im Konto-Menü der Chat-Statusleiste) zeigt den Monatsverbrauch des angemeldeten Nutzers — Tokens, Limit, Prozent, Anfragen, Tarif (`GET /v1/usage` des Proxys). Serverseitig zählt der Proxy jetzt pro Nutzer und Monat in Firestore mit und setzt harte Monats-Quoten durch (Proxy v0.2.0, siehe `docs/agent-proxy.md`).

### Geändert
- Ein erschöpftes Monatskontingent (429 mit `reason: quota`) wird nicht mehr wie ein Rate-Limit behandelt: kein automatischer Retry (Warten hilft bis Monatsende nicht), stattdessen ein klarer Hinweis auf die Verbrauchsanzeige.

## [0.7.0] – 2026-07-12

### Hinzugefügt
- **Agent-Verkehr über den Proxy (SaaS-Pfad):** Wer angemeldet ist, spricht mit Chat, Inline-Edit und „In Datei übernehmen“ automatisch den Cloud-Run-Proxy (`lib/proxyClient.js` — gleiches Interface wie der bisherige Client, Authentifizierung per ID-Token, SSE-Streaming, Retry bei 429/5xx, verständliche Hinweise bei 401/404/429). Ohne Anmeldung gilt übergangsweise weiter der API-Key-Pfad.
- **Modell-Picker zeigt das Server-Angebot:** Angemeldet bezieht der Picker die Modellliste vom Proxy (`GET /v1/models`, 5 Minuten gecacht) — der Dienst bestimmt das Angebot, inklusive Standort-Anzeige; bei nicht erreichbarem Proxy greift der lokale Katalog.
- Der Verbindungstest nutzt beim Proxy-Pfad den Katalog-Endpunkt und verbraucht keine Modell-Tokens; das Log nennt pro Lauf den Weg („Proxy“ vs. „AI Logic“).

## [0.6.0] – 2026-07-12

### Hinzugefügt
- **Google-Anmeldung (SaaS-Login, Phase S):** Kommando „Agent: Mit Google anmelden“ öffnet den Browser (OAuth für installierte Apps: PKCE + Loopback-Redirect auf 127.0.0.1); das Google-Konto wird per `signInWithIdp` bei Firebase Auth eingelöst. Der Refresh-Token liegt in der SecretStorage, das kurzlebige ID-Token wird automatisch erneuert (Token-Rotation wird persistiert). Anmeldestatus in der Chat-Statusleiste — Klick meldet an bzw. öffnet das Konto-Menü (Abmelden, Proxy-Test). Neue Kommandos: „Abmelden“, „Proxy-Verbindung testen“ (End-to-End-Probe gegen den Cloud-Run-Proxy).
- Neue Einstellungen: `vscodiumAgent.proxy.url` (Standard: der Cloud-Run-Proxy des Projekts) sowie `vscodiumAgent.auth.googleClientId`/`googleClientSecret` (OAuth-Client vom Typ „Desktop-App“).
- Robustheit der Anmeldung (aus dem Security-Review): Anmeldung ist abbrechbar (Fortschritts-Benachrichtigung; ein neuer Versuch beendet den alten statt parallel zu laufen); der Loopback-Server schließt auch bei Browser-Fehlern sofort; Abmelden während einer laufenden Token-Erneuerung bleibt endgültig (kein Zurückschreiben rotierter Tokens); Anmeldestatus synchronisiert sich zwischen mehreren Fenstern; ein Wechsel oder Löschen des Web-API-Keys (Projektwechsel) meldet automatisch ab; transiente Keyring-Fehler werden beim nächsten Zugriff erneut versucht statt die Sitzung dauerhaft abzumelden.

## [0.5.0] – 2026-07-12

### Hinzugefügt
- **Modell-Katalog mit Auto-Routing:** `gemini-3.5-flash` steht im Modell-Picker zur Wahl. Den Standort löst die Extension pro Modell automatisch auf (das Backend bestimmt weiterhin `vscodiumAgent.firebase.backend`) — Gemini-3.x-Modelle sind über Firebase AI Logic nur mit Standort `global` erreichbar (gilt per Heuristik auch für 3.x-Modelle, die manuell in den Einstellungen stehen); die 2.5-Familie bleibt regional pinnbar. Der Picker zeigt feste Standorte als Suffix samt Tooltip; wird die Location-Einstellung übersteuert, steht das im Log.

### Geändert
- `vscodiumAgent.firebase.location` ist jetzt ein Experten-Override: Modelle mit festem Standort übersteuern die Einstellung automatisch (erster Schritt von Phase S der Roadmap; das Routing wandert später in das Proxy-Backend).
- Der 404-Fehlerhinweis erklärt die Standort-Regel für Gemini 3.x.

### Behoben
- **Codeblöcke:** „Kopieren“ und „In Datei übernehmen“ verloren bei mehrzeiligen Blöcken alle Zeilenumbrüche (Umbrüche wurden im Rendering zu `<br>` und fehlten beim Auslesen).
- **Modell-Picker:** Die Auswahl schrieb immer in die globalen Einstellungen; ein Workspace-Wert von `vscodiumAgent.model` überstimmte sie stillschweigend und der Picker sprang zurück. Jetzt wird dorthin geschrieben, wo der Wert wirkt.
- Modellnamen mit abschließendem Schrägstrich (z. B. `gemini-3.5-flash/`) wurden still auf das Default-Modell umgeleitet, statt als Tippfehler sichtbar zu werden (404-Hinweis).
- Während einer laufenden Codeblock-Übernahme kann kein Agent-Lauf mehr starten, der die offene Review-Karte der Übernahme stillschweigend abgelehnt hätte.
- Settings-Änderungen mitten in einer Kommando-Freigabe verwerfen nicht mehr den bereits editierten Kommando-Text in der Karte.
- Der Picker zeigt den festen Standort auch für Modelle, die nur in den Einstellungen stehen (z. B. 3.x-Previews); Schreibweisen wie `models/gemini-3.5-flash` erzeugen keinen Duplikat-Eintrag mehr.

## [0.4.0] – 2026-07-08

### Hinzugefügt
- **Streaming-Diff im Inline-Edit:** Die Modellantwort wird live in die Editor-Region gestreamt – als eine einzige Undo-Gruppe (Strg+Z stellt den Ausgangszustand her). Abbruch über die Fortschritts-Benachrichtigung setzt die Region sauber zurück; ohne SSE-Unterstützung automatischer Rückfall auf den nicht-streamenden Aufruf.
- **Partielles Annehmen:** Nach dem Inline-Edit zeigt ein Zeilen-Diff die geänderten Blöcke (grün markiert). Jeder Block lässt sich per CodeLens einzeln verwerfen; am Blockanfang stehen „Alles behalten“, „Anpassen…“ und „Alles verwerfen“. Alle Verwerfen-Pfade sind gegen zwischenzeitliche Benutzereingaben abgesichert.
- **Follow-ups:** „Anpassen…“ verfeinert den offenen Vorschlag mit einer weiteren Instruktion auf dem aktuellen Stand; „Verwerfen“ stellt weiterhin den Zustand vor dem ersten Edit wieder her.
- **Sichtbares Agent-Terminal:** Mit `vscodiumAgent.terminal.mode` = `terminal` laufen freigegebene Kommandos sichtbar im „Agent“-Terminal (Shell-Integration-API, VS Code ≥ 1.93). Die Ausgabe wird ANSI-bereinigt an das Modell gegeben; ohne Shell-Integration automatischer Rückfall auf den unsichtbaren Hintergrund-Lauf.
- **Editierbare Kommandos:** Im Review-Modus lässt sich das Kommando in der Freigabe-Karte vor dem Ausführen anpassen; ausgeführt, angezeigt und protokolliert wird der angepasste Text.
- **Modell-Picker im Chat:** Dropdown in der Statusleiste des Chat-Panels (ausschließlich Gemini: 2.5 Flash, 2.5 Pro, 2.5 Flash-Lite; ein abweichender Wert aus den Einstellungen erscheint zusätzlich). Aus Phase 3 der Roadmap vorgezogen.

### Geändert
- Mindestanforderung an die VS-Code-Basis: `engines.vscode` von `^1.90.0` auf `^1.93.0` (Shell-Integration-API `onDidEndTerminalShellExecution`/`execution.read()`).

## [0.3.0] – 2026-07-07

### Hinzugefügt
- **Aktivitäts-Index:** Die IDE verfolgt, wo der Benutzer arbeitet (bearbeitete, gespeicherte, betrachtete und extern geänderte Dateien; Frecency-Scoring mit 30-Minuten-Halbwertszeit). Das Modell erhält bei jedem Aufgabenstart eine frische Zusammenfassung inklusive aktiver Datei.
- **Delta seit letzter Erfassung:** Liste aller Dateien, die seit der letzten Kontext-Erfassung des Agenten angefasst wurden; Agent-eigene Schreibvorgänge werden getrennt markiert.
- Neues Tool `get_recent_activity`, mit dem sich das Modell während langer Aufgaben selbst aktualisiert.
- Persistenz des Index pro Projekt (`workspaceState`).

## [0.2.0] – 2026-07-07

### Hinzugefügt
- **Auto-Start:** Der Agent-Chat öffnet sich automatisch beim Laden der IDE (Einstellung `vscodiumAgent.openOnStartup`).
- **Mehrfach-Sitzungen:** Sitzungen werden pro Projekt gespeichert und überleben Neustarts; Sitzungsleiste mit Dropdown, Neu- und Löschen-Knopf; Titel aus der ersten Aufgabe; Limit über `vscodiumAgent.sessions.max`.

## [0.1.0] – 2026-07-07

Erste Version.

### Hinzugefügt
- Chat-Sidebar (Webview) mit Plan-, Tool- und Ergebnisprotokoll.
- Agent-Loop mit Gemini Function Calling über Firebase AI Logic (REST, dependency-frei; Standard-Projekt `controlling-man`, Backends Gemini Developer API und Vertex AI).
- Werkzeuge: `list_files`, `read_file`, `search_project`, `write_file`, `replace_in_file`, `delete_file`, `run_command`, `get_diagnostics`, `task_complete`.
- Review-Modus: Diff-Vorschau mit Übernehmen/Ablehnen je Dateiänderung, Freigabe-Gate für Kommandos; Auto-Modus zuschaltbar.
- Drift-Schutz: Schrittlimit (`maxIterations`), periodische Ziel-Erinnerung, Stopp-Knopf.
- API-Key-Verwaltung über SecretStorage, Verbindungstest-Kommando, Workspace-Pfad-Sandbox, deaktiviert in nicht vertrauenswürdigen Workspaces.
- Headless-Testsuite (`node test/run.js`) mit Mock-LLM und Mock-Host.
