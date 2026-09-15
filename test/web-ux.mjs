import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

let projects = [], failTree = false, posts = 0;
const session = { id: 'real-session', title: 'Fallback', summary: { title: 'Проверить создание проектов и удобство веб-интерфейса', gist: 'Папки, голосовой ввод и состояние работы' }, status: 'completed', messageCount: 2, messages: [{role:'user',content:'Привет'}] };
const server = createServer(async (req,res) => {
  const json = (data,code=200) => { res.writeHead(code, {'content-type':'application/json'});res.end(JSON.stringify(data)); };
  if(req.url === '/web/me') return json({username:'ux-test'});
  if(req.url === '/web/sessions') return json([session]);
  if(req.url === '/web/files/tree') return json(failTree ? {error:'unavailable'} : {tree:projects},failTree ? 502 : 200);
  if(req.url === '/web/project-create') {projects=[{path:'generic-new',name:'Новый проект'}]; return json({project:{id:'generic-new',name:'Новый проект'}});}
  if(req.url === '/web/transcribe') return json({transcript:'Проверить голосовую задачу'});
  if(req.url === '/web/run' || req.url.startsWith('/web/reply/')) {
    posts++; res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {}\n\n');
    const timer=setTimeout(()=>res.end('data: {"type":"done","sessionId":"real-session"}\n\n'),5000);
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
  await page.getByTestId('cancel-new').click();
  await page.locator('#retry-projects').click();
  await page.locator('[data-project="generic-new"]').click();
  await page.waitForFunction(()=>document.querySelector('#folder-select').value==='generic-new');
  assert.equal(await page.getByTestId('folder-select').inputValue(),'generic-new');
  await page.getByTestId('task-mic').click();
  await page.waitForFunction(()=>document.querySelector('#btn-task-mic').textContent.includes('Stop'));
  await page.waitForTimeout(300);
  await page.getByTestId('task-mic').click();
  await page.waitForFunction(()=>document.querySelector('#task-input').value.includes('голосовую'));
  assert.equal(await page.getByTestId('reply-input').inputValue(),'');
  assert.equal(posts,0,'dictation does not send automatically');
  await page.getByTestId('start-new').click();
  await page.waitForTimeout(1200);
  assert.match(await page.getByTestId('activity').innerText(),/Ожидаю ответ агента/);
  await page.waitForTimeout(4500);
  await page.getByTestId('mic-record').click();
  await page.waitForFunction(()=>document.querySelector('#btn-mic').textContent.includes('Stop'));
  await page.waitForTimeout(300);
  await page.getByTestId('mic-record').click();
  await page.waitForFunction(()=>document.querySelector('#reply-input').value.includes('голосовую'));
  session.status='running';
  await page.reload();
  await page.waitForTimeout(2900);
  assert.match(await page.getByTestId('stream').innerText(),/Агент работает/);
  await page.setViewportSize({width:390,height:844});
  await page.getByTestId('back-to-sessions').click();
  await page.getByTestId('session-item').waitFor({state:'visible'});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no mobile horizontal overflow');
  await page.getByTestId('session-item').click();
  await page.getByTestId('mic-record').waitFor({state:'visible'});
  assert.deepEqual(errors,[]);
  console.log('PASS: projects persist/select after refresh failure; summary title; short sessions; real MediaRecorder task/reply dictation; no auto-send; SSE waiting; polling status; mobile layout; no browser errors');
} finally { await browser.close(); server.closeAllConnections(); await new Promise(r=>server.close(r)); }
