import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

let projects = [], failTree = false, posts = 0, failUpload = false, streamMode = 'done';
const submissions = [];
let restartIntents = [{handle:'confirm-handle',title:'<script>Confirm saved task'}, {handle:'cancel-handle',title:'Cancel saved task'}], failDecision=true, decisions=0;
const session = { id: 'real-session', title: 'Fallback', summary: { title: 'Проверить создание проектов и удобство веб-интерфейса', gist: 'Папки, голосовой ввод и состояние работы' }, status: 'completed', messageCount: 2, messages: [{role:'user',content:'Привет'}] };
const server = createServer(async (req,res) => {
  const json = (data,code=200) => { res.writeHead(code, {'content-type':'application/json'});res.end(JSON.stringify(data)); };
  if(req.url === '/web/restart-intents') {
    if(req.method==='GET') return json({intents:restartIntents});
    decisions++;
    if(failDecision){failDecision=false;return json({error:'temporary'},503);}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const input=JSON.parse(Buffer.concat(chunks).toString());
    assert.deepEqual(Object.keys(input).sort(),['action','handle']);
    restartIntents=restartIntents.filter(i=>i.handle!==input.handle);
    return json({accepted:true,decision:input.action});
  }
  if(req.url === '/web/me') return json({username:'ux-test'});
  if(req.url === '/web/sessions') return json([session]);
  if(req.url === '/web/files/tree') return json(failTree ? {error:'unavailable'} : {tree:projects},failTree ? 502 : 200);
  if(req.url === '/web/project-create') {projects=[{path:'generic-new',name:'Новый проект'}]; return json({project:{id:'generic-new',name:'Новый проект'}});}
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
  const deferred=page.getByTestId('restart-intent');
  await deferred.first().waitFor();assert.equal(await deferred.count(),2);
  await deferred.first().getByTestId('restart-confirm').click();await deferred.first().getByRole('alert').waitFor();
  assert.equal(await deferred.first().getByTestId('restart-confirm').isEnabled(),true);
  await deferred.first().getByTestId('restart-confirm').click();await deferred.first().getByRole('status').waitFor();
  assert.equal(await deferred.first().locator('button').count(),0);
  await deferred.nth(1).getByTestId('restart-cancel').click();await deferred.nth(1).getByRole('status').waitFor();
  assert.equal(decisions,3);assert.equal(restartIntents.length,0);
  assert.equal(await page.locator('#restart-intents script').count(),0);
  await page.getByTestId('new-session').click();
  await page.getByTestId('new-project').click();
  await page.getByTestId('new-project-name').fill('Новый проект');
  failTree=true;
  await page.getByTestId('create-project').click();
  await page.locator('#project-notice').waitFor();
  await page.waitForFunction(()=>document.querySelector('#folder-select').value==='generic-new');
  assert.equal(await page.getByTestId('folder-select').inputValue(),'generic-new');
  assert.match(await page.locator('#project-notice').innerText(),/создан и выбран/);
  failTree=false;
  await page.getByTestId('reply-input').fill('Сохранить черновик новой задачи');
  await page.getByTestId('file-input').setInputFiles({name:'Файл.txt',mimeType:'text/plain',buffer:Buffer.from('test')});
  await page.getByTestId('session-item').click();
  await page.getByTestId('session-title').waitFor();
  await page.getByTestId('reply-input').fill('Отдельный ответ');
  // Reopening the modal re-fetches the project tree (loadFolders → renderProjects),
  // which is also how the sidebar project filter recovers from the earlier failure —
  // there's no separate retry affordance for it.
  await page.getByTestId('new-session').click();
  await page.waitForFunction(()=>document.querySelector('#folder-select').value==='generic-new');
  assert.equal(await page.getByTestId('folder-select').inputValue(),'generic-new');
  assert.equal(await page.locator('#project-filter option[value="generic-new"]').count(),1,'sidebar filter picks up the new project');
  assert.equal(await page.getByTestId('reply-input').inputValue(),'Сохранить черновик новой задачи');
  assert.equal(await page.getByTestId('attach-chip').count(),1);
  await page.getByTestId('reply-input').fill('');
  await page.getByTestId('mic-record').click();
  await page.waitForFunction(()=>document.querySelector('#btn-mic').textContent.includes('Stop'));
  await page.waitForTimeout(300);
  await page.getByTestId('mic-record').click();
  await page.waitForFunction(()=>document.querySelector('#reply-input').value.includes('голосовую'));
  assert.match(await page.getByTestId('reply-input').inputValue(),/голосовую/);
  assert.equal(posts,0,'dictation does not send automatically');
  failUpload=true;
  await page.getByTestId('send-reply').click();
  await page.getByTestId('attach-hint').filter({hasText:'Черновик сохранён'}).waitFor();
  assert.match(await page.getByTestId('reply-input').inputValue(),/голосовую/);
  assert.equal(await page.getByTestId('attach-chip').count(),1);
  assert.equal(posts,0);
  failUpload=false;
  await page.getByTestId('send-reply').dblclick();
  await page.waitForTimeout(1200);
  assert.match(await page.getByTestId('activity').innerText(),/Ожидаю ответ агента/);
  await page.waitForFunction(()=>location.hash.includes('real-session') && !document.querySelector('#btn-send').disabled);
  assert.equal(posts,1,'double click creates one submission');
  assert.match(submissions[0].task,/Work in folder: generic-new/);
  assert.equal(submissions[0].attachments.length,1);
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
  assert.equal(posts,2);
  assert.equal(await page.getByTestId('reply-input').inputValue(),'Ответ при обрыве');
  session.status='running';
  await page.reload();
  await page.waitForTimeout(2900);
  assert.match(await page.getByTestId('stream').innerText(),/Агент работает/);
  assert(await page.getByTestId('send-reply').isDisabled(),'running backend session disables submission');
  const stopBox=await page.getByTestId('stop-session').boundingBox();
  const sendBox=await page.getByTestId('send-reply').boundingBox();
  assert(stopBox.y > sendBox.y+sendBox.height,'stop below send');
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
  console.log('PASS: unified composer; preserved per-session drafts/files; upload failure; double click; no repeat POST; busy status; stop position; 4 viewports; projects persist/select after refresh failure; summary title; short sessions; real MediaRecorder task/reply dictation; no auto-send; SSE waiting; polling status; mobile layout; no browser errors');
} finally { await browser.close(); server.closeAllConnections(); await new Promise(r=>server.close(r)); }
