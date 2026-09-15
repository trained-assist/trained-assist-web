import assert from 'node:assert/strict';
import { SessionHub } from '../worker.mjs';
const savedFetch = globalThis.fetch;
const data = new Map([['t:test', {username:'owner'}]]);
const state = {blockConcurrencyWhile: fn=>fn(),storage:{list:async()=>new Map(),get:async k=>data.get(k),put:async(k,v)=>data.set(k,v)}};
const hub = new SessionHub(state,{AGENT_VERIFY_URL:'https://agent.example/web/verify',AGENT_VERIFY_SECRET:'fixture'});
hub.isAuthed=async()=>true;hub.tokenUser=async()=> 'owner';
const req=()=>new Request('https://web.example/web/files/tree');
try {
  globalThis.fetch=async()=>new Response('{}',{status:503});
  assert.equal((await hub.fetch(req())).status,502,'failure must not masquerade as empty folders');
  globalThis.fetch=async()=>{throw new Error('offline')};
  assert.equal((await hub.fetch(req())).status,502);
  globalThis.fetch=async(url,opts)=>{assert.equal(JSON.parse(opts.body).username,'owner');return Response.json({projects:[{id:'generic-new',name:'New'}]})};
  assert.deepEqual(await (await hub.fetch(req())).json(),{tree:[{path:'generic-new',name:'New'}]});
  hub.agentSessions=async()=>[{id:'s1',summary:{title:'Meaningful title',gist:'Summary'},projectId:'generic-new'}];
  const sessions=await (await hub.fetch(new Request('https://web.example/web/sessions'))).json();
  assert.equal(sessions[0].summary.gist,'Summary');assert.equal(sessions[0].title,'Meaningful title');assert.equal(sessions[0].projectId,'generic-new');
  console.log('PASS: worker project errors, profile delegation, folder mapping, summary forwarding');
} finally {globalThis.fetch=savedFetch;}
