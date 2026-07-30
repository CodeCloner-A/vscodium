/*---------------------------------------------------------------------------------------------
 * VSCodium Agent Proxy – Übersetzung Gemini-Wire-Format ↔ OpenAI-kompatible Chat Completions.
 *
 * Der Client spricht ausschließlich Gemini (`generateContent`). Anbieter außerhalb von
 * Vertex AI (Z.ai GLM, später Moonshot Kimi) bieten die verbreitete OpenAI-Schnittstelle
 * `/chat/completions` – diese Datei übersetzt beide Richtungen verlustfrei:
 *
 *   Request:  systemInstruction → system-Message; contents(user/model) → messages;
 *             functionCall → assistant.tool_calls; functionResponse → role 'tool';
 *             functionDeclarations → tools[type=function] (Schema-Typen kleingeschrieben);
 *             generationConfig.temperature/maxOutputTokens → temperature/max_tokens.
 *   Response: choices[0].message.content → parts[{text}]; tool_calls → parts[{functionCall}];
 *             finish_reason → finishReason; usage → usageMetadata (fürs Metering).
 *   Stream:   OpenAI-SSE-Deltas → Gemini-SSE-Chunks; Tool-Call-Fragmente werden gesammelt
 *             und beim Abschluss als vollständige functionCall-Parts ausgegeben.
 *
 * Bewusste Grenzen: `thinking`/Reasoning-Rückkanäle werden nicht durchgereicht (nicht
 * Gemini-transportierbar, gleiche Entscheidung wie bei Claude); Bilder/Multimodalität
 * folgen mit Roadmap-Phase 5.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const { StringDecoder } = require('string_decoder');

/** finish_reason (OpenAI) → finishReason (Gemini). */
const FINISH_REASON_MAP = {
	stop: 'STOP',
	length: 'MAX_TOKENS',
	tool_calls: 'STOP',
	function_call: 'STOP',
	content_filter: 'SAFETY'
};

function mapFinishReason(reason) {
	if (!reason) { return undefined; }
	return FINISH_REASON_MAP[reason] || 'STOP';
}

function httpError(status, message) {
	const err = new Error(message);
	err.status = status;
	return err;
}

/**
 * Gemini-Parameterschema (OpenAPI-Subset mit GROSSGESCHRIEBENEN Typen) → JSON Schema.
 * Rekursiv, damit auch verschachtelte Objekte/Arrays sauber ankommen.
 */
function toJsonSchema(schema) {
	if (!schema || typeof schema !== 'object') { return { type: 'object', properties: {} }; }
	const out = {};
	for (const [key, value] of Object.entries(schema)) {
		if (key === 'type' && typeof value === 'string') {
			out.type = value.toLowerCase();
		} else if (key === 'properties' && value && typeof value === 'object') {
			out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJsonSchema(v)]));
		} else if (key === 'items') {
			out.items = toJsonSchema(value);
		} else {
			out[key] = value;
		}
	}
	if (out.type === 'object' && !out.properties) { out.properties = {}; }
	return out;
}

/** systemInstruction (String oder {parts:[{text}]}) → einzelner Systemtext. */
function systemText(systemInstruction) {
	if (!systemInstruction) { return ''; }
	if (typeof systemInstruction === 'string') { return systemInstruction; }
	const parts = Array.isArray(systemInstruction.parts) ? systemInstruction.parts : [];
	return parts.map(p => (p && typeof p.text === 'string' ? p.text : '')).join('\n').trim();
}

/** Synthetische, stabile Tool-Call-ID (OpenAI verlangt die Zuordnung Call ↔ Ergebnis). */
function callId(name, index) {
	return `call_${index}_${String(name || 'tool').replace(/[^\w-]/g, '').slice(0, 40)}`;
}

/**
 * Bild-Teile (Gemini `inlineData`) → OpenAI-Content-Blöcke (`image_url` mit Data-URL).
 * Beide Seiten transportieren Base64; unterschiedlich ist nur die Verpackung.
 */
function toImageBlock(part) {
	const data = part && (part.inlineData || part.inline_data);
	if (!data || !data.data) { return null; }
	const mime = data.mimeType || data.mime_type || 'image/png';
	return { type: 'image_url', image_url: { url: `data:${mime};base64,${data.data}` } };
}

/**
 * Ab wie vielen Werkzeugen die dynamische Ladung überhaupt lohnt. Darunter kostet die
 * Umstellung mehr Komplexität als sie Tokens spart (Kimi-Doku: gedacht für große Bestände).
 */
const DYNAMIC_TOOLS_THRESHOLD = 20;

/**
 * Gemini-Request → OpenAI-Chat-Completions-Request.
 * @param {object} gemini
 * @param {{ model: string, stream?: boolean, maxTokensDefault?: number,
 *           capabilities?: object }} options
 */
function toOpenAiRequest(gemini, options) {
	const model = options && options.model;
	if (!model) { throw httpError(500, 'Modellname fehlt.'); }
	// Fähigkeiten des Zielmodells: nur senden, was es versteht (Default: alles Gängige an,
	// Sonderfunktionen aus – siehe DEFAULT_CAPABILITIES in lib/catalog.js).
	const caps = {
		temperature: true, topP: true, toolChoice: true, streamUsage: true,
		dynamicTools: false, vision: false,
		...((options && options.capabilities) || {})
	};
	if (!gemini || typeof gemini !== 'object') { throw httpError(400, 'Request-Body fehlt.'); }
	const contents = Array.isArray(gemini.contents) ? gemini.contents : [];
	if (contents.length === 0) { throw httpError(400, 'contents fehlt oder ist leer.'); }

	const messages = [];
	const system = systemText(gemini.systemInstruction);
	if (system) { messages.push({ role: 'system', content: system }); }

	let toolIndex = 0;
	// Merker: functionResponse-Parts müssen die ID des zugehörigen Aufrufs tragen.
	const pendingIds = new Map(); // name → letzte vergebene ID

	for (const content of contents) {
		if (!content || typeof content !== 'object') { continue; }
		const parts = Array.isArray(content.parts) ? content.parts : [];
		const role = content.role === 'model' ? 'assistant' : 'user';

		const texts = [];
		const toolCalls = [];
		const toolResults = [];
		const images = [];

		for (const part of parts) {
			if (!part || typeof part !== 'object') { continue; }
			if (typeof part.text === 'string' && part.text.length > 0 && !part.thought) {
				texts.push(part.text);
			} else if (part.inlineData || part.inline_data) {
				// Bilder nur an Modelle schicken, die sie verstehen – sonst kommentarlos weglassen
				// (ein 400 mitten im Agent-Lauf wäre die schlechtere Antwort).
				const block = caps.vision ? toImageBlock(part) : null;
				if (block) { images.push(block); }
			} else if (part.functionCall && part.functionCall.name) {
				const id = callId(part.functionCall.name, toolIndex++);
				pendingIds.set(part.functionCall.name, id);
				toolCalls.push({
					id,
					type: 'function',
					function: {
						name: part.functionCall.name,
						arguments: JSON.stringify(part.functionCall.args || {})
					}
				});
			} else if (part.functionResponse && part.functionResponse.name) {
				const name = part.functionResponse.name;
				toolResults.push({
					role: 'tool',
					tool_call_id: pendingIds.get(name) || callId(name, toolIndex++),
					content: JSON.stringify(part.functionResponse.response === undefined ? {} : part.functionResponse.response)
				});
			}
		}

		// Mit Bildern wird der Inhalt zur Blockliste (Text zuerst), sonst bleibt es ein String.
		const messageContent = images.length > 0
			? [...(texts.length > 0 ? [{ type: 'text', text: texts.join('\n') }] : []), ...images]
			: texts.join('\n');
		const hasContent = images.length > 0 || texts.length > 0;

		if (role === 'assistant' && toolCalls.length > 0) {
			messages.push({ role: 'assistant', content: hasContent ? messageContent : null, tool_calls: toolCalls });
		} else if (toolResults.length > 0) {
			// Tool-Ergebnisse sind eigene Nachrichten; begleitender Text (selten) davor.
			if (hasContent) { messages.push({ role, content: messageContent }); }
			messages.push(...toolResults);
		} else if (hasContent) {
			messages.push({ role, content: messageContent });
		}
	}

	if (messages.filter(m => m.role !== 'system').length === 0) {
		throw httpError(400, 'Keine verwertbaren Nachrichten im Request.');
	}

	const out = { model, messages };

	const declarations = Array.isArray(gemini.tools)
		? gemini.tools.flatMap(t => (t && Array.isArray(t.functionDeclarations) ? t.functionDeclarations : []))
		: [];
	if (declarations.length > 0) {
		const toolDefs = declarations.map(d => ({
			type: 'function',
			function: {
				name: d.name,
				description: d.description || '',
				parameters: toJsonSchema(d.parameters)
			}
		}));
		// Große Werkzeug-Bestände können nachgeladen werden: Statt alles im Kopf der
		// Anfrage zu deklarieren, hängt eine `system`-Nachricht mit `tools` am ENDE der
		// Nachrichtenliste (Kimi K3). Vorteil laut Anbieter-Doku: Der gecachte Präfix
		// bleibt unberührt. Unterhalb der Schwelle bleibt alles beim Top-Level-Feld –
		// die Umstellung lohnt erst bei vielen Werkzeugen (z. B. später über MCP).
		if (caps.dynamicTools && toolDefs.length >= DYNAMIC_TOOLS_THRESHOLD) {
			// Achtung (Anbieter-Regel): so eine Nachricht darf KEIN content-Feld tragen.
			messages.push({ role: 'system', tools: toolDefs });
		} else {
			out.tools = toolDefs;
		}
		if (caps.toolChoice) {
			const mode = gemini.toolConfig && gemini.toolConfig.functionCallingConfig && gemini.toolConfig.functionCallingConfig.mode;
			out.tool_choice = mode === 'NONE' ? 'none' : mode === 'ANY' ? 'required' : 'auto';
		}
	}

	const cfg = gemini.generationConfig || {};
	if (caps.temperature && Number.isFinite(cfg.temperature)) { out.temperature = cfg.temperature; }
	if (caps.topP && Number.isFinite(cfg.topP)) { out.top_p = cfg.topP; }
	const maxTokens = Number.isFinite(cfg.maxOutputTokens) ? cfg.maxOutputTokens : (options && options.maxTokensDefault);
	if (Number.isFinite(maxTokens)) { out.max_tokens = maxTokens; }

	if (options && options.stream) {
		out.stream = true;
		// Nur so liefert der Anbieter am Stream-Ende die Token-Zahlen – ohne sie
		// zählt das Metering den Lauf nicht (Quote liefe ins Leere).
		if (caps.streamUsage) { out.stream_options = { include_usage: true }; }
	}
	return out;
}

/** OpenAI-usage → Gemini-usageMetadata (Feldnamen wie im Metering erwartet). */
function toUsageMetadata(usage) {
	if (!usage || typeof usage !== 'object') { return undefined; }
	const prompt = Number(usage.prompt_tokens) || 0;
	const completion = Number(usage.completion_tokens) || 0;
	const total = Number(usage.total_tokens) || prompt + completion;
	return { promptTokenCount: prompt, candidatesTokenCount: completion, totalTokenCount: total };
}

/** message.tool_calls → Gemini-functionCall-Parts (unparsebare Argumente werden gerettet). */
function toolCallParts(toolCalls) {
	const parts = [];
	for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
		const fn = call && call.function;
		if (!fn || !fn.name) { continue; }
		let args = {};
		if (typeof fn.arguments === 'string' && fn.arguments.trim()) {
			try { args = JSON.parse(fn.arguments); } catch (_e) { args = { _raw: fn.arguments }; }
		} else if (fn.arguments && typeof fn.arguments === 'object') {
			args = fn.arguments;
		}
		parts.push({ functionCall: { name: fn.name, args } });
	}
	return parts;
}

/** OpenAI-Antwort → Gemini-Antwort. */
function toGeminiResponse(openai) {
	const choice = openai && Array.isArray(openai.choices) ? openai.choices[0] : null;
	const message = (choice && choice.message) || {};
	const parts = [];
	if (typeof message.content === 'string' && message.content.length > 0) {
		parts.push({ text: message.content });
	} else if (Array.isArray(message.content)) {
		// Manche Anbieter liefern Content-Blöcke statt String.
		const text = message.content.map(c => (c && typeof c.text === 'string' ? c.text : '')).join('');
		if (text) { parts.push({ text }); }
	}
	parts.push(...toolCallParts(message.tool_calls));

	const candidate = { content: { role: 'model', parts } };
	const finishReason = mapFinishReason(choice && choice.finish_reason);
	if (finishReason) { candidate.finishReason = finishReason; }

	const out = { candidates: [candidate] };
	const usage = toUsageMetadata(openai && openai.usage);
	if (usage) { out.usageMetadata = usage; }
	return out;
}

/**
 * SSE-Übersetzer: OpenAI-Deltas → Gemini-Chunks.
 * Tool-Call-Fragmente (Name/Argumente kommen häppchenweise) werden je Index gesammelt
 * und beim Abschluss als vollständige functionCall-Parts ausgegeben.
 */
function createSseTranslator() {
	const decoder = new StringDecoder('utf8');
	let buffer = '';
	const toolAcc = new Map(); // index → { name, args }
	let sawUsage = false;

	function geminiChunk(parts, extra) {
		const candidate = { content: { role: 'model', parts } };
		if (extra && extra.finishReason) { candidate.finishReason = extra.finishReason; }
		const payload = { candidates: [candidate] };
		if (extra && extra.usageMetadata) { payload.usageMetadata = extra.usageMetadata; }
		return `data: ${JSON.stringify(payload)}\n\n`;
	}

	function flushToolCalls() {
		if (toolAcc.size === 0) { return []; }
		const parts = [];
		for (const acc of [...toolAcc.values()]) {
			if (!acc.name) { continue; }
			let args = {};
			if (acc.args && acc.args.trim()) {
				try { args = JSON.parse(acc.args); } catch (_e) { args = { _raw: acc.args }; }
			}
			parts.push({ functionCall: { name: acc.name, args } });
		}
		toolAcc.clear();
		return parts;
	}

	function handleEvent(dataLine) {
		const raw = dataLine.slice(5).trim(); // "data:" entfernen
		if (!raw) { return ''; }
		if (raw === '[DONE]') {
			const parts = flushToolCalls();
			return parts.length > 0 ? geminiChunk(parts, { finishReason: 'STOP' }) : '';
		}
		let event;
		try { event = JSON.parse(raw); } catch (_e) { return ''; }

		let out = '';
		const choice = Array.isArray(event.choices) ? event.choices[0] : null;
		const delta = (choice && choice.delta) || {};

		if (typeof delta.content === 'string' && delta.content.length > 0) {
			out += geminiChunk([{ text: delta.content }]);
		}
		for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
			const index = Number.isFinite(call.index) ? call.index : 0;
			const acc = toolAcc.get(index) || { name: '', args: '' };
			if (call.function && call.function.name) { acc.name = call.function.name; }
			if (call.function && typeof call.function.arguments === 'string') { acc.args += call.function.arguments; }
			toolAcc.set(index, acc);
		}

		const finishReason = mapFinishReason(choice && choice.finish_reason);
		const usageMetadata = toUsageMetadata(event.usage);
		if (usageMetadata) { sawUsage = true; }

		if (finishReason || usageMetadata) {
			const parts = flushToolCalls();
			out += geminiChunk(parts, { finishReason, usageMetadata });
		}
		return out;
	}

	return {
		push(chunk) {
			buffer += decoder.write(chunk);
			let out = '';
			let newline;
			while ((newline = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line.startsWith('data:')) { out += handleEvent(line); }
			}
			return out;
		},
		end() {
			buffer += decoder.end();
			let out = '';
			const line = buffer.trim();
			buffer = '';
			if (line.startsWith('data:')) { out += handleEvent(line); }
			const parts = flushToolCalls();
			if (parts.length > 0) { out += geminiChunk(parts, { finishReason: 'STOP' }); }
			return out;
		},
		/** Für Tests/Diagnose: kam am Stream-Ende eine Token-Abrechnung an? */
		get sawUsage() { return sawUsage; }
	};
}

/** Antwort des Anbieters in Gemini-Form bringen (wie lib/anthropic.js wrapResponse). */
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

/**
 * Client für OpenAI-kompatible Anbieter (Z.ai GLM, später Moonshot Kimi).
 * Gleiches Interface wie createVertexClient: call(model, task, body, { stream, signal }).
 *
 * @param {{ baseUrl: string, apiKey: string, fetchImpl?: typeof fetch,
 *           maxTokensDefault?: number, headers?: object }} options
 */
function createOpenAiClient(options) {
	const baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
	if (!baseUrl) { throw new Error('baseUrl erforderlich.'); }
	const apiKey = options.apiKey;
	if (!apiKey) { throw new Error('apiKey erforderlich.'); }
	const fetchImpl = options.fetchImpl || fetch;
	const maxTokensDefault = options.maxTokensDefault;
	const extraHeaders = options.headers || {};

	async function call(model, task, body, { stream = false, signal } = {}) {
		// Übersetzung VOR dem Netz-Weg: Validierungsfehler kosten keinen Upstream-Aufruf.
		const upstreamBody = toOpenAiRequest(body, {
			model: model.upstreamId || model.id,
			stream,
			maxTokensDefault,
			capabilities: model.capabilities
		});
		const response = await fetchImpl(`${baseUrl}/chat/completions`, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
				'Accept': stream ? 'text/event-stream' : 'application/json',
				...extraHeaders
			},
			body: JSON.stringify(upstreamBody),
			signal
		});
		return wrapResponse(response, { stream });
	}

	return { call };
}

module.exports = {
	DYNAMIC_TOOLS_THRESHOLD,
	toImageBlock,
	toOpenAiRequest,
	toGeminiResponse,
	toUsageMetadata,
	toJsonSchema,
	createSseTranslator,
	wrapResponse,
	createOpenAiClient,
	FINISH_REASON_MAP
};
