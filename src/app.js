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
    completed: '<span class="badge badge-completed">✓ Done</span>',
    failed:    '<span class="badge badge-failed">✕ Failed</span>',
  };
  return map[status] || (status ? `<span class="badge">${esc(status)}</span>` : '');
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
let showTests = false;       // reveal auto-hidden trivial test/demo sessions

// A trivial test/demo session: the shape of a manual "does it still work?" poke,
// not real work — a ≤2-message exchange whose visible text is all short, plus the
// known seeded-demo / Playwright / chaos fixture id prefixes. These are hidden by
// default to keep the list clean, but only hidden (never dropped) — a toggle and
// any active search bring them back (see renderSessions).
function isTestSession(s) {
  if (/^(s-00[12]$|ui-test-|chaos-|test-|demo-)/.test(s.id || '')) return true;
  const n = s.messageCount;
  if (n != null && n <= 2) {
    const longest = Math.max(
      (s.title || '').length, (s.topic || '').length,
      (s.lastUserMessage || '').length, (s.lastMessage || '').length);
    if (longest <= 40) return true;
  }
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
  const hay = `${s.topic || ''} ${s.title || ''} ${s.lastUserMessage || ''} ${s.lastMessage || ''} ${s.id}`.toLowerCase();
  return hay.includes(q);
}

function renderSessions() {
  const el = $('sessions-list');
  const q = searchQuery.trim().toLowerCase();
  let list = allSessions.filter(s => matchesSearch(s, q));

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
      : `<div class="empty" data-testid="sessions-all-hidden"><p>Only test sessions here — all hidden.</p></div>`)
      + toggle;
    wireTestsToggle();
    return;
  }

  el.innerHTML = list.map(s => `
    <div class="session-item" data-testid="session-item" data-id="${esc(s.id)}" role="listitem">
      <div class="session-info">
        <div class="session-path">${esc(s.topic || s.lastUserMessage || s.id)}</div>
        <div class="session-meta">${timeAgo(s.lastAt || s.createdAt)}${s.messageCount ? ` · ${s.messageCount} msg` : ''}</div>
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
let currentSessionId = null;
let streamAbort = null;
let pollTimer = null;

async function loadSession(id) {
  currentSessionId = id;
  showConvo(true);
  highlightActive(id);
  $('session-title').textContent = id;
  $('session-status').innerHTML = '';
  $('messages-container').innerHTML =
    '<div class="loading" style="padding:24px;justify-content:center"><div class="spinner"></div> Loading…</div>';
  $('stream-area').classList.add('hidden');
  $('btn-stop').classList.add('hidden');
  showContinue(false); // renderSession re-enables it once we know the status
  clearInterval(pollTimer);

  try {
    const res = await api(`/web/session/${id}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const session = await res.json();
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
  const { id, status, messages, lastMessage } = session;
  $('session-title').textContent = session.topic || session.path || id;
  $('session-status').innerHTML = statusBadge(status);

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
    $('btn-stop').classList.remove('hidden');
    showContinue(false);
    startPolling(id);
  } else {
    $('btn-stop').classList.add('hidden');
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

  pollTimer = setInterval(async () => {
    if (currentSessionId !== sessionId) { clearInterval(pollTimer); return; }
    try {
      const res = await api(`/web/session/${sessionId}`);
      const session = await res.json();
      if (session.status !== 'running') {
        clearInterval(pollTimer);
        renderSession(session);
        streamEl.classList.add('hidden');
      } else if (session.lastMessage) {
        streamEl.innerHTML = `<div class="md-content">${md(session.lastMessage)}</div>`;
        scrollBottom();
      }
    } catch {}
  }, 2500);
}

// ─── SSE streaming via POST ─────────────────────────────────────────────────
async function startStream(endpoint, body, appendUserMsg = null, appendAtts = null) {
  clearInterval(pollTimer);
  if (streamAbort) streamAbort.abort();
  streamAbort = new AbortController();

  const streamEl = $('stream-area');
  const btnStop  = $('btn-stop');
  const btnSend  = $('btn-send');
  const input    = $('reply-input');
  const notice   = $('reconnect-notice');

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
  streamEl.innerHTML = '';
  btnStop.classList.remove('hidden');
  showContinue(false); // a stream is active — nothing to "continue" yet
  btnSend.disabled = true;
  input.disabled = true;

  let buffer = '';

  const tryConnect = async (attempt = 0) => {
    if (attempt > 0) {
      notice.classList.remove('hidden');
      notice.textContent = `Reconnecting… (attempt ${attempt})`;
      // The backend replays the stream from the start on every reconnect (we
      // re-POST the same body), so drop whatever partial text we buffered on the
      // dropped attempt — otherwise the replay concatenates and the preview shows
      // duplicated/garbled output ("Working onWorking on it…").
      buffer = '';
      streamEl.innerHTML = '';
      await new Promise(r => setTimeout(r, 3000));
      if (streamAbort.signal.aborted) return;
    }

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        signal: streamAbort.signal,
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
        if (streamAbort.signal.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '{}') continue; // ping
          try {
            const msg = JSON.parse(raw);
            if (msg.type === 'chunk' && msg.text) {
              buffer += msg.text;
              streamEl.innerHTML = `<div class="md-content">${md(buffer)}</div>`;
              scrollBottom();
            } else if (msg.type === 'done') {
              const sid = msg.sessionId || currentSessionId;
              if (sid) {
                currentSessionId = sid;
                navigate(`/session/${sid}`, false); // reflect real id in the URL
                await loadSession(sid);
              } else {
                // No id came back (e.g. task produced no session) — refresh the list
                await loadSessions();
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

      // Stream ended without done event — try reconnect
      if (!streamAbort.signal.aborted && attempt < 3) {
        await tryConnect(attempt + 1);
      } else {
        finalise();
      }
    } catch (err) {
      if (streamAbort.signal.aborted || err.name === 'AbortError') { finalise(); return; }
      if (attempt < 3) {
        await tryConnect(attempt + 1);
      } else {
        streamEl.innerHTML = `<div class="err" data-testid="stream-error" role="alert">Connection failed: ${esc(err.message)}</div>`;
        finalise();
      }
    }
  };

  function finalise() {
    btnStop.classList.add('hidden');
    btnSend.disabled = false;
    input.disabled = false;
    // Only drop the `active` accent — leave `hidden` untouched. On `done` the
    // reload (loadSession) hides the stream area after re-rendering the thread;
    // if we reset the whole className here we'd un-hide it and show the finished
    // stream text a second time below the persisted message. On error the area
    // stays visible (we never set hidden) so the error remains readable.
    streamEl.classList.remove('active');
    notice.classList.add('hidden');
    // Stream is over (done reloads via loadSession; error stays here) — offer
    // Continue again so the user can nudge a stalled/errored session forward.
    showContinue(!!currentSessionId);
  }

  await tryConnect();
  finalise();
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

// ─── New session modal ──────────────────────────────────────────────────────
async function openNewModal() {
  const modal = $('modal-new');
  $('task-input').value = '';
  // Reset the inline new-project form each time the modal opens.
  $('new-project-form').classList.add('hidden');
  $('new-project-name').value = '';
  $('new-project-error').classList.add('hidden');
  modal.classList.remove('hidden');
  await loadFolders();
}

// Populate the project-folder select from the agent's project list. `selectPath`
// pre-selects a project id (used right after creating one). Kept separate from
// openNewModal so create-project can refresh the list without reopening.
async function loadFolders(selectPath) {
  const sel = $('folder-select');
  sel.innerHTML = '<option value="">Loading folders…</option>';
  sel.disabled  = true;
  try {
    const res  = await api('/web/files/tree');
    const data = await res.json();
    const tree = data.tree || [];
    if (!tree.length) {
      sel.innerHTML = '<option value="">No folders available</option>';
    } else {
      sel.innerHTML = '<option value="">Select a folder…</option>' +
        tree.map(f => `<option value="${esc(f.path)}">${esc(f.name)}</option>`).join('');
      sel.disabled = false;
      if (selectPath) sel.value = selectPath;
    }
  } catch {
    sel.innerHTML = '<option value="">Failed to load folders</option>';
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
    await loadFolders(data.project.id);
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

async function submitNewSession() {
  const path    = $('folder-select').value;
  const message = $('task-input').value.trim();
  const btn     = $('btn-start-new');
  if (!message) { $('task-input').focus(); return; }

  btn.disabled = true;
  btn.textContent = 'Starting…';

  try {
    // The backend creates the session implicitly inside /web/run — no separate
    // create step. We don't have an id yet; it arrives on the SSE `done` event.
    $('modal-new').classList.add('hidden');
    currentSessionId = null;
    showConvo(true);
    highlightActive(null);
    $('session-title').textContent = path || 'New session';
    $('session-status').innerHTML = '';
    $('messages-container').innerHTML = '';

    // MVP folder targeting: prepend the chosen folder to the task text.
    const task = path ? `[Work in folder: ${path}]\n\n${message}` : message;
    await startStream('/web/run', { task }, message);
  } catch (err) {
    alert('Error starting session: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Start';
  }
}

// ─── File attachments (drag-drop / paste) ────────────────────────────────────
// UX: dropping or pasting files just *stages* them as chips next to the reply —
// nothing is uploaded yet, so the user can add/remove before committing. The
// actual upload happens on Send (see sendReply), matching "insert the name now,
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

// Upload staged files to the worker, returning stored refs {id,name,type,size,url}.
async function uploadPending() {
  const refs = [];
  for (const a of pendingAttachments) {
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

// ─── Reply ──────────────────────────────────────────────────────────────────
async function sendReply() {
  const input   = $('reply-input');
  const message = input.value.trim();
  if ((!message && !pendingAttachments.length) || !currentSessionId) return;

  let attachments = [];
  if (pendingAttachments.length) {
    const btnSend = $('btn-send');
    btnSend.disabled = true;
    setAttachHint('Uploading…', 'busy');
    try {
      attachments = await uploadPending();
    } catch (err) {
      setAttachHint(`Upload failed: ${err.message}`, 'error');
      btnSend.disabled = false;
      return;
    }
    clearAttachments();
    setAttachHint('');
  }

  input.value = '';
  await startStream(`/web/reply/${encodeURIComponent(currentSessionId)}`, { message, attachments }, message, attachments);
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

function setVoiceStatus(text, kind = '') {
  const el = $('voice-status');
  if (!text) { el.classList.add('hidden'); el.textContent = ''; el.removeAttribute('role'); return; }
  el.classList.remove('hidden');
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.className = `voice-status${kind ? ' voice-' + kind : ''}`;
  el.textContent = text;
}

async function toggleRecording() {
  const btn = $('btn-mic');
  if (recording) { stopRecording(); return; }
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    setVoiceStatus('Voice input not supported in this browser', 'error');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    setVoiceStatus('Microphone access denied', 'error');
    return;
  }
  recordChunks = [];
  const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
  mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  mediaRecorder.addEventListener('dataavailable', e => { if (e.data && e.data.size) recordChunks.push(e.data); });
  mediaRecorder.addEventListener('stop', async () => {
    stream.getTracks().forEach(t => t.stop());
    const blob = new Blob(recordChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    await transcribeBlob(blob);
  });
  mediaRecorder.start();
  recording = true;
  btn.classList.add('recording');
  btn.textContent = '⏹ Stop';
  btn.setAttribute('data-testid', 'mic-record');
  setVoiceStatus('● Recording… click Stop when done', 'recording');
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  recording = false;
  const btn = $('btn-mic');
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
    setTimeout(() => setVoiceStatus(''), 3000);
  } catch (err) {
    if (err.message !== 'Unauthorized') setVoiceStatus(`Transcription failed: ${err.message}`, 'error');
  }
}

// ─── Continue ─────────────────────────────────────────────────────────────────
// One-click resume of the selected session: sends a canned "продолжай" through
// the same reply+stream path as a typed message, so it works identically on the
// real agent backend (which treats it as a plain instruction to keep going).
async function continueSession() {
  if (!currentSessionId) return;
  const msg = 'продолжай';
  await startStream(`/web/reply/${encodeURIComponent(currentSessionId)}`, { message: msg }, msg);
}

// ─── Stop ───────────────────────────────────────────────────────────────────
async function stopSession() {
  if (!currentSessionId) return;
  if (streamAbort) streamAbort.abort();
  clearInterval(pollTimer);
  try {
    await api(`/web/stop/${encodeURIComponent(currentSessionId)}`, { method: 'POST' });
  } catch {}
  $('btn-stop').classList.add('hidden');
  $('stream-area').classList.add('hidden');
  await loadSession(currentSessionId);
}

// ─── Router ─────────────────────────────────────────────────────────────────
function navigate(path, pushState = true) {
  if (pushState) location.hash = path;
}

async function route() {
  if (!requireAuth()) return;
  clearInterval(pollTimer);
  if (streamAbort) { streamAbort.abort(); streamAbort = null; }

  // The list pane is always visible — keep it fresh on every route.
  await loadSessions();

  const hash = location.hash.slice(1); // strip '#'
  if (hash.startsWith('/session/')) {
    const id = hash.slice('/session/'.length);
    if (id) { await loadSession(id); return; }
  }
  // Nothing selected → show the placeholder.
  currentSessionId = null;
  showConvo(false);
  highlightActive(null);
  showContinue(false); // no session selected → nothing to continue
}

// ─── Event listeners ────────────────────────────────────────────────────────
$('btn-new').addEventListener('click', openNewModal);

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

$('btn-continue').addEventListener('click', continueSession);
$('btn-stop').addEventListener('click', stopSession);

$('btn-mic').addEventListener('click', toggleRecording);

$('btn-send').addEventListener('click', sendReply);
$('reply-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendReply(); }
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
  addFiles(e.dataTransfer.files);
});
$('reply-input').addEventListener('paste', e => {
  const files = e.clipboardData && e.clipboardData.files;
  if (files && files.length) { e.preventDefault(); addFiles(files); }
});

$('btn-cancel-new').addEventListener('click', () => $('modal-new').classList.add('hidden'));
$('btn-start-new').addEventListener('click', submitNewSession);
$('btn-new-project').addEventListener('click', () => {
  const form = $('new-project-form');
  form.classList.toggle('hidden');
  if (!form.classList.contains('hidden')) $('new-project-name').focus();
});
$('btn-create-project').addEventListener('click', createProject);
$('new-project-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); createProject(); }
});
$('modal-new').addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
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
