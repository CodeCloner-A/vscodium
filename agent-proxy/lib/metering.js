/*---------------------------------------------------------------------------------------------
 * VSCodium Agent Proxy – Metering & Quoten über Firestore (REST, dependency-frei).
 *
 * Datenmodell (nur Zähler und Tarif, nie Inhalte – Leitplanke Datensparsamkeit):
 *   entitlements/{uid}            monthlyTokenLimit (int, 0 = unbegrenzt), plan (string),
 *                                 disabled (bool) – fehlt das Dokument, gilt der Free-Default.
 *   usage/{uid}/months/{YYYY-MM}  promptTokens, candidateTokens, totalTokens, requests,
 *                                 weightedTokens, updatedAt – per atomarem Increment.
 *
 * Gewichtete Quote: Teure Modelle (Claude Opus ≫ Gemini Flash) zählen mit Faktoren aus
 * dem Katalog (quotaFactor {input, output}, Basiseinheit gemini-2.5-flash) auf
 * weightedTokens. Das Quota-Gate prüft max(weightedTokens, totalTokens) – deckt
 * Monats-Dokumente aus der Zeit vor der Gewichtung korrekt ab (damals nur Faktor-1-
 * Modelle, weightedTokens fehlt/0) und bleibt korrekt, weil Faktoren nie < 1 sind.
 *
 * Verhalten:
 *   check(uid)     Quota-Gate vor dem Modell-Aufruf. Liest Entitlement + Monatszähler
 *                  (gecacht, Default 60 s) und entscheidet. Bei Firestore-Fehlern FAIL-OPEN
 *                  (der Dienst bleibt nutzbar, die Rate-Limits deckeln weiter) – geloggt.
 *   record(uid, u) Zähler nach der Antwort fortschreiben (Increment-Commit, ein Retry).
 *                  Wirft nie – Fehler kosten nur die Zählung, nie die Antwort.
 *   snapshot(uid)  Frischer Stand für GET /v1/usage (Anzeige in der IDE).
 *--------------------------------------------------------------------------------------------*/

'use strict';

const { createMetadataTokenSource } = require('./vertex');

const MAX_CACHED_USERS = 10000;
const FIRESTORE_TIMEOUT_MS = 5000;
// Nach einem Lesefehler so lange nicht erneut lesen (Negativ-Cache): Ein hängendes
// Firestore soll nicht jede einzelne Modell-Anfrage um den vollen Timeout verzögern.
const FAIL_OPEN_CACHE_MS = 30_000;
// Firebase-UIDs sind alphanumerisch; alles andere (etwa "/" aus exotischen Custom-Tokens)
// darf nie zum Firestore-Pfadbestandteil werden.
const UID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Monatsschlüssel in UTC, z. B. "2026-07". */
function monthKey(ms) {
	return new Date(ms).toISOString().slice(0, 7);
}

function intField(doc, name) {
	const field = doc && doc.fields && doc.fields[name];
	if (!field) { return 0; }
	if (field.integerValue !== undefined) { return parseInt(field.integerValue, 10) || 0; }
	if (field.doubleValue !== undefined) { return Math.round(field.doubleValue) || 0; }
	return 0;
}

function boolField(doc, name) {
	const field = doc && doc.fields && doc.fields[name];
	return Boolean(field && field.booleanValue === true);
}

function stringField(doc, name) {
	const field = doc && doc.fields && doc.fields[name];
	return field && typeof field.stringValue === 'string' ? field.stringValue : '';
}

/**
 * @param {{ project: string, fetchImpl?: typeof fetch, getAccessToken?: () => Promise<string>,
 *           freeMonthlyTokens?: number, cacheTtlMs?: number, now?: () => number,
 *           log?: (entry: object) => void }} options
 */
function createMeter(options) {
	const project = options.project;
	if (!project) { throw new Error('project erforderlich.'); }
	const fetchImpl = options.fetchImpl || fetch;
	const getAccessToken = options.getAccessToken || createMetadataTokenSource(fetchImpl);
	const freeMonthlyTokens = options.freeMonthlyTokens === undefined ? 2_000_000 : options.freeMonthlyTokens;
	const cacheTtlMs = options.cacheTtlMs === undefined ? 60_000 : options.cacheTtlMs;
	const now = options.now || Date.now;
	const log = options.log || ((entry) => console.log(JSON.stringify(entry)));

	const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
	const docPrefix = `projects/${project}/databases/(default)/documents`;
	/** @type {Map<string, {month: string, usage: object, limit: number, plan: string, disabled: boolean, fetchedAt: number}>} */
	const cache = new Map();

	async function firestore(path, body) {
		const token = await getAccessToken();
		const res = await fetchImpl(`${base}${path}`, {
			method: 'POST',
			headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(FIRESTORE_TIMEOUT_MS)
		});
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			const err = new Error(`Firestore [${res.status}]: ${text.slice(0, 300)}`);
			err.status = res.status;
			throw err;
		}
		return res.json();
	}

	function remember(uid, state) {
		if (!cache.has(uid) && cache.size >= MAX_CACHED_USERS) {
			for (const [key, entry] of cache) {
				if (now() - entry.fetchedAt >= cacheTtlMs) { cache.delete(key); }
			}
			// Immer noch voll (lauter heiße Einträge): ältesten opfern statt zu wachsen.
			if (cache.size >= MAX_CACHED_USERS) {
				cache.delete(cache.keys().next().value);
			}
		}
		cache.set(uid, state);
	}

	/** Frischer Stand aus Firestore: Entitlement + Monatszähler in einem batchGet. */
	async function load(uid) {
		const month = monthKey(now());
		const results = await firestore(':batchGet', {
			documents: [
				`${docPrefix}/entitlements/${uid}`,
				`${docPrefix}/usage/${uid}/months/${month}`
			]
		});
		let entitlement = null;
		let usageDoc = null;
		let answered = 0;
		for (const item of Array.isArray(results) ? results : []) {
			// batchGet ist eine Streaming-RPC: Fehler NACH Streambeginn kommen als
			// {error}-Element bei HTTP 200 – das ist ein Lesefehler, kein "Dokument fehlt".
			if (item.error) {
				throw new Error(`Firestore-Streamfehler: ${JSON.stringify(item.error).slice(0, 200)}`);
			}
			const name = item.found ? item.found.name : item.missing;
			if (!name) { continue; }
			answered++;
			if (name.endsWith(`/entitlements/${uid}`)) { entitlement = item.found || null; }
			else { usageDoc = item.found || null; }
		}
		if (answered < 2) {
			throw new Error('Firestore-batchGet-Antwort unvollständig.');
		}
		const hasCustomLimit = Boolean(entitlement && entitlement.fields && entitlement.fields.monthlyTokenLimit !== undefined);
		return {
			month,
			usage: {
				promptTokens: intField(usageDoc, 'promptTokens'),
				candidateTokens: intField(usageDoc, 'candidateTokens'),
				totalTokens: intField(usageDoc, 'totalTokens'),
				weightedTokens: intField(usageDoc, 'weightedTokens'),
				requests: intField(usageDoc, 'requests')
			},
			limit: hasCustomLimit ? intField(entitlement, 'monthlyTokenLimit') : freeMonthlyTokens,
			plan: stringField(entitlement, 'plan') || 'free',
			disabled: boolField(entitlement, 'disabled'),
			fetchedAt: now()
		};
	}

	/**
	 * Quota-Gate. Ergebnis: { allowed: true } oder
	 * { allowed: false, status, error, reason? } – reason 'quota' markiert für den Client,
	 * dass Warten innerhalb des Monats nichts bringt (kein Retry).
	 */
	async function check(uid) {
		if (!UID_PATTERN.test(uid)) {
			return { allowed: false, status: 403, error: 'Ungültige Nutzerkennung.' };
		}
		let state = cache.get(uid);
		if (state && state.failOpenUntil) {
			if (now() < state.failOpenUntil) { return { allowed: true, degraded: true }; }
			state = undefined;
		}
		const fresh = state && state.month === monthKey(now()) && now() - state.fetchedAt < cacheTtlMs;
		if (!fresh) {
			try {
				state = await load(uid);
				remember(uid, state);
			} catch (err) {
				// Fail-open: Ein Firestore-Ausfall darf den Dienst nicht lahmlegen –
				// Missbrauch deckeln weiterhin die Rate-Limits. Der Negativ-Cache
				// verhindert, dass jede Anfrage erneut in den Timeout läuft.
				log({ severity: 'WARNING', message: `Metering-Lesefehler (fail-open): ${err.message}`, uid });
				remember(uid, { failOpenUntil: now() + FAIL_OPEN_CACHE_MS, fetchedAt: now() });
				return { allowed: true, degraded: true };
			}
		}
		if (state.disabled) {
			return { allowed: false, status: 403, error: 'Konto gesperrt. Bitte Support kontaktieren.' };
		}
		const used = Math.max(state.usage.weightedTokens || 0, state.usage.totalTokens || 0);
		if (state.limit > 0 && used >= state.limit) {
			return {
				allowed: false, status: 429, reason: 'quota',
				error: `Monatskontingent erschöpft (${used} von ${state.limit} gewichteten Tokens im Monat ${state.month}).`
			};
		}
		return { allowed: true };
	}

	/**
	 * Zähler fortschreiben (atomare Increments; legt das Monatsdokument bei Bedarf an).
	 * usage stammt aus usageMetadata der Modell-Antwort und darf fehlen (dann zählt nur
	 * die Anfrage). quotaFactor ({input, output}, aus dem Katalog) gewichtet die Tokens
	 * für die Quote; fehlt er, gilt Faktor 1. Wirft nie – ein Schreibfehler kostet die
	 * Zählung, nie die Antwort.
	 */
	async function record(uid, usage, quotaFactor) {
		if (!UID_PATTERN.test(uid)) {
			log({ severity: 'WARNING', message: 'Metering: ungültige UID, Zählung übersprungen.' });
			return;
		}
		const month = monthKey(now());
		const transforms = [{ fieldPath: 'requests', increment: { integerValue: '1' } }];
		const bump = { requests: 1 };
		for (const field of ['promptTokens', 'candidateTokens', 'totalTokens']) {
			const value = usage && usage[field];
			if (Number.isFinite(value) && value > 0) {
				transforms.push({ fieldPath: field, increment: { integerValue: String(Math.round(value)) } });
				bump[field] = Math.round(value);
			}
		}
		const factorIn = quotaFactor && Number.isFinite(quotaFactor.input) ? quotaFactor.input : 1;
		const factorOut = quotaFactor && Number.isFinite(quotaFactor.output) ? quotaFactor.output : 1;
		// Denk-/Zusatztokens (Gemini: totalTokenCount > prompt+candidates) werden wie
		// Output bepreist – alles über dem Prompt zählt zum Output-Faktor.
		const outTokens = Math.max(bump.candidateTokens || 0, (bump.totalTokens || 0) - (bump.promptTokens || 0));
		const weighted = Math.round((bump.promptTokens || 0) * factorIn + outTokens * factorOut);
		if (weighted > 0) {
			transforms.push({ fieldPath: 'weightedTokens', increment: { integerValue: String(weighted) } });
			bump.weightedTokens = weighted;
		}
		transforms.push({ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' });
		const body = {
			writes: [{
				update: { name: `${docPrefix}/usage/${uid}/months/${month}`, fields: {} },
				// Leere Maske = keine Felder ersetzen, nur Transforms anwenden (Merge-Semantik;
				// ohne Maske würde `fields: {}` das Dokument leeren und die Zähler zurücksetzen).
				updateMask: { fieldPaths: [] },
				updateTransforms: transforms
			}]
		};
		// Für den Cache-Bump nach dem Commit: nur mitziehen, wenn der Eintrag inzwischen
		// nicht durch einen frischen Load ersetzt wurde – sonst zählte der Bump doppelt
		// (der frische Stand kann den Commit schon enthalten) und sperrte ggf. zu früh.
		const cachedBefore = cache.get(uid);
		for (let attempt = 1; attempt <= 2; attempt++) {
			try {
				await firestore(':commit', body);
				const state = cache.get(uid);
				if (state && state === cachedBefore && state.month === month) {
					for (const [field, value] of Object.entries(bump)) {
						state.usage[field] = (state.usage[field] || 0) + value;
					}
				}
				return;
			} catch (err) {
				// Retry nur, wenn eine HTTP-Fehlerantwort kam (Commit sicher nicht angewendet).
				// Timeout/Netzfehler sind ambig – der Commit kann serverseitig gelandet sein,
				// ein Replay würde die Increments doppelt anwenden (Kontingent des Nutzers
				// zu Unrecht verbrauchen). Im Zweifel lieber unterzählen.
				const retryable = Boolean(err.status) && (err.status === 429 || err.status >= 500);
				if (retryable && attempt === 1) {
					await new Promise((resolve) => setTimeout(resolve, 1000));
					continue;
				}
				log({ severity: 'ERROR', message: `Metering-Schreibfehler (Zählung verloren): ${err.message}`, uid });
				return;
			}
		}
	}

	/** Frischer Stand für GET /v1/usage – Fehler gehen an den Aufrufer (kein Gate). */
	async function snapshot(uid) {
		if (!UID_PATTERN.test(uid)) { throw new Error('Ungültige Nutzerkennung.'); }
		const state = await load(uid);
		remember(uid, state);
		const used = Math.max(state.usage.weightedTokens || 0, state.usage.totalTokens || 0);
		return {
			month: state.month,
			plan: state.plan,
			limit: state.limit,
			remaining: state.limit > 0 ? Math.max(0, state.limit - used) : null,
			promptTokens: state.usage.promptTokens,
			candidateTokens: state.usage.candidateTokens,
			totalTokens: state.usage.totalTokens,
			weightedTokens: used,
			requests: state.usage.requests
		};
	}

	return { check, record, snapshot };
}

module.exports = { createMeter, monthKey };
