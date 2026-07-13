/*---------------------------------------------------------------------------------------------
 * VSCodium Agent Proxy – Chat-Sitzungs-Sync über Firestore (REST, dependency-frei).
 *
 * Seit dem BYOK-Rückbau hat der Client keinen direkten Firebase-Zugang mehr; der Sync läuft
 * deshalb – wie das Metering – über den Proxy (Service-Account → Firestore). Die Isolation
 * pro Nutzer erzwingt der Proxy selbst: Die uid stammt IMMER aus dem verifizierten ID-Token,
 * nie aus dem Request – die Security Rules bleiben zu.
 *
 * Datenmodell (anders als beim Metering liegen hier bewusst Inhalte – das IST der Zweck):
 *   sessions/{uid}/workspaces/{ws}/items/{sessionId}
 *     title (string), createdAt/updatedAt (int, ms), data (string: JSON aus {items, history})
 *
 * Der Workspace-Schlüssel (Ordnername des Projekts) trennt Sitzungen pro Projekt und
 * synchronisiert dasselbe Repo über Geräte hinweg. items/history wandern als EIN
 * JSON-String ins Dokument: Die Chat-Items sind beliebig verschachtelt, eine Abbildung
 * auf Firestore-Felder brächte nur Encoding-Aufwand ohne Nutzen (es fragt nie jemand
 * nach einzelnen Items). Die Listenansicht liest per Projektion nur die Metadaten.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const { createMetadataTokenSource } = require('./vertex');

const FIRESTORE_TIMEOUT_MS = 8000;
// Firestore-Dokumente sind auf 1 MiB gedeckelt; Luft für Feldnamen/Index-Overhead lassen.
const MAX_DATA_BYTES = 900 * 1024;
const MAX_TITLE_CHARS = 200;
const MAX_LIST_SESSIONS = 100;
// Firebase-UIDs sind alphanumerisch (siehe lib/metering.js) – alles andere darf nie
// zum Firestore-Pfadbestandteil werden.
const UID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
// Sitzungs-IDs erzeugt der Client als UUID.
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

function httpError(status, message) {
	return Object.assign(new Error(message), { status });
}

/**
 * Workspace-Schlüssel = Ordnername des Projekts. Firestore-Dokument-IDs erlauben
 * fast alles außer "/" – zusätzlich sind ".", ".." und __…__ reserviert.
 */
function validWorkspace(ws) {
	return typeof ws === 'string'
		&& ws.length >= 1 && ws.length <= 100
		&& !ws.includes('/')
		&& ws !== '.' && ws !== '..'
		&& !/^__.*__$/.test(ws);
}

function intField(doc, name) {
	const field = doc && doc.fields && doc.fields[name];
	if (!field) { return 0; }
	if (field.integerValue !== undefined) { return parseInt(field.integerValue, 10) || 0; }
	if (field.doubleValue !== undefined) { return Math.round(field.doubleValue) || 0; }
	return 0;
}

function stringField(doc, name) {
	const field = doc && doc.fields && doc.fields[name];
	return field && typeof field.stringValue === 'string' ? field.stringValue : '';
}

/**
 * @param {{ project: string, fetchImpl?: typeof fetch, getAccessToken?: () => Promise<string>,
 *           maxDataBytes?: number, log?: (entry: object) => void }} options
 */
function createSessionStore(options) {
	const project = options.project;
	if (!project) { throw new Error('project erforderlich.'); }
	const fetchImpl = options.fetchImpl || fetch;
	const getAccessToken = options.getAccessToken || createMetadataTokenSource(fetchImpl);
	const maxDataBytes = options.maxDataBytes === undefined ? MAX_DATA_BYTES : options.maxDataBytes;

	const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;

	async function firestore(method, path, body) {
		const token = await getAccessToken();
		const res = await fetchImpl(`${base}${path}`, {
			method,
			headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(FIRESTORE_TIMEOUT_MS)
		});
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			throw Object.assign(new Error(`Firestore [${res.status}]: ${text.slice(0, 300)}`), { firestoreStatus: res.status });
		}
		return res.json();
	}

	/** Pfad unter /documents für eine Sitzung; alle Bestandteile sind vorab validiert. */
	function docPath(uid, ws, id) {
		return `/sessions/${encodeURIComponent(uid)}/workspaces/${encodeURIComponent(ws)}/items/${encodeURIComponent(id)}`;
	}

	function guard(uid, ws, id) {
		if (!UID_PATTERN.test(uid)) { throw httpError(403, 'Ungültige Nutzerkennung.'); }
		if (!validWorkspace(ws)) { throw httpError(400, 'Ungültiger oder fehlender Workspace-Schlüssel (Query-Parameter/Feld "workspace").'); }
		if (id !== undefined && !SESSION_ID_PATTERN.test(String(id || ''))) { throw httpError(400, 'Ungültige Sitzungs-ID.'); }
	}

	/** Sitzungs-Metadaten für die Listenansicht – Projektion, damit `data` nie mitläuft. */
	async function list(uid, ws) {
		guard(uid, ws);
		const results = await firestore('POST', `/sessions/${encodeURIComponent(uid)}/workspaces/${encodeURIComponent(ws)}:runQuery`, {
			structuredQuery: {
				from: [{ collectionId: 'items' }],
				select: { fields: [{ fieldPath: 'title' }, { fieldPath: 'createdAt' }, { fieldPath: 'updatedAt' }] },
				orderBy: [{ field: { fieldPath: 'updatedAt' }, direction: 'DESCENDING' }],
				limit: MAX_LIST_SESSIONS
			}
		});
		const sessions = [];
		for (const item of Array.isArray(results) ? results : []) {
			if (item.error) {
				throw new Error(`Firestore-Streamfehler: ${JSON.stringify(item.error).slice(0, 200)}`);
			}
			if (!item.document) { continue; } // reine readTime-Elemente
			sessions.push({
				id: decodeURIComponent(String(item.document.name).split('/').pop()),
				title: stringField(item.document, 'title'),
				createdAt: intField(item.document, 'createdAt'),
				updatedAt: intField(item.document, 'updatedAt')
			});
		}
		return sessions;
	}

	/** Volle Sitzung oder null, wenn sie (noch) nicht existiert. */
	async function get(uid, ws, id) {
		guard(uid, ws, id);
		let doc;
		try {
			doc = await firestore('GET', docPath(uid, ws, id));
		} catch (err) {
			if (err.firestoreStatus === 404) { return null; }
			throw err;
		}
		let payload = {};
		try {
			payload = JSON.parse(stringField(doc, 'data') || '{}');
		} catch (_e) { /* korruptes Dokument: leere Sitzung liefern statt 502 */ }
		return {
			id,
			title: stringField(doc, 'title'),
			createdAt: intField(doc, 'createdAt'),
			updatedAt: intField(doc, 'updatedAt'),
			items: Array.isArray(payload.items) ? payload.items : [],
			history: Array.isArray(payload.history) ? payload.history : []
		};
	}

	/** Sitzung anlegen/ersetzen (Last-write-wins; die Konfliktauflösung trifft der Client per updatedAt). */
	async function put(uid, ws, session) {
		guard(uid, ws, session && session.id);
		if (!session || typeof session !== 'object') { throw httpError(400, 'Sitzungsdaten fehlen.'); }
		const createdAt = Number(session.createdAt);
		const updatedAt = Number(session.updatedAt);
		if (!Number.isFinite(createdAt) || createdAt <= 0 || !Number.isFinite(updatedAt) || updatedAt <= 0) {
			throw httpError(400, 'createdAt/updatedAt müssen Zeitstempel (ms) sein.');
		}
		if (!Array.isArray(session.items) || !Array.isArray(session.history)) {
			throw httpError(400, 'items und history müssen Arrays sein.');
		}
		const data = JSON.stringify({ items: session.items, history: session.history });
		if (Buffer.byteLength(data, 'utf8') > maxDataBytes) {
			throw httpError(413, `Sitzung zu groß für den Sync (Limit ${Math.floor(maxDataBytes / 1024)} KiB) – sie bleibt lokal erhalten.`);
		}
		// PATCH ohne updateMask ersetzt das ganze Dokument (Upsert).
		await firestore('PATCH', docPath(uid, ws, session.id), {
			fields: {
				title: { stringValue: String(session.title || '').slice(0, MAX_TITLE_CHARS) },
				createdAt: { integerValue: String(Math.round(createdAt)) },
				updatedAt: { integerValue: String(Math.round(updatedAt)) },
				data: { stringValue: data }
			}
		});
	}

	/** Sitzung löschen; nicht vorhandene Dokumente sind kein Fehler (Firestore-Semantik). */
	async function remove(uid, ws, id) {
		guard(uid, ws, id);
		await firestore('DELETE', docPath(uid, ws, id));
	}

	return { list, get, put, remove };
}

module.exports = { createSessionStore, validWorkspace };
