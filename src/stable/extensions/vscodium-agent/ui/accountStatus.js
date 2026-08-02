/*---------------------------------------------------------------------------------------------
 * PHI47 – Konto-Status in der Statusleiste (rechts).
 *
 * Beantwortet auf einen Blick: Bin ich angemeldet – und als wer? Ein Klick öffnet das
 * Konto-Menü: Anmelden/Abmelden, Konto wechseln (Mehrbenutzer am selben Gerät),
 * Verbrauch anzeigen. Reagiert live auf An-/Abmeldungen – auch aus anderen Fenstern
 * (SecretStorage-Ereignis) – und ersetzt damit den entfernten Copilot-Sign-In des Kerns.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const vscode = require('vscode');

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {import('../lib/authManager').AuthManager} auth
 * @param {{ info: Function, warn: Function }} logger
 */
function registerAccountStatus(context, auth, logger) {
	const item = vscode.window.createStatusBarItem('phi47.account', vscode.StatusBarAlignment.Right, 90);
	item.name = 'PHI47-Konto';
	item.command = 'vscodiumAgent.accountMenu';
	context.subscriptions.push(item);

	async function refresh() {
		try {
			if (await auth.isSignedIn()) {
				const email = await auth.email();
				item.text = `$(account) ${email || 'Angemeldet'}`;
				item.tooltip = `PHI47: angemeldet${email ? ` als ${email}` : ''} – klicken für Konto-Menü (Abmelden, Konto wechseln, Verbrauch)`;
				item.backgroundColor = undefined;
			} else {
				item.text = '$(account) Anmelden';
				item.tooltip = 'PHI47: nicht angemeldet – klicken zum Anmelden mit Google';
				// Dezent hervorheben: ohne Anmeldung ist der Agent stumm.
				item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
			}
			item.show();
		} catch (err) {
			logger.warn('Konto-Status nicht ermittelbar.', err);
			item.text = '$(account) PHI47';
			item.show();
		}
	}

	context.subscriptions.push(vscode.commands.registerCommand('vscodiumAgent.accountMenu', async () => {
		const signedIn = await auth.isSignedIn();
		const email = signedIn ? await auth.email() : '';
		/** @type {Array<{label: string, description?: string, action: string}>} */
		const items = signedIn
			? [
				{ label: '$(sign-out) Abmelden', description: email || undefined, action: 'signOut' },
				{ label: '$(arrow-swap) Konto wechseln', description: 'abmelden und direkt neu anmelden', action: 'switch' },
				{ label: '$(graph) Verbrauch anzeigen', description: 'Monatskontingent und Tokens', action: 'usage' }
			]
			: [
				{ label: '$(sign-in) Mit Google anmelden', action: 'signIn' }
			];
		const picked = await vscode.window.showQuickPick(items, {
			title: signedIn ? `PHI47-Konto: ${email || 'angemeldet'}` : 'PHI47-Konto: nicht angemeldet',
			placeHolder: 'Was möchtest du tun?'
		});
		if (!picked) { return; }
		switch (picked.action) {
			case 'signIn':
				await vscode.commands.executeCommand('vscodiumAgent.signIn');
				break;
			case 'signOut':
				await vscode.commands.executeCommand('vscodiumAgent.signOut');
				break;
			case 'switch':
				// Mehrbenutzer am selben Gerät: sauber trennen, dann direkt der neue Login.
				await vscode.commands.executeCommand('vscodiumAgent.signOut');
				await vscode.commands.executeCommand('vscodiumAgent.signIn');
				break;
			case 'usage':
				await vscode.commands.executeCommand('vscodiumAgent.showUsage');
				break;
		}
		void refresh();
	}));

	// Live halten: eigene An-/Abmeldung UND die aus anderen Fenstern (geteilter Keyring).
	const { AUTH_SECRET_KEY } = require('../lib/authManager');
	context.subscriptions.push(context.secrets.onDidChange((e) => {
		if (e.key === AUTH_SECRET_KEY) { void refresh(); }
	}));

	void refresh();
	logger.info('Konto-Status aktiv (Statusleiste rechts, Klick öffnet das Konto-Menü).');
	return { refresh };
}

module.exports = { registerAccountStatus };
