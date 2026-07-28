/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – „Dateien vom Computer …“ im Anhang-Menü des Chats (KEEP IT SIMPLE).
 *
 * Einsteiger kennen das „Öffnen“-Fenster – nicht den Quick-Access. Dieser Provider
 * stellt deshalb einen Eintrag in das Attach-Menü (Plus-/Büroklammer-Symbol), dessen
 * Klick den nativen Datei-Dialog öffnet; die gewählten Dateien werden über das
 * Core-Kommando `workbench.action.chat.attachFile` an den Chat gehängt.
 *
 * Mechanik (verifiziert gegen 1.121, Belege in docs/phase-k-verdrahtung.md):
 *   - contributes.chatContext (id/icon/displayName) + Proposal `chatContextProvider`
 *   - chat.registerChatExplicitContextProvider: Items mit `command` führen beim
 *     Klick das Kommando aus
 *   - `workbench.action.chat.attachFile` akzeptiert (undefined, URI[]) für mehrere Dateien
 *--------------------------------------------------------------------------------------------*/

'use strict';

const vscode = require('vscode');

const PROVIDER_ID = 'vscodium-agent.files';
const COMMAND_ID = 'vscodiumAgent.attachFilesFromComputer';

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {{ info: Function, warn: Function }} logger
 * @returns {boolean} ob der Anhang-Eintrag registriert wurde
 */
function registerAttachFromComputer(context, logger) {
	context.subscriptions.push(vscode.commands.registerCommand(COMMAND_ID, async () => {
		const uris = await vscode.window.showOpenDialog({
			canSelectMany: true,
			canSelectFiles: true,
			canSelectFolders: false,
			openLabel: 'Zum Chat hinzufügen',
			title: 'Dateien zum Chat hinzufügen'
		});
		if (!uris || uris.length === 0) { return; }
		try {
			await vscode.commands.executeCommand('workbench.action.chat.attachFile', undefined, uris);
		} catch (err) {
			logger.warn('Dateien anhängen: attachFile-Kommando fehlgeschlagen.', err);
			void vscode.window.showErrorMessage(`Dateien konnten nicht angehängt werden: ${err.message}`);
		}
	}));

	if (!vscode.chat || typeof vscode.chat.registerChatExplicitContextProvider !== 'function') {
		logger.info('Dateien vom Computer: Kontext-Provider-API nicht verfügbar – Eintrag entfällt (Kommando bleibt nutzbar).');
		return false;
	}
	try {
		const disposable = vscode.chat.registerChatExplicitContextProvider(PROVIDER_ID, {
			provideExplicitChatContext() {
				return [{
					label: 'Dateien vom Computer …',
					icon: new vscode.ThemeIcon('folder-opened'),
					tooltip: new vscode.MarkdownString('Öffnet das normale „Öffnen“-Fenster, um Dateien von deinem Computer in den Chat zu laden.'),
					command: { command: COMMAND_ID, title: 'Dateien vom Computer hinzufügen' }
				}];
			},
			resolveExplicitChatContext(item) {
				return item;
			}
		});
		context.subscriptions.push(disposable);
		logger.info('Dateien vom Computer: Anhang-Eintrag registriert (Öffnen-Dialog statt Quick-Access).');
		return true;
	} catch (err) {
		logger.warn('Dateien vom Computer: Registrierung nicht möglich – Kommando bleibt nutzbar.', err);
		return false;
	}
}

module.exports = { registerAttachFromComputer, COMMAND_ID };
