import assert from 'node:assert/strict';
import { SessionHub } from '../worker.mjs';

const savedFetch = globalThis.fetch;
const state = { blockConcurrencyWhile: fn => fn(), storage: { list: async()=>new Map(), get: async()=>undefined, put: async()=>{} } };
function hub() {
  const h = new SessionHub(state,{AGENT_VERIFY_URL:'https://agent.example/web/verify',AGENT_VERIFY_SECRET:'fixture'});
  h.isAuthed=async()=>true; h.tokenUser=async()=> 'alice';
  return h;
}
const sse = () => new Response('data: {"type":"done","sessionId":"real-1"}\n\n',{status:200,headers:{'content-type':'text/event-stream'}});

try {
  // New session: bytes are copied to agent intake first; run gets durable fileRefs.
  {
    const h=hub(); let runSeen=null, uploadSeen=null;
    h.state.storage.get=async key=>key==='f:f-1'
      ? {id:'f-1',name:'cv.pdf',type:'application/pdf',size:4,b64:btoa('test')}
      : undefined;
    globalThis.fetch=async(url,opts)=>{
      if (url.endsWith('/web/intake-file-bearer')) {
        uploadSeen={url,headers:opts.headers,bytes:new Uint8Array(opts.body)};
        return Response.json({ok:true});
      }
      runSeen={url,body:JSON.parse(opts.body)};
      return sse();
    };
    const res=await h.fetch(new Request('https://web.example/web/run',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({task:'hello',projectId:'p1',requestId:'req-new-1',attachments:[{id:'f-1',name:'cv.pdf'}]})}));
    assert.equal(res.status,200);
    assert.equal(uploadSeen.url,'https://agent.example/web/intake-file-bearer');
    assert.equal(uploadSeen.headers['x-username'],'alice');
    assert.equal(uploadSeen.headers['content-type'],'application/pdf');
    assert.equal(new TextDecoder().decode(uploadSeen.bytes),'test');
    assert.equal(runSeen.url,'https://agent.example/web/run-bearer');
    assert.equal(runSeen.body.username,'alice');
    assert.equal(runSeen.body.task,'hello');
    assert.equal(runSeen.body.projectId,'p1');
    assert.equal(runSeen.body.requestId,'req-new-1');
    assert.equal(runSeen.body.fileRefs.length,1);
    assert.match(runSeen.body.fileRefs[0].id,/^[a-f0-9]{64}$/);
    assert.equal(runSeen.body.fileRefs[0].name,'cv.pdf');
  }

  // Upstream rejection and outage are visible; never replaced by local demo success.
  for (const mode of ['reject','offline']) {
    const h=hub();
    globalThis.fetch = mode==='reject'
      ? async()=>Response.json({error:'busy'},{status:409})
      : async()=>{throw new Error('offline')};
    const res=await h.fetch(new Request('https://web.example/web/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({task:'hello'})}));
    assert.equal(res.status, mode==='reject'?409:503);
    assert.equal(h.sessions.size,0,'failed real run must not create a local demo session');
  }

  // A metadata ref without bytes must fail before the agent task starts.
  {
    const h=hub(); let calls=0; globalThis.fetch=async()=>{calls++;return sse();};
    const res=await h.fetch(new Request('https://web.example/web/run',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({task:'hello',attachments:[{id:'missing',name:'lost.pdf'}]})}));
    assert.equal(res.status,400); assert.equal(calls,0);
    assert.match((await res.json()).error,/bytes missing/);
  }

  // Agent duplicate response is preserved all the way to the browser so UI can
  // treat a retry as already accepted instead of inventing a fresh mutation.
  {
    const h=hub();
    globalThis.fetch=async()=>Response.json({
      error:'duplicate request already accepted',duplicate:true,requestId:'req-dup',
      state:'done',sessionId:'real-1'
    },{status:409});
    const res=await h.fetch(new Request('https://web.example/web/reply/real-1',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({message:'continue',requestId:'req-dup'})
    }));
    assert.equal(res.status,409);
    const data=await res.json();
    assert.equal(data.duplicate,true);
    assert.equal(data.requestId,'req-dup');
    assert.equal(data.state,'done');
    assert.equal(data.sessionId,'real-1');
  }

  // Reply preserves upstream error instead of collapsing into local 404.
  {
    const h=hub(); globalThis.fetch=async()=>Response.json({error:'session busy'},{status:409});
    const res=await h.fetch(new Request('https://web.example/web/reply/real-1',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:'continue'})}));
    assert.equal(res.status,409); assert.equal((await res.json()).error,'session busy');
  }

  // Session list outage is explicit, not an empty array that looks like data loss.
  {
    const h=hub(); globalThis.fetch=async()=>{throw new Error('offline')};
    const res=await h.fetch(new Request('https://web.example/web/sessions'));
    assert.equal(res.status,503); assert.match((await res.json()).error,/agent unavailable/);
  }

  console.log('PASS: worker→agent create/reply/read contracts fail closed; web attachment bytes are durably bridged before task start');
} finally { globalThis.fetch=savedFetch; }
