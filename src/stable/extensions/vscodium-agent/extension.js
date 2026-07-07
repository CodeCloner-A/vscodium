/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – Extension-Einstiegspunkt.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const vscode = require('vscode');
const { ChatViewProvider, SECRET_KEY } = require('./ui/chatViewProvider');
const { DIFF_SCHEME } = require('./lib/workspaceHost');

/** @param {vscode.ExtensionContext} context */
function activate(context) {
	const provider = new ChatViewProvider(context);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
			webviewOptions: { retainContextWhenHidden: true }
		})
	);

	// Diff-Vorschau (virtuelle Dokumente); Provider delegiert an den jeweils aktiven Host.
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, {
			provideTextDocumentContent(uri) {
				const host = provider.host;
				if (!host) { return ''; }
				return host.createDiffContentProvider().provideTextDocumentContent(uri);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('vscodiumAgent.setApiKey', async () => {
			const value = await vscode.window.showInputBox({
				title: 'Firebase Web-API-Key',
				prompt: 'API-Key aus der Firebase Console (Projekteinstellungen → Allgemein → Web-App → apiKey)',
				password: true,
				ignoreFocusOut: true,
				placeHolder: 'AIza…'
			});
			if (value) {
				await context.secrets.store(SECRET_KEY, value.trim());
				void vscode.window.showInformationMessage('Firebase API-Key gespeichert (SecretStorage).');
				void provider._sendInit();
			}
		}),

		vscode.commands.registerCommand('vscodiumAgent.clearApiKey', async () => {
			await context.secrets.delete(SECRET_KEY);
			void vscode.window.showInformationMessage('Firebase API-Key gelöscht.');
			void provider._sendInit();
		}),

		vscode.commands.registerCommand('vscodiumAgent.testConnection', async () => {
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: 'Teste Firebase AI Logic…' },
				async () => {
					try {
						const client = await provider.buildClient();
						const text = await client.ping();
						void vscode.window.showInformationMessage(`Verbindung OK (Projekt "${client.projectId}", Modell "${client.model}"): ${text.slice(0, 80)}`);
					} catch (err) {
						const hint = err && err.hint ? ` – ${err.hint}` : '';
						void vscode.window.showErrorMessage(`Verbindung fehlgeschlagen: ${err.message}${hint}`);
					}
				}
			);
		}),

		vscode.commands.registerCommand('vscodiumAgent.newSession', () => provider.newSession()),

		vscode.commands.registerCommand('vscodiumAgent.openSettings', () => {
			void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:vscodium.vscodium-agent');
		})
	);
}

function deactivate() { /* nichts zu tun */ }

module.exports = { activate, deactivate };
