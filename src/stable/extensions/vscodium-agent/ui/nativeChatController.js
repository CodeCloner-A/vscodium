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
	NO_WORKSPACE_NOTES
} = require('../lib/nativeChat');
const { AgentRun } = require('../lib/agentController');
const { buildSystemPrompt, buildPlanPrompt } = require('../lib/prompts');
const { registerNativeTools, runContexts, NativeRunHost } = require('./nativeTools');

const AGENT_PARTICIPANT_ID = 'vscodium-agent.agent';
const MODEL_VENDOR = 'vscodium-agent';
/** Platzhalter-Modell, das ohne Anmeldung im Picker steht. */
const SIGN_IN_MODEL_ID = 'anmeldung-erforderlich';
/** Marker → Plan-Variante (bewusst explizit statt „alles durchreichen“). */
const PLAN_VARIANTS = new Set(['plan', 'plan-extended']);

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {any} provider  ChatViewProvider (liefert buildClient/config/auth)
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
	context.subscriptions.push(participant);
	deps.logger.info(`Nativer Chat: Default-Participant registriert (${AGENT_PARTICIPANT_ID}, Modus agent; Plan-Modi via agents/*.agent.md).`);
	return true;
}

/** Modell aus der nativen Picker-Auswahl, sofern sie von unserem Provider stammt. */
function pickedModelId(request) {
	return request.model && request.model.vendor === MODEL_VENDOR ? request.model.id : undefined;
}

/** Anmelde-Hinweis mit Button streamen (statt kryptischer Systemmeldungen). */
function streamSignInHint(stream) {
	stream.markdown('**Nicht angemeldet.** Der Agent spricht über den Agent-Proxy mit Gemini & Claude – dafür braucht es dein Google-Konto.\n\n');
	try {
		stream.button({ command: 'vscodiumAgent.signIn', title: 'Mit Google anmelden' });
	} catch (_e) { /* Button ist Komfort – der Text erklärt den Weg. */ }
	stream.markdown('\nDanach die Frage einfach erneut senden.\n');
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
	try {
		if (pickedModelId(request) === SIGN_IN_MODEL_ID) {
			streamSignInHint(stream);
			return {};
		}
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

		const promptCtx = {
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

		const result = await run.run(request.prompt);
		if (result.status === 'completed' && result.summary) {
			stream.markdown(`${result.summary}\n\n`);
		}
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
			 * Proxy-Katalog → Picker-Einträge. Ohne Anmeldung liefern wir einen
			 * Platzhalter: Die UI verlangt zwingend ein Modell pro Request – mit
			 * leerer Liste scheitern Anfragen VOR dem Participant mit „Language
			 * model unavailable“ (Probefahrt-Befund). Über den Platzhalter landet
			 * die Anfrage bei uns und führt freundlich zur Anmeldung.
			 */
			async provideLanguageModelChatInformation(_options, _token) {
				try {
					const signedIn = provider.auth && await provider.auth.isSignedIn();
					if (signedIn) {
						const models = await provider._proxyModels();
						if (Array.isArray(models) && models.length > 0) {
							return models.map((m) => ({
								id: m.id,
								name: m.label || m.id,
								family: MODEL_VENDOR,
								version: '1.0',
								// Der Proxy-Katalog liefert (noch) keine Token-Limits – konservative
								// Platzhalter; die tatsächliche Begrenzung erzwingt der Proxy.
								maxInputTokens: 200000,
								maxOutputTokens: 64000,
								// toolCalling MUSS true sein: Agent-Modus (und Inline-Chat) filtern den
								// Picker auf diese Fähigkeit (languageModels.ts suitableForAgentMode) –
								// mit false ist die Modell-Liste leer und der Chat meldet „Language model
								// unavailable“. Die Modelle KÖNNEN Tools (der Proxy übersetzt Function
								// Calling nativ); die Durchleitung von options.tools in
								// provideLanguageModelChatResponse für FREMDE Konsumenten ist ein
								// späteres Arbeitspaket (unser eigener Agent-Loop nutzt diesen Pfad nicht).
								capabilities: { toolCalling: true, imageInput: false },
								detail: m.region ? `Region: ${m.region}` : undefined,
								tooltip: 'VSCodium Agent-Proxy (Vertex AI)'
							}));
						}
					}
				} catch (err) {
					logger.warn('Nativer Chat: Modell-Katalog für den Picker nicht abrufbar.', err);
				}
				return [{
					id: SIGN_IN_MODEL_ID,
					name: 'Anmelden erforderlich',
					family: MODEL_VENDOR,
					version: '1.0',
					maxInputTokens: 1000,
					maxOutputTokens: 1000,
					capabilities: { toolCalling: true, imageInput: false },
					detail: 'Kommando „Agent: Mit Google anmelden“',
					tooltip: 'Anmelden, um die Gemini- und Claude-Modelle des Agent-Proxys zu laden.'
				}];
			},

			async provideLanguageModelChatResponse(model, messages, _options, progress, token) {
				if (model.id === SIGN_IN_MODEL_ID) {
					throw new Error('Nicht angemeldet – bitte das Kommando „Agent: Mit Google anmelden“ ausführen und erneut senden.');
				}
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
		return true;
	} catch (err) {
		logger.warn('Nativer Chat: Modell-Provider-Registrierung nicht möglich.', err);
		return false;
	}
}

module.exports = {
	registerNativeChat,
	AGENT_PARTICIPANT_ID,
	MODEL_VENDOR,
	SIGN_IN_MODEL_ID
};
