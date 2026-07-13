/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – Verwaltung der Firebase-Anmeldung (Phase S).
 *
 * Hält den Refresh-Token in der SecretStorage (ein JSON-Eintrag) und cached das kurzlebige
 * ID-Token im Speicher; erneuert automatisch kurz vor Ablauf. Bewusst vscode-frei –
 * `secrets` ist ein injizierbares {get, store, delete}, dadurch headless testbar.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const { signInWithGoogle, refreshIdToken } = require('./firebaseAuth');

const AUTH_SECRET_KEY = 'vscodiumAgent.auth.v1';
const EXPIRY_MARGIN_MS = 60 * 1000;

class AuthManager {
	/**
	 * @param {{ secrets: { get: Function, store: Function, delete: Function },
	 *           log?: { info: Function, error: Function }, now?: () => number,
	 *           fetchImpl?: typeof fetch }} options
	 */
	constructor(options) {
		this.secrets = options.secrets;
		this.log = options.log || { info() { }, error() { } };
		this.now = options.now || Date.now;
		this.fetchImpl = options.fetchImpl;
		/** @type {{ idToken: string, expiresAt: number, proxyUrl: string } | null} */
		this._cached = null;
		/** @type {{ refreshToken: string, email: string } | null | undefined} undefined = noch nicht geladen */
		this._stored = undefined;
	}

	async _load() {
		if (this._stored !== undefined) { return this._stored; }
		let raw;
		try {
			raw = await this.secrets.get(AUTH_SECRET_KEY);
		} catch (err) {
			// Transient (z. B. gesperrter Keyring beim Start): NICHT memoizen,
			// der nächste Zugriff liest erneut.
			this.log.error('SecretStorage nicht lesbar', err);
			return null;
		}
		try {
			const parsed = raw ? JSON.parse(raw) : null;
			// Formprüfung: nur brauchbare Einträge gelten als angemeldet.
			this._stored = parsed && typeof parsed.refreshToken === 'string' && parsed.refreshToken
				? parsed
				: null;
		} catch (_e) {
			this._stored = null; // korruptes JSON ist dauerhaft – memoizen ist hier richtig
		}
		return this._stored;
	}

	async _persist(refreshToken, email) {
		// Erst persistieren, dann übernehmen – der Speicher darf der Platte nie voraus sein.
		const stored = { refreshToken, email };
		await this.secrets.store(AUTH_SECRET_KEY, JSON.stringify(stored));
		this._stored = stored;
	}

	/** Von außen geänderte Secrets übernehmen (z. B. zweites Fenster): Caches verwerfen. */
	invalidate() {
		this._stored = undefined;
		this._cached = null;
	}

	async isSignedIn() {
		return Boolean(await this._load());
	}

	async email() {
		const stored = await this._load();
		return stored ? stored.email : '';
	}

	/** Interaktive Google-Anmeldung; speichert Refresh-Token + E-Mail. */
	async signIn({ clientId, proxyUrl, openBrowser, timeoutMs, signal }) {
		const result = await signInWithGoogle({
			clientId, proxyUrl, openBrowser, timeoutMs, signal,
			fetchImpl: this.fetchImpl
		});
		await this._persist(result.refreshToken, result.email);
		this._cached = { idToken: result.idToken, expiresAt: result.expiresAt, proxyUrl };
		this.log.info(`Angemeldet als ${result.email || '(ohne E-Mail)'}`);
		return { email: result.email };
	}

	async signOut() {
		// Erst löschen, dann In-Memory-Zustand räumen – schlägt das Löschen fehl,
		// bleibt der Zustand konsistent „angemeldet“ und der Fehler sichtbar.
		await this.secrets.delete(AUTH_SECRET_KEY);
		this._stored = null;
		this._cached = null;
		this.log.info('Abgemeldet, Tokens gelöscht.');
	}

	/**
	 * Gültiges Firebase-ID-Token liefern; erneuert automatisch (Refresh-Token-Rotation
	 * wird persistiert). Wirft, wenn niemand angemeldet ist.
	 */
	async getIdToken(proxyUrl) {
		// Cache gilt nur für denselben Proxy (Dienst-Wechsel invalidiert ihn).
		if (this._cached && this._cached.proxyUrl === proxyUrl
			&& this.now() < this._cached.expiresAt - EXPIRY_MARGIN_MS) {
			return this._cached.idToken;
		}
		const stored = await this._load();
		if (!stored) { throw new Error('Nicht angemeldet. Kommando „Agent: Mit Google anmelden“ ausführen.'); }
		const result = await refreshIdToken({
			proxyUrl,
			refreshToken: stored.refreshToken,
			fetchImpl: this.fetchImpl
		});
		// Sitzung wechselte während der Erneuerung (Abmelden/anderes Konto)?
		// Ergebnis verwerfen, sonst würde z. B. ein explizites Abmelden rückgängig gemacht.
		if (this._stored !== stored) {
			throw new Error('Nicht angemeldet. Kommando „Agent: Mit Google anmelden“ ausführen.');
		}
		if (result.refreshToken !== stored.refreshToken) {
			await this._persist(result.refreshToken, stored.email);
		}
		this._cached = { idToken: result.idToken, expiresAt: result.expiresAt, proxyUrl };
		return result.idToken;
	}
}

module.exports = { AuthManager, AUTH_SECRET_KEY };
