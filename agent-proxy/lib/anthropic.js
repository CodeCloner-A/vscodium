/*---------------------------------------------------------------------------------------------
 * VSCodium Agent Proxy – Format-Übersetzer für Anthropic-Claude über Vertex AI MaaS.
 *
 * Der Client spricht ausschließlich das Gemini-generateContent-Format; dieser Layer
 * übersetzt Requests in das Anthropic-Messages-Format (rawPredict/streamRawPredict,
 * Pflichtfelder anthropic_version und max_tokens, kein model-Feld) und Antworten
 * zurück ins Gemini-Format – inklusive usageMetadata, damit Metering (server.js:
 * extractUsage/createUsageScanner) und der Client-SSE-Parser unverändert funktionieren.
 *
 * Bewusste Entscheidungen (v1):
 *  - thinking: {type:"disabled"} wird IMMER gesetzt. Ohne das Feld liefe Sonnet 5
 *    adaptiv und produzierte thinking-Blöcke, die beim Tool-Roundtrip signiert und
 *    unverändert zurückgereicht werden müssten – das kann die Gemini-Historie des
 *    Clients nicht verlustfrei transportieren (400-Risiko bei Tool-Fortsetzungen).
 *  - generationConfig (temperature/topP/topK) wird NIE weitergereicht: Auf Opus 4.8
 *    und Sonnet 5 sind Sampling-Parameter entfernt (400 bei Nicht-Default-Werten).
 *  - thought-Parts und thoughtSignature-Felder aus Gemini-Sitzungen werden gedroppt
 *    (Modellwechsel Gemini→Claude innerhalb einer Sitzung darf nicht scheitern).
 *--------------------------------------------------------------------------------------------*/

'use strict';

const { StringDecoder } = require('string_decoder');

const ANTHROPIC_VERSION = 'vertex-2023-10-16';
// Anthropic verlangt max_tokens; der Agent-Chat setzt kein maxOutputTokens. 32k lässt
// Raum für lange Antworten, bleibt aber deutlich unter dem 300-s-Cloud-Run-Timeout.
const DEFAULT_MAX_TOKENS = 32768;

// Anthropic stop_reason → Gemini finishReason. Bei Tool-Aufrufen MUSS 'STOP' herauskommen,
// sonst behandelt der Client die Antwort als Fehler (extractBlockReason akzeptiert nur
// STOP/MAX_TOKENS). 'refusal' wird als SAFETY sichtbar gemacht.
const STOP_REASON_MAP = {
	end_turn: 'STOP',
	tool_use: 'STOP',
	stop_sequence: 'STOP',
	pause_turn: 'STOP',
	max_tokens: 'MAX_TOKENS',
	refusal: 'SAFETY'
};

function mapStopReason(reason) {
	if (!reason) { return 'STOP'; }
	return STOP_REASON_MAP[reason] || 'OTHER';
}

function httpError(status, message) {
	return Object.assign(new Error(message), { status });
}

/** Gemini-Tool-Schema (OpenAPI-Subset, Typen in GROSSBUCHSTABEN) → JSON Schema (lowercase). */
function toJsonSchema(schema) {
	if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
		return { type: 'object', properties: {} };
	}
	const out = {};
	for (const [key, value] of Object.entries(schema)) {
		if (key === 'type' && typeof value === 'string') {
			out.type = value.toLowerCase();
		} else if (key === 'properties' && value && typeof value === 'object') {
			out.properties = {};
			for (const [name, sub] of Object.entries(value)) {
				out.properties[name] = toJsonSchema(sub);
			}
		} else if (key === 'items') {
			out.items = toJsonSchema(value);
		} else {
			out[key] = value; // description, required, enum, …
		}
	}
	if (out.type === 'object' && !out.properties) { out.properties = {}; }
	return out;
}

/** systemInstruction ({role?, parts:[{text}]} oder String) → Anthropic-system-String. */
function systemText(systemInstruction) {
	if (!systemInstruction) { return ''; }
	if (typeof systemInstruction === 'string') { return systemInstruction; }
	const parts = Array.isArray(systemInstruction.parts) ? systemInstruction.parts : [];
	return parts.map(p => (typeof p.text === 'string' ? p.text : '')).filter(Boolean).join('\n');
}

/**
 * Gemini-generateContent-Body → Anthropic-Messages-Body.
 *
 * Tool-Aufrufe: Gemini kennt keine IDs (Match per Name/Reihenfolge), Anthropic verlangt
 * tool_use.id ↔ tool_result.tool_use_id – aber nur konsistent INNERHALB eines Requests.
 * Da beide Seiten hier im selben Durchlauf aus der Historie synthetisiert werden, genügen
 * deterministische IDs; functionResponses ziehen per FIFO den ältesten offenen Aufruf
 * gleichen Namens.
 */
function toAnthropicRequest(gemini, { maxTokensDefault = DEFAULT_MAX_TOKENS, stream = false } = {}) {
	const messages = [];
	/** offene tool_use-Aufrufe: {name, id} in Reihenfolge des Auftretens */
	const pending = [];

	const contents = Array.isArray(gemini && gemini.contents) ? gemini.contents : [];
	contents.forEach((content, ci) => {
		const role = content && content.role === 'model' ? 'assistant' : 'user';
		const blocks = [];
		const parts = Array.isArray(content && content.parts) ? content.parts : [];
		parts.forEach((part, pi) => {
			if (part && part.functionCall && part.functionCall.name) {
				const id = `toolu_${ci}_${pi}`;
				pending.push({ name: part.functionCall.name, id });
				blocks.push({ type: 'tool_use', id, name: part.functionCall.name, input: part.functionCall.args || {} });
				return;
			}
			if (part && part.functionResponse && part.functionResponse.name) {
				let idx = pending.findIndex(p => p.name === part.functionResponse.name);
				if (idx === -1) { idx = 0; } // Fallback: ältester offener Aufruf (Namens-Drift)
				const match = pending[idx];
				if (!match) {
					throw httpError(400, `functionResponse ohne vorangehenden functionCall: ${part.functionResponse.name}`);
				}
				pending.splice(idx, 1);
				const payload = part.functionResponse.response === undefined ? null : part.functionResponse.response;
				blocks.push({ type: 'tool_result', tool_use_id: match.id, content: JSON.stringify(payload) });
				return;
			}
			// thought-Parts (inkl. thoughtSignature) und leere Texte droppen – Anthropic
			// lehnt leere text-Blöcke ab, und Gemini-Signaturen sind dort wertlos.
			if (part && typeof part.text === 'string' && !part.thought && part.text.trim().length > 0) {
				blocks.push({ type: 'text', text: part.text });
			}
		});
		if (blocks.length > 0) {
			// Aufeinanderfolgende gleiche Rollen sind bei Anthropic erlaubt (werden zu
			// einem Turn zusammengefasst) – z. B. Tool-Ergebnisse + Drift-Reminder.
			messages.push({ role, content: blocks });
		}
	});

	// Unbeantwortete Tool-Aufrufe entfernen: Bricht der Nutzer einen Lauf mitten in der
	// Tool-Ausführung ab, bleibt in der Gemini-Historie ein functionCall ohne
	// functionResponse zurück (agentController stoppt vor dem Antwort-Push). Gemini
	// toleriert das – Anthropic lehnt tool_use ohne tool_result mit 400 ab und würde
	// damit JEDE Folgeanfrage der Sitzung blockieren.
	if (pending.length > 0) {
		const unanswered = new Set(pending.map(p => p.id));
		for (let i = messages.length - 1; i >= 0; i--) {
			messages[i].content = messages[i].content.filter(b => !(b.type === 'tool_use' && unanswered.has(b.id)));
			if (messages[i].content.length === 0) { messages.splice(i, 1); }
		}
	}

	if (messages.length === 0) {
		throw httpError(400, 'Leerer Request: contents ohne verwertbare Inhalte.');
	}

	const generationConfig = (gemini && gemini.generationConfig) || {};
	const request = {
		anthropic_version: ANTHROPIC_VERSION,
		max_tokens: Number.isFinite(generationConfig.maxOutputTokens) && generationConfig.maxOutputTokens > 0
			? generationConfig.maxOutputTokens
			: maxTokensDefault,
		thinking: { type: 'disabled' },
		messages
	};

	const system = systemText(gemini && gemini.systemInstruction);
	if (system) { request.system = system; }

	const declarations = (Array.isArray(gemini && gemini.tools) ? gemini.tools : [])
		.flatMap(t => (Array.isArray(t && t.functionDeclarations) ? t.functionDeclarations : []));
	if (declarations.length > 0) {
		request.tools = declarations.map(d => ({
			name: d.name,
			description: d.description || '',
			input_schema: toJsonSchema(d.parameters)
		}));
	}
	// toolConfig mode 'AUTO' ist der Anthropic-Default (tool_choice weglassen);
	// andere Modi nutzt der Client nicht.

	if (stream) { request.stream = true; }
	return request;
}

/** Anthropic-usage → Gemini-usageMetadata (Feldnamen, die das Metering liest). */
function toUsageMetadata(inputTokens, outputTokens) {
	const promptTokenCount = Number.isFinite(inputTokens) ? inputTokens : 0;
	const candidatesTokenCount = Number.isFinite(outputTokens) ? outputTokens : 0;
	return { promptTokenCount, candidatesTokenCount, totalTokenCount: promptTokenCount + candidatesTokenCount };
}

/** Anthropic-Messages-Antwort (nicht gestreamt) → Gemini-generateContent-Antwort. */
function toGeminiResponse(anthropic) {
	const parts = [];
	for (const block of Array.isArray(anthropic && anthropic.content) ? anthropic.content : []) {
		if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
			parts.push({ text: block.text });
		} else if (block.type === 'tool_use' && block.name) {
			parts.push({ functionCall: { name: block.name, args: block.input || {} } });
		}
		// thinking/redacted_thinking: nicht durchreichen (extractText würde sie als
		// Antworttext konkatenieren und z. B. Inline-Edit-Ausgaben korrumpieren).
	}
	const usage = (anthropic && anthropic.usage) || {};
	return {
		candidates: [{
			content: { role: 'model', parts },
			finishReason: mapStopReason(anthropic && anthropic.stop_reason)
		}],
		usageMetadata: toUsageMetadata(usage.input_tokens, usage.output_tokens)
	};
}

/**
 * Übersetzt den Anthropic-SSE-Strom (message_start, content_block_delta, …) in
 * Gemini-SSE-Chunks ('data: {candidates,…}\n\n'). Text-Deltas werden sofort emittiert
 * (Streaming-UX), Tool-Aufrufe erst bei content_block_stop (input_json_delta liefert
 * JSON-Bruchstücke, die akkumuliert werden müssen). Der finale Chunk trägt finishReason
 * und usageMetadata – genau das, was Usage-Scanner und Client-Merge erwarten.
 */
function createSseTranslator() {
	const decoder = new StringDecoder('utf8');
	let tail = '';
	let inputTokens = 0;
	let outputTokens = 0;
	let stopReason = 'STOP';
	let done = false;
	/** Block-Index → {name, json} für tool_use-Blöcke im Aufbau */
	const toolBlocks = new Map();

	function frame(obj) {
		return `data: ${JSON.stringify(obj)}\n\n`;
	}

	// Jeder Chunk trägt den aktuell bekannten Zählerstand: Der Usage-Scanner nimmt die
	// LETZTE usageMetadata – bricht der Client den Strom ab, zählen so wenigstens die
	// (bei Opus teuren) Input-Tokens aus message_start ins Kontingent statt gar nichts.
	// Der Client ignoriert usageMetadata in Zwischen-Chunks (mergeStreamResponses liest
	// nur candidates), der finale Chunk trägt die endgültigen Zahlen.
	function partChunk(parts) {
		return frame({
			candidates: [{ content: { role: 'model', parts } }],
			usageMetadata: toUsageMetadata(inputTokens, outputTokens)
		});
	}

	function finalChunk() {
		return frame({
			candidates: [{ content: { role: 'model', parts: [] }, finishReason: stopReason }],
			usageMetadata: toUsageMetadata(inputTokens, outputTokens)
		});
	}

	function handle(event) {
		switch (event.type) {
			case 'message_start': {
				const usage = event.message && event.message.usage;
				if (usage && Number.isFinite(usage.input_tokens)) { inputTokens = usage.input_tokens; }
				if (usage && Number.isFinite(usage.output_tokens)) { outputTokens = usage.output_tokens; }
				return '';
			}
			case 'content_block_start': {
				const block = event.content_block;
				if (block && block.type === 'tool_use') {
					toolBlocks.set(event.index, { name: block.name, json: '' });
				}
				return '';
			}
			case 'content_block_delta': {
				const delta = event.delta || {};
				if (delta.type === 'text_delta' && delta.text) {
					return partChunk([{ text: delta.text }]);
				}
				if (delta.type === 'input_json_delta') {
					const tool = toolBlocks.get(event.index);
					if (tool) { tool.json += delta.partial_json || ''; }
				}
				return ''; // thinking_delta u. Ä. nicht durchreichen
			}
			case 'content_block_stop': {
				const tool = toolBlocks.get(event.index);
				if (!tool) { return ''; }
				toolBlocks.delete(event.index);
				let args = {};
				try {
					args = tool.json.trim() ? JSON.parse(tool.json) : {};
				} catch (_e) {
					// Abgeschnittenes JSON (z. B. max_tokens mitten im Aufruf): Call verwerfen,
					// nie werfen – der finale Chunk trägt dann MAX_TOKENS als finishReason.
					return '';
				}
				return partChunk([{ functionCall: { name: tool.name, args } }]);
			}
			case 'message_delta': {
				if (event.delta && event.delta.stop_reason) { stopReason = mapStopReason(event.delta.stop_reason); }
				const usage = event.usage;
				if (usage && Number.isFinite(usage.output_tokens)) { outputTokens = usage.output_tokens; }
				return '';
			}
			case 'message_stop': {
				done = true;
				return finalChunk();
			}
			case 'error': {
				// Upstream-Fehler mitten im Strom: als OTHER beenden – der Client zeigt
				// "Antwort beendet mit: OTHER" statt still zu hängen.
				stopReason = 'OTHER';
				done = true;
				return finalChunk();
			}
			default:
				return ''; // ping etc.
		}
	}

	return {
		/** @param {Buffer} buffer  @returns {Buffer|null} übersetzte Gemini-SSE-Bytes */
		push(buffer) {
			const lines = (tail + decoder.write(buffer)).split(/\r?\n/);
			tail = lines.pop() || '';
			let out = '';
			for (const line of lines) {
				// SSE erlaubt 'data:' mit und ohne Leerzeichen; event:-Zeilen/Leerzeilen überspringen.
				if (!line.startsWith('data:')) { continue; }
				let event;
				try { event = JSON.parse(line.slice(5).trim()); } catch (_e) { continue; }
				if (!done) { out += handle(event); }
			}
			return out ? Buffer.from(out, 'utf8') : null;
		},
		/** Best-Effort-Abschluss, falls der Strom vor message_stop abreißt. */
		end() {
			if (done) { return null; }
			done = true;
			return Buffer.from(finalChunk(), 'utf8');
		}
	};
}

/**
 * Verpackt die Vertex-Antwort so, dass server.js sie wie eine Gemini-Antwort konsumieren
 * kann: text() liefert übersetztes JSON, body ein Async-Iterable übersetzter SSE-Buffers.
 * Fehlerantworten (!ok) gehen unverändert durch – server.js reicht Status + Text weiter.
 */
function wrapResponse(upstream, { stream = false } = {}) {
	if (!upstream.ok || (stream && !upstream.body)) {
		return upstream;
	}
	if (!stream) {
		return {
			ok: upstream.ok,
			status: upstream.status,
			body: null,
			async text() {
				const raw = await upstream.text();
				try {
					return JSON.stringify(toGeminiResponse(JSON.parse(raw)));
				} catch (_e) {
					return raw; // unparsebar: roh durchreichen, der Client zeigt den Fehler
				}
			}
		};
	}
	const translator = createSseTranslator();
	async function* translated() {
		for await (const piece of upstream.body) {
			const out = translator.push(Buffer.isBuffer(piece) ? piece : Buffer.from(piece));
			if (out) { yield out; }
		}
		const rest = translator.end();
		if (rest) { yield rest; }
	}
	return { ok: upstream.ok, status: upstream.status, body: translated() };
}

module.exports = {
	toAnthropicRequest,
	toGeminiResponse,
	createSseTranslator,
	wrapResponse,
	ANTHROPIC_VERSION,
	DEFAULT_MAX_TOKENS
};
