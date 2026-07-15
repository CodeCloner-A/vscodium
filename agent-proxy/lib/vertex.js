/*---------------------------------------------------------------------------------------------
 * VSCodium Agent Proxy – Vertex-AI-Aufrufe mit Service-Account-Token vom Cloud-Run-
 * Metadata-Server. Gemini (publishers/google) wird byte-identisch durchgereicht;
 * Anthropic-Claude (publisher 'anthropic', Vertex MaaS) läuft über rawPredict/
 * streamRawPredict mit Format-Übersetzung in lib/anthropic.js.
 * `getAccessToken`/`fetchImpl` sind für Tests injizierbar.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const { toAnthropicRequest, wrapResponse } = require('./anthropic');

const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

// Gemini-Task → Anthropic-MaaS-Task. streamRawPredict liefert nativ SSE (kein ?alt=sse).
const ANTHROPIC_TASKS = {
	generateContent: 'rawPredict',
	streamGenerateContent: 'streamRawPredict'
};

/**
 * Access-Token des Cloud-Run-Service-Accounts vom Metadata-Server, mit Cache bis kurz
 * vor Ablauf. Wird auch vom Firestore-Metering genutzt (cloud-platform-Scope deckt beides).
 */
function createMetadataTokenSource(fetchImpl = fetch) {
	let cached = { token: null, expiresAt: 0 };
	return async function getAccessToken() {
		const nowSec = Math.floor(Date.now() / 1000);
		if (cached.token && nowSec < cached.expiresAt) { return cached.token; }
		const res = await fetchImpl(METADATA_TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' } });
		if (!res.ok) { throw new Error(`Metadata-Server antwortet nicht (${res.status}).`); }
		const json = await res.json();
		cached = {
			token: json.access_token,
			expiresAt: nowSec + Math.max(60, (json.expires_in || 300) - 60)
		};
		return cached.token;
	};
}

/**
 * Endpunkt-Host je Standort: 'global' → globaler Endpunkt, 'eu'/'us' → jurisdiktionale
 * Multiregion (rep-Hosts, Datenresidenz), sonst regionaler Endpunkt.
 */
function hostFor(location) {
	if (location === 'global') { return 'aiplatform.googleapis.com'; }
	if (location === 'eu' || location === 'us') { return `aiplatform.${location}.rep.googleapis.com`; }
	return `${location}-aiplatform.googleapis.com`;
}

/**
 * @param {{ project: string, fetchImpl?: typeof fetch, getAccessToken?: () => Promise<string>,
 *           maxTokensDefault?: number }} options
 */
function createVertexClient(options) {
	const project = options.project;
	if (!project) { throw new Error('project erforderlich.'); }
	const fetchImpl = options.fetchImpl || fetch;
	const maxTokensDefault = options.maxTokensDefault;

	const getAccessToken = options.getAccessToken || createMetadataTokenSource(fetchImpl);

	function url(model, task, stream) {
		const host = hostFor(model.location);
		const anthropic = model.publisher === 'anthropic';
		const publisher = anthropic ? 'anthropic' : 'google';
		const upstreamTask = anthropic ? (ANTHROPIC_TASKS[task] || task) : task;
		const path = `/v1/projects/${project}/locations/${model.location}/publishers/${publisher}/models/${model.id}:${upstreamTask}`;
		return `https://${host}${path}${stream && !anthropic ? '?alt=sse' : ''}`;
	}

	/**
	 * @param {{ id: string, location: string, publisher?: string }} model Katalog-Eintrag
	 * @param {'generateContent'|'streamGenerateContent'} task
	 * @param {object} body Gemini-Request (Gemini: unverändert durchgereicht;
	 *                      Anthropic: hin- und zurückübersetzt, lib/anthropic.js)
	 */
	async function call(model, task, body, { stream = false, signal } = {}) {
		const anthropic = model.publisher === 'anthropic';
		// Übersetzung VOR dem Token-Abruf: Validierungsfehler (400) kosten keinen Upstream-Weg.
		const upstreamBody = anthropic ? toAnthropicRequest(body, { maxTokensDefault, stream }) : body;
		const token = await getAccessToken();
		const response = await fetchImpl(url(model, task, stream), {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${token}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(upstreamBody),
			signal
		});
		return anthropic ? wrapResponse(response, { stream }) : response;
	}

	return { call, url };
}

module.exports = { createVertexClient, createMetadataTokenSource, hostFor, METADATA_TOKEN_URL };
