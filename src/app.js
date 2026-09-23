// ─── Auth ──────────────────────────────────────────────────────────────────
// The server issues a httpOnly cookie (`web_token`) that JS cannot read, so the
// client can't check auth up-front. We optimistically render and let the first
// API 401 bounce the user to the login page.
const requireAuth = () => true;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...opts.headers,
    },
  });
  if (res.status === 401) {
    location.href = 'login.html';
    throw new Error('Unauthorized');
  }
  return res;
}

// ─── Utils ─────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function statusBadge(status) {
  const map = {
    running:   '<span class="badge badge-running">⟳ Running</span>',
    completed: '<span class="badge badge-completed" title="Завершена" aria-label="Завершена">✓</span>',
    failed:    '<span class="badge badge-failed">✕ Failed</span>',
  };
  return map[status] || (status ? `<span class="badge">${esc(status)}</span>` : '');
}

function sessionTitle(s) {
  return s.summary?.title || s.title || s.topic || s.lastUserMessage || s.id;
}

function md(text) {
  if (!text) return '';
  return marked.parse(text, { breaks: true, gfm: true });
}

// ─── Pane helpers ─────────────────────────────────────────────────────────
// Email-style shell: the list pane is always present; the conversation pane
// shows either a placeholder or the active conversation. On narrow screens we
// toggle `.convo-open` on the shell to swap which pane is visible.
const $ = id => document.getElementById(id);

function showConvo(open) {
  $('convo').classList.toggle('hidden', !open);
  $('convo-empty').classList.toggle('hidden', open);
  $('app').classList.toggle('convo-open', open);
}

function highlightActive(id) {
  document.querySelectorAll('.session-item').forEach(el =>
    el.classList.toggle('active', el.dataset.id === id));
}

// The "Продолжай" button is the recovery affordance for a session that has
// stopped (idle / completed / failed — e.g. killed at the 38-min SIGTERM). It's
// only meaningful when a session is selected AND nothing is currently streaming,
// so it's the mutual opposite of the Kill button. One helper, called wherever
// Kill's visibility changes, keeps the two in sync.
function showContinue(show) {
  $('btn-continue').classList.toggle('hidden', !show);
}

// Стоп and Дополнить only make sense while something is actually running —
// Дополнить restarts a running task with extra context, so it has the same
// visibility rule as Стоп (see spec-stop-supplement-confirm). One helper,
// called wherever Стоп's visibility changes, keeps the two in sync.
function showRunningControls(running) {
  $('btn-stop').classList.toggle('hidden', !running);
  $('btn-supplement').classList.toggle('hidden', !running);
  if (!running) hideConfirmPanel();
}

// ─── Стоп/Дополнить confirm step ─────────────────────────────────────────────
// Neither button acts on the first click — both swap the action row for an
// explicit confirm (owner: accidental Стоп clicks were a real complaint).
// See spec-stop-supplement-confirm.
let confirmAction = null; // 'stop' | 'supplement' | null

function showConfirmPanel(kind) {
  confirmAction = kind;
  $('reply-buttons').classList.add('hidden');
  $('stop-row').classList.add('hidden');
  if (kind === 'stop') {
    $('confirm-text').textContent = 'Остановить текущую задачу? Прогресс не сохранится.';
    $('btn-confirm-yes').textContent = 'Остановить';
  } else {
    const text = $('reply-input').value.trim();
    $('confirm-text').textContent = `Остановить текущий прогон и перезапустить с этим текстом как дополнительным контекстом? «${text}»`;
    $('btn-confirm-yes').textContent = 'Подтвердить и перезапустить';
  }
  $('btn-confirm-cancel').textContent = kind === 'supplement' ? 'Отмена — вернуться к тексту' : 'Отмена';
  $('confirm-panel').classList.remove('hidden');
}

function hideConfirmPanel() {
  confirmAction = null;
  $('confirm-panel').classList.add('hidden');
  $('reply-buttons').classList.remove('hidden');
  $('stop-row').classList.remove('hidden');
}

// ─── Profile ────────────────────────────────────────────────────────────────
// Show which profile is signed in, so an operator sharing this URL across
// several profiles always knows whose sessions they're looking at. The server
// resolves it from the httpOnly token; the browser can't read the token, so we
// ask /web/me. Failure is non-fatal — the label just stays empty.
async function loadProfile() {
  try {
    const res = await api('/web/me');
    const { username } = await res.json();
    if (username) $('profile-label').textContent = username;
  } catch { /* label stays empty */ }
}

// ─── Sessions list ──────────────────────────────────────────────────────────
let allSessions = [];        // full set, cached for client-side search
let searchQuery = '';
let projectFilter = '';      // selected project id, '' = all projects
let projectNames = new Map(); // projectId -> display name, for the badge on each session
let showTests = false;       // reveal auto-hidden trivial test/demo sessions

// A trivial test/demo session: the shape of a manual "does it still work?" poke,
// not real work — a ≤2-message exchange whose visible text is all short, plus the
// known seeded-demo / Playwright / chaos fixture id prefixes. These are hidden by
// default to keep the list clean, but only hidden (never dropped) — a toggle and
// any active search bring them back (see renderSessions).
function isTestSession(s) {
  if (/^(s-00[12]$|ui-test-|chaos-|test-|demo-)/.test(s.id || '')) return true;
  return false;

}


async function loadSessions() {
  if (!allSessions.length) {
    $('sessions-list').innerHTML =
      '<div class="loading" style="padding:24px;justify-content:center"><div class="spinner"></div> Loading…</div>';
  }
  try {
    const res = await api('/web/sessions');
    const sessions = await res.json();
    allSessions = Array.isArray(sessions) ? sessions : [];
    renderSessions();
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      $('sessions-list').innerHTML =
        '<div class="empty" data-testid="sessions-error" role="alert"><h3>Failed to load</h3><p>Check connection and try refreshing</p></div>';
    }
  }
}

function matchesSearch(s, q) {
  if (!q) return true;
  const hay = `${s.summary?.title || ''} ${s.summary?.gist || ''} ${s.topic || ''} ${s.title || ''} ${s.lastUserMessage || ''} ${s.lastMessage || ''} ${s.id}`.toLowerCase();
  return hay.includes(q);
}

function renderSessions() {
  const el = $('sessions-list');
  const q = searchQuery.trim().toLowerCase();
  let list = allSessions.filter(s => matchesSearch(s, q));
  if (projectFilter) list = list.filter(s => (s.projectId || '') === projectFilter);

  // Auto-hide trivial test/demo sessions in the default browse view. An active
  // search reveals everything (searching is explicit intent to find something),
  // and the toggle below surfaces them on demand — hidden, never dropped.
  const hideTests = !showTests && !q;
  const hiddenCount = hideTests ? list.filter(isTestSession).length : 0;
  if (hideTests) list = list.filter(s => !isTestSession(s));

  if (!allSessions.length) {
    el.innerHTML = '<div class="empty" data-testid="sessions-empty"><h3>No sessions yet</h3><p>Start a new session to begin</p></div>';
    return;
  }

  // Show a toggle when there are hidden test sessions, or when we're currently
  // revealing them (so the user can hide them again).
  const toggle = (hiddenCount || (showTests && !q))
    ? `<button class="list-tests-toggle" id="btn-toggle-tests" data-testid="toggle-tests">${
        showTests ? '▾ Hide test sessions' : `▸ Show ${hiddenCount} test session${hiddenCount === 1 ? '' : 's'}`}</button>`
    : '';

  if (!list.length) {
    el.innerHTML = (q
      ? `<div class="empty" data-testid="sessions-no-match"><p>No sessions match “${esc(searchQuery)}”</p></div>`
      : `<div class="empty" data-testid="sessions-all-hidden"><p>${projectFilter ? 'No sessions in this project.' : 'Only test sessions here — all hidden.'}</p></div>`)
      + toggle;
    wireTestsToggle();
    return;
  }

  el.innerHTML = list.map(s => `
    <div class="session-item" data-testid="session-item" data-id="${esc(s.id)}" role="listitem">
      <div class="session-info">
        <div class="session-path">${esc(sessionTitle(s))}</div>
        ${s.summary?.gist ? `<div class="session-summary">${esc(s.summary.gist)}</div>` : ''}
        <div class="session-meta">${timeAgo(s.lastAt || s.createdAt)}${s.messageCount ? ` · ${s.messageCount} msg` : ''}</div>
        ${(!projectFilter && s.projectId && projectNames.get(s.projectId)) ? `<div class="session-project">${esc(projectNames.get(s.projectId))}</div>` : ''}
      </div>
      ${statusBadge(s.status)}
    </div>
  `).join('') + toggle;
  el.querySelectorAll('.session-item').forEach(item =>
    item.addEventListener('click', () => navigate(`/session/${item.dataset.id}`))
  );
  wireTestsToggle();
  highlightActive(currentSessionId);
}

function wireTestsToggle() {
  const b = $('btn-toggle-tests');
  if (b) b.addEventListener('click', () => { showTests = !showTests; renderSessions(); });
}

// ─── Session detail ─────────────────────────────────────────────────────────
// Bumped by every navigation (route() dispatch) so a route() that's still
// awaiting its prefetch when a newer navigation lands can recognize it's
// stale and bail out instead of re-dispatching late.
let navSeq = 0;
let currentSessionId = null;
let streamAbort = null;
let pollTimer = null;
let streaming = false; // true whenever a run/reply request is in flight

// Reply drafts belong to a session; switching sessions never sends or
// discards them. (New-session drafts live in #create-panel's own state —
// see "Sidebar: new session" below — since that panel isn't a navigation
// destination.)
const composerDrafts = new Map();
let draftDestination = null;
let sessionRunning = false;
let dispatching = false;
function rememberDraft() {
  if (!draftDestination) return;
  composerDrafts.set(draftDestination, {
    message: $('reply-input').value, attachments: pendingAttachments.slice(),
  });
}
function openDraft(destination) {
  if (destination === draftDestination) return;
  rememberDraft();
  draftDestination = destination;
  const draft = composerDrafts.get(destination);
  $('reply-input').value = draft?.message || '';
  pendingAttachments = draft?.attachments?.slice() || [];
  renderAttachments();
  setAttachHint('');
}
function updateSendLabel() {
  const busy = streaming || sessionRunning || dispatching;
  $('btn-send').textContent = busy ? 'Выполняется…' : 'Отправить';
  $('btn-send').disabled = busy || !currentSessionId;
  const notice = $('composer-notice');
  notice.textContent = busy ? 'Можно подготовить следующий ответ. Отправка станет доступна после завершения.' : '';
  notice.classList.toggle('hidden', !busy);
}

async function loadSession(id) {
  closeCreatePanel();
  openDraft(id);
  sessionRunning = false;
  currentSessionId = id;
  showConvo(true);
  highlightActive(id);
  $('session-title').textContent = id;
  $('session-status').innerHTML = '';
  $('session-project-badge').classList.add('hidden');
  $('messages-container').innerHTML =
    '<div class="loading" style="padding:24px;justify-content:center"><div class="spinner"></div> Loading…</div>';
  $('stream-area').classList.add('hidden');
  $('activity-area').classList.add('hidden');
  showRunningControls(false); // renderSession re-enables it once we know the status
  showContinue(false);
  clearInterval(pollTimer);

  try {
    const res = await api(`/web/session/${id}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const session = await res.json();
    if (currentSessionId !== id) return;
    renderSession(session);
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      $('messages-container').innerHTML =
        '<div class="empty" data-testid="session-error" role="alert"><h3>Failed to load session</h3></div>';
    }
  }
}

// Render at most COLLAPSE_TAIL recent messages; older ones stay behind a toggle
// so long histories don't blow up the DOM / slow first paint.
const COLLAPSE_TAIL = 6;

function fmtSize(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

// Render attachments carried on a stored message (thumbnails for images, a file
// chip otherwise). Each links to /web/file/:id served by the worker.
function attachmentsHtml(atts) {
  if (!Array.isArray(atts) || !atts.length) return '';
  const items = atts.map(a => {
    const isImg = (a.type || '').startsWith('image/');
    return isImg
      ? `<a class="msg-attach msg-attach-img" href="${esc(a.url)}" target="_blank" rel="noopener" title="${esc(a.name)}"><img src="${esc(a.url)}" alt="${esc(a.name)}" loading="lazy"></a>`
      : `<a class="msg-attach msg-attach-file" href="${esc(a.url)}" target="_blank" rel="noopener"><span class="attach-icon">📄</span><span class="attach-name">${esc(a.name)}</span><span class="attach-size">${esc(fmtSize(a.size))}</span></a>`;
  }).join('');
  return `<div class="msg-attachments" data-testid="msg-attachments">${items}</div>`;
}

function messageHtml(m) {
  return `
    <div class="message message-${esc(m.role)}" data-testid="message" data-role="${esc(m.role)}">
      <div class="message-head">
        <span class="message-role">${m.role === 'user' ? 'You' : 'Claude'}</span>
        <button class="msg-copy" type="button" data-copy="msg" data-testid="copy-message"
                title="Copy message" aria-label="Copy message">⧉</button>
      </div>
      <div class="message-content${m.role === 'assistant' ? ' md-content' : ''}">${
        m.role === 'assistant' ? md(m.content) : esc(m.content)
      }</div>
      ${attachmentsHtml(m.attachments)}
    </div>`;
}

// ─── Copy to clipboard ────────────────────────────────────────────────────────
// Two affordances, one mechanism: a per-message button (copies the whole message
// text) and a button on every fenced code block (copies the exact code). Both
// carry data-copy and are handled by a single delegated click listener, so any
// message rendered now or later — history, stream reload, reply — gets working
// copy with no extra wiring. Clipboard API with an execCommand fallback for
// non-secure contexts.
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path below */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

function flashCopied(btn) {
  btn.classList.add('copied');
  btn.textContent = '✓';
  clearTimeout(btn._copyTimer);
  btn._copyTimer = setTimeout(() => { btn.classList.remove('copied'); btn.textContent = '⧉'; }, 1200);
}

// Add a copy button to each fenced code block under `root` (idempotent — skips
// blocks already decorated, so it's safe to call after every re-render).
function decorateCodeBlocks(root) {
  root.querySelectorAll('pre').forEach(pre => {
    if (pre.querySelector('.code-copy')) return;
    const btn = document.createElement('button');
    btn.className = 'code-copy';
    btn.type = 'button';
    btn.textContent = '⧉';
    btn.setAttribute('data-copy', 'code');
    btn.setAttribute('data-testid', 'copy-code');
    btn.setAttribute('title', 'Copy code');
    btn.setAttribute('aria-label', 'Copy code');
    pre.appendChild(btn);
  });
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  let text = '';
  if (btn.dataset.copy === 'code') {
    const pre = btn.closest('pre');
    const code = pre && pre.querySelector('code');
    text = (code || pre || {}).innerText || '';
  } else {
    const content = btn.closest('.message')?.querySelector('.message-content');
    text = content ? content.innerText : '';
  }
  if (text && await copyToClipboard(text)) flashCopied(btn);
});

function renderSession(session) {
  sessionRunning = session.status === 'running';
  updateSendLabel();
  const { id, status, messages, lastMessage } = session;
  $('session-title').textContent = sessionTitle(session) || session.path || id;
  $('session-status').innerHTML = statusBadge(status);
  const badge = $('session-project-badge');
  const projectName = session.projectId ? projectNames.get(session.projectId) : null;
  if (projectName) { badge.textContent = `📁 ${projectName}`; badge.classList.remove('hidden'); }
  else badge.classList.add('hidden');
  $('composer-project').textContent = projectName || session.projectId || 'Без проекта';
  $('composer-project').classList.remove('hidden');

  const msgs = Array.isArray(messages) && messages.length
    ? messages
    : (lastMessage ? [{ role: 'assistant', content: lastMessage }] : []);

  const container = $('messages-container');
  if (!msgs.length) {
    container.innerHTML = '<div class="empty" data-testid="messages-empty" style="padding:32px"><p>No messages yet</p></div>';
  } else if (msgs.length > COLLAPSE_TAIL) {
    const hiddenCount = msgs.length - COLLAPSE_TAIL;
    const older = msgs.slice(0, hiddenCount).map(messageHtml).join('');
    const recent = msgs.slice(hiddenCount).map(messageHtml).join('');
    container.innerHTML =
      `<button class="collapse-toggle" data-testid="show-earlier">▾ Show ${hiddenCount} earlier message${hiddenCount > 1 ? 's' : ''}</button>` +
      `<div id="older-messages" class="hidden" data-testid="older-messages">${older}</div>` +
      recent;
    const toggle = container.querySelector('[data-testid="show-earlier"]');
    toggle.addEventListener('click', () => {
      const box = $('older-messages');
      const nowHidden = box.classList.toggle('hidden');
      toggle.textContent = nowHidden
        ? `▾ Show ${hiddenCount} earlier message${hiddenCount > 1 ? 's' : ''}`
        : `▴ Hide earlier messages`;
    });
  } else {
    container.innerHTML = msgs.map(messageHtml).join('');
  }
  decorateCodeBlocks(container);

  if (status === 'running') {
    showRunningControls(true);
    showContinue(false);
    startPolling(id);
  } else {
    showRunningControls(false);
    showContinue(!!currentSessionId);
  }

  scrollBottom();
}

function scrollBottom() {
  const c = $('messages-container');
  c.scrollTop = c.scrollHeight;
}

// ─── Polling for running sessions ───────────────────────────────────────────
function startPolling(sessionId) {
  const streamEl = $('stream-area');
  streamEl.classList.remove('hidden');
  streamEl.innerHTML = '<div class="loading"><div class="spinner"></div> Waiting for output…</div>';

  clearInterval(pollTimer);
  const started = Date.now();
  pollTimer = setInterval(async () => {
    if (currentSessionId !== sessionId) { clearInterval(pollTimer); return; }
    try {
      const res = await api(`/web/session/${sessionId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const session = await res.json();
      if (currentSessionId !== sessionId) return;
      if (session.status !== 'running') {
        clearInterval(pollTimer);
        renderSession(session);
        streamEl.classList.add('hidden');
      } else {
        streamEl.innerHTML = `<div class="loading"><div class="spinner"></div>Агент работает · проверено ${new Date().toLocaleTimeString()} · ожидание ${Math.floor((Date.now() - started) / 1000)} с</div>`;
      }
    } catch {
      if (currentSessionId === sessionId) streamEl.textContent = 'Не удалось проверить состояние. Повторяю…';
    }
  }, 2500);
}

// ─── SSE streaming via POST ─────────────────────────────────────────────────
async function startStream(endpoint, body, appendUserMsg = null, appendAtts = null) {
  clearInterval(pollTimer);
  if (streamAbort) streamAbort.abort();
  const controller = new AbortController();
  streamAbort = controller;

  const streamEl = $('stream-area');
  const notice   = $('reconnect-notice');

  streaming = true;
  updateSendLabel();

  if (appendUserMsg || (appendAtts && appendAtts.length)) {
    const c = $('messages-container');
    const empty = c.querySelector('.empty');
    if (empty) empty.remove();
    const div = document.createElement('div');
    div.className = 'message message-user';
    div.innerHTML = `<div class="message-role">You</div><div class="message-content">${esc(appendUserMsg || '')}</div>${attachmentsHtml(appendAtts)}`;
    c.appendChild(div);
    scrollBottom();
  }

  streamEl.classList.remove('hidden');
  streamEl.className = 'stream-area active';
  streamEl.innerHTML = '<div class="loading"><div class="spinner"></div>Отправляю задачу…</div>';
  showRunningControls(true);
  showContinue(false); // a stream is active — nothing to "continue" yet

  let buffer = '';
  let delivered = false;
  const startedAt = Date.now();
  let lastSignal = 0;
  let activityText = '';
  const activityTimer = setInterval(() => {
    if (controller.signal.aborted) return;
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    const quiet = lastSignal ? Math.floor((Date.now() - lastSignal) / 1000) : elapsed;
    const state = quiet > 45 ? 'Нет обновлений от сервера — проверяю соединение' : lastSignal ? 'Соединение открыто. Ожидаю ответ агента' : 'Подключаюсь к агенту';
    const activity = $('activity-area');
    activity.classList.remove('hidden');
    activity.innerHTML = `<div class="loading"><div class="spinner"></div>${esc(quiet > 45 ? state : activityText || state)} · ${elapsed} с</div>`;
    if (!buffer) streamEl.innerHTML = '';
  }, 1000);

  // A dropped POST is ambiguous: reconnect must eventually use a read-only
  // resume token. Never repeat a mutation to recover a display stream.
  const tryConnect = async () => {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify(body),
      });

      if (res.status === 401) { location.href = 'login.html'; return; }

      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }

      notice.classList.add('hidden');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';

      while (true) {
        if (controller.signal.aborted) break;
        const { done, value } = await reader.read();
        if (done || controller.signal.aborted || streamAbort !== controller) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          lastSignal = Date.now();
          if (raw === '{}') continue; // heartbeat confirms connection, not model progress
          try {
            const msg = JSON.parse(raw);
            if (msg.type === 'progress' || msg.type === 'status') {
              activityText = msg.message || msg.text || '';
            } else if (msg.type === 'chunk' && msg.text) {
              buffer += msg.text;
              streamEl.innerHTML = `<div class="md-content">${md(buffer)}</div>`;
              scrollBottom();
            } else if (msg.type === 'done') {
              delivered = true;
              clearInterval(activityTimer);
              $('activity-area').classList.add('hidden');
              const sid = msg.sessionId || currentSessionId;
              if (sid) {
                currentSessionId = sid;
                navigate(`/session/${sid}`, false); // reflect real id in the URL
                await loadSession(sid);
              } else {
                // No id came back (e.g. task produced no session) — refresh the list
                // and say so explicitly. Silently stopping here used to leave the
                // composer frozen on "Отправляю задачу…" forever with no feedback,
                // which read as a hang (task actually finished server-side).
                await loadSessions();
                streamEl.innerHTML = '<div class="err" data-testid="stream-error" role="alert">'
                  + 'Задача выполнена, но сессию не удалось определить автоматически — откройте её в списке слева.</div>';
              }
              return;
            } else if (msg.type === 'error') {
              streamEl.innerHTML = `<div class="err" data-testid="stream-error" role="alert">${esc(msg.error || msg.message || 'Error')}</div>`;
              finalise();
              return;
            }
          } catch {}
        }
      }

      if (!controller.signal.aborted) throw new Error('Поток закрыт без подтверждения выполнения');
    } catch (err) {
      if (controller.signal.aborted || err.name === 'AbortError') return;
      streamEl.innerHTML = `<div class="err" data-testid="stream-error" role="alert">${esc(err.message)}</div>`;
    }

  };

  function finalise() {
    clearInterval(activityTimer);
    if (streamAbort !== controller) return;
    $('activity-area').classList.add('hidden');
    showRunningControls(sessionRunning);
    streaming = false;
    updateSendLabel();
    // Only drop the `active` accent — leave `hidden` untouched. On `done` the
    // reload (loadSession) hides the stream area after re-rendering the thread;
    // if we reset the whole className here we'd un-hide it and show the finished
    // stream text a second time below the persisted message. On error the area
    // stays visible (we never set hidden) so the error remains readable.
    streamEl.classList.remove('active');
    notice.classList.add('hidden');
    // Stream is over (done reloads via loadSession; error stays here) — offer
    // Continue again so the user can nudge a stalled/errored session forward.
    showContinue(!!currentSessionId && !sessionRunning);

  }

  await tryConnect();
  finalise();
  return delivered;
}

// ─── Import sessions from files ───────────────────────────────────────────────
// Reads one or more session JSON files (agent transcript format) and POSTs them
// to /web/import so they appear in the list as history. Each file may hold a
// single session object or an array of them.
async function importFiles(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return;
  const btn = $('btn-import');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Importing…';
  let total = 0, failed = 0;
  try {
    for (const file of files) {
      try {
        const parsed = JSON.parse(await file.text());
        const res = await api('/web/import', { method: 'POST', body: JSON.stringify(parsed) });
        const data = await res.json();
        total += (data && data.imported) || 0;
      } catch { failed++; }
    }
  } finally {
    btn.disabled = false;
    btn.textContent = original;
    $('import-file').value = '';
  }
  await loadSessions();
  const note = failed
    ? `Imported ${total} session(s), ${failed} file(s) failed to parse.`
    : `Imported ${total} session(s).`;
  const el = $('sessions-list');
  const banner = document.createElement('div');
  banner.className = 'empty';
  banner.setAttribute('data-testid', 'import-result');
  banner.setAttribute('role', 'status');
  banner.style.cssText = 'padding:10px;margin-bottom:8px';
  banner.textContent = note;
  el.prepend(banner);
  setTimeout(() => banner.remove(), 4000);
}

// ─── Sidebar: new session ─────────────────────────────────────────────────
// "+ New" opens a small self-contained panel in the sidebar (project picker,
// task textarea, attachments) instead of putting the reply composer into a
// "compose" mode. The old design routed creation through a composingNew flag
// and a '/new' hash so it could reuse the reply box — but that made the
// composer a shared destination between "new session" and "reply to
// session", and every navigation race between the two (#26, #28) was a
// symptom of that sharing, not of routing per se. This panel isn't a
// navigation destination and shares no state with the reply composer, so
// that whole bug class doesn't apply here. Cancel just hides it — the
// draft (project/text/attachments) stays in its DOM until Send, so
// reopening "+ New" restores it for free.
let createOpen = false;
let createBusy = false;
let createProjectsReady = false;

function updateCreateSendState() {
  $('btn-create-send').disabled = createBusy || !createProjectsReady;
  $('btn-create-send').textContent = createBusy ? 'Выполняется…' : 'Начать';
}

function openCreatePanel() {
  if (voiceBusy || recording) return;
  createOpen = true;
  $('create-panel').classList.remove('hidden');
  loadNewSessionFolders($('folder-select').value || projectFilter);
  $('create-input').focus();
}
function closeCreatePanel() {
  if (!createOpen) return;
  createOpen = false;
  $('create-panel').classList.add('hidden');
}

// Populate the project-folder select from the agent's project list. `selectPath`
// pre-selects a project id (used right after creating one).
async function loadNewSessionFolders(selectPath) {
  createProjectsReady = false;
  updateCreateSendState();
  const sel = $('folder-select');
  selectPath ||= sel.value;
  sel.innerHTML = '<option value="">Loading folders…</option>';
  sel.disabled  = true;
  try {
    const res  = await api('/web/files/tree');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Project list unavailable');
    const tree = data.tree || [];
    renderProjects(tree);
    if (!tree.length) {
      sel.innerHTML = '<option value="">No folders available</option>';
    } else {
      sel.innerHTML = '<option value="">No project (optional)</option>' +
        tree.map(f => `<option value="${esc(f.path)}">${esc(f.name)}</option>`).join('');
      sel.disabled = false;
      if (selectPath) sel.value = selectPath;
    }
    createProjectsReady = true;
    updateCreateSendState();
    return true;
  } catch {
    setCreateHint('Не удалось загрузить проекты. Нажмите «+ New», чтобы повторить.', 'error');
    sel.innerHTML = '<option value="">Failed to load folders</option>';
    return false;
  }
}

// Populates the sidebar project filter (not the create-panel's folder-select,
// which loadNewSessionFolders owns) and the projectId → name lookup used for
// the per-session badge. This dropdown is purely a filter over the existing
// session list.
function renderProjects(tree) {
  projectNames = new Map(tree.map(p => [p.path, p.name]));
  const sel = $('project-filter');
  const prev = sel.value;
  sel.innerHTML = '<option value="">Все проекты</option>' +
    tree.map(p => `<option value="${esc(p.path)}">${esc(p.name)}</option>`).join('');
  if (tree.some(p => p.path === prev)) sel.value = prev;
  else projectFilter = '';
  renderSessions();
}

async function loadProjects() {
  try {
    const res = await api('/web/files/tree');
    if (!res.ok) throw new Error('unavailable');
    renderProjects((await res.json()).tree || []);
  } catch {
    // Non-fatal: the filter just stays at "Все проекты" until a retry succeeds.
  }
}

// Create a project via the worker → agent, then refresh the folder list and select
// the new project. Errors surface in the inline role=alert box, not a blocking alert.
async function createProject() {
  const nameEl = $('new-project-name');
  const typeEl = $('new-project-type');
  const errEl  = $('new-project-error');
  const btn    = $('btn-create-project');
  const name   = nameEl.value.trim();
  errEl.classList.add('hidden');
  if (!name) { nameEl.focus(); return; }
  btn.disabled = true;
  btn.textContent = 'Creating…';
  try {
    const res = await api('/web/project-create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, type: typeEl.value || undefined }),
    });
    const data = await res.json();
    if (!res.ok || !data.project) throw new Error(data.error || `HTTP ${res.status}`);
    const loaded = await loadNewSessionFolders(data.project.id);
    const sel = $('folder-select');
    if (!loaded || sel.value !== data.project.id) {
      sel.add(new Option(data.project.name, data.project.id));
      sel.disabled = false;
      sel.value = data.project.id;
    }
    createProjectsReady = true;
    updateCreateSendState();
    const notice = $('project-notice');
    notice.textContent = `Проект «${data.project.name}» создан и выбран. ${loaded ? '' : 'Список временно недоступен.'}`;
    notice.classList.remove('hidden');
    await loadProjects();
    $('new-project-form').classList.add('hidden');
    nameEl.value = '';
  } catch (err) {
    errEl.textContent = 'Could not create project: ' + err.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create';
  }
}

// ─── Reproject: restructure the profile's projects ───────────────────────────
// The "⟳" button opens a modal: run the cheap-model preview → show the proposed
// project structure → the user can move sessions between projects and rename
// projects (adjust) → apply (reversible) → revert. All via the worker→agent
// bearer proxy (/web/reproject-*), same single source of truth as the bot.
let rpPlan = null; // the current proposed plan

function openReproject() {
  $('reproject-modal').classList.remove('hidden');
  $('reproject-actions').classList.add('hidden');
  rpPlan = null;
  $('reproject-body').innerHTML =
    '<div class="loading"><span class="spinner"></span> Анализирую сессии дешёвой моделью…</div>';
  runReprojectPreview();
}

function closeReproject() {
  $('reproject-modal').classList.add('hidden');
}

async function runReprojectPreview() {
  const body = $('reproject-body');
  try {
    const res = await api('/web/reproject-preview', { method: 'POST' });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    rpPlan = data.plan || null;
    renderReprojectPlan(data);
  } catch (err) {
    body.innerHTML = `<div class="err" role="alert" data-testid="reproject-error">Переструктурирование не удалось: ${esc(err.message)}</div>`;
  }
}

// Render the plan as editable projects: each project shows its name (editable)
// and its sessions (each with a dropdown to move it to another project).
function renderReprojectPlan(data) {
  const body = $('reproject-body');
  const plan = rpPlan || (data && data.plan) || [];
  if (!plan || !plan.projects) {
    body.innerHTML = '<div class="err" role="alert">Нет данных для отображения.</div>';
    return;
  }
  const projects = plan.projects || [];
  const clusterOf = (sid) => (projects.find(p => (p.sessionIds || []).includes(sid)) || {}).cluster;
  const opts = (sid) => projects.map(p =>
    `<option value="${esc(p.cluster)}" ${p.cluster === clusterOf(sid) ? 'selected' : ''}>${esc(p.name)}</option>`).join('');

  const html = projects.map(p => {
    const clarity = p.clarity || 'mixed';
    const conf = p.avgConfidence == null ? '' : ` · уверенность ${Math.round(p.avgConfidence * 100)}%`;
    const sessions = (p.memberTopics && p.memberTopics.length ? p.memberTopics : (p.sessionIds || []).map(id => ({ id })))
      .map(m => `<div class="rp-session" data-testid="rp-session" data-session="${esc(m.id)}">
        <span class="rp-session-topic" title="${esc(m.topic || '')}">${esc(m.topic || m.id)}</span>
        <select data-testid="rp-move" data-session="${esc(m.id)}" aria-label="Перенести сессию">${opts(m.id)}</select>
      </div>`).join('');
    return `<div class="rp-project" data-testid="rp-project" data-cluster="${esc(p.cluster)}">
      <div class="rp-project-head">
        <span class="rp-project-name"><input data-testid="rp-name" data-cluster="${esc(p.cluster)}"
          value="${esc(p.name)}" aria-label="Имя проекта" /></span>
        <span class="rp-clarity ${esc(clarity)}">${esc(clarity)}</span>
      </div>
      <div class="rp-project-meta">${p.sessionCount} сессий · тип ${esc(p.type || 'generic')}${conf}${p.existingProjectId ? ` · папка: ${esc(p.existingProjectId)}` : ' · новая папка'}</div>
      <div>${sessions}</div>
    </div>`;
  }).join('');

  const unassigned = (plan.unassigned || []).map(u =>
    `<li class="rp-unassigned">«${esc(u.topic || u.id)}»</li>`).join('');

  body.innerHTML = `
    <p class="rp-hint">Предлагаемая структура — сессии сгруппированы дешёвой моделью. Перенесите сессии в нужные проекты, переименуйте, затем «Применить». Ничего не перемещено, всё обратимо.</p>
    ${(plan.warnings || []).map(w => `<div class="rp-warning" role="note">${esc(w)}</div>`).join('')}
    ${html}
    ${unassigned ? `<div class="rp-project"><div class="rp-project-meta">Без проекта (${plan.unassigned.length})</div><ul>${unassigned}</ul></div>` : ''}
  `;
  $('reproject-actions').classList.remove('hidden');

  // Wire the "move" dropdowns: onChange → persist an adjust to the agent.
  body.querySelectorAll('[data-testid="rp-move"]').forEach(sel => {
    sel.addEventListener('change', () => adjustReprojectSession(sel.dataset.session, sel.value));
  });
  // Wire the name inputs: on blur → persist a rename.
  body.querySelectorAll('[data-testid="rp-name"]').forEach(inp => {
    inp.addEventListener('change', () => adjustReprojectRename(inp.dataset.cluster, inp.value));
  });
}

// Move one session to another project (persists via /web/reproject-adjust).
async function adjustReprojectSession(sessionId, toCluster) {
  if (!toCluster) return;
  try {
    const res = await api('/web/reproject-adjust', {
      method: 'POST',
      body: JSON.stringify({ moves: [{ sessionId, toCluster }] }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    rpPlan = data.plan || rpPlan;
    renderReprojectPlan(data);
  } catch (err) {
    // Non-fatal: keep the modal open, show a note near the top.
    const hint = $('reproject-body').querySelector('.rp-hint');
    if (hint) hint.textContent = `⚠ Не удалось перенести: ${err.message}. Попробуйте ещё раз.`;
  }
}

// Rename a project (persists via /web/reproject-adjust).
async function adjustReprojectRename(cluster, name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return;
  try {
    const res = await api('/web/reproject-adjust', {
      method: 'POST',
      body: JSON.stringify({ renames: [{ cluster, name: trimmed }] }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    rpPlan = data.plan || rpPlan;
    renderReprojectPlan(data);
  } catch (err) {
    const hint = $('reproject-body').querySelector('.rp-hint');
    if (hint) hint.textContent = `⚠ Не удалось переименовать: ${err.message}.`;
  }
}

// Apply the (possibly adjusted) plan — reversible.
async function applyReproject() {
  const btn = $('btn-reproject-apply');
  btn.disabled = true;
  btn.textContent = 'Применяю…';
  try {
    const res = await api('/web/reproject-apply', {
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    $('reproject-body').innerHTML =
      `<p class="rp-hint" data-testid="reproject-applied">✓ Перемещено сессий: ${data.sessionsMoved}. Проекты: ${data.projectsAffected}. Обратимо — «↩ Откатить».</p>`;
    await loadProjects();
    await loadNewSessionFolders($('folder-select').value);
    $('btn-reproject-revert').disabled = false;
  } catch (err) {
    $('reproject-body').innerHTML =
      `<div class="err" role="alert">Не удалось применить: ${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '✓ Применить';
  }
}

// Revert the last apply (from the ledger).
async function revertReproject() {
  const btn = $('btn-reproject-revert');
  btn.disabled = true;
  try {
    const res = await api('/web/reproject-revert', { method: 'POST' });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    $('reproject-body').innerHTML =
      `<p class="rp-hint" data-testid="reproject-reverted">↩ Откат: сессий возвращено — ${data.reverted}.</p>`;
    await loadProjects();
    await loadNewSessionFolders($('folder-select').value);
  } catch (err) {
    $('reproject-body').innerHTML =
      `<div class="err" role="alert">Не удалось откатить: ${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

// Staged attachments for the create-panel — the same stage-then-upload-on-
// submit pattern as the reply composer's pendingAttachments (see below), but
// a separate array/DOM so the two composers never share state.
let createAttachments = []; // { file, name, size, type, localUrl }

function setCreateHint(text, kind = '') {
  const el = $('create-hint');
  if (!text) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.classList.remove('hidden');
  el.className = `voice-status${kind ? ' voice-' + kind : ''}`;
  el.textContent = text;
}

function renderCreateAttachments() {
  const el = $('create-attachments');
  if (!createAttachments.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  el.innerHTML = createAttachments.map((a, i) => `
    <div class="attach-chip" data-testid="create-attach-chip" data-idx="${i}">
      ${a.localUrl
        ? `<img class="attach-thumb" src="${a.localUrl}" alt="">`
        : `<span class="attach-icon">📄</span>`}
      <span class="attach-name">${esc(a.name)}</span>
      <span class="attach-size">${esc(fmtSize(a.size))}</span>
      <button class="attach-remove" data-testid="create-attach-remove" data-idx="${i}" aria-label="Remove ${esc(a.name)}" title="Remove">✕</button>
    </div>`).join('');
  el.querySelectorAll('.attach-remove').forEach(b =>
    b.addEventListener('click', () => {
      const a = createAttachments[+b.dataset.idx];
      if (a && a.localUrl) URL.revokeObjectURL(a.localUrl);
      createAttachments.splice(+b.dataset.idx, 1);
      renderCreateAttachments();
    }));
}

function addCreateFiles(fileList) {
  const files = [...(fileList || [])];
  let skipped = 0;
  for (const f of files) {
    if (f.size > MAX_ATTACH) { skipped++; continue; }
    const type = f.type || 'application/octet-stream';
    createAttachments.push({
      file: f,
      name: f.name || (type.startsWith('image/') ? `screenshot.${(type.split('/')[1] || 'png')}` : 'file'),
      size: f.size,
      type,
      localUrl: type.startsWith('image/') ? URL.createObjectURL(f) : null,
    });
  }
  renderCreateAttachments();
  if (skipped) setCreateHint(`${skipped} file(s) skipped — max 3MB each`, 'error');
  else if (files.length) setCreateHint(`${createAttachments.length} attachment(s) ready`, 'ok');
}

async function sendCreate() {
  if (voiceBusy || recording) return;
  if (createBusy || !createProjectsReady) return;
  const message = $('create-input').value.trim();
  if (!message && !createAttachments.length) return;
  const project = $('folder-select').value;
  const files = createAttachments.slice();
  createBusy = true;
  updateCreateSendState();

  // Reset the center/right panes into an empty session view so startStream()
  // (below) has somewhere to render "You: <message>" and live progress into
  // while the backend works out a session id — the same elements a loaded
  // session uses, just not attached to any id yet.
  if (streamAbort) streamAbort.abort();
  streamAbort = null;
  clearInterval(pollTimer);
  sessionRunning = false;
  currentSessionId = null;
  streaming = false;
  // openDraft (not a direct reset) so an unsent reply typed for the session
  // we're leaving gets saved to composerDrafts instead of silently dropped.
  openDraft(null);
  showConvo(true);
  highlightActive(null);
  $('session-title').textContent = 'Новая сессия';
  $('session-status').innerHTML = '';
  $('session-project-badge').classList.add('hidden');
  $('composer-project').classList.add('hidden');
  $('messages-container').innerHTML = '';
  $('stream-area').classList.add('hidden');
  $('activity-area').classList.add('hidden');
  showRunningControls(false);
  showContinue(false);
  updateSendLabel();

  try {
    const attachments = await uploadFiles(files);
    $('create-input').value = '';
    createAttachments.forEach(a => a.localUrl && URL.revokeObjectURL(a.localUrl));
    createAttachments = [];
    renderCreateAttachments();
    closeCreatePanel();
    const task = project ? `[Work in folder: ${project}]\n\n${message}` : message;
    // startStream navigates into the real session once the backend returns a
    // sessionId (see its `done` handler) — same path an existing session's
    // reply takes, so there's no separate "new session" outcome to keep in
    // sync with.
    await startStream('/web/run', { task, attachments }, message, attachments);
  } catch (err) {
    setCreateHint(`Не удалось отправить: ${err.message}. Черновик сохранён.`, 'error');
  } finally {
    createBusy = false;
    updateCreateSendState();
  }
}

// ─── File attachments (drag-drop / paste) ────────────────────────────────────
// UX: dropping or pasting files just *stages* them as chips next to the reply —
// nothing is uploaded yet, so the user can add/remove before committing. The
// actual upload happens on Send (see dispatchMessage), matching "insert the name now,
// upload on submit". Images get a live thumbnail via a local object URL.
const MAX_ATTACH = 3 * 1024 * 1024;
let pendingAttachments = []; // { file, name, size, type, localUrl }

function setAttachHint(text, kind = '') {
  const el = $('attach-hint');
  if (!text) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.classList.remove('hidden');
  el.className = `voice-status${kind ? ' voice-' + kind : ''}`;
  el.textContent = text;
}

function renderAttachments() {
  const el = $('attachments');
  if (!pendingAttachments.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  el.innerHTML = pendingAttachments.map((a, i) => `
    <div class="attach-chip" data-testid="attach-chip" data-idx="${i}">
      ${a.localUrl
        ? `<img class="attach-thumb" src="${a.localUrl}" alt="">`
        : `<span class="attach-icon">📄</span>`}
      <span class="attach-name">${esc(a.name)}</span>
      <span class="attach-size">${esc(fmtSize(a.size))}</span>
      <button class="attach-remove" data-testid="attach-remove" data-idx="${i}" aria-label="Remove ${esc(a.name)}" title="Remove">✕</button>
    </div>`).join('');
  el.querySelectorAll('.attach-remove').forEach(b =>
    b.addEventListener('click', () => removeAttachment(+b.dataset.idx)));
}

function removeAttachment(idx) {
  const a = pendingAttachments[idx];
  if (a && a.localUrl) URL.revokeObjectURL(a.localUrl);
  pendingAttachments.splice(idx, 1);
  renderAttachments();
}

function clearAttachments() {
  pendingAttachments.forEach(a => a.localUrl && URL.revokeObjectURL(a.localUrl));
  pendingAttachments = [];
  renderAttachments();
}

function addFiles(fileList) {
  const files = [...(fileList || [])];
  let skipped = 0;
  for (const f of files) {
    if (f.size > MAX_ATTACH) { skipped++; continue; }
    const type = f.type || 'application/octet-stream';
    pendingAttachments.push({
      file: f,
      name: f.name || (type.startsWith('image/') ? `screenshot.${(type.split('/')[1] || 'png')}` : 'file'),
      size: f.size,
      type,
      localUrl: type.startsWith('image/') ? URL.createObjectURL(f) : null,
    });
  }
  renderAttachments();
  if (skipped) setAttachHint(`${skipped} file(s) skipped — max 3MB each`, 'error');
  else if (files.length) setAttachHint(`${pendingAttachments.length} attachment(s) ready`, 'ok');
}

// Upload a list of staged files to the worker, returning stored refs
// {id,name,type,size,url}. Takes the list explicitly (rather than always
// reading the live `pendingAttachments`) because a queued message carries its
// own snapshot, taken at queue time — see queueMessage.
async function uploadFiles(list) {
  const refs = [];
  for (const a of list) {
    const res = await api('/web/upload', {
      method: 'POST',
      headers: { 'Content-Type': a.type, 'x-filename': encodeURIComponent(a.name) },
      body: a.file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.id) throw new Error(data.error || `upload failed (${res.status})`);
    refs.push({ id: data.id, name: data.name, type: data.type, size: data.size, url: data.url });
  }
  return refs;
}

// Submission snapshots its destination before any asynchronous upload.
async function sendMessage() {
  if (voiceBusy || recording) { setVoiceStatus('Остановите запись и дождитесь расшифровки', 'busy'); return; }
  if (streaming || sessionRunning || dispatching || !currentSessionId) return;
  const message = $('reply-input').value.trim();
  if (!message && !pendingAttachments.length) return;
  rememberDraft();
  const destination = draftDestination;
  const files = pendingAttachments.slice();
  dispatching = true;
  updateSendLabel();
  try {
    const attachments = await uploadFiles(files);
    // A navigation during upload retains the source draft for an explicit send.
    if (draftDestination !== destination) return;
    $('reply-input').value = '';
    pendingAttachments = [];
    renderAttachments();
    rememberDraft();
    const delivered = await startStream(`/web/reply/${encodeURIComponent(destination)}`,
      {message, attachments}, message, attachments);
    if (!delivered) {
      if (draftDestination === destination) rememberDraft();
      const draft = composerDrafts.get(destination) || {message: '', attachments: []};
      draft.message = [message, draft.message].filter(Boolean).join('\n\n');
      draft.attachments = [...files, ...draft.attachments];
      composerDrafts.set(destination, draft);
      if (draftDestination === destination) {
        $('reply-input').value = draft.message;
        pendingAttachments = draft.attachments.slice();
        renderAttachments();
        setAttachHint('Подтверждение не получено. Черновик сохранён; проверьте историю перед повторной отправкой.', 'error');
      }
    } else files.forEach(a => a.localUrl && URL.revokeObjectURL(a.localUrl));
  } catch (err) {
    if (draftDestination === destination) setAttachHint(`Не удалось отправить: ${err.message}. Черновик сохранён.`, 'error');
  } finally {
    dispatching = false;
    updateSendLabel();
  }
}

// ─── Voice input (Deepgram) ──────────────────────────────────────────────────
// Click to record, click again to stop. The audio is POSTed to /web/transcribe
// (which proxies Deepgram server-side) and the transcript is *appended to the
// reply draft* — never auto-sent, so the user reviews/edits before Send. Deepgram
// occasionally swallows a short/quiet clip; on an empty result we auto-retry the
// same audio once, then surface a "didn't catch that" hint.
let mediaRecorder = null;
let recordChunks = [];
let recording = false;
let voiceBusy = false;
const voiceButton = () => $('btn-mic');

function setVoiceStatus(text, kind = '') {
  const el = $('voice-status');
  if (!text) { el.classList.add('hidden'); el.textContent = ''; el.removeAttribute('role'); return; }
  el.classList.remove('hidden');
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.className = `voice-status${kind ? ' voice-' + kind : ''}`;
  el.textContent = text;
}

async function toggleRecording() {
  if (recording) { stopRecording(); return; }
  if (voiceBusy) return;
  const btn = voiceButton();
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    setVoiceStatus('Voice input not supported in this browser', 'error');
    return;
  }
  voiceBusy = true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    voiceBusy = false;
    setVoiceStatus('Microphone access denied', 'error');
    return;
  }
  try {
  recordChunks = [];
  const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
  mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  mediaRecorder.addEventListener('dataavailable', e => { if (e.data && e.data.size) recordChunks.push(e.data); });
  mediaRecorder.addEventListener('stop', async () => {
    stream.getTracks().forEach(t => t.stop());
    const blob = new Blob(recordChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    try { await transcribeBlob(blob); } finally { voiceBusy = false; }
  });
  mediaRecorder.start();
  recording = true;
  btn.classList.add('recording');
  btn.textContent = '⏹ Stop';
  setVoiceStatus('● Recording… click Stop when done', 'recording');
  } catch {
    stream.getTracks().forEach(t => t.stop());
    voiceBusy = false;
    recording = false;
    setVoiceStatus('Не удалось начать запись. Попробуйте ещё раз.', 'error');
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  recording = false;
  const btn = voiceButton();
  btn.classList.remove('recording');
  btn.textContent = '🎤 Voice';
}

async function transcribeBlob(blob, attempt = 0) {
  const input = $('reply-input');
  setVoiceStatus(attempt ? `Transcribing… (retry ${attempt})` : 'Transcribing…', 'busy');
  try {
    const res = await api('/web/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'audio/webm' },
      body: blob,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.empty || !data.transcript) {
      // Deepgram swallowed it — retry the same audio once before giving up.
      if (attempt < 1) return transcribeBlob(blob, attempt + 1);
      setVoiceStatus("Didn't catch that — try recording again", 'error');
      return;
    }
    // Append to the existing draft so dictation can add to typed text.
    const sep = input.value && !/\s$/.test(input.value) ? ' ' : '';
    input.value = input.value + sep + data.transcript;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    setVoiceStatus('✓ Transcribed — review & Send', 'ok');

  } catch (err) {
    if (err.message !== 'Unauthorized') setVoiceStatus(`Transcription failed: ${err.message}`, 'error');
  }
}

// ─── Continue ─────────────────────────────────────────────────────────────────
// One-click resume of the selected session: sends a canned "продолжай" through
// the same reply+stream path as a typed message, so it works identically on the
// real agent backend (which treats it as a plain instruction to keep going).
async function continueSession() {
  if (!currentSessionId || streaming || sessionRunning || dispatching) return;
  if ($('reply-input').value.trim() || pendingAttachments.length) { $('reply-input').focus(); return; }
  $('reply-input').value = 'продолжай';
  await sendMessage();
}

// ─── Stop ───────────────────────────────────────────────────────────────────
async function stopSession() {
  if (!currentSessionId) return;
  if (streamAbort) streamAbort.abort();
  clearInterval(pollTimer);
  streaming = false;
  updateSendLabel();
  try {
    await api(`/web/stop/${encodeURIComponent(currentSessionId)}`, { method: 'POST' });
  } catch {}
  showRunningControls(false);
  $('stream-area').classList.add('hidden');
  await loadSession(currentSessionId);
}

// ─── Дополнить ────────────────────────────────────────────────────────────────
// SIGTERM the running task, then send the composer text as a normal reply —
// an honest restart (a fresh process, not a resume) that inherits the
// session's accumulated history plus this text as extra context. See
// spec-stop-supplement-confirm.
async function supplementSession() {
  if (!currentSessionId) return;
  const message = $('reply-input').value.trim();
  if (!message) return;
  if (streamAbort) streamAbort.abort();
  clearInterval(pollTimer);
  streaming = false;
  sessionRunning = false;
  updateSendLabel();
  try {
    await api(`/web/stop/${encodeURIComponent(currentSessionId)}`, { method: 'POST' });
  } catch {}
  showRunningControls(false);
  $('stream-area').classList.add('hidden');
  $('reply-input').value = '';
  await startStream(`/web/reply/${encodeURIComponent(currentSessionId)}`, { message }, message);
}

// ─── Router ─────────────────────────────────────────────────────────────────
// Only ever session ids now — creating a session isn't a navigation
// destination (see "Sidebar: new session" above), so there's no '/new' case.
function destinationForPath(path) {
  if (path.startsWith('/session/')) return path.slice('/session/'.length) || null;
  return null;
}
function navigate(path, pushState = true) {
  // Swap the draft bucket right here, synchronously — `location.hash = path`
  // only fires `hashchange` (and thus route()) on a later task, not before
  // this call returns. Anything typed or dropped in that gap would otherwise
  // still land in the *previous* destination's bucket.
  openDraft(destinationForPath(path));
  if (pushState) {
    // Setting `location.hash` to the value it already has is a no-op — the
    // browser does not fire `hashchange` — so re-clicking the already-active
    // session (e.g. to close the create-panel and jump back to it) would
    // otherwise silently skip route() and every side effect it drives.
    const samePath = location.hash.slice(1) === path;
    location.hash = path;
    if (samePath) route();
  } else {
    history.replaceState(null, '', `#${path}`);
  }
}

async function route() {
  if (!requireAuth()) return;
  const seq = ++navSeq; // this route() call owns navSeq until a newer navigation bumps it
  const hash = location.hash.slice(1); // strip '#' — captured now, not after the await below
  clearInterval(pollTimer);
  $('activity-area').classList.add('hidden');
  if (streamAbort) {
    // Tear down synchronously rather than waiting for the aborted stream's own
    // finalise() to run — that one bails out early (streamAbort no longer
    // matches its controller) and would otherwise leave `streaming` stuck
    // true forever, silently queuing every future send instead of sending it.
    streamAbort.abort();
    streamAbort = null;
    streaming = false;
    updateSendLabel();
  }

  // Swap the composer's draft bucket synchronously, before any awaited network
  // work below. navigate() already does this for clicks/back-button-free
  // transitions; this covers hashchange firing without navigate() (back/
  // forward buttons, a manually-edited hash) so the same rule always holds:
  // the previous destination's input is never left live during the prefetch.
  openDraft(destinationForPath(hash));

  // The list pane is always visible — keep it fresh on every route.
  await Promise.all([loadSessions(), loadProjects()]);
  // A newer navigation (another route() call) landed while we were fetching —
  // applying our now-stale target would re-dispatch to wherever the hash
  // happens to be *now*, clobbering whatever the user already moved on to.
  // Bail out silently; the newer navigation owns the outcome.
  if (seq !== navSeq) return;

  if (hash.startsWith('/session/')) {
    const id = hash.slice('/session/'.length);
    if (id) { await loadSession(id); return; }
  }
  // Nothing selected → show the placeholder (draft bucket already swapped above).
  sessionRunning = false;
  currentSessionId = null;
  showConvo(false);
  highlightActive(null);
  showContinue(false); // no session selected → nothing to continue
  updateSendLabel();
}

// ─── Event listeners ────────────────────────────────────────────────────────
$('btn-new').addEventListener('click', () => (createOpen ? closeCreatePanel() : openCreatePanel()));
$('btn-create-cancel').addEventListener('click', closeCreatePanel);
$('btn-create-send').addEventListener('click', sendCreate);
$('create-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendCreate(); }
});
$('btn-create-attach').addEventListener('click', () => $('create-attach-file').click());
$('create-attach-file').addEventListener('change', e => { addCreateFiles(e.target.files); e.target.value = ''; });
$('create-input').addEventListener('paste', e => {
  const files = e.clipboardData && e.clipboardData.files;
  if (files && files.length) { e.preventDefault(); addCreateFiles(files); }
});

$('btn-import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', e => importFiles(e.target.files));

$('btn-logout').addEventListener('click', async () => {
  try { await fetch('/web/logout', { method: 'POST', credentials: 'include' }); } catch {}
  location.href = 'login.html';
});

$('btn-back').addEventListener('click', e => {
  e.preventDefault();
  if (streamAbort) streamAbort.abort();
  clearInterval(pollTimer);
  navigate('/');
});

// Client-side keyword search over the cached session list.
$('search-input').addEventListener('input', e => {
  searchQuery = e.target.value;
  renderSessions();
});

// Filter the cached session list down to one project.
$('project-filter').addEventListener('change', e => {
  projectFilter = e.target.value;
  renderSessions();
});

$('btn-continue').addEventListener('click', continueSession);
$('btn-stop').addEventListener('click', () => showConfirmPanel('stop'));
$('btn-supplement').addEventListener('click', () => {
  if (!$('reply-input').value.trim()) return;
  showConfirmPanel('supplement');
});
$('btn-confirm-yes').addEventListener('click', () => {
  const action = confirmAction;
  hideConfirmPanel();
  if (action === 'stop') stopSession();
  else if (action === 'supplement') supplementSession();
});
$('btn-confirm-cancel').addEventListener('click', hideConfirmPanel);

$('btn-mic').addEventListener('click', () => toggleRecording());

$('btn-send').addEventListener('click', sendMessage);
$('reply-input').addEventListener('input', rememberDraft);
$('btn-attach').addEventListener('click', () => $('attach-file').click());
$('attach-file').addEventListener('change', e => { addFiles(e.target.files); rememberDraft(); e.target.value = ''; });
$('reply-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendMessage(); }
});

// ─── Drag-and-drop + paste of files ───────────────────────────────────────────
// A full-window overlay appears while dragging files in; drop stages them as
// attachment chips (upload deferred to Send). Paste captures screenshots pasted
// straight into the reply box.
const dropOverlay = $('drop-overlay');
let dragDepth = 0;
const hasFiles = dt => dt && [...dt.types || []].includes('Files');

window.addEventListener('dragenter', e => {
  if (!hasFiles(e.dataTransfer)) return;
  e.preventDefault();
  dragDepth++;
  dropOverlay.classList.remove('hidden');
});
window.addEventListener('dragover', e => { if (hasFiles(e.dataTransfer)) e.preventDefault(); });
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; dropOverlay.classList.add('hidden'); }
});
window.addEventListener('drop', e => {
  if (!e.dataTransfer || !e.dataTransfer.files.length) { dropOverlay.classList.add('hidden'); dragDepth = 0; return; }
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.add('hidden');
  // Files dropped anywhere go to whichever composer is actually active: the
  // create panel while it's open, otherwise the reply box.
  if (createOpen) addCreateFiles(e.dataTransfer.files);
  else addFiles(e.dataTransfer.files);
});
$('reply-input').addEventListener('paste', e => {
  const files = e.clipboardData && e.clipboardData.files;
  if (files && files.length) { e.preventDefault(); addFiles(files); }
});

$('btn-new-project').addEventListener('click', () => {
  const form = $('new-project-form');
  form.classList.toggle('hidden');
  if (!form.classList.contains('hidden')) $('new-project-name').focus();
});
$('btn-create-project').addEventListener('click', createProject);
$('new-project-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); createProject(); }
});

// Reproject modal
$('btn-reproject').addEventListener('click', openReproject);
$('btn-reproject-close').addEventListener('click', closeReproject);
$('btn-reproject-apply').addEventListener('click', applyReproject);
$('btn-reproject-revert').addEventListener('click', revertReproject);
$('reproject-modal').addEventListener('click', e => {
  if (e.target === $('reproject-modal')) closeReproject();
});

window.addEventListener('hashchange', route);

// ─── Theme (light / dark) ─────────────────────────────────────────────────────
// Stored choice wins; otherwise follow the OS. The button shows the theme you'd
// switch TO, so ☀️ = "go light", 🌙 = "go dark".
const prefersDark = () => window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
const effectiveTheme = () => document.documentElement.getAttribute('data-theme')
  || (prefersDark() ? 'dark' : 'light');
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = $('btn-theme');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
}
(function initTheme() {
  const saved = localStorage.getItem('theme');
  applyTheme(saved || (prefersDark() ? 'dark' : 'light'));
})();
$('btn-theme').addEventListener('click', () => {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', next);
  applyTheme(next);
});

// ─── Boot ───────────────────────────────────────────────────────────────────
loadProfile();
route();
