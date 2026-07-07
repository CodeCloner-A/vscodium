/* VSCodium Agent – Webview-Logik (ohne Abhängigkeiten). */
(function () {
	'use strict';

	const vscode = acquireVsCodeApi();

	const elMessages = document.getElementById('messages');
	const elInput = document.getElementById('input');
	const elSend = document.getElementById('btn-send');
	const elStop = document.getElementById('btn-stop');
	const elSetup = document.getElementById('setup');
	const elStatusModel = document.getElementById('status-model');
	const elStatusMode = document.getElementById('status-mode');

	let running = false;

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

	/** Sehr kleines, sicheres Markdown: Codeblöcke, Inline-Code, fett. */
	function md(s) {
		const escaped = esc(s);
		const withBlocks = escaped.replace(/```([\s\S]*?)```/g, (_m, code) => `<pre>${code.replace(/^\w+\n/, '')}</pre>`);
		return withBlocks
			.replace(/`([^`\n]+)`/g, '<code>$1</code>')
			.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
			.replace(/\n/g, '<br>');
	}

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
			case 'command':
				div.innerHTML =
					`<div class="card-head"><span class="tag cmd">Kommando</span> <code>${esc(item.command)}</code></div>` +
					`<div class="card-sub">${esc(item.purpose || '')} <span class="lines">(in ${esc(item.cwd || '.')})</span></div>` +
					`<div class="card-actions">` +
					`<button data-act="accept">Ausführen</button>` +
					`<button class="danger" data-act="reject">Überspringen</button>` +
					`<span class="decision"></span>` +
					`</div>`;
				wireCommandCard(div, item);
				break;
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
		div.querySelector('[data-act="accept"]').addEventListener('click', () => {
			vscode.postMessage({ type: 'commandDecision', id: item.id, accept: true });
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
		document.body.classList.toggle('running', value);
	}

	// ── Nachrichten vom Extension-Host ───────────────────────────────────────

	window.addEventListener('message', (event) => {
		const msg = event.data;
		switch (msg.type) {
			case 'init': {
				elMessages.innerHTML = '';
				elSetup.classList.toggle('hidden', msg.state.configured);
				elStatusModel.textContent = `${msg.state.projectId} · ${msg.state.model}`;
				elStatusMode.textContent = msg.state.approvalMode === 'review' ? 'Review-Modus' : 'Auto-Modus';
				for (const item of msg.state.items) { render(item); }
				setRunning(msg.state.running);
				break;
			}
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
				if (div) { applyDecisionState(div, msg.status); }
				break;
			}
			case 'running':
				setRunning(Boolean(msg.value));
				break;
		}
	});

	vscode.postMessage({ type: 'ready' });
})();
