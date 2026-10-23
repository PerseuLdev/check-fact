import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createWebApp, boundedBody } from '../lib/web-app.mjs';
import { WebSessions, MemoryStore, TranscriptionPool } from '../lib/web-sessions.mjs';
import { LiveEngine } from '../lib/engine.mjs';
import { PCMEncoder } from '../public/pcm-codec.js';
import { PassThrough } from 'node:stream';

const origin='https://verifica.example';
class FakeASR extends EventEmitter {
  constructor(){super();this.state={status:'ready',model:'test',device:'cpu'};this.calls=[];}
  snapshot(){return {...this.state};}
  async prepare(){return this.snapshot();}
  async transcribe(pcm){this.calls.push(pcm.length);return 'Este é um trecho de fala transcrito para validar a entrada de áudio.';}
  shutdown(){}
}
function fixture(t,{maxActive=2,createContext,...options}={}){
  const contexts=[];
  const sessions=new WebSessions({origin,maxActive,createContext:createContext||(()=>{const asr=new FakeASR(),engine=new LiveEngine({localAsr:asr,record:false});engine.key='';const ctx={engine,asr,oauth:null};contexts.push(ctx);return ctx;})});
  const app=createWebApp({origin,sessions,...options});t.after(()=>app.close());return {app,sessions,contexts};
}
async function browser(app){
  const r=await app.fetch(new Request(origin+'/api/web/session'));assert.equal(r.status,200);const d=await r.json(),cookie=r.headers.get('set-cookie').split(';')[0];
  return {csrf:d.csrf,cookie,data:d,async get(path='/api/web/state'){return app.fetch(new Request(origin+path,{headers:{cookie}}));},async post(path,data={},headers={}){return app.fetch(new Request(origin+'/api/web/'+path,{method:'POST',headers:{cookie,origin,'content-type':'application/json','x-csrf-token':d.csrf,...headers},body:JSON.stringify(data)}));}};
}
const pcm=seconds=>{const b=Buffer.alloc(Math.round(seconds*16000)*2);for(let i=0;i<b.length;i+=2)b.writeInt16LE(1200,i);return b;};

test('web browsers have separate credentials, engine state, transcripts and cookies',async t=>{
  const {app,contexts}=fixture(t),a=await browser(app),b=await browser(app);
  assert.notEqual(a.cookie,b.cookie);assert.notEqual(a.csrf,b.csrf);assert.equal(a.data.localPlan,false);
  const r=await a.post('gateway',{key:'test-private-gateway-key'});assert.equal(r.status,200);
  contexts[0].engine.state.segments.push({id:1,text:'texto privado',start:0,end:1});
  const ad=await (await a.get()).json(),bd=await (await b.get()).json();
  assert.equal(ad.state.aiConfigured,true);assert.equal(bd.state.aiConfigured,false);assert.deepEqual(bd.state.segments,[]);
  assert.equal(JSON.stringify(ad).includes('test-private-gateway-key'),false);
  assert.equal((await app.fetch(new Request(origin+'/api/web/state'))).status,401);
});
test('secure cookie, CSRF and origin checks reject cross-site requests and forged sessions',async t=>{
  const {app}=fixture(t),r=await app.fetch(new Request(origin+'/api/web/session')),cookie=r.headers.get('set-cookie');
  assert.match(cookie,/^__Host-verifica_session=/);assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Lax/);
  const a=await browser(app);
  assert.equal((await a.post('stop',{}, {'x-csrf-token':'wrong'})).status,403);
  assert.equal((await a.post('stop',{}, {origin:'https://attacker.example'})).status,403);
  assert.equal((await a.post('stop',{}, {origin:''})).status,403);
  assert.equal((await app.fetch(new Request(origin+'/api/web/session',{headers:{'sec-fetch-site':'cross-site'}}))).status,403);
  assert.equal((await app.fetch(new Request(origin+'/api/web/state',{headers:{cookie:'verifica_session='+'a'.repeat(64)}}))).status,401);
  assert.equal((await app.fetch(new Request('https://other.example/api/web/session'))).status,403);
});
test('public web does not offer the loopback ChatGPT plan flow or inherit the operator key',async t=>{
  const old=process.env.AI_GATEWAY_API_KEY;process.env.AI_GATEWAY_API_KEY='test-operator-key';
  const app=createWebApp({origin});t.after(()=>{app.close();if(old===undefined)delete process.env.AI_GATEWAY_API_KEY;else process.env.AI_GATEWAY_API_KEY=old;});
  const b=await browser(app);assert.equal(b.data.state.aiConfigured,false);assert.equal(b.data.auth,null);
  assert.equal((await b.post('auth/begin')).status,409);
  assert.equal((await b.post('start',{input:'capture',transcribeOnly:false})).status,400);
  assert.equal((await app.fetch(new Request(origin+'/auth/callback?state=forged'))).status,401);
});
test('optional access code gates every processing route and is rate limited',async t=>{
  const {app}=fixture(t,{accessCode:'test-invite'}),b=await browser(app);assert.equal(b.data.locked,true);
  assert.equal((await b.get()).status,403);assert.equal((await b.post('unlock',{code:'wrong'})).status,403);
  assert.equal((await b.post('unlock',{code:'test-invite'})).status,200);assert.equal((await b.get()).status,200);
  const c=await browser(app);for(let i=0;i<5;i++)await c.post('unlock',{code:'wrong'});assert.equal((await c.post('unlock',{code:'test-invite'})).status,429);
});
test('capture uploads enforce stream ownership, sequence, format, bounds and stop cancellation',async t=>{
  const {app}=fixture(t),a=await browser(app),b=await browser(app);
  const started=await (await a.post('start',{input:'capture',transcribeOnly:true,title:'Áudio autorizado'})).json(),id=started.state.sessionId;
  const upload=(client,body,seq=0,streamId=id)=>app.fetch(new Request(origin+'/api/web/audio',{method:'POST',headers:{cookie:client.cookie,origin,'x-csrf-token':client.csrf,'content-type':'application/octet-stream','x-audio-sequence':String(seq),'x-stream-id':streamId},body}));
  assert.equal((await upload(b,pcm(.6))).status,400);assert.equal((await upload(a,pcm(.6),1)).status,400);
  assert.equal((await upload(a,Buffer.alloc(128002))).status,413);assert.equal((await upload(a,Buffer.alloc(3))).status,400);
  assert.equal((await upload(a,pcm(.6))).status,200);assert.equal((await upload(a,pcm(.6))).status,400);
  await a.post('stop');assert.equal((await upload(a,pcm(.6),1)).status,400);
});
test('capture reaches the real engine and ends with a transcript without an AI key or saved record',async t=>{
  const {app,contexts}=fixture(t),a=await browser(app),data=await (await a.post('start',{input:'capture',transcribeOnly:true})).json();
  const e=contexts[0].engine;e.pushAudio(pcm(.6),data.state.sessionId,0);
  const end=await a.post('end-audio',{streamId:data.state.sessionId});assert.equal(end.status,200);
  await new Promise(resolve=>setTimeout(resolve,800));const s=(await (await a.get()).json()).state;
  assert.equal(s.status,'completed');assert.equal(s.metrics.transcripts,1);assert.equal(s.metrics.published,0);assert.equal(s.segments.length,1);assert.equal(contexts[0].asr.calls.length,1);assert.equal(e.deps.record,false);
});
test('web mode uses server ASR for YouTube even when Gateway is explicitly selected',async t=>{
  let cloudCalls=0,captureDuration;const asr=new FakeASR(),child=new EventEmitter();child.stdout=new PassThrough();child.kill=()=>child.emit('close',0);
  const e=new LiveEngine({localAsr:asr,localTranscription:true,record:false,resolve:async()=>({id:'BgjpOorIXoI',title:'Teste',duration:100}),capture:(_info,_offset,duration)=>{captureDuration=duration;return child;},transcribe:async()=>{cloudCalls++;return 'nuvem';},detect:async()=>({state:'none',claims:[],revisions:[]})});
  t.after(()=>e.stop());e.configure('test-explicit-gateway-key');await e.start({url:'https://www.youtube.com/watch?v=BgjpOorIXoI',continuous:true});
  e.audioQueue.push({pcm:pcm(.6),start:0,end:.6,endedAt:Date.now()});await e.pumpAudio(e.generation);
  assert.equal(cloudCalls,0);assert.equal(asr.calls.length,1);assert.equal(captureDuration,0);
});
test('capacity is reserved during model preparation and a stop cancels a pending start',async t=>{
  let release;const gate=new Promise(r=>{release=r;});
  const {app}=fixture(t,{maxActive:1,createContext:()=>{const asr=new FakeASR();asr.prepare=()=>gate;const engine=new LiveEngine({localAsr:asr,record:false});engine.key='';return {engine,asr};}}),a=await browser(app),b=await browser(app);
  const first=a.post('start',{input:'capture',transcribeOnly:true});await new Promise(r=>setTimeout(r,5));
  assert.equal((await b.post('start',{input:'capture',transcribeOnly:true})).status,503);await a.post('stop');release();await first;
  assert.equal((await (await a.get()).json()).state.status,'stopped');
});
test('deleting one session clears its data and does not affect another browser',async t=>{
  const {app,sessions}=fixture(t),a=await browser(app),b=await browser(app);await a.post('gateway',{key:'test-session-secret'});await b.post('gateway',{key:'other-session-secret'});
  assert.equal((await a.post('session/delete')).status,200);assert.equal((await a.get()).status,401);assert.equal((await (await b.get()).json()).state.aiConfigured,true);assert.equal(sessions.entries.size,1);
});
test('SSE is session-bound and detaches listeners immediately on cancellation',async t=>{
  const {app,contexts}=fixture(t),a=await browser(app),b=await browser(app),res=await a.get('/api/web/events'),reader=res.body.getReader();
  assert.equal(res.headers.get('content-type'),'text/event-stream');const initial=new TextDecoder().decode((await reader.read()).value);assert.match(initial,/snapshot/);
  assert.equal(contexts[0].engine.listenerCount('event'),1);assert.equal(contexts[1].engine.listenerCount('event'),0);await reader.cancel();assert.equal(contexts[0].engine.listenerCount('event'),0);
  assert.equal((await b.get()).status,200);
});
test('expired sessions are stopped and session exhaustion does not evict active visitors',()=>{
  let now=0;const r=new WebSessions({origin,maxSessions:1,idleMs:100,now:()=>now,createContext:()=>({engine:new LiveEngine({record:false}),asr:new FakeASR()})});
  const a=r.create();assert.throws(()=>r.create(),/cheio/);now=101;r.sweep();assert.equal(r.get(a.token),null);assert.equal(a.session.engine.state.status,'stopped');assert.equal(r.entries.size,0);r.close();
});
test('PCM resampling preserves duration and channel values across fragmented browser callbacks',()=>{
  for(const rate of [44100,48000]){const chunks=[],e=new PCMEncoder(rate,p=>chunks.push(p));for(let offset=0;offset<rate;offset+=128)e.push(new Float32Array(Math.min(128,rate-offset)).fill(.5));e.flush();assert.equal(chunks.reduce((n,p)=>n+p.length,0),16000);for(const chunk of chunks)assert.equal(chunk[0],16384);}
  const chunks=[],e=new PCMEncoder(48000,p=>chunks.push(p));e.push(new Float32Array(1440).fill(-1));e.flush();assert.equal(chunks[0].length,480);assert.equal(chunks[0][0],-32768);
});
test('memory credential transactions are serialized and do not leak mutable references',async()=>{
  const store=new MemoryStore();await Promise.all(Array.from({length:5},(_,i)=>store.transaction(d=>{d.profiles.push({id:i});})));const a=await store.load();a.profiles.length=0;assert.equal((await store.load()).profiles.length,5);
});
test('PCM transfer detaches delivered buffers without breaking later worklet chunks',()=>{
  const delivered=[];const e=new PCMEncoder(48000,pcm=>{delivered.push(structuredClone(pcm,{transfer:[pcm.buffer]}));});
  for(let offset=0;offset<48000*3;offset+=128)e.push(new Float32Array(Math.min(128,48000*3-offset)).fill(.5));e.flush();
  assert.deepEqual(delivered.map(p=>p.length),[16000,16000,16000]);assert.equal(delivered[2][0],16384);
});
test('ASR jobs are serialized across visitors and cancellation does not process queued audio',async()=>{
  const worker=new FakeASR();let current=0,max=0;worker.transcribe=async()=>{max=Math.max(max,++current);await new Promise(r=>setTimeout(r,5));current--;return 'texto';};
  const pool=new TranscriptionPool(worker),a=pool.facade(),b=pool.facade(),cancel=new AbortController();
  const one=a.transcribe(pcm(.1),null),two=b.transcribe(pcm(.1),null,cancel.signal);cancel.abort();await assert.rejects(two);await one;assert.equal(max,1);assert.equal(pool.queued,0);pool.close();
});
test('streamed request size limit applies even without Content-Length',async()=>{
  const request=new Request(origin,{method:'POST',body:new ReadableStream({start(c){c.enqueue(new Uint8Array(6));c.enqueue(new Uint8Array(6));c.close();}}),duplex:'half'});await assert.rejects(()=>boundedBody(request,10),/grande/);
});
