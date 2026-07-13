/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – Fest eingebaute SaaS-Identität (Phase S, BYOK-Rückbau).
 *
 * Hier steht ausschließlich Öffentliches: Die OAuth-Client-ID erscheint ohnehin in jeder
 * Browser-Anmelde-URL. Geheimnisse (OAuth-Client-Secret, Firebase-Web-API-Key) liegen
 * NIE im Client – sie leben als Secret-Manager-Env-Vars im Agent-Proxy (Auth-Relay,
 * siehe docs/agent-proxy.md).
 *--------------------------------------------------------------------------------------------*/

'use strict';

// OAuth-Client vom Typ „Desktop-App“ (GCP Console → APIs & Dienste → Anmeldedaten).
// Vor dem ersten Release eintragen; leer lassen führt zu einer klaren Fehlermeldung
// beim Anmelden statt zu einem kaputten Browser-Flow.
const GOOGLE_OAUTH_CLIENT_ID = '';

module.exports = { GOOGLE_OAUTH_CLIENT_ID };
