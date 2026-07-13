/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – Gemini-Wire-Format-Helfer (SSE-Parser, Antwort-Auswertung).
 *
 * Bis v0.8.0 lebte hier der direkte BYOK-Client gegen Firebase AI Logic
 * (FirebaseAiLogicClient, Auth per x-goog-api-key). Mit dem BYOK-Rückbau (v0.9.0)
 * läuft ALLER Modellverkehr über lib/proxyClient.js – geblieben sind die geteilten
 * Helfer für das Gemini-Antwortformat, die Proxy-Client, Agent-Loop und Inline-Edit
 * gemeinsam nutzen.
 *--------------------------------------------------------------------------------------------*/

'use strict';

/**
 * Minimaler SSE-Parser: verkraftet beliebig zerteilte Chunks (auch mitten in einer Zeile)
 * und ruft onData für jedes vollständige Event mit dem zusammengesetzten data-Inhalt auf.
 * @param {(data: string) => void} onData
 */
function createSseParser(onData) {
	let buffer = '';
	const processEvent = (raw) => {
		const dataLines = [];
		for (const line of raw.split(/\r?\n/)) {
			if (line.startsWith('data:')) {
				dataLines.push(line.slice(5).replace(/^ /, ''));
			}
		}
		if (dataLines.length > 0) {
			onData(dataLines.join('\n'));
		}
	};
	return {
		push(text) {
			buffer += text;
			for (;;) {
				const m = /\r?\n\r?\n/.exec(buffer);
				if (!m) { break; }
				const raw = buffer.slice(0, m.index);
				buffer = buffer.slice(m.index + m[0].length);
				processEvent(raw);
			}
		},
		end() {
			if (buffer.trim()) {
				processEvent(buffer);
			}
			buffer = '';
		}
	};
}

/**
 * Streaming-Chunks zu einer GenerateContentResponse zusammenführen:
 * Textteile werden konkateniert, andere Parts (functionCall …) angehängt,
 * finishReason kommt aus dem letzten Chunk, promptFeedback aus dem ersten.
 * @param {object[]} chunks
 */
function mergeStreamResponses(chunks) {
	let text = '';
	const otherParts = [];
	let finishReason;
	let promptFeedback;
	for (const chunk of chunks) {
		if (!promptFeedback && chunk && chunk.promptFeedback) {
			promptFeedback = chunk.promptFeedback;
		}
		const cand = chunk && Array.isArray(chunk.candidates) ? chunk.candidates[0] : undefined;
		if (!cand) { continue; }
		if (cand.finishReason) { finishReason = cand.finishReason; }
		const parts = (cand.content && Array.isArray(cand.content.parts)) ? cand.content.parts : [];
		for (const p of parts) {
			if (typeof p.text === 'string') { text += p.text; }
			else { otherParts.push(p); }
		}
	}
	const merged = {
		candidates: [{
			content: { role: 'model', parts: text ? [{ text }, ...otherParts] : otherParts },
			finishReason: finishReason || 'STOP'
		}]
	};
	if (promptFeedback) { merged.promptFeedback = promptFeedback; }
	return merged;
}

/** "models/x" | "publishers/google/models/x" | "x" → "x" */
function normalizeModelName(name) {
	const trimmed = String(name || '').trim();
	// Leere Segmente (z. B. trailing Slash) fallen weg, statt still auf das
	// Default-Modell umzuleiten; nur wirklich leere Eingabe erhält den Default.
	const parts = trimmed.split('/').filter(Boolean);
	return parts.length > 0 ? parts[parts.length - 1] : 'gemini-2.5-flash';
}

/** Erste Text-Teile einer Antwort extrahieren. */
function extractText(response) {
	const parts = extractParts(response);
	return parts.filter(p => typeof p.text === 'string').map(p => p.text).join('');
}

/** Alle Parts des ersten Kandidaten (leeres Array, wenn keine). */
function extractParts(response) {
	if (!response || !Array.isArray(response.candidates) || response.candidates.length === 0) {
		return [];
	}
	const content = response.candidates[0].content;
	return (content && Array.isArray(content.parts)) ? content.parts : [];
}

/** FunctionCall-Parts des ersten Kandidaten. */
function extractFunctionCalls(response) {
	return extractParts(response).filter(p => p.functionCall && p.functionCall.name);
}

/** Blockierung/Abbruchgrund als String (oder null). */
function extractBlockReason(response) {
	if (response && response.promptFeedback && response.promptFeedback.blockReason) {
		return `Prompt blockiert: ${response.promptFeedback.blockReason}`;
	}
	const cand = response && Array.isArray(response.candidates) ? response.candidates[0] : undefined;
	if (cand && cand.finishReason && !['STOP', 'MAX_TOKENS'].includes(cand.finishReason)) {
		return `Antwort beendet mit: ${cand.finishReason}`;
	}
	return null;
}

module.exports = {
	extractText,
	extractParts,
	extractFunctionCalls,
	extractBlockReason,
	normalizeModelName,
	createSseParser,
	mergeStreamResponses
};
