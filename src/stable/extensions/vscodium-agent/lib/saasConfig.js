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
const GOOGLE_OAUTH_CLIENT_ID = '476281311476-6rvnd9gbma58slcm9o119jm338ucfbkq.apps.googleusercontent.com';

/**
 * Adresse des PHI47-Dienstes. Gehört ins Produkt, NICHT in eine Einstellung:
 * Seit die Experten-Schalter aus der Oberfläche verborgen sind (`included: false`),
 * registriert VS Code sie gar nicht mehr – und wendet damit auch ihre Standardwerte
 * aus der package.json nicht an. Jeder Wert muss deshalb im Code stehen; die
 * (weiterhin setzbare) Einstellung `vscodiumAgent.proxy.url` überschreibt ihn nur.
 */
const DEFAULT_PROXY_URL = 'https://agent-proxy-476281311476.europe-west1.run.app';

module.exports = { GOOGLE_OAUTH_CLIENT_ID, DEFAULT_PROXY_URL };
