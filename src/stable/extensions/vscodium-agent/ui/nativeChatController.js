/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – Glue für den nativen Core-Chat (Roadmap Phase K).
 *
 * Registriert (1) EINEN Default-ChatParticipant für den Agent-Modus (Upstream hat
 * die Builtin-Modi Ask/Edit abgekündigt – Beleg in docs/phase-k-verdrahtung.md,
 * Befund 8), (2) die Agent-Tools als native LanguageModelTools (ui/nativeTools.js)
 * und (3) einen LanguageModelChatProvider, der das Proxy-Angebot in den nativen
 * Modell-Picker speist – ohne Anmeldung mit einem Platzhalter-Eintrag, damit
 * Anfragen bei uns landen und freundlich zur Anmeldung führen statt mit
 * „Language model unavailable“ zu scheitern.
 *
 * Die Plan-Modi (Entscheid 17.07.2026) kommen als Custom Agents aus
 * `agents/*.agent.md` (contributes.chatAgents, stabiler Extension-Point). Der
 * Handler erkennt sie am Marker in `request.modeInstructions` und erzwingt die
 * Lese-Tool-Teilmenge serverseitig – unabhängig von der Tool-Mechanik der UI.
 * Custom Agents OHNE Marker (z. B. eigene .agent.md des Nutzers) laufen als
 * Agent-Modus mit angehängten Zusatz-Instructions.
 *
 * Läuft nur auf dem gepatchten Fork rund: `isDefault`/`modes` brauchen das Proposal
 * `defaultChatParticipant`, textEdit-/workspaceEdit-Streams und `modeInstructions`
 * das Proposal `chatParticipantAdditions` (beide in der product.json des Builds
 * freigeschaltet). Auf fremden Basen scheitern die Registrierungen kontrolliert –
 * die Webview bleibt alleiniger Träger.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const vscode = require('vscode');
const {
	simplifyHistory,
	historyToContents,
	lmMessagesToContents,
	streamAskResponse,
	parseModeMarker,
	declarationsForMode,
	toolsMapToNames,
	parseToolResultText,
	lmResultToText,
	buildNativeModeNotes,
	NO_WORKSPACE_NOTES,
	SIGN_IN_PROMPT,
	addUsage,
	buildUsageLine,
	imageAttachmentParts,
	modelDetail,
	modelTooltip
} = require('../lib/nativeChat');
const { AgentRun } = require('../lib/agentController');
const { buildSystemPrompt, buildPlanPrompt } = require('../lib/prompts');
const { MEMORY_PATH, COMPAT_PATHS, MEMORY_RULES, buildMemorySection } = require('../lib/projectMemory');
const { pickerModels } = require('../lib/modelCatalog');
const { registerNativeTools, runContexts, NativeRunHost } = require('./nativeTools');
const { agentActivity } = require('./activitySignalController');

const AGENT_PARTICIPANT_ID = 'vscodium-agent.agent';
const MODEL_VENDOR = 'vscodium-agent';
/** Platzhalter-Modell, das ohne Anmeldung im Picker steht. */
// (Bis v0.21.1 stand hier ein Platzhalter-Modell „Anmelden erforderlich“. Die Anmeldung
// gehört in den Chat, nicht in den Modell-Picker – siehe ensureSignedIn.)
/** Marker → Plan-Variante (bewusst explizit statt „alles durchreichen“). */
const PLAN_VARIANTS = new Set(['plan', 'plan-extended']);

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {import('./agentService').AgentService} provider  Kern-Dienst (buildClient/config/auth/_proxyModels)
 * @param {any} activity  ActivityIndex oder null
 * @param {{ info: Function, warn: Function, error: Function }} logger
 * @returns {{ participants: number, tools: number, modelProvider: boolean }}
 */
function registerNativeChat(context, provider, activity, logger) {
	const deps = { provider, activity, logger, toolCount: 0 };
	deps.toolCount = registerNativeTools(context, {
		approvalMode: () => provider.config().approvalMode,
		logger
	});

	const participants = registerParticipant(context, deps) ? 1 : 0;
	const modelProvider = participants > 0 ? registerModelProvider(context, provider, logger) : false;
	return { participants, tools: deps.toolCount, modelProvider };
}

// ── Default-ChatParticipant (Agent-Modus; Plan-Modi kommen als Custom Agents) ──

function registerParticipant(context, deps) {
	if (!vscode.chat || typeof vscode.chat.createChatParticipant !== 'function') {
		deps.logger.info('Nativer Chat: chat-API nicht verfügbar – Webview bleibt alleiniger Träger.');
		return false;
	}
	let participant;
	try {
		participant = vscode.chat.createChatParticipant(AGENT_PARTICIPANT_ID, (request, chatContext, stream, token) =>
			handleAgentRequest(deps, request, chatContext, stream, token)
		);
	} catch (err) {
		// Erwartbar auf Basen ohne Proposal-Freischaltung (die chatParticipants-
		// Contribution wurde dann verworfen) – kein Nutzerfehler, nur protokollieren.
		deps.logger.warn(`Nativer Chat: Registrierung von ${AGENT_PARTICIPANT_ID} nicht möglich – Webview bleibt alleiniger Träger.`, err);
		return false;
	}
	try {
		participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'agent.svg');
	} catch (_e) { /* Icon ist optional */ }
	try {
		// Leerer Chat: Tonalität aus dem PHI47-Design („Chart the next move.“) – kurz,
		// einladend, mit drei Startpunkten. Proposal `defaultChatParticipant`.
		participant.additionalWelcomeMessage = new vscode.MarkdownString([
			'**Wohin soll’s gehen?**',
			'',
			'Sag, was entstehen soll – ich plane die Route, schreibe den Code und führe ihn aus.',
			'',
			'- Bau mir eine Anmeldung mit Firebase Auth',
			'- Warum schlägt der Build fehl?',
			'- Verschaff dir einen Überblick über dieses Projekt'
		].join('\n'));
	} catch (_e) { /* Willkommenstext ist Komfort */ }
	context.subscriptions.push(participant);
	deps.logger.info(`Nativer Chat: Default-Participant registriert (${AGENT_PARTICIPANT_ID}, Modus agent; Plan-Modi via agents/*.agent.md).`);
	return true;
}

/**
 * Modell aus der nativen Picker-Auswahl, sofern sie von unserem Provider stammt.
 * Fremde Auswahl (oder gar keine) fällt auf das konfigurierte Modell zurück.
 */
function pickedModelId(request) {
	if (!request.model || request.model.vendor !== MODEL_VENDOR) { return undefined; }
	return request.model.id;
}

/** Anmelde-Hinweis mit Button streamen (Rückfalltext, wenn der Dialog übersprungen wurde). */
function streamSignInHint(stream) {
	stream.markdown(`**${SIGN_IN_PROMPT.message}.** Ohne Anmeldung kann ich nicht antworten.\n\n`);
	try {
		stream.button({ command: 'vscodiumAgent.signIn', title: SIGN_IN_PROMPT.signIn });
	} catch (_e) { /* Button ist Komfort – der Text erklärt den Weg. */ }
	stream.markdown('\nDanach die Frage einfach erneut senden.\n');
}

/**
 * Merker für „Überspringen“: Wer den Dialog wegklickt, soll ihn nicht bei jeder
 * Nachricht erneut sehen – dann genügt der Hinweis im Chat. Gilt für die Laufzeit
 * des Fensters; nach erfolgreicher Anmeldung ist er ohnehin gegenstandslos.
 */
let signInDialogSkipped = false;

/**
 * Tokenverbrauch je Chat-Sitzung (Schlüssel wie bei den Tool-Läufen: die
 * sessionResource aus dem Invocation-Token). Nur Zähler, keine Inhalte; lebt im
 * Speicher des Fensters und verschwindet mit ihm.
 */
const sessionUsage = new Map();

function sessionKeyOf(request) {
	const token = request && request.toolInvocationToken;
	if (token && token.sessionResource != null) {
		try { return String(token.sessionResource); } catch (_e) { return 'default'; }
	}
	return 'default';
}

/**
 * Sicherstellen, dass jemand angemeldet ist – sonst erscheint ein echter Dialog
 * („Mit Google anmelden“ / „Überspringen“). Nach erfolgreicher Anmeldung läuft die
 * Anfrage direkt weiter, die Nachricht des Nutzers geht also nicht verloren.
 * @returns {Promise<boolean>} true = angemeldet, weitermachen
 */
async function ensureSignedIn(deps, stream) {
	const { provider, logger } = deps;
	try {
		if (provider.auth && await provider.auth.isSignedIn()) { return true; }
	} catch (err) {
		logger.warn('Anmeldestatus nicht prüfbar.', err);
	}

	if (!signInDialogSkipped) {
		const choice = await vscode.window.showInformationMessage(
			SIGN_IN_PROMPT.message,
			{ modal: true, detail: SIGN_IN_PROMPT.detail },
			SIGN_IN_PROMPT.signIn,
			SIGN_IN_PROMPT.skip
		);
		if (choice === SIGN_IN_PROMPT.signIn) {
			await vscode.commands.executeCommand('vscodiumAgent.signIn');
			try {
				if (provider.auth && await provider.auth.isSignedIn()) {
					provider.invalidateCatalog();
					stream.markdown('_Angemeldet – ich mache direkt weiter._\n\n');
					return true;
				}
			} catch (_e) { /* unten landet der Hinweis */ }
		} else if (choice === SIGN_IN_PROMPT.skip) {
			// Nicht weiter drängen: ab jetzt nur noch der Hinweis im Chat.
			signInDialogSkipped = true;
		}
	}

	streamSignInHint(stream);
	return false;
}

async function buildClientOrExplain(provider, request, stream) {
	try {
		return await provider.buildClient(pickedModelId(request));
	} catch (err) {
		if (/angemeldet/i.test(String(err.message || ''))) {
			streamSignInHint(stream);
		} else {
			stream.markdown(`**Nicht verbunden:** ${err.message}${err.hint ? `\n\n_${err.hint}_` : ''}`);
		}
		return null;
	}
}

// ── Agent-/Plan-Requests: der Agent-Loop hinter der nativen Oberfläche ───────

async function handleAgentRequest(deps, request, chatContext, stream, token) {
	const { provider, activity, logger } = deps;
	const abort = new AbortController();
	const cancellation = token.onCancellationRequested(() => abort.abort());
	let exitRun = null;
	agentActivity.started();
	try {
		// Ohne Anmeldung führt der Weg über einen echten Dialog – auch dann, wenn die
		// UI den Platzhalter-Eintrag „Anmelden erforderlich“ als Modell gewählt hat.
		if (!await ensureSignedIn(deps, stream)) { return {}; }
		if (deps.toolCount === 0) {
			stream.markdown('**Native Tools nicht verfügbar** – dieser Build kann den Agent-Modus im nativen Chat nicht ausführen. Bitte die Agent-Ansicht (Seitenleiste) verwenden.');
			return { errorDetails: { message: 'Native Tools nicht registriert.' } };
		}
		const client = await buildClientOrExplain(provider, request, stream);
		if (!client) { return {}; }

		// Ohne geöffneten Ordner bleibt der Chat voll gesprächsfähig – nur ohne
		// Datei-/Kommando-Werkzeuge. Einsteiger führt das Modell bei Bedarf selbst
		// zum Ordner-Öffnen (NO_WORKSPACE_NOTES), statt abgewiesen zu werden.
		const hasWorkspace = (vscode.workspace.workspaceFolders || []).length > 0;

		// Plan-Modi (Custom Agents) am Marker erkennen; fremde Instructions laufen generisch mit.
		const marker = parseModeMarker(request.modeInstructions);
		const planVariant = marker.mode && PLAN_VARIANTS.has(marker.mode) ? marker.mode : null;
		const customInstructions = !planVariant && marker.instructions ? marker.instructions : null;

		const cfg = provider.config();
		let host = null;
		if (hasWorkspace) {
			host = new NativeRunHost(stream, {
				approvalMode: cfg.approvalMode,
				terminalMode: cfg.terminalMode,
				commandTimeoutSec: cfg.commandTimeoutSec,
				maxTreeEntries: cfg.maxTreeEntries,
				logger
			});
			if (activity) {
				host.activityCallback = () => activity.summary(8, 0);
			}
			exitRun = runContexts.enter(request.toolInvocationToken, { host, signal: abort.signal });
		}

		const fileTree = hasWorkspace
			? await Promise.resolve(host.listProjectFiles(cfg.maxTreeEntries)).catch(() => '')
			: '';
		let activitySummary;
		try {
			activitySummary = activity ? String(activity.summary(8, 0) || '') : undefined;
		} catch (_e) { activitySummary = undefined; }

		// Projekt-Gedächtnis: was frühere Läufe (mit Freigabe) festgehalten haben.
		const memory = hasWorkspace ? await loadMemorySection(host, logger) : '';

		const promptCtx = {
			memory,
			memoryRules: hasWorkspace ? MEMORY_RULES : '',
			rootName: hasWorkspace ? host.rootName : '(kein Ordner geöffnet)',
			platform: `${process.platform} (${process.arch})`,
			fileTree,
			approvalMode: cfg.approvalMode,
			shell: process.platform === 'win32' ? 'cmd/PowerShell' : 'sh',
			activity: activitySummary,
			today: new Date().toLocaleDateString('de-DE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
		};
		const noWorkspaceNotes = hasWorkspace ? [] : [NO_WORKSPACE_NOTES];
		const systemPrompt = planVariant
			? [buildPlanPrompt(planVariant, promptCtx), ...noWorkspaceNotes].join('\n\n')
			: [
				buildSystemPrompt(promptCtx),
				buildNativeModeNotes(),
				...(customInstructions ? ['== Additional instructions from the selected custom agent ==', customInstructions] : []),
				...noWorkspaceNotes
			].join('\n\n');

		const modeLabel = planVariant || 'agent';
		logger.info(`Nativer ${modeLabel}-Lauf gestartet (Modell: ${client.model}, Freigaben: ${cfg.approvalMode}).`);
		const run = new AgentRun({
			client,
			host: host || {},
			systemPrompt,
			maxIterations: cfg.maxIterations,
			signal: abort.signal,
			history: historyToContents(simplifyHistory(chatContext && chatContext.history)),
			// Ohne Workspace KEINE Deklarationen: Der Lauf ist rein konversationell
			// (AgentRun lässt das tools-Feld dann komplett weg).
			toolDeclarations: hasWorkspace ? declarationsForMode(planVariant || 'agent', toolsMapToNames(request.tools)) : [],
			invokeTool: (name, args) => invokeNativeTool(request, name, args, token),
			ui: {
				assistantText: (t) => stream.markdown(`${t}\n\n`),
				// Tool-Cards (Start/Ende, Args, Freigaben) rendert der Core selbst.
				toolStart: () => { },
				toolEnd: () => { },
				info: (t) => stream.markdown(`_${t}_\n\n`),
				error: (t) => stream.markdown(`**Fehler:** ${t}\n\n`)
			}
		});

		// Bild-Anhänge (Screenshots, Mockups) an die erste Nutzer-Nachricht hängen.
		const { parts: imageParts, skipped } = imageAttachmentParts(await collectImageAttachments(request, logger));
		if (skipped > 0) {
			stream.markdown(`_${skipped === 1 ? 'Ein Anhang wurde' : `${skipped} Anhänge wurden`} übersprungen (nur PNG, JPEG, WebP oder GIF bis 4 MB)._\n\n`);
		}
		if (imageParts.length > 0) {
			logger.info(`Nativer ${modeLabel}-Lauf: ${imageParts.length} Bild-Anhang/Anhänge übernommen.`);
		}

		const result = await run.run(request.prompt, { parts: imageParts });
		// viaText-Summaries wurden schon während des Laufs gestreamt – nicht doppeln.
		if (result.status === 'completed' && result.summary && !result.viaText) {
			stream.markdown(`${result.summary}\n\n`);
		}

		// Tokenverbrauch: dieser Lauf und – ab dem zweiten – die Summe der Sitzung.
		const key = sessionKeyOf(request);
		const total = addUsage(sessionUsage.get(key), run.usage);
		sessionUsage.set(key, total);
		const usageLine = buildUsageLine(run.usage, total);
		if (usageLine) { stream.markdown(`${usageLine}\n`); }
		if (!hasWorkspace) {
			// Zwei klare Wege für Einsteiger direkt unter der Antwort.
			try {
				stream.button({ command: 'vscodiumAgent.createWorkspace', title: 'Neuen Projektordner anlegen' });
				stream.button({ command: 'workbench.action.files.openFolder', title: 'Vorhandenen Ordner öffnen…' });
			} catch (_e) { /* Buttons sind Komfort */ }
		}
		logger.info(`Nativer ${modeLabel}-Lauf beendet (Status: ${result.status}, gestreamte Edits: ${host ? host.streamedEdits.size : 0}).`);
		return result.status === 'error'
			? { errorDetails: { message: result.summary || 'Agent-Lauf fehlgeschlagen.' } }
			: {};
	} catch (err) {
		if (abort.signal.aborted || token.isCancellationRequested) { return {}; }
		logger.error('Nativer Agent-Lauf fehlgeschlagen', err);
		stream.markdown(`**Fehler:** ${err.message}${err.hint ? `\n\n_${err.hint}_` : ''}`);
		return { errorDetails: { message: String(err.message || err) } };
	} finally {
		agentActivity.ended();
		if (exitRun) { exitRun(); }
		cancellation.dispose();
	}
}

/**
 * Einen Tool-Aufruf des Loops über die native Tool-Infrastruktur ausführen.
 * Der Core rendert die Invocation-Card, holt im Review-Modus die Freigabe ein
 * und ruft unsere Tool-Implementierung (ui/nativeTools.js) auf; das Ergebnis
 * kommt als JSON-Text zurück und wird für den functionResponse re-materialisiert.
 *
 * Ablehnung ist KEIN Fehler: Der Core wirft dann eine CancellationError, ohne
 * dass der Request abgebrochen wurde – das wird als „abgelehnt“ an das Modell
 * gemeldet (gleiches Vertragsverhalten wie im Webview-Review).
 */
async function invokeNativeTool(request, name, args, token) {
	if (name === 'task_complete') {
		return { acknowledged: true };
	}
	try {
		const lmResult = await vscode.lm.invokeTool(name, {
			input: args || {},
			toolInvocationToken: request.toolInvocationToken
		}, token);
		return parseToolResultText(lmResultToText(lmResult));
	} catch (err) {
		if (token.isCancellationRequested) { throw err; }
		if (isCancellationLike(err)) {
			return { skipped: true, status: 'rejected', message: 'Vom Benutzer abgelehnt.' };
		}
		return { error: String(err && err.message ? err.message : err) };
	}
}

/**
 * Projekt-Gedächtnis laden: eigene Datei zuerst, sonst verbreitete Agenten-Dateien
 * anderer Werkzeuge (nur lesend). Fehlt alles, läuft der Agent wie bisher.
 * @returns {Promise<string>} fertiger Prompt-Abschnitt oder ''
 */
async function loadMemorySection(host, logger) {
	for (const candidate of [MEMORY_PATH, ...COMPAT_PATHS]) {
		try {
			if (!await host.fileExists(candidate)) { continue; }
			const text = await host.readFile(candidate);
			if (text && text.trim()) {
				return buildMemorySection(text, candidate);
			}
		} catch (err) {
			logger.warn(`Projekt-Gedächtnis (${candidate}) nicht lesbar.`, err);
		}
	}
	return '';
}

/**
 * Bild-Anhänge einer Anfrage einsammeln (Screenshots, Mockups – per Drag-and-drop
 * oder Einfügen). VS Code liefert sie als Referenzen mit Binärdaten
 * (`ChatReferenceBinaryData`, Proposal `chatReferenceBinaryData`); ältere Basen
 * kennen das nicht – dann kommt einfach nichts zurück.
 * @returns {Promise<Array<{ mimeType: string, data: Uint8Array }>>}
 */
async function collectImageAttachments(request, logger) {
	const out = [];
	for (const ref of (request && request.references) || []) {
		const value = ref && ref.value;
		// Duck-Typing: Binärdaten-Referenzen tragen mimeType + data().
		if (!value || typeof value !== 'object' || typeof value.data !== 'function' || !value.mimeType) { continue; }
		try {
			out.push({ mimeType: String(value.mimeType), data: await value.data() });
		} catch (err) {
			logger.warn('Bild-Anhang konnte nicht gelesen werden.', err);
		}
	}
	return out;
}

function isCancellationLike(err) {
	if (!err) { return false; }
	if (typeof vscode.CancellationError === 'function' && err instanceof vscode.CancellationError) { return true; }
	return err.name === 'Canceled' || /\bcancel/i.test(String(err.message || ''));
}

// ── LanguageModelChatProvider (nativer Modell-Picker) ───────────────────────

function registerModelProvider(context, provider, logger) {
	if (!vscode.lm || typeof vscode.lm.registerLanguageModelChatProvider !== 'function') {
		logger.info('Nativer Chat: lm-Provider-API nicht verfügbar – Modell-Picker bleibt ohne Proxy-Angebot.');
		return false;
	}
	try {
		const disposable = vscode.lm.registerLanguageModelChatProvider(MODEL_VENDOR, {
			/**
			 * Modelle für den Picker – IMMER sichtbar, auch ohne Anmeldung.
			 *
			 * Angemeldet gilt der Server-Katalog (maßgeblich, inkl. Fremd-Anbieter);
			 * ohne Anmeldung oder bei unerreichbarem Dienst zeigt der lokale Katalog
			 * dasselbe Angebot, damit die Auswahl nie leer dasteht. Die Anmeldung
			 * verlangt der Chat selbst (Dialog beim ersten Senden) – ein Platzhalter
			 * „Anmelden erforderlich“ im Modell-Picker war der falsche Ort dafür.
			 */
			async provideLanguageModelChatInformation(_options, _token) {
				const toEntry = (m) => ({
					id: m.id,
					name: m.label || m.id,
					family: MODEL_VENDOR,
					version: '1.0',
					// Echte Werte aus dem Katalog – daraus rendert die Modellkarte ihr
					// „Max context“; Rückfall konservativ, falls ein Eintrag sie nicht trägt.
					maxInputTokens: Number.isFinite(m.maxInputTokens) ? m.maxInputTokens : 200000,
					maxOutputTokens: Number.isFinite(m.maxOutputTokens) ? m.maxOutputTokens : 64000,
					// toolCalling MUSS true sein: Agent-Modus (und Inline-Chat) filtern den
					// Picker auf diese Fähigkeit (languageModels.ts suitableForAgentMode) –
					// mit false bliebe die Liste leer. imageInput je Modell (das Vision-
					// Gating macht der Dienst; hier steuert es nur die UI-Anzeige).
					capabilities: { toolCalling: true, imageInput: m.vision === true },
					detail: modelDetail(m),
					tooltip: modelTooltip(m)
				});
				try {
					if (provider.auth && await provider.auth.isSignedIn()) {
						const models = await provider._proxyModels();
						if (Array.isArray(models) && models.length > 0) {
							return models.map(toEntry);
						}
					}
				} catch (err) {
					logger.warn('Nativer Chat: Modell-Katalog vom Dienst nicht abrufbar – lokale Liste.', err);
				}
				// Rückfall: kuratierte Liste aus dem Build (lib/modelCatalog.js).
				return pickerModels().map(toEntry);
			},

			async provideLanguageModelChatResponse(model, messages, _options, progress, token) {
				const abort = new AbortController();
				const cancellation = token.onCancellationRequested(() => abort.abort());
				try {
					const client = await provider.buildClient(model.id);
					const contents = lmMessagesToContents(messages);
					await streamAskResponse(client, { contents }, abort.signal, (t) => {
						progress.report(new vscode.LanguageModelTextPart(t));
					});
				} finally {
					cancellation.dispose();
				}
			},

			/** Grobe Schätzung (~4 Zeichen/Token) – reicht für die Kontext-Anzeige der UI. */
			async provideTokenCount(_model, text, _token) {
				if (typeof text === 'string') { return Math.ceil(text.length / 4); }
				const parts = text && Array.isArray(text.content) ? text.content : [];
				const chars = parts.reduce((n, p) => n + (p && typeof p.value === 'string' ? p.value.length : 0), 0);
				return Math.ceil(chars / 4);
			}
		});
		context.subscriptions.push(disposable);
		logger.info(`Nativer Chat: Modell-Provider registriert (Vendor "${MODEL_VENDOR}").`);
		// Katalog vorwärmen: Die Chat-UI zeigt beim Start ihre GEMERKTE Modell-Liste und
		// fragt den Provider erst bei Bedarf – mit warmem Cache liefert die erste Abfrage
		// dann sofort den frischen Server-Stand statt in den 5s-Timeout zu laufen
		// (Befund 28.07.: alte Liste blieb nach Katalogwechsel bis zur ersten Nachricht sichtbar).
		setTimeout(() => {
			Promise.resolve()
				.then(async () => {
					if (provider.auth && await provider.auth.isSignedIn()) { await provider._proxyModels(); }
				})
				.catch(() => { /* Vorwärmen ist Komfort – Fehler zeigt ggf. die echte Abfrage */ });
		}, 3000);
		return true;
	} catch (err) {
		logger.warn('Nativer Chat: Modell-Provider-Registrierung nicht möglich.', err);
		return false;
	}
}

module.exports = {
	registerNativeChat,
	AGENT_PARTICIPANT_ID,
	MODEL_VENDOR
};
