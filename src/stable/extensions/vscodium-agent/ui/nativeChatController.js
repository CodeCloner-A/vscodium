/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – Glue für den nativen Core-Chat (Roadmap Phase K).
 *
 * Registriert (1) DREI Default-ChatParticipants – einen pro Modus (ask/edit/agent),
 * dem Muster der Core-Setup-Agents folgend, denn der Modus steht NICHT im Request
 * (Beleg in docs/phase-k-verdrahtung.md) –, (2) die Agent-Tools als native
 * LanguageModelTools (ui/nativeTools.js) und (3) einen LanguageModelChatProvider,
 * der das Proxy-Angebot in den nativen Modell-Picker speist.
 *
 * Modus-Verhalten:
 *   ask    – Fragen beantworten, keine Tools (Streaming über den Agent-Proxy).
 *   edit   – Agent-Loop mit Lese-/Edit-Tools; Datei-Edits laufen als textEdit-Parts
 *            ins native Chat-Editing (Multi-File-Review).
 *   agent  – voller Agent-Loop mit allen Tools; Freigaben rendert der Core aus den
 *            confirmationMessages der Tools (Review-Modus), Auto-Modus fragt nicht.
 *
 * Läuft nur auf dem gepatchten Fork rund: `isDefault`/`modes` brauchen das Proposal
 * `defaultChatParticipant`, textEdit-/workspaceEdit-Streams `chatParticipantAdditions`
 * (beide in der product.json des Builds freigeschaltet). Auf fremden Basen scheitern
 * die Registrierungen kontrolliert – die Webview bleibt alleiniger Träger.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const vscode = require('vscode');
const {
	buildAskRequest,
	simplifyHistory,
	historyToContents,
	lmMessagesToContents,
	streamAskResponse,
	declarationsForMode,
	toolsMapToNames,
	parseToolResultText,
	lmResultToText,
	buildNativeModeNotes
} = require('../lib/nativeChat');
const { AgentRun } = require('../lib/agentController');
const { buildSystemPrompt } = require('../lib/prompts');
const { registerNativeTools, runContexts, NativeRunHost } = require('./nativeTools');

const PARTICIPANT_ID = 'vscodium-agent.default';
const EDIT_PARTICIPANT_ID = 'vscodium-agent.edit';
const AGENT_PARTICIPANT_ID = 'vscodium-agent.agent';
const MODEL_VENDOR = 'vscodium-agent';

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

	const specs = [
		{ id: PARTICIPANT_ID, mode: 'ask' },
		{ id: EDIT_PARTICIPANT_ID, mode: 'edit' },
		{ id: AGENT_PARTICIPANT_ID, mode: 'agent' }
	];
	let participants = 0;
	for (const spec of specs) {
		if (registerParticipant(context, deps, spec)) { participants++; }
	}
	const modelProvider = participants > 0 ? registerModelProvider(context, provider, logger) : false;
	return { participants, tools: deps.toolCount, modelProvider };
}

// ── Default-ChatParticipants (ein Participant pro Modus) ────────────────────

function registerParticipant(context, deps, spec) {
	if (!vscode.chat || typeof vscode.chat.createChatParticipant !== 'function') {
		deps.logger.info('Nativer Chat: chat-API nicht verfügbar – Webview bleibt alleiniger Träger.');
		return false;
	}
	let participant;
	try {
		participant = vscode.chat.createChatParticipant(spec.id, (request, chatContext, stream, token) =>
			spec.mode === 'ask'
				? handleAskRequest(deps, request, chatContext, stream, token)
				: handleAgentRequest(deps, spec.mode, request, chatContext, stream, token)
		);
	} catch (err) {
		// Erwartbar auf Basen ohne Proposal-Freischaltung (die chatParticipants-
		// Contribution wurde dann verworfen) – kein Nutzerfehler, nur protokollieren.
		deps.logger.warn(`Nativer Chat: Registrierung von ${spec.id} nicht möglich – Webview bleibt alleiniger Träger.`, err);
		return false;
	}
	try {
		participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'agent.svg');
	} catch (_e) { /* Icon ist optional */ }
	context.subscriptions.push(participant);
	deps.logger.info(`Nativer Chat: Default-Participant registriert (${spec.id}, Modus ${spec.mode}).`);
	return true;
}

/** Modell aus der nativen Picker-Auswahl, sofern sie von unserem Provider stammt. */
function pickedModelId(request) {
	return request.model && request.model.vendor === MODEL_VENDOR ? request.model.id : undefined;
}

async function buildClientOrExplain(provider, request, stream) {
	try {
		return await provider.buildClient(pickedModelId(request));
	} catch (err) {
		stream.markdown(`**Nicht verbunden:** ${err.message}${err.hint ? `\n\n_${err.hint}_` : ''}`);
		return null;
	}
}

// ── Ask-Modus: erklären, nicht ändern ────────────────────────────────────────

async function handleAskRequest(deps, request, chatContext, stream, token) {
	const { provider, activity, logger } = deps;
	const abort = new AbortController();
	const cancellation = token.onCancellationRequested(() => abort.abort());
	try {
		const client = await buildClientOrExplain(provider, request, stream);
		if (!client) { return {}; }

		const host = provider.getHost();
		const fileTree = await Promise.resolve(host.listProjectFiles()).catch(() => '');
		let activitySummary = '';
		try {
			activitySummary = typeof host.activityCallback === 'function'
				? String(host.activityCallback() || '')
				: (activity ? String(activity.summary(8, 0) || '') : '');
		} catch (_e) { /* Aktivität ist optionaler Kontext */ }

		const workspaceFolder = (vscode.workspace.workspaceFolders || [])[0];
		const geminiRequest = buildAskRequest(
			{
				rootName: host.rootName || (workspaceFolder ? workspaceFolder.name : ''),
				platform: process.platform,
				today: new Date().toISOString().slice(0, 10),
				fileTree,
				activity: activitySummary
			},
			simplifyHistory(chatContext && chatContext.history),
			request.prompt
		);

		await streamAskResponse(client, geminiRequest, abort.signal, (t) => stream.markdown(t));
		return {};
	} catch (err) {
		if (abort.signal.aborted) { return {}; }
		logger.error('Nativer Chat: Anfrage fehlgeschlagen', err);
		stream.markdown(`**Fehler:** ${err.message}${err.hint ? `\n\n_${err.hint}_` : ''}`);
		return { errorDetails: { message: String(err.message || err) } };
	} finally {
		cancellation.dispose();
	}
}

// ── Agent-/Edit-Modus: der Agent-Loop hinter der nativen Oberfläche ─────────

async function handleAgentRequest(deps, mode, request, chatContext, stream, token) {
	const { provider, activity, logger } = deps;
	const abort = new AbortController();
	const cancellation = token.onCancellationRequested(() => abort.abort());
	let exitRun = null;
	try {
		if (deps.toolCount === 0) {
			stream.markdown('**Native Tools nicht verfügbar** – dieser Build kann den Agent-Modus im nativen Chat nicht ausführen. Bitte die Agent-Ansicht (Seitenleiste) verwenden.');
			return { errorDetails: { message: 'Native Tools nicht registriert.' } };
		}
		const client = await buildClientOrExplain(provider, request, stream);
		if (!client) { return {}; }

		const cfg = provider.config();
		const host = new NativeRunHost(stream, {
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

		const fileTree = await Promise.resolve(host.listProjectFiles(cfg.maxTreeEntries)).catch(() => '');
		let activitySummary;
		try {
			activitySummary = activity ? String(activity.summary(8, 0) || '') : undefined;
		} catch (_e) { activitySummary = undefined; }

		const systemPrompt = [
			buildSystemPrompt({
				rootName: host.rootName,
				platform: `${process.platform} (${process.arch})`,
				fileTree,
				approvalMode: cfg.approvalMode,
				shell: process.platform === 'win32' ? 'cmd/PowerShell' : 'sh',
				activity: activitySummary,
				today: new Date().toLocaleDateString('de-DE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
			}),
			buildNativeModeNotes(mode)
		].join('\n\n');

		logger.info(`Nativer ${mode}-Lauf gestartet (Modell: ${client.model}, Freigaben: ${cfg.approvalMode}).`);
		const run = new AgentRun({
			client,
			host,
			systemPrompt,
			maxIterations: cfg.maxIterations,
			signal: abort.signal,
			history: historyToContents(simplifyHistory(chatContext && chatContext.history)),
			toolDeclarations: declarationsForMode(mode, toolsMapToNames(request.tools)),
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
		logger.info(`Nativer ${mode}-Lauf beendet (Status: ${result.status}, gestreamte Edits: ${host.streamedEdits.size}).`);
		return result.status === 'error'
			? { errorDetails: { message: result.summary || 'Agent-Lauf fehlgeschlagen.' } }
			: {};
	} catch (err) {
		if (abort.signal.aborted || token.isCancellationRequested) { return {}; }
		logger.error(`Nativer ${mode}-Lauf fehlgeschlagen`, err);
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
			/** Proxy-Katalog → Picker-Einträge; ohne Anmeldung leer (kein Login-Prompt von hier). */
			async provideLanguageModelChatInformation(_options, _token) {
				try {
					if (!provider.auth || !await provider.auth.isSignedIn()) { return []; }
					const models = await provider._proxyModels();
					if (!Array.isArray(models)) { return []; }
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
				} catch (err) {
					logger.warn('Nativer Chat: Modell-Katalog für den Picker nicht abrufbar.', err);
					return [];
				}
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
		return true;
	} catch (err) {
		logger.warn('Nativer Chat: Modell-Provider-Registrierung nicht möglich.', err);
		return false;
	}
}

module.exports = {
	registerNativeChat,
	PARTICIPANT_ID,
	EDIT_PARTICIPANT_ID,
	AGENT_PARTICIPANT_ID,
	MODEL_VENDOR
};
