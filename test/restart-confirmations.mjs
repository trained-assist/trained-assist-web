import assert from 'node:assert/strict';
import { SessionHub } from '../worker.mjs';
const savedFetch=globalThis.fetch;
const data=new Map([['t:valid',{username:'owner'}]]);
const state={blockConcurrencyWhile:fn=>fn(),storage:{list:async()=>new Map(),get:async k=>data.get(k),put:async(k,v)=>data.set(k,v)}};
const hub=new SessionHub(state,{AGENT_VERIFY_URL:'https://agent.example/web/verify',AGENT_VERIFY_SECRET:'fixture'});
function request(method='GET',payload,auth=true){return new Request('https://web.example/web/restart-intents',{method,headers:{...(auth?{cookie:'web_token=valid'}:{}),'content-type':'application/json'},...(payload?{body:JSON.stringify(payload)}:{})});}
try {
 let calls=0;
 globalThis.fetch=async(url,opts)=>{calls++;assert.equal(url,'https://agent.example/web/restart-intents-bearer');assert.equal(opts.headers.authorization,'Bearer fixture');const p=JSON.parse(opts.body);assert.equal(p.username,'owner');assert.equal(p.owner,undefined);assert.equal(p.confirmedAt,undefined);assert.equal(p.payload,undefined);return Response.json(p.action==='list'?{intents:[]}:{decision:p.action,accepted:true});};
 assert.equal((await hub.fetch(request('GET',null,false))).status,401);assert.equal(calls,0);
 assert.deepEqual(await (await hub.fetch(request())).json(),{intents:[]});
 const result=await hub.fetch(request('POST',{handle:'handle',action:'cancel',username:'victim',owner:{username:'victim'},payload:{task:'evil'},confirmedAt:1}));
 assert.equal((await result.json()).decision,'cancel');assert.equal(calls,2);
 assert.equal((await hub.fetch(request('POST',{action:'list'}))).status,400);
 globalThis.fetch=async()=>new Response('{}',{status:404});assert.equal((await hub.fetch(request('POST',{handle:'x',action:'confirm'}))).status,404);
 globalThis.fetch=async()=>{throw Error('offline');};assert.equal((await hub.fetch(request())).status,503);
 console.log('PASS restart worker: authentication, authoritative profile, allowlisted payload, errors stay errors');
}finally{globalThis.fetch=savedFetch;}
