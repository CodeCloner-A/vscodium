/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – Tool-Definitionen (Gemini Function Calling) und Ausführung.
 *
 * Die Ausführung läuft gegen ein "host"-Interface, damit die Logik ohne VS Code testbar ist:
 *   host = {
 *     listProjectFiles(maxEntries) -> Promise<string>          // Baum als Text
 *     readFile(relPath) -> Promise<string>
 *     fileExists(relPath) -> Promise<boolean>
 *     searchText(query, {isRegex, fileGlob, maxResults}) -> Promise<Array<{path,line,text}>>
 *     applyChange({kind:'write'|'delete', path, newContent, summary}) -> Promise<{status:'applied'|'rejected', message?}>
 *     runCommand(command, {cwd, timeoutSec, purpose}) -> Promise<{status:'ran'|'skipped', exitCode?, stdout?, stderr?, durationMs?, message?}>
 *     getDiagnostics(relPath?) -> Promise<Array<{path,line,severity,message,source?}>>
 *   }
 *--------------------------------------------------------------------------------------------*/

'use strict';

const MAX_READ_CHARS = 24000;
const MAX_SEARCH_RESULTS = 60;
const MAX_CMD_OUTPUT = 12000;

/** Gemini functionDeclarations (OpenAPI-Subset, Typnamen in Großbuchstaben). */
const TOOL_DECLARATIONS = [
	{
		name: 'list_files',
		description: 'Lists files and folders of the workspace as a tree (common build/dependency folders are excluded).',
		parameters: {
			type: 'OBJECT',
			properties: {
				max_entries: { type: 'INTEGER', description: 'Maximum number of entries (default 250).' }
			}
		}
	},
	{
		name: 'read_file',
		description: 'Reads a text file from the workspace. Returns content with line numbers. Use start_line/end_line for large files.',
		parameters: {
			type: 'OBJECT',
			properties: {
				path: { type: 'STRING', description: 'Path relative to the workspace root.' },
				start_line: { type: 'INTEGER', description: '1-based first line (optional).' },
				end_line: { type: 'INTEGER', description: '1-based last line inclusive (optional).' }
			},
			required: ['path']
		}
	},
	{
		name: 'search_project',
		description: 'Searches all workspace text files for a string or regular expression. Returns matches as path:line: text.',
		parameters: {
			type: 'OBJECT',
			properties: {
				query: { type: 'STRING', description: 'Search text or regex pattern.' },
				is_regex: { type: 'BOOLEAN', description: 'Treat query as regular expression (default false).' },
				file_glob: { type: 'STRING', description: 'Optional glob filter, e.g. "src/**/*.ts" or "*.json".' }
			},
			required: ['query']
		}
	},
	{
		name: 'write_file',
		description: 'Creates a new file or fully overwrites an existing one. Subject to user approval in review mode.',
		parameters: {
			type: 'OBJECT',
			properties: {
				path: { type: 'STRING', description: 'Path relative to the workspace root.' },
				content: { type: 'STRING', description: 'Complete new file content.' },
				summary: { type: 'STRING', description: 'One short German sentence describing the change (shown to the user).' }
			},
			required: ['path', 'content', 'summary']
		}
	},
	{
		name: 'replace_in_file',
		description: 'Targeted edit: replaces an exact, unique text passage in a file. old_text must match exactly once (include enough surrounding lines to make it unique).',
		parameters: {
			type: 'OBJECT',
			properties: {
				path: { type: 'STRING', description: 'Path relative to the workspace root.' },
				old_text: { type: 'STRING', description: 'Exact existing text (must occur exactly once).' },
				new_text: { type: 'STRING', description: 'Replacement text.' },
				summary: { type: 'STRING', description: 'One short German sentence describing the change (shown to the user).' }
			},
			required: ['path', 'old_text', 'new_text', 'summary']
		}
	},
	{
		name: 'delete_file',
		description: 'Deletes a file from the workspace. Subject to user approval in review mode.',
		parameters: {
			type: 'OBJECT',
			properties: {
				path: { type: 'STRING', description: 'Path relative to the workspace root.' },
				summary: { type: 'STRING', description: 'One short German sentence explaining why (shown to the user).' }
			},
			required: ['path', 'summary']
		}
	},
	{
		name: 'run_command',
		description: 'Runs a shell command in the workspace root (e.g. tests, build, linter). Non-interactive; output is captured. Subject to user approval in review mode.',
		parameters: {
			type: 'OBJECT',
			properties: {
				command: { type: 'STRING', description: 'The command line, e.g. "npm test".' },
				cwd: { type: 'STRING', description: 'Optional working directory relative to the workspace root.' },
				timeout_sec: { type: 'INTEGER', description: 'Optional timeout in seconds.' },
				purpose: { type: 'STRING', description: 'One short German sentence: why this command (shown to the user).' }
			},
			required: ['command', 'purpose']
		}
	},
	{
		name: 'get_diagnostics',
		description: 'Returns current errors/warnings from the IDE language services (compiler, linter), optionally filtered by file.',
		parameters: {
			type: 'OBJECT',
			properties: {
				path: { type: 'STRING', description: 'Optional: only diagnostics for this file.' }
			}
		}
	},
	{
		name: 'task_complete',
		description: 'Finishes the task. Call this exactly once at the end with a German summary for the user.',
		parameters: {
			type: 'OBJECT',
			properties: {
				summary: { type: 'STRING', description: 'German summary: what was changed, which files, test results, open questions.' },
				success: { type: 'BOOLEAN', description: 'Whether the task was completed successfully.' }
			},
			required: ['summary']
		}
	}
];

/**
 * Führt einen Tool-Aufruf aus. Wirft nie – Fehler werden als {error} zurückgegeben,
 * damit das Modell darauf reagieren kann.
 * @returns {Promise<object>} JSON-serialisierbares Ergebnis für functionResponse.
 */
async function executeTool(host, name, args) {
	args = args || {};
	try {
		switch (name) {
			case 'list_files': {
				const tree = await host.listProjectFiles(clampInt(args.max_entries, 10, 2000, 250));
				return { tree };
			}
			case 'read_file': {
				requireString(args.path, 'path');
				const raw = await host.readFile(args.path);
				return formatRead(raw, args.start_line, args.end_line);
			}
			case 'search_project': {
				requireString(args.query, 'query');
				const results = await host.searchText(args.query, {
					isRegex: Boolean(args.is_regex),
					fileGlob: args.file_glob || undefined,
					maxResults: MAX_SEARCH_RESULTS
				});
				return {
					matchCount: results.length,
					truncated: results.length >= MAX_SEARCH_RESULTS,
					matches: results.map(r => `${r.path}:${r.line}: ${r.text.slice(0, 400)}`)
				};
			}
			case 'write_file': {
				requireString(args.path, 'path');
				requireString(args.content, 'content');
				const exists = await host.fileExists(args.path);
				return await host.applyChange({
					kind: 'write',
					path: args.path,
					newContent: args.content,
					summary: args.summary || (exists ? 'Datei überschreiben' : 'Neue Datei anlegen')
				});
			}
			case 'replace_in_file': {
				requireString(args.path, 'path');
				requireString(args.old_text, 'old_text');
				if (typeof args.new_text !== 'string') { throw new Error('new_text fehlt.'); }
				const current = await host.readFile(args.path);
				const occurrences = countOccurrences(current, args.old_text);
				if (occurrences === 0) {
					return { error: 'old_text wurde in der Datei nicht gefunden. Datei erneut mit read_file lesen – der Inhalt kann sich geändert haben.' };
				}
				if (occurrences > 1) {
					return { error: `old_text ist nicht eindeutig (${occurrences} Treffer). Mehr umgebende Zeilen einschließen.` };
				}
				const newContent = current.replace(args.old_text, () => args.new_text);
				return await host.applyChange({
					kind: 'write',
					path: args.path,
					newContent,
					summary: args.summary || 'Gezielte Änderung'
				});
			}
			case 'delete_file': {
				requireString(args.path, 'path');
				return await host.applyChange({
					kind: 'delete',
					path: args.path,
					summary: args.summary || 'Datei löschen'
				});
			}
			case 'run_command': {
				requireString(args.command, 'command');
				const result = await host.runCommand(args.command, {
					cwd: args.cwd || undefined,
					timeoutSec: clampInt(args.timeout_sec, 5, 1800, undefined),
					purpose: args.purpose || ''
				});
				if (result.status === 'ran') {
					return {
						exitCode: result.exitCode,
						durationMs: result.durationMs,
						stdout: capOutput(result.stdout),
						stderr: capOutput(result.stderr)
					};
				}
				return { skipped: true, message: result.message || 'Vom Benutzer abgelehnt.' };
			}
			case 'get_diagnostics': {
				const diags = await host.getDiagnostics(args.path || undefined);
				return {
					count: diags.length,
					diagnostics: diags.slice(0, 100).map(d => `${d.path}:${d.line} [${d.severity}${d.source ? '/' + d.source : ''}] ${d.message}`)
				};
			}
			case 'task_complete': {
				return { acknowledged: true };
			}
			default:
				return { error: `Unbekanntes Tool: ${name}` };
		}
	} catch (err) {
		return { error: String(err && err.message ? err.message : err) };
	}
}

function formatRead(raw, startLine, endLine) {
	const lines = raw.split(/\r?\n/);
	const total = lines.length;
	let start = clampInt(startLine, 1, total, 1);
	let end = clampInt(endLine, start, total, total);
	let slice = lines.slice(start - 1, end);
	let joined = slice.map((l, i) => `${start + i}\t${l}`).join('\n');
	let truncated = false;
	if (joined.length > MAX_READ_CHARS) {
		joined = joined.slice(0, MAX_READ_CHARS);
		truncated = true;
	}
	return {
		totalLines: total,
		shownRange: `${start}-${end}`,
		truncated,
		content: joined + (truncated ? '\n… [abgeschnitten – mit start_line/end_line gezielt lesen]' : '')
	};
}

function capOutput(text) {
	const s = String(text || '');
	if (s.length <= MAX_CMD_OUTPUT) { return s; }
	const head = s.slice(0, MAX_CMD_OUTPUT * 0.6);
	const tail = s.slice(-MAX_CMD_OUTPUT * 0.35);
	return `${head}\n… [${s.length - head.length - tail.length} Zeichen ausgelassen] …\n${tail}`;
}

function countOccurrences(haystack, needle) {
	if (!needle) { return 0; }
	let count = 0;
	let idx = haystack.indexOf(needle);
	while (idx !== -1) {
		count++;
		idx = haystack.indexOf(needle, idx + needle.length);
	}
	return count;
}

function clampInt(value, min, max, fallback) {
	const n = Number(value);
	if (!Number.isFinite(n)) { return fallback; }
	return Math.min(max, Math.max(min, Math.round(n)));
}

function requireString(value, name) {
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`Parameter "${name}" fehlt oder ist leer.`);
	}
}

module.exports = { TOOL_DECLARATIONS, executeTool, countOccurrences, capOutput };
