/*---------------------------------------------------------------------------------------------
 * VSCodium Agent – Lokales Fehler-Logging.
 *
 * Schreibt strukturiert in einen VS-Code-LogOutputChannel („VSCodium Agent“).
 * Bewusst ohne require('vscode'), damit lib/ headless testbar bleibt: der Channel
 * wird injiziert. Es verlassen keine Daten die Maschine (Leitplanke: keine Telemetrie).
 *--------------------------------------------------------------------------------------------*/

'use strict';

/**
 * @param {{info(m:string):void, warn(m:string):void, error(m:string):void}} channel
 *        LogOutputChannel (oder etwas mit gleicher Oberfläche, z. B. im Test).
 */
function createLogger(channel) {
	const emit = (level, message, detail) => {
		try {
			channel[level](detail !== undefined ? `${message} ${formatDetail(detail)}` : message);
		} catch (_e) { /* Logging darf nie den Agenten stören */ }
	};
	return {
		info: (message, detail) => emit('info', message, detail),
		warn: (message, detail) => emit('warn', message, detail),
		error: (message, detail) => emit('error', message, detail)
	};
}

/** Fehlerobjekte kompakt serialisieren (Message + Status/Hint), sonst JSON. */
function formatDetail(detail) {
	if (detail instanceof Error) {
		const parts = [detail.name !== 'Error' ? `[${detail.name}]` : '', detail.message];
		if (detail.status !== undefined) { parts.push(`(HTTP ${detail.status})`); }
		if (detail.hint) { parts.push(`Hinweis: ${detail.hint}`); }
		return parts.filter(Boolean).join(' ');
	}
	if (typeof detail === 'string') { return detail; }
	try {
		return JSON.stringify(detail);
	} catch (_e) {
		return String(detail);
	}
}

/** No-op-Logger für Tests und optionale Abhängigkeiten. */
const NOOP_LOGGER = {
	info: () => { },
	warn: () => { },
	error: () => { }
};

module.exports = { createLogger, formatDetail, NOOP_LOGGER };
