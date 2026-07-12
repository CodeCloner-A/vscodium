/* VSCodium Agent – Webview-Logik (ohne Abhängigkeiten). */
(function () {
	'use strict';

	const vscode = acquireVsCodeApi();

	const elMessages = document.getElementById('messages');
	const elInput = document.getElementById('input');
	const elSend = document.getElementById('btn-send');
	const elStop = document.getElementById('btn-stop');
	const elSetup = document.getElementById('setup');
	const elStatusProject = document.getElementById('status-project');
	const elModelSelect = document.getElementById('model-select');
	const elStatusMode = document.getElementById('status-mode');
	const elStatusAuth = document.getElementById('status-auth');
	const elSessionSelect = document.getElementById('session-select');
	const elNewSession = document.getElementById('btn-new-session');
	const elDelSession = document.getElementById('btn-del-session');

	let running = false;

	// ── Sitzungen ─────────────────────────────────────────────────────────────

	function renderSessions(sessions, activeId) {
		elSessionSelect.innerHTML = '';
		for (const s of sessions) {
			const opt = document.createElement('option');
			opt.value = s.id;
			const when = new Date(s.updatedAt).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
			opt.textContent = `${when} · ${s.title}`;
			if (s.id === activeId) { opt.selected = true; }
			elSessionSelect.appendChild(opt);
		}
	}

	elSessionSelect.addEventListener('change', () => {
		vscode.postMessage({ type: 'switchSession', id: elSessionSelect.value });
	});
	elNewSession.addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));

	// ── Modell-Picker (nur Gemini; Liste kommt vom Extension-Host) ───────────

	function renderModels(models, current) {
		elModelSelect.innerHTML = '';
		const entries = (models || []).slice();
		if (current && !entries.some(m => m.id === current)) {
			entries.push({ id: current, label: `${current} (aus den Einstellungen)` });
		}
		for (const m of entries) {
			const opt = document.createElement('option');
			opt.value = m.id;
			// Fester Standort (z. B. Gemini 3.x → global) wird angezeigt statt konfiguriert.
			opt.textContent = m.region ? `${m.label} (${m.region})` : m.label;
			if (m.region) { opt.title = `Standort wird automatisch gesetzt: ${m.region}`; }
			if (m.id === current) { opt.selected = true; }
			elModelSelect.appendChild(opt);
		}
	}

	elModelSelect.addEventListener('change', () => {
		vscode.postMessage({ type: 'setModel', model: elModelSelect.value });
	});

	// ── Anmeldestatus (SaaS-Login, Phase S) ───────────────────────────────────

	function renderAuth(auth) {
		if (!auth) {
			elStatusAuth.textContent = '';
			return;
		}
		elStatusAuth.textContent = auth.signedIn ? `⦿ ${auth.email || 'angemeldet'}` : '○ Anmelden';
		elStatusAuth.classList.toggle('signed-in', Boolean(auth.signedIn));
	}

	elStatusAuth.addEventListener('click', () => vscode.postMessage({ type: 'authClick' }));
	elDelSession.addEventListener('click', () => {
		if (elSessionSelect.value) {
			vscode.postMessage({ type: 'deleteSession', id: elSessionSelect.value });
		}
	});

	// ── Senden / Stoppen ──────────────────────────────────────────────────────

	function send() {
		const text = elInput.value.trim();
		if (!text || running) { return; }
		elInput.value = '';
		vscode.postMessage({ type: 'sendTask', text });
	}

	elSend.addEventListener('click', send);
	elStop.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
	elInput.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	});
	document.getElementById('btn-setkey').addEventListener('click', () => vscode.postMessage({ type: 'setApiKey' }));
	document.getElementById('btn-settings').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));

	// ── Rendering ─────────────────────────────────────────────────────────────

	function esc(s) {
		return String(s == null ? '' : s)
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	/** Sehr kleines, sicheres Markdown: Codeblöcke (mit Aktionen), Inline-Code, fett. */
	function md(s) {
		const escaped = esc(s);
		// Zeilenumbrüche im <pre> als &#10; kodieren: der abschließende \n→<br>-Ersatz darf sie
		// nicht treffen, sonst verlieren Kopieren/Übernehmen (pre.textContent) alle Umbrüche.
		const withBlocks = escaped.replace(/```([\s\S]*?)```/g, (_m, code) =>
			`<div class="codeblock"><pre>${code.replace(/^\w+\n/, '').replace(/\n/g, '&#10;')}</pre>` +
			`<div class="code-actions">` +
			`<button class="secondary" data-act="apply-code" title="Codeblock per KI in die aktive Datei integrieren (Review-Karte folgt)">In Datei übernehmen</button>` +
			`<button class="secondary" data-act="copy-code">Kopieren</button>` +
			`</div></div>`);
		return withBlocks
			.replace(/`([^`\n]+)`/g, '<code>$1</code>')
			.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
			.replace(/\n/g, '<br>');
	}

	// Codeblock-Aktionen (delegiert, da Items dynamisch gerendert werden).
	elMessages.addEventListener('click', (e) => {
		const btn = e.target && e.target.closest ? e.target.closest('button[data-act="apply-code"], button[data-act="copy-code"]') : null;
		if (!btn) { return; }
		const block = btn.closest('.codeblock');
		const pre = block ? block.querySelector('pre') : null;
		if (!pre) { return; }
		const code = pre.textContent;
		if (btn.dataset.act === 'copy-code') {
			navigator.clipboard.writeText(code).then(() => {
				const old = btn.textContent;
				btn.textContent = 'Kopiert ✓';
				setTimeout(() => { btn.textContent = old; }, 1500);
			});
		} else {
			if (running) { return; }
			vscode.postMessage({ type: 'applyCode', code });
		}
	});

	const statusLabel = {
		pending: 'wartet auf Freigabe',
		accepted: 'übernommen',
		rejected: 'abgelehnt',
		running: 'läuft…',
		ok: 'fertig',
		warn: 'Hinweis'
	};

	function render(item) {
		const div = document.createElement('div');
		div.className = 'item ' + item.kind;
		if (item.id) { div.dataset.id = item.id; }

		switch (item.kind) {
			case 'user':
				div.innerHTML = `<div class="bubble user-bubble">${md(item.text)}</div>`;
				break;
			case 'assistant':
				div.innerHTML = `<div class="bubble assistant-bubble">${md(item.text)}</div>`;
				break;
			case 'tool':
				div.innerHTML =
					`<span class="tool-icon ${item.status}"></span>` +
					`<span class="tool-detail">${esc(item.detail)}</span>` +
					`<span class="tool-result">${esc(item.result || '')}</span>`;
				break;
			case 'edit': {
				const actionLabel = { create: 'Neue Datei', modify: 'Änderung', delete: 'Löschen' }[item.action] || 'Änderung';
				div.innerHTML =
					`<div class="card-head"><span class="tag ${item.action}">${actionLabel}</span> <span class="path">${esc(item.path)}</span></div>` +
					`<div class="card-sub">${esc(item.summary || '')} <span class="lines">(${esc(item.lines || '')})</span></div>` +
					`<div class="card-actions">` +
					`<button class="secondary" data-act="diff">Diff anzeigen</button>` +
					`<button data-act="accept">Übernehmen</button>` +
					`<button class="danger" data-act="reject">Ablehnen</button>` +
					`<span class="decision"></span>` +
					`</div>`;
				wireEditCard(div, item);
				break;
			}
			case 'command': {
				// Solange die Freigabe aussteht, ist das Kommando editierbar (wird so ausgeführt).
				const cmdField = item.status === 'pending'
					? `<input class="cmd-edit" value="${esc(item.command)}" spellcheck="false" title="Kommando vor der Ausführung anpassen">`
					: `<code>${esc(item.command)}</code>`;
				div.innerHTML =
					`<div class="card-head"><span class="tag cmd">Kommando</span> ${cmdField}</div>` +
					`<div class="card-sub">${esc(item.purpose || '')} <span class="lines">(in ${esc(item.cwd || '.')})</span></div>` +
					`<div class="card-actions">` +
					`<button data-act="accept">Ausführen</button>` +
					`<button class="danger" data-act="reject">Überspringen</button>` +
					`<span class="decision"></span>` +
					`</div>`;
				wireCommandCard(div, item);
				break;
			}
			case 'done':
				div.innerHTML = `<div class="done-head">${item.success === false ? '◐ Abgeschlossen (mit offenen Punkten)' : '✔ Abgeschlossen'}</div><div class="bubble assistant-bubble">${md(item.text)}</div>`;
				break;
			case 'error':
				div.innerHTML = `<div class="error-text">${md(item.text)}</div>`;
				break;
			default: // info
				div.innerHTML = `<div class="info-text">${md(item.text)}</div>`;
		}

		elMessages.appendChild(div);
		applyDecisionState(div, item.status);
		elMessages.scrollTop = elMessages.scrollHeight;
		return div;
	}

	function wireEditCard(div, item) {
		div.querySelector('[data-act="diff"]').addEventListener('click', () => {
			vscode.postMessage({ type: 'showDiff', changeId: item.id });
		});
		div.querySelector('[data-act="accept"]').addEventListener('click', () => {
			vscode.postMessage({ type: 'editDecision', id: item.id, accept: true });
		});
		div.querySelector('[data-act="reject"]').addEventListener('click', () => {
			vscode.postMessage({ type: 'editDecision', id: item.id, accept: false });
		});
	}

	function wireCommandCard(div, item) {
		const editedCommand = () => {
			const input = div.querySelector('.cmd-edit');
			return input ? input.value : item.command;
		};
		div.querySelector('[data-act="accept"]').addEventListener('click', () => {
			vscode.postMessage({ type: 'commandDecision', id: item.id, accept: true, command: editedCommand() });
		});
		div.querySelector('[data-act="reject"]').addEventListener('click', () => {
			vscode.postMessage({ type: 'commandDecision', id: item.id, accept: false });
		});
	}

	function applyDecisionState(div, status) {
		if (!status || !div.querySelector('.card-actions')) { return; }
		const decision = div.querySelector('.decision');
		if (status === 'pending') {
			if (decision) { decision.textContent = ''; }
			return;
		}
		// Entschieden: editierbares Kommando-Feld einfrieren.
		const input = div.querySelector('.cmd-edit');
		if (input) {
			const code = document.createElement('code');
			code.textContent = input.value;
			input.replaceWith(code);
		}
		for (const btn of div.querySelectorAll('.card-actions button')) {
			if (btn.dataset.act !== 'diff') { btn.classList.add('hidden'); }
		}
		if (decision) {
			decision.textContent = statusLabel[status] || status;
			decision.className = 'decision ' + status;
		}
	}

	function setRunning(value) {
		running = value;
		elSend.classList.toggle('hidden', value);
		elStop.classList.toggle('hidden', !value);
		elInput.disabled = false;
		elSessionSelect.disabled = value;
		elModelSelect.disabled = value;
		elNewSession.disabled = value;
		elDelSession.disabled = value;
		document.body.classList.toggle('running', value);
	}

	// ── Nachrichten vom Extension-Host ───────────────────────────────────────

	window.addEventListener('message', (event) => {
		const msg = event.data;
		switch (msg.type) {
			case 'init': {
				// Entwürfe in editierbaren Kommando-Feldern überleben das Neu-Rendern
				// (jede Settings-Änderung löst init aus, auch mitten in einer Freigabe).
				const drafts = new Map();
				for (const input of elMessages.querySelectorAll('.item[data-id] .cmd-edit')) {
					drafts.set(input.closest('.item').dataset.id, input.value);
				}
				elMessages.innerHTML = '';
				elSetup.classList.toggle('hidden', msg.state.configured);
				elStatusProject.textContent = msg.state.projectId;
				renderModels(msg.state.models, msg.state.model);
				renderAuth(msg.state.auth);
				elStatusMode.textContent = msg.state.approvalMode === 'review' ? 'Review-Modus' : 'Auto-Modus';
				renderSessions(msg.state.sessions || [], msg.state.activeSessionId);
				for (const item of msg.state.items) { render(item); }
				for (const [id, value] of drafts) {
					const input = elMessages.querySelector(`.item[data-id="${id}"] .cmd-edit`);
					if (input) { input.value = value; }
				}
				setRunning(msg.state.running);
				break;
			}
			case 'sessions':
				renderSessions(msg.sessions || [], msg.activeSessionId);
				break;
			case 'append':
				render(msg.item);
				break;
			case 'toolUpdate': {
				const div = elMessages.querySelector(`.item.tool[data-id="${msg.id}"]`);
				if (div) {
					div.querySelector('.tool-icon').className = 'tool-icon ' + msg.status;
					div.querySelector('.tool-result').textContent = msg.result || '';
				}
				break;
			}
			case 'decision': {
				const div = elMessages.querySelector(`.item[data-id="${msg.id}"]`);
				if (div) {
					const input = div.querySelector('.cmd-edit');
					if (input && msg.command) { input.value = msg.command; }
					applyDecisionState(div, msg.status);
				}
				break;
			}
			case 'running':
				setRunning(Boolean(msg.value));
				break;
		}
	});

	vscode.postMessage({ type: 'ready' });
})();
