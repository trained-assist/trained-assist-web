import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

let projects = [], failTree = false, posts = 0, failUpload = false, streamMode = 'done';
const submissions = [];
const rpMoves = [], rpRenames = [];
const rpPlan = {
  plan: {
    totalSessions: 3,
    projects: [
      { cluster: 'vacancy1', name: 'Вакансия 1', type: 'recruiting', sessionCount: 2, sessionIds: ['s1','s2'], memberTopics: [{id:'s1',topic:'Ищем кандидата'},{id:'s2',topic:'Собеседование'}], avgConfidence: 0.9, existingProjectId: null, clarity: 'clear', weakMembers: [] },
      { cluster: 'expo1', name: 'Выставка 1', type: 'expo', sessionCount: 1, sessionIds: ['s3'], memberTopics: [{id:'s3',topic:'Стенд на выставке'}], avgConfidence: 0.8, existingProjectId: null, clarity: 'clear', weakMembers: [] },
    ],
    unassigned: [{ id: 's4', topic: 'Разовое' }],
    warnings: [],
  },
  report: '# test',
  projectCount: 2,
  totalSessions: 3,
  unassigned: 1,
};
const session = { id: 'real-session', title: 'Fallback', summary: { title: 'Проверить создание проектов и удобство веб-интерфейса', gist: 'Папки, голосовой ввод и состояние работы' }, status: 'completed', messageCount: 2, messages: [{role:'user',content:'Привет'}] };
const server = createServer(async (req,res) => {
  const json = (data,code=200) => { res.writeHead(code, {'content-type':'application/json'});res.end(JSON.stringify(data)); };
  if(req.url === '/web/me') return json({username:'ux-test'});
  if(req.url === '/web/sessions') return json([session]);
  if(req.url === '/web/files/tree') return json(failTree ? {error:'unavailable'} : {tree:projects},failTree ? 502 : 200);
  if(req.url === '/web/project-create') {projects=[{path:'generic-new',name:'Новый проект'}]; return json({project:{id:'generic-new',name:'Новый проект'}});}
  if(req.url === '/web/reproject-preview') return json(rpPlan);
  if(req.url === '/web/reproject-adjust') {
    const chunks=[];for await (const chunk of req) chunks.push(chunk);
    const b = JSON.parse(Buffer.concat(chunks));
    if (b.moves) rpMoves.push(...b.moves);
    if (b.renames) rpRenames.push(...b.renames);
    // Apply a move to the fake plan so the re-render reflects it.
    if (b.moves) {
      for (const mv of b.moves) {
        const from = rpPlan.plan.projects.find(p => (p.sessionIds||[]).includes(mv.sessionId));
        const to = rpPlan.plan.projects.find(p => p.cluster === mv.toCluster);
        if (from && to) { from.sessionIds = from.sessionIds.filter(id=>id!==mv.sessionId); to.sessionIds.push(mv.sessionId); }
      }
    }
    if (b.renames) {
      for (const r of b.renames) { const p = rpPlan.plan.projects.find(p=>p.cluster===r.cluster); if (p && r.name) p.name = r.name; }
    }
    return json({ adjusted: true, plan: rpPlan.plan, report: '# updated' });
  }
  if(req.url === '/web/reproject-apply') return json({ applied: true, sessionsMoved: 3, projectsAffected: 2, ledgerWritten: true });
  if(req.url === '/web/reproject-revert') return json({ reverted: 3 });
  if(req.url === '/web/upload') { await new Promise(r=>setTimeout(r,100)); return json(failUpload ? {error:'upload failed'} : {id:'file-1',name:'Файл.txt',size:4,type:'text/plain',url:'/web/file/file-1'},failUpload?502:200); }
  if(req.url.startsWith('/web/stop/')) {session.status='completed';return json({ok:true});}
  if(req.url === '/web/transcribe') return json({transcript:'Проверить голосовую задачу'});
  if(req.url === '/web/run' || req.url.startsWith('/web/reply/')) {
    const chunks=[];for await (const chunk of req) chunks.push(chunk);submissions.push(JSON.parse(Buffer.concat(chunks)));
    posts++; res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {}\n\n');
    const timer=setTimeout(()=>res.end(streamMode === 'drop' ? '' : 'data: {"type":"done","sessionId":"real-session"}\n\n'),1500);
    res.on('close',()=>clearTimeout(timer));return;
  }
  if(req.url.startsWith('/web/session/')) return json(session);
  try {
    const file = req.url === '/' ? 'index.html' : req.url.slice(1);
    const data = await readFile(new URL('../src/'+file, import.meta.url));
    res.writeHead(200,{'content-type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});res.end(data);
  } catch {res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser = await chromium.launch({headless:true,args:['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
try {
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://cdn.jsdelivr.net/**',r=>r.fulfill({contentType:'text/javascript',body:'window.marked={parse:s=>s};'}));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByTestId('session-item').waitFor();
  assert.match(await page.getByTestId('session-item').innerText(),/Проверить создание/);
  assert.equal(await page.getByTestId('session-item').count(),1,'short real session stays visible');
  assert(!await page.getByTestId('session-item').innerText().then(t=>t.includes('Done')));

  // ── One right-rail composer serves both New and Reply.
  const listBefore = await page.getByTestId('sessions-list').boundingBox();
  assert.equal(await page.getByTestId('create-panel').count(),0,'legacy sidebar create panel is gone');
  assert.equal(await page.getByTestId('pane-actions').getByTestId('new-session').count(),1,'New lives in right rail');

  await page.getByTestId('new-session').click();
  await page.getByTestId('new-session-project').waitFor({state:'visible'});
  const listAfter = await page.getByTestId('sessions-list').boundingBox();
  assert.equal(Math.round(listAfter.height),Math.round(listBefore.height),'opening New does not steal session-list height');

  await page.getByTestId('new-project').click();
  await page.getByTestId('new-project-name').fill('Новый проект');
  failTree=true;
  await page.getByTestId('create-project').click();
  await page.locator('#project-notice').waitFor();
  await page.waitForFunction(()=>document.querySelector('#folder-select').value==='generic-new');
  assert.equal(await page.getByTestId('folder-select').inputValue(),'generic-new');
  assert.match(await page.locator('#project-notice').innerText(),/создан и выбран/);
  failTree=false;

  await page.getByTestId('reply-input').fill('Новая задача с проектом');
  await page.getByTestId('file-input').setInputFiles({name:'Файл.txt',mimeType:'text/plain',buffer:Buffer.from('test')});
  assert.equal(await page.getByTestId('attach-chip').count(),1);
  assert(await page.getByTestId('mic-record').isVisible(),'same microphone is visible in New mode');

  await page.getByTestId('send-reply').click();
  await page.waitForFunction(()=>location.hash.includes('real-session'));
  assert.equal(posts,1,'New mode posts /web/run exactly once');
  assert.match(submissions[0].task,/Work in folder: generic-new/);
  assert.match(submissions[0].task,/Новая задача с проектом/);
  assert.equal(submissions[0].attachments.length,1);

  await page.getByTestId('new-session').click();
  await page.getByTestId('reply-input').fill('Черновик новой сессии');
  await page.getByTestId('session-item').click();
  await page.getByTestId('session-title').waitFor();
  await page.waitForFunction(()=>document.querySelector('#project-filter option[value="generic-new"]'));
  assert.equal(await page.locator('#project-filter option[value="generic-new"]').count(),1,'sidebar filter picks up the new project');
  await page.getByTestId('reply-input').fill('Отдельный ответ');
  await page.getByTestId('new-session').click();
  assert.equal(await page.getByTestId('reply-input').inputValue(),'Черновик новой сессии','new draft survives mode switch');
  await page.getByTestId('cancel-new').click();
  assert.equal(await page.getByTestId('reply-input').inputValue(),'Отдельный ответ','reply draft survives New→Reply');

  // ── Reply composer: per-session draft, real MediaRecorder dictation, upload
  // failure recovery, idempotent double-send, no-retry on a dropped POST.
  // The reply composer keeps its own attachment state (file-input/attach-chip),
  // separate from the New mode's — this is what makes a failed upload
  // below actually exercise the failure path instead of a no-op empty upload.
  await page.getByTestId('reply-input').fill('');
  await page.getByTestId('file-input').setInputFiles({name:'Файл.txt',mimeType:'text/plain',buffer:Buffer.from('test')});
  assert.equal(await page.getByTestId('attach-chip').count(),1);
  await page.getByTestId('mic-record').click();
  await page.waitForFunction(()=>document.querySelector('#btn-mic').textContent.includes('Stop'));
  await page.waitForTimeout(300);
  await page.getByTestId('mic-record').click();
  await page.waitForFunction(()=>document.querySelector('#reply-input').value.includes('голосовую'));
  assert.match(await page.getByTestId('reply-input').inputValue(),/голосовую/);
  assert.equal(posts,1,'dictation does not send automatically');
  failUpload=true;
  await page.getByTestId('send-reply').click();
  await page.getByTestId('attach-hint').filter({hasText:'Черновик сохранён'}).waitFor();
  assert.match(await page.getByTestId('reply-input').inputValue(),/голосовую/);
  assert.equal(await page.getByTestId('attach-chip').count(),1,'failed upload keeps the attachment in the draft');
  assert.equal(posts,1);
  failUpload=false;
  await page.getByTestId('send-reply').dblclick();
  await page.waitForTimeout(1200);
  assert.match(await page.getByTestId('activity').innerText(),/Ожидаю ответ агента/);
  await page.waitForFunction(()=>!document.querySelector('#btn-send').disabled);
  assert.equal(posts,2,'double click creates one submission');
  assert.equal(submissions[1].task,undefined,'a reply never carries the New mode\'s task/project prefix');
  assert.match(submissions[1].message,/голосовую/);
  await page.getByTestId('reply-input').fill('');
  await page.getByTestId('mic-record').click();
  await page.waitForFunction(()=>document.querySelector('#btn-mic').textContent.includes('Stop'));
  await page.waitForTimeout(300);
  await page.getByTestId('mic-record').click();
  await page.waitForFunction(()=>document.querySelector('#reply-input').value.includes('голосовую'));
  // A disconnected POST is never retried, and its draft is recoverable.
  streamMode='drop';
  await page.getByTestId('reply-input').fill('Ответ при обрыве');
  await page.getByTestId('send-reply').click();
  await page.getByTestId('attach-hint').filter({hasText:'Подтверждение не получено'}).waitFor();
  assert.equal(posts,3);
  assert.equal(await page.getByTestId('reply-input').inputValue(),'Ответ при обрыве');
  session.status='running';
  await page.reload();
  await page.waitForTimeout(2900);
  assert.match(await page.getByTestId('stream').innerText(),/Агент работает/);
  assert(await page.getByTestId('send-reply').isDisabled(),'running backend session disables submission');
  const stopBox=await page.getByTestId('stop-session').boundingBox();
  const sendBox=await page.getByTestId('send-reply').boundingBox();
  assert(stopBox.y > sendBox.y+sendBox.height,'stop below send');

  // ── Стоп/Дополнить confirm step (spec-stop-supplement-confirm): neither
  // button acts on the first click — both swap the action row for an explicit
  // confirm, so an accidental click never kills a running task.
  assert(await page.getByTestId('supplement-session').isVisible(),'Дополнить visible while running, like Стоп');
  // Дополнить with an empty draft is a no-op — nothing to restart with.
  await page.getByTestId('supplement-session').click();
  assert(await page.getByTestId('confirm-panel').isHidden(),'Дополнить with empty input does not open confirm');
  await page.getByTestId('reply-input').fill('доп. контекст для перезапуска');
  await page.getByTestId('supplement-session').click();
  assert(await page.getByTestId('confirm-panel').isVisible());
  assert(await page.getByTestId('stop-session').isHidden(),'stop-row swapped out while confirming');
  assert.match(await page.getByTestId('confirm-text').innerText(),/доп\. контекст для перезапуска/);
  // Cancel returns to the normal row and keeps the typed text.
  await page.getByTestId('confirm-cancel').click();
  assert(await page.getByTestId('confirm-panel').isHidden());
  assert(await page.getByTestId('stop-session').isVisible());
  assert.equal(await page.getByTestId('reply-input').inputValue(),'доп. контекст для перезапуска');
  // Confirm restarts: stop, then the typed text goes out as a normal reply.
  const postsBeforeSupplement = posts;
  await page.getByTestId('supplement-session').click();
  await page.getByTestId('confirm-yes').click();
  await page.waitForFunction(()=>document.getElementById('btn-supplement').classList.contains('hidden'),{timeout:3000});
  assert.equal(posts,postsBeforeSupplement+1,'Дополнить sends exactly one reply, not one per click');
  assert.equal(submissions.at(-1).message,'доп. контекст для перезапуска');
  assert.equal(await page.getByTestId('reply-input').inputValue(),'','composer clears after a confirmed Дополнить');

  // Стоп: same confirm gate, cancel leaves the task running, confirm stops it.
  session.status='running';
  await page.reload();
  await page.waitForTimeout(2900);
  await page.getByTestId('stop-session').click();
  assert(await page.getByTestId('confirm-panel').isVisible());
  assert.match(await page.getByTestId('confirm-text').innerText(),/Прогресс не сохранится/);
  await page.getByTestId('confirm-cancel').click();
  assert(await page.getByTestId('confirm-panel').isHidden());
  assert(await page.getByTestId('stop-session').isVisible(),'cancel leaves the running task alone');
  await page.getByTestId('stop-session').click();
  await page.getByTestId('confirm-yes').click();
  await page.waitForFunction(()=>document.getElementById('btn-stop').classList.contains('hidden'),{timeout:3000});
  assert.equal(session.status,'completed','confirmed Стоп reached /web/stop');

  for (const width of [1440,1280,1024,390]) {
    await page.setViewportSize({width,height:844});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`no overflow at ${width}`);
  }
  await page.getByTestId('back-to-sessions').click();
  await page.getByTestId('session-item').waitFor({state:'visible'});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no mobile horizontal overflow');
  await page.getByTestId('session-item').click();
  await page.getByTestId('mic-record').waitFor({state:'visible'});
  const micBox = await page.getByTestId('mic-record').boundingBox();
  assert(micBox.y >= 0 && micBox.y + micBox.height <= 844, 'mobile microphone is inside viewport');
  await page.screenshot({path: process.env.UX_SCREENSHOT || '/tmp/web-ux-mobile.png'});
  assert.deepEqual(errors,[]);

  // ── Reproject: the "⟳" button opens the restructure modal, shows the cheap-model
  // proposal, lets the user move a session to another project and rename a project
  // (both persist via /web/reproject-adjust), then apply (reversible) and revert.
  // The button lives in the sidebar search row — come back to the list view first
  // (mobile back button is mobile-only), then resize to a desktop width (the
  // previous section leaves the mobile conversation open at 390px).
  await page.getByTestId('back-to-sessions').click();
  await page.getByTestId('session-item').waitFor({ state: 'visible' });
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.getByTestId('reproject').click();
  await page.getByTestId('reproject-modal').waitFor({state:'visible'});
  await page.getByTestId('rp-project').first().waitFor();
  assert.equal(await page.getByTestId('rp-project').count(),2,'two proposed projects');
  assert.equal(await page.getByTestId('rp-session').count(),3,'three sessions across projects');

  // Move session s2 → expo1 via its dropdown.
  const s2Sel = page.locator('[data-testid="rp-move"][data-session="s2"]');
  await s2Sel.selectOption({ label: 'Выставка 1' });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="rp-move"][data-session="s2"]').length === 0 || true);
  await page.waitForTimeout(150);
  assert.equal(rpMoves.length,1,'one move persisted');
  assert.equal(rpMoves[0].sessionId,'s2');
  assert.equal(rpMoves[0].toCluster,'expo1');

  // Rename "Вакансия 1" → "Вакансия: Backend dev" (Enter commits the change event).
  const nameInp = page.locator('[data-testid="rp-name"][data-cluster="vacancy1"]');
  await nameInp.fill('Вакансия: Backend dev');
  await nameInp.press('Enter');
  await page.waitForTimeout(150);
  assert.equal(rpRenames.length,1,'one rename persisted');
  assert.equal(rpRenames[0].cluster,'vacancy1');
  assert.equal(rpRenames[0].name,'Вакансия: Backend dev');

  // Apply.
  await page.getByTestId('reproject-apply').click();
  await page.getByTestId('reproject-applied').waitFor();
  assert.match(await page.getByTestId('reproject-applied').innerText(),/Перемещено сессий: 3/);

  // Revert.
  await page.getByTestId('reproject-revert').click();
  await page.getByTestId('reproject-reverted').waitFor();
  assert.match(await page.getByTestId('reproject-reverted').innerText(),/Откат: сессий возвращено — 3/);

  // Close resets the modal to a fresh "analysing…" state for next open.
  await page.getByTestId('reproject-close').click();
  await page.getByTestId('reproject-modal').waitFor({state:'hidden'});
  await page.getByTestId('reproject').click();
  await page.getByTestId('reproject-body').waitFor({state:'visible'});
  await page.getByTestId('reproject-close').click();
  await page.getByTestId('reproject-modal').waitFor({state:'hidden'});
  assert.deepEqual(errors,[]);
  console.log('PASS: single right-rail composer (New/Reply, project create/retry, shared file/mic controls, draft isolation, session-list height stable); per-session reply drafts; upload failure; double click; no repeat POST; busy status; stop position; Стоп/Дополнить confirm gate (empty-input no-op, cancel preserves draft, confirmed Дополнить restarts once, confirmed Стоп reaches backend); 4 viewports; projects persist/select after refresh failure; summary title; short sessions; real MediaRecorder task/reply dictation; no auto-send; SSE waiting; polling status; mobile layout; no browser errors; reproject modal open/render/move/rename/apply/revert');
} finally { await browser.close(); server.closeAllConnections(); await new Promise(r=>server.close(r)); }
