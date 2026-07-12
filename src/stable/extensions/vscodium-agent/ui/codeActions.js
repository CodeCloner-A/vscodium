/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – Quick-Fix-Aktionen an Diagnostics.
 *
 * „Mit KI beheben“ → Inline-Edit-Pfad mit vorgefertigter Instruktion (lokal, Diff im Editor).
 * „Mit KI erklären“ → Aufgabe an den Agent-Chat (liest die Datei, erklärt, schlägt Fix vor).
 *--------------------------------------------------------------------------------------------*/

'use strict';

const vscode = require('vscode');

class AgentCodeActionProvider {
	static providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

	provideCodeActions(document, _range, context) {
		const actions = [];
		for (const diagnostic of context.diagnostics || []) {
			if (diagnostic.severity > vscode.DiagnosticSeverity.Warning) { continue; }

			const fix = new vscode.CodeAction(
				`Mit KI beheben: ${truncate(diagnostic.message, 50)}`,
				vscode.CodeActionKind.QuickFix
			);
			fix.diagnostics = [diagnostic];
			fix.command = {
				command: 'vscodiumAgent.fixWithAi',
				title: 'Mit KI beheben',
				arguments: [document.uri, diagnostic]
			};

			const explain = new vscode.CodeAction('Mit KI erklären', vscode.CodeActionKind.QuickFix);
			explain.diagnostics = [diagnostic];
			explain.command = {
				command: 'vscodiumAgent.explainProblem',
				title: 'Mit KI erklären',
				arguments: [document.uri, diagnostic]
			};

			actions.push(fix, explain);
		}
		return actions;
	}
}

function truncate(s, n) {
	s = String(s || '').replace(/\s+/g, ' ');
	return s.length > n ? s.slice(0, n) + '…' : s;
}

module.exports = { AgentCodeActionProvider };
