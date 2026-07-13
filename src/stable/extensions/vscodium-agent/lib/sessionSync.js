/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – Sync-Logik für Chat-Sitzungen (pur, ohne vscode-Abhängigkeit).
 *
 * Sitzungen leben lokal im workspaceState (Offline-Cache) und – pro Nutzer und Projekt –
 * in Firestore hinter dem Proxy. Konfliktauflösung: last-write-wins pro Sitzung über
 * updatedAt; hier wird nur ENTSCHIEDEN, was zu holen/hochzuladen ist, die Netzarbeit
 * macht der ChatViewProvider mit dem ProxyClient.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const MAX_WORKSPACE_KEY_CHARS = 64;

/**
 * Workspace-Schlüssel aus dem Ordnernamen des Projekts: trennt Sitzungen pro Projekt
 * und findet dasselbe Repo auf anderen Geräten wieder. Firestore-Dokument-IDs
 * verbieten "/" sowie ".", ".." und __…__ – solche Namen fallen auf 'default' zurück
 * (Sync ohne offenen Ordner ergibt ohnehin keinen sinnvollen Scope).
 */
function workspaceKey(folderName) {
	const name = String(folderName || '').trim().replace(/[/\\]/g, '-').slice(0, MAX_WORKSPACE_KEY_CHARS);
	if (!name || name === '.' || name === '..' || /^__.*__$/.test(name)) { return 'default'; }
	return name;
}

/** Formprüfung einer remote geladenen Sitzung, bevor sie den lokalen Stand ersetzen darf. */
function validRemoteSession(s) {
	return Boolean(s && typeof s === 'object'
		&& typeof s.id === 'string' && SESSION_ID_PATTERN.test(s.id)
		&& typeof s.title === 'string'
		&& Number.isFinite(s.createdAt) && Number.isFinite(s.updatedAt)
		&& Array.isArray(s.items) && Array.isArray(s.history));
}

/**
 * Abgleichplan aus lokalem Stand und Remote-Metadaten:
 *   pull – remote neuer oder lokal unbekannt → vollständig holen
 *   push – lokal neuer oder remote unbekannt → hochladen (leere Sitzungen nie:
 *          jede frische „Neue Sitzung“ würde sonst als Karteileiche synchronisiert)
 * @param {Array<{id: string, updatedAt: number, items?: Array}>} localSessions
 * @param {Array<{id: string, updatedAt: number}>} remoteSummaries
 */
function planSync(localSessions, remoteSummaries) {
	const local = new Map(localSessions.map(s => [s.id, s]));
	const remote = new Map(remoteSummaries.map(s => [s.id, s]));
	const pull = [];
	const push = [];
	for (const [id, r] of remote) {
		const l = local.get(id);
		if (!l || r.updatedAt > l.updatedAt) { pull.push(id); }
	}
	for (const [id, l] of local) {
		const r = remote.get(id);
		if ((l.items || []).length === 0) { continue; }
		if (!r || l.updatedAt > r.updatedAt) { push.push(id); }
	}
	return { pull, push };
}

module.exports = { workspaceKey, validRemoteSession, planSync };
