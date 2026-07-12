/*---------------------------------------------------------------------------------------------
 * VSCodium Agent Proxy – Vertex-AI-Aufrufe (Gemini, direkt) mit Service-Account-Token
 * vom Cloud-Run-Metadata-Server. `getAccessToken`/`fetchImpl` sind für Tests injizierbar.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

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
 * @param {{ project: string, fetchImpl?: typeof fetch,
 *           getAccessToken?: () => Promise<string> }} options
 */
function createVertexClient(options) {
	const project = options.project;
	if (!project) { throw new Error('project erforderlich.'); }
	const fetchImpl = options.fetchImpl || fetch;

	let cached = { token: null, expiresAt: 0 };
	const getAccessToken = options.getAccessToken || (async () => {
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
	});

	function url(model, task, stream) {
		const host = hostFor(model.location);
		const path = `/v1/projects/${project}/locations/${model.location}/publishers/google/models/${model.id}:${task}`;
		return `https://${host}${path}${stream ? '?alt=sse' : ''}`;
	}

	/**
	 * @param {{ id: string, location: string }} model Katalog-Eintrag
	 * @param {'generateContent'|'streamGenerateContent'} task
	 * @param {object} body Gemini-Request (wird unverändert durchgereicht)
	 */
	async function call(model, task, body, { stream = false, signal } = {}) {
		const token = await getAccessToken();
		return fetchImpl(url(model, task, stream), {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${token}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(body),
			signal
		});
	}

	return { call, url };
}

module.exports = { createVertexClient, hostFor, METADATA_TOKEN_URL };
