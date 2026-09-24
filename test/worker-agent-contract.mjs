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
  // New session: exact profile/project/attachments contract is forwarded.
  {
    const h=hub(); let seen;
    globalThis.fetch=async(url,opts)=>{seen={url,body:JSON.parse(opts.body)}; return sse();};
    const res=await h.fetch(new Request('https://web.example/web/run',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({task:'hello',projectId:'p1',attachments:[{id:'f-1',name:'cv.pdf'}]})}));
    assert.equal(res.status,200); assert.equal(seen.url,'https://agent.example/web/run-bearer');
    assert.deepEqual(seen.body,{username:'alice',task:'hello',projectId:'p1',attachments:[{id:'f-1',name:'cv.pdf'}]});
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

  console.log('PASS: worker→agent create/reply/read contracts fail closed and preserve project/attachment metadata');
} finally { globalThis.fetch=savedFetch; }
