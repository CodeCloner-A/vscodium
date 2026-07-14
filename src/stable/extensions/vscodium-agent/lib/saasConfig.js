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
// Bewusst fest eingebaut – das ist der öffentliche Teil des OAuth-Clients; das
// zugehörige Secret kennt nur der Proxy.
const GOOGLE_OAUTH_CLIENT_ID = '476281311476-3j1hkvbcom4q2lvjtbgovhcfq5drnpq8.apps.googleusercontent.com';

module.exports = { GOOGLE_OAUTH_CLIENT_ID };
