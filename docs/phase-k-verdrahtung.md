# Phase K — Verdrahtung des nativen Core-Chats (Beleg gegen VS Code 1.121.0)

Verifiziert am 15.07.2026 gegen `microsoft/vscode` @ `987c9597` (Tag 1.121.0, unser Pin in `upstream/stable.json`), per Sparse-Checkout des Quellcodes; ergänzt um die Befunde für Inkrement 2 (v0.13.0: Modi + Tools + Chat-Editing). Dieses Dokument belegt, **wie** die Built-in-Extension die native Chat-UI übernimmt, **warum** wir bewusst ohne `defaultChatAgent` arbeiten, und **was nur ein echter Build** verifizieren kann.

## Kernentscheidung: Minimalpfad ohne `defaultChatAgent`

Die ursprüngliche Annahme („`defaultChatAgent` auf die eigene Extension setzen") hat sich beim Blick in den Quellcode als unnötig und unerwünscht erwiesen:

1. **`IDefaultChatAgent` ist Copilot-förmig.** `src/vs/base/common/product.ts:373–413`: Entitlement-/SKU-/Signup-URLs, Sign-in-Provider (default/enterprise/google/apple), Quota-Kontexte, Copilot-Kommandos. Fast nichts davon hat für uns eine sinnvolle Belegung — unsere Auth läuft über den Agent-Proxy, unser Metering über Firestore.
2. **Ohne den Eintrag bleibt der gesamte Setup-/Entitlement-Apparat inaktiv.** `src/vs/workbench/services/chat/common/chatEntitlementService.ts:411`: `if (!productService.defaultChatAgent) { return; }` — es entstehen weder `ChatEntitlementContext` noch `ChatEntitlementRequests`. Kein Signup-Flow, keine Plan-UI, keine Entitlement-Requests, nichts zu entbranden.
3. **Die Chat-View braucht ihn nicht.** `when`-Klausel der View (`src/vs/workbench/contrib/chat/browser/chatParticipant.contribution.ts:71–81`): `accountPolicyGateActive.negate() && ((Setup.hidden.negate() && Setup.disabledInWorkspace.negate()) || panelParticipantRegistered || extensionInvalid)`. Die Setup-Kontextschlüssel haben Default `false` (`chatEntitlementService.ts:38–48`), und `panelParticipantRegistered` wird gesetzt, sobald ein **Default-Participant** registriert ist (`src/vs/workbench/contrib/chat/common/participants/chatAgents.ts:307`) — also durch unsere Extension selbst.

Konsequenz: Wir registrieren nur den Default-Participant und lassen den Copilot-Apparat schlafen, statt ihn umzubranden. `trustedExtensionAuthAccess` entfällt ebenfalls (unsere Auth nutzt keine VS-Code-Auth-Provider-Sessions).

## Die drei Bausteine

### 1. product.json (Root, jq-Merge in `prepare_vscode.sh`)

```json
"extensionEnabledApiProposals": {
  "vscodium.vscodium-agent": ["defaultChatParticipant", "chatParticipantAdditions"]
}
```

Beleg der Notwendigkeit: `chatParticipant.contribution.ts:247` verwirft Contributions mit `isDefault`/`modes`, wenn das Proposal `defaultChatParticipant` nicht freigeschaltet ist („CANNOT use API proposal“). `chatParticipantAdditions` (seit v0.13.0) braucht der Edit-/Agent-Modus für die Chat-Editing-Streams: `stream.textEdit`/`notebookEdit`/`workspaceEdit` sind runtime-gegated (`extHostChatAgents2.ts:283–309`, je `checkProposedApiEnabled(…, 'chatParticipantAdditions')`); auch `request.tools` und `modeInstructions` gehören zu diesem Proposal (`vscode.proposed.chatParticipantAdditions.d.ts:1072ff`).

### 2. Patch `patches/85-chat-enable-native-agent.patch`

VSCodiums Stock-Patch `00-copilot-fix-action-condition.patch` setzt den Default von `chat.disableAIFeatures` auf `true` und hängt `config.chat.disableAIFeatures`-Guards an alle Chat-Oberflächen. Unser 85er-Patch kippt **nur den Default zurück auf `false`** (eine Zeile in `chat.shared.contribution.ts`); alle Guards bleiben funktional — wer AI-Features abschalten will, kann das weiterhin per Setting. Patch-Reihenfolge `00 → 85` wurde gegen den 1.121-Checkout mit `git apply` verifiziert (Ergebnis: `default: false`).

Die Copilot-Removal-Patches (`51/52-ext-copilot-remove-it`) bleiben unangetastet: Sie entfernen die gebündelte Microsoft-Extension aus dem Build, nicht die Core-UI.

### 3. Extension v0.12.0 – v0.14.0

Seit v0.14.0 zusätzlich: `contributes.chatAgents` liefert `agents/plan.agent.md` + `agents/erweiterter-plan.agent.md` (Plan-Modi als Custom Agents, Erkennung + Lese-Tool-Zwang über Instructions-Marker, Prompts in `lib/prompts.js` `buildPlanPrompt`); nur noch EIN Default-Participant (`vscodium-agent.agent` — ask/edit zurückgebaut, Befund 8); Platzhalter-Modell `anmeldung-erforderlich` mit Sign-in-Button statt „Language model unavailable"; 1×-Netz-Retry im Loop (`AgentRun.retryDelayMs`); alle 9 Tools mit `canBeReferencedInPrompt` + `toolReferenceName` (Befund 9).

- `package.json`: `enabledApiProposals: ["defaultChatParticipant", "chatParticipantAdditions"]`; DREI Default-Participants (`vscodium-agent.default` → ask, `.edit` → edit, `.agent` → agent, je `isDefault: true` + `modes: [<modus>]`); `contributes.languageModelTools` mit 9 der 10 Agent-Tools (`task_complete` bleibt Loop-intern); `contributes.languageModelChatProviders` (`vendor: vscodium-agent`).
- `ui/nativeChatController.js`: Participant-Registrierung und Modus-Dispatch. Ask: Projektbaum- + Aktivitätskontext, SSE-Streaming über den Agent-Proxy. Edit/Agent: der bestehende `AgentRun`-Loop bedient den Request; Tool-Aufrufe laufen über `vscode.lm.invokeTool` (Core rendert Tool-Cards und Freigaben), Deklarationen werden per Modus und nativem Tool-Picker gefiltert (`request.tools`). Feature-Detection + try/catch: auf Basen ohne Proposal-Freischaltung scheitert die Registrierung kontrolliert, die Webview bleibt alleiniger Träger.
- `ui/nativeTools.js`: `lm.registerTool` für die 9 Tools (Freigaben via `prepareInvocation.confirmationMessages`, nur im Review-Modus); `NativeRunHost` streamt Datei-Edits als `textEdit`-Parts und Löschungen als `workspaceEdit`-Part ins native Chat-Editing statt auf die Platte und liest bevorzugt aus offenen Dokumenten (Chat-Editing arbeitet auf Puffern); Run-Kontext-Registry verbindet Tool-Invocations mit ihrem Lauf (Schlüssel: `sessionResource` aus dem Token — der Main-Thread hydriert das Token neu, Objekt-Identität trägt nicht: `extHostLanguageModelTools.ts:189` `revive(dto.context)`; Fallback: zuletzt gestarteter Lauf).
- `lib/nativeChat.js`: headless testbare Kernlogik (Historie → Gemini-`contents`, Ask-Request, Streaming-Adapter, LM-API-Nachrichten-Konvertierung; seit v0.13.0: Deklarations-Filter je Modus, Freigabe-Metadaten, Ergebnis-Roundtrip Loop ↔ `LanguageModelToolResult`, Modus-Systemtexte). Tests in `test/run.js` (`testNativeChat`, `testNativeAgentMode` inkl. Manifest↔Deklarations-Sync).
- `lib/agentController.js`: `AgentRun` akzeptiert `toolDeclarations` (Teilmenge je Lauf) und `invokeTool` (austauschbare Ausführung) — die native Route ersetzt nur die Tool-Ausführung, der Loop bleibt identisch.

## Stabil vs. Proposal (Stand 1.121)

| API | Status | Beleg |
|---|---|---|
| `vscode.chat.createChatParticipant` | stabil | `src/vscode-dts/vscode.d.ts` |
| `vscode.lm.registerLanguageModelChatProvider(vendor, provider)` | **stabil** | `vscode.d.ts:20847` |
| `LanguageModelChatInformation` (`id`, `name`, `family`, `version`, `maxInputTokens`, `maxOutputTokens`, `capabilities`) | stabil | `vscode.d.ts:20580ff` |
| `provideLanguageModelChatResponse(model, messages, options, progress<LanguageModelResponsePart>, token)` + `provideTokenCount` | stabil | `vscode.d.ts:20708ff` |
| `contributes.languageModelChatProviders` (Aktivierung `onLanguageModelChatProvider:<vendor>`) | stabil | `contrib/chat/common/languageModels.ts:571` |
| `isDefault` + `modes` an `contributes.chatParticipants` | **Proposal `defaultChatParticipant`** | `chatParticipant.contribution.ts:247` |
| `contributes.languageModelTools` (Schema: name/displayName/modelDescription/inputSchema als JSON-Schema, Namens-Pattern `^(?!copilot_\|vscode_)[\w-]+$`; Aktivierung `onLanguageModelTool:<name>`) | stabil | `common/tools/languageModelToolsContribution.ts:41–140` |
| `lm.registerTool`, `lm.invokeTool`, `ChatRequest.toolInvocationToken`, `prepareInvocation` + `PreparedToolInvocation.confirmationMessages` | **stabil** | `vscode.d.ts:20774/20808/19893/21173/21195` |
| `stream.textEdit` / `notebookEdit` / `workspaceEdit`, `request.tools`, `modeInstructions` | **Proposal `chatParticipantAdditions`** | `extHostChatAgents2.ts:283–309`, `vscode.proposed.chatParticipantAdditions.d.ts:585–608/1072ff` |

Wichtig: Der **Default**-Participant bekommt exakt die deklarierten `modes` (sonst nur `ask`); Nicht-Default-Participants bekämen automatisch alle drei (`chatParticipant.contribution.ts:297`).

Merkliste künftig relevanter Proposals: `chatSessionsProvider` (Kandidat für die Chat-Sync-Andockung), `languageModelSystem`, `chatParticipantPrivate` (offizielle Quelle für `chatSessionResource` in Tool-Invocations, falls der `sessionResource`-Schlüssel je bricht).

## Befunde für Inkrement 2 (v0.13.0: Modi, Tools, Chat-Editing)

1. **Der Modus steht NICHT im Request.** `IChatAgentRequest` transportiert nur `modeInstructions` (Custom-Modes) und `permissionLevel`, kein `ChatModeKind` (`chatService/chatServiceImpl.ts`, `buildAgentRequest`; ebenso `extHostTypeConverters.ts`, `ChatAgentRequest.to`). Auch mit allen Proposals gibt es kein Modus-Feld am `vscode.ChatRequest`.
2. **Konsequenz — ein Default-Participant pro Modus.** Exakt das Muster der Core-eigenen Setup-Agents: je Modus ein Agent mit `modes: [mode]` (`chatSetup/chatSetupProviders.ts:156`, `doRegisterAgent`); `getDefaultAgent(location, mode)` wählt nach Modus aus (`participants/chatAgents.ts:442–450`). Mehrere Default-Participants einer Extension sind zulässig (keine Eindeutigkeits-Prüfung im Extension-Point-Handler). Default-Agents sehen die volle Session-Historie, nicht nur eigene Requests (`chatServiceImpl.ts`, `getHistoryEntriesFromModel`: „The default agent … get to see all of them“) — Moduswechsel mitten in der Session behält also den Kontext.
3. **`request.tools` ist nur im Agent-Modus gefüllt.** Die Widget-Seite sendet `userSelectedTools` ausschließlich bei `ChatModeKind.Agent` (`browser/widget/chatWidget.ts:2534`); sonst liefert `getToolsForRequest` eine leere Map (`extHostChatAgents2.ts`). Der Edit-Modus bekommt seine Tool-Teilmenge deshalb NICHT vom Picker, sondern aus unserer Modus-Zuordnung (`EDIT_MODE_TOOLS`).
4. **Tool-Invocations rendern nativ.** `lm.invokeTool` mit dem `toolInvocationToken` des Requests hängt die Invocation als Chat-Progress an (`browser/tools/languageModelToolsService.ts:605–616`, `appendProgress`); `prepareInvocation.confirmationMessages` erzeugt die Weiter/Abbrechen-Freigabe. **Ablehnung wirft `CancellationError`** (`:620–621`), ohne dass der Request-Token abbricht — wir mappen das auf „Vom Benutzer abgelehnt“ für das Modell. Globale Auto-Approve-Settings des Cores: `chat.tools.global.autoApprove`, `chat.tools.edits.autoApprove` (`common/constants.ts:35–36`) — unser `approvalMode` bleibt davon unabhängig (Auto-Modus = keine confirmationMessages).
5. **Chat-Editing konsumiert `textEditGroup`- und `workspaceEdit`-Parts** (`browser/chatEditing/chatEditingServiceImpl.ts:289–315`): `stream.textEdit(uri, edits)` + `stream.textEdit(uri, true)` je Datei; Löschungen über `stream.workspaceEdit` (→ `applyWorkspaceEdit` → `startDeletion`, `chatEditingSession.ts`; „Future: creations/renames“ — Neuanlagen funktionieren über das Streamen an eine neue URI). Wir streamen bewusst EIN Whole-Document-Edit pro Datei: das Review-Diff berechnet der Core selbst, Hunk-Granularität wäre Streaming-Kosmetik mit EOL-/Offset-Risiko.
6. **Token-Korrelation:** Der Main-Thread hydriert den `toolInvocationToken` vor dem Tool-`invoke` neu (`extHostLanguageModelTools.ts:189`, `revive(dto.context)`) — Objekt-Identität (WeakMap) trägt NICHT. Laufzeitform `{ sessionResource, workingDirectory }`; wir schlüsseln über `String(sessionResource)` mit Fallback auf den zuletzt gestarteten Lauf und kontrolliertem Fehler ohne Kontext.
7. **Der Agent-Modus filtert den Modell-Picker auf `capabilities.toolCalling`** (`browser/widget/input/chatModelSelectionLogic.ts:54` → `ILanguageModelChatMetadata.suitableForAgentMode`, `common/languageModels.ts:236`: `toolCalling` muss true sein, `agentMode` darf nicht explizit false sein); Inline-Chat filtert ebenso (`chatModelSelectionLogic.ts:70`). Meldet der Provider `toolCalling: false`, ist die Liste im Agent-Modus leer, „Auto" findet nichts und der Request scheitert VOR dem Participant mit „Language model unavailable" (`extHostChatAgents2.$invokeAgent` → `getModelForRequest`). Befund aus dem ersten Praxistest (16.07.2026, Extension-Dev-Host gegen Stock-Core); Fix in v0.13.0: `toolCalling: true`.
8. **Die Builtin-Modi Ask und Edit sind in 1.121 abgekündigt.** Der Modus-/Agent-Picker blendet sie standardmäßig aus (`browser/widget/input/modePickerActionItem.ts`, `shouldShowBuiltInMode`): Edit erscheint nur bei per Policy deaktiviertem Agent-Modus („deprecated" laut Quellcode-Kommentar), der alte Ask nur per Experiment-Zuweisung `showOldAskMode`. Standardbild ist NUR „Agent" + Custom Agents („Configure Custom Agents…"). Praxis-Befund der ersten Probefahrt (17.07.2026, echter Fork-Build): ask/edit-Participants korrekt registriert und funktionsfähig, aber ohne UI-Zugang. Konsequenz (Nutzer-Entscheid): Modus-Angebot künftig über die Custom-Agent-Mechanik — Agent/Plan/Erweiterter Plan, siehe ROADMAP Phase K. Fürs nächste Inkrement zu verifizieren: Wie liefert das Produkt eigene Custom Agents aus (`isModeConsideredBuiltIn` koppelt „builtin" an `defaultChatAgent.chatExtensionId`, den wir bewusst nicht setzen; Sichtbarkeit als Custom Agent über `PromptsStorage.extension` bzw. Proposal `chatPromptFiles` prüfen). Zweiter Befund derselben Probefahrt: Ohne Anmeldung liefert der Modell-Provider eine leere Liste → Request scheitert mit „Language model unavailable" statt mit unserem Anmelde-Hinweis — der Provider braucht einen Platzhalter-Eintrag (bestätigt Verifikationspunkt 4; umgesetzt in v0.14.0: `SIGN_IN_MODEL_ID` + Sign-in-Button).
9. **Custom Agents aus Extensions: stabiler Weg gefunden (v0.14.0).** Der Extension-Point `contributes.chatAgents` (`common/promptSyntax/chatPromptFilesContribution.ts:41ff`) registriert `.agent.md`-Dateien der Extension beim PromptsService — OHNE Proposal-Gate. Frontmatter-Felder parst `promptFileParser.ts` (`name`, `description`, `tools`, `model`, `handoffs`, …); der Picker zeigt sie als Custom Agents (kind Agent), die `tools:`-Liste wird beim Senden zur Tool-Auswahl (`chatSelectedTools.ts`: `toToolAndToolSetEnablementMap` matcht über fullReferenceNames), der Dateiinhalt kommt als `request.modeInstructions` (chatParticipantAdditions) beim Agent-Default-Participant an. ZWEI Fallstricke: (a) Die Enablement-Map der UI nimmt nur Tools mit `canBeReferencedInPrompt: true` auf (`chatSelectedTools.ts:149ff`) — ohne das Flag sind Extension-Tools weder im Picker steuerbar noch von Frontmatter-`tools:`-Listen erfassbar (seit v0.14.0 gesetzt, inkl. `toolReferenceName`). (b) Deshalb verlässt sich die Lese-Tool-Grenze der Plan-Modi NICHT auf die UI-Mechanik: Ein Marker `<!-- vscodium-agent:mode=… -->` in den Instructions wird serverseitig erkannt (`parseModeMarker`) und erzwingt das Plan-Toolset in den Modell-Deklarationen. Extension-gelieferte Agents sind für Nutzer read-only (`ToolsScope.Agent_ReadOnly`).

## Was nur der echte Build zeigt (Verifikationsplan)

1. **Contribution angenommen:** Kein „CANNOT use API proposal: defaultChatParticipant“ im Extension-Host-Log; `chatParticipants`-Schema-Warnungen prüfen.
2. **Chat-View sichtbar** im Secondary Sidebar (Strg+Alt+I), Participant antwortet, Streaming flüssig, Abbrechen wirkt.
3. **Modell-Picker** zeigt nach Anmeldung das Proxy-Angebot; Auswahl kommt als `request.model` (Vendor-Check) im Handler an.
4. **Verhalten ohne Anmeldung:** Picker ist leer — sendet die UI trotzdem an den Participant (erwartet: ja, unser Handler antwortet mit Anmelde-Hinweis)? Falls die UI ein gewähltes Modell erzwingt, braucht der Provider einen Platzhalter-Eintrag.
5. **Kosmetik-Restrisiken:** `chatWidget.ts:1072` (Terms-Text greift auf `product.defaultChatAgent.provider` zu — Pfad gehört zum Setup-Flow und sollte nie rendern; im Build gegenprüfen), `modePickerActionItem.ts:314` (optional-chained, unkritisch), Copilot-Nennung in der Beschreibung von `chat.disableAIFeatures` (Entbranden-Patch später).
6. **Leerer Chat-Zustand** (Willkommensinhalt) ohne Entitlement-Kontext.
7. **Upstream-Merge-Probe:** Patch 85 und Proposal-Namen gegen das nächste 1.12x-Tag diffen (Chat ist der volatilste Bereich).

Zusätzlich seit Inkrement 2 (v0.13.0):

8. ~~**Modus-Picker zeigt alle drei Modi**~~ *(Überholt durch Befund 8: Upstream blendet Ask/Edit aus, nur „Agent" ist erwartbar — Probefahrt 17.07.2026 hat genau das bestätigt. Neues Zielbild: Agent/Plan/Erweiterter Plan, siehe ROADMAP.)*
9. **Tool-Cards & Freigaben:** Invocation-Meldungen erscheinen, Review-Modus zeigt Weiter/Abbrechen (write/replace/delete/run), Auto-Modus fragt nicht; Ablehnung führt den Lauf fort („abgelehnt“ statt Abbruch). Interaktion mit den Core-Settings `chat.tools.global.autoApprove`/`chat.tools.edits.autoApprove` prüfen (übersteuern sie unsere confirmationMessages erwartungsgemäß?).
10. **Multi-File-Review:** textEdit-Streams erzeugen Pending-Changes mit Annehmen/Verwerfen pro Datei; Neuanlage (Edit an neue URI) und Löschung (workspaceEdit) erscheinen korrekt im Review; Verwerfen stellt den Ausgangszustand wieder her.
11. **Plattenstand nach Edits:** Läuft `run_command` (z. B. Tests) nach gestreamten Edits gegen den NEUEN Inhalt? (Chat-Editing arbeitet auf Puffern; prüfen, wann der Core speichert — sonst müssen wir vor Kommandos gezielt speichern.)
12. **Tool-Picker:** Unsere 9 Tools erscheinen im Agent-Modus-Picker unter der Extension; Abwahl entfernt sie nachweislich aus den Modell-Deklarationen (Log: gefilterte functionDeclarations).
13. **Edit-Modus-Grenzen:** kein run_command/delete_file im Angebot; Hinweis auf den Agent-Modus kommt, wenn das Modell Kommandos braucht.
14. **Session-Korrelation:** Zwei parallel laufende Agent-Anfragen (zwei Chat-Fenster) landen im jeweils richtigen Run-Kontext (`sessionResource`-Schlüssel; Log prüfen, dass der Fallback nicht greift).

Zusätzlich seit v0.14.0 (Plan-Modi + Fixliste):

15. **Plan-Einträge sichtbar:** Das Modus-/Agent-Auswahlfeld bietet „Plan" und „Erweiterter Plan" (aus `agents/*.agent.md`) mit Beschreibungen an; Auswahl + Anfrage landet bei unserem Participant (Log: „Nativer plan-Lauf gestartet …").
16. **Lese-Grenze hält:** Im Plan-Modus „Lege eine Datei an" verlangen → er erklärt, dass er nur liest/plant, und die Werkzeug-Karten zeigen ausschließlich Lese-Tools. „Erweiterter Plan" stellt exakt EINE Frage pro Runde, jeweils mit Empfehlung.
17. **Anmelde-Flow:** Abgemeldet zeigt der Picker „Anmelden erforderlich"; eine Anfrage liefert den Hinweis mit „Mit Google anmelden"-Knopf (statt „Language model unavailable"); nach Anmeldung erscheinen die echten Modelle (ggf. Picker neu öffnen).
18. **Plan → Agent-Übergabe per Handoff:** Nach bestätigtem Plan erscheint unter dem Chat der Knopf „Plan umsetzen" (natives Handoff-Feature: `handoffs:`-Frontmatter mit `send: true`; Rendering `chatSuggestNextWidget`, Ausführung `chatWidget.executeHandoff` → `_switchToAgentByName('agent')` + Auto-Submit) — ein Klick wechselt in den Agent-Modus und startet die Umsetzung; der Agent kennt den Plan aus der Chat-Historie.
19. **Chat ohne Ordner:** In einem Fenster ohne Projektordner antwortet der Chat normal (Fragen/Erklärungen, keine Tool-Karten, kein „Kein Workspace-Ordner geöffnet"-Fehler); auf „Bau mir X" kommt die einsteigerfreundliche Führung plus die Knöpfe „Neuen Projektordner anlegen" (fragt Namen ab, legt `Dokumente\VSCodium-Projekte\<Name>` an, öffnet ihn) und „Vorhandenen Ordner öffnen…"; nach dem Öffnen läuft derselbe Auftrag mit Werkzeugen.
20. **Sessions-Liste „stacked":** „Show Agent Sessions" legt die Übersicht über den Chat-Bereich (Default `chat.viewSessions.orientation: stacked` via configurationDefaults) statt sie seitlich auszuklappen; Umstellen des Settings wirkt sofort.

## Offene Phase-K-Schritte (nach diesem Inkrement)

Review-Paritätskriterien nachweisen (Punkte 8–14 oben; bewusst offene Lücke: Kommando vor Ausführung editieren), Chat-Sync-Andockung (Kandidat `chatSessionsProvider`; dabei auch Tool-Verkehr vergangener Runden in Folge-Requests rekonstruieren), Produkt-Identität (Default-Layout, Walkthrough statt deaktiviertem Onboarding, Strg+L), Webview-Rückbau nach Paritätsnachweis.
