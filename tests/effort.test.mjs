import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {openaiEfforts,geminiEfforts,geminiThinking,validateEffort} from '../lib/effort.mjs';
import {ChatGPTAuth} from '../lib/chatgpt-auth.mjs';
import {GeminiAuth,googleScopes} from '../lib/gemini-auth.mjs';
import {testChatGPT,detect,check,transcribe,models} from '../lib/ai.mjs';
import {geminiResponse} from '../lib/gemini-ai.mjs';
import {LiveEngine} from '../lib/engine.mjs';
import {extensionRequest,extensionToken} from '../lib/extension-bridge.mjs';

class MemoryStore{
  constructor(data){this.data=structuredClone(data);this.tail=Promise.resolve();}
  async load(){return structuredClone(this.data);}
  transaction(fn){const task=this.tail.then(async()=>{const data=structuredClone(this.data),result=await fn(data);this.data=data;return{data:structuredClone(data),result};});this.tail=task.catch(()=>{});return task;}
}
const profile=(id='p')=>({id,label:id,accessToken:'fake-token',expiresAt:Date.now()+3600000,scopes:['resource.invoke','chatgpt.tokens.use.direct'],selectedModel:'gpt-6-luna'});
const catalog={models:[{slug:'gpt-6-luna',visibility:'list'},{slug:'gpt-6.1-sol',visibility:'list'},{slug:'gpt-4.1-mini',visibility:'list'}]};
const data={activeId:'p',profiles:[profile(),profile('q')]};
const triage={state:'none',reason:'Sem afirmação.',claims:[],waitingSegmentIds:[],revisions:[]};
const result={verdict:'evidencias_insuficientes',tags:[],explanation:'Sem evidências.',context:'',evidence:[]};
const input={segments:[],freshIds:[],known:[],expanded:false};
function sse(text){return new Response('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',output:[{type:'message',content:[{type:'output_text',text}]}]}})+'\n\n');}

test('effort options are model-specific, respect catalog restrictions, and do not guess for unknown models',()=>{
  assert.ok(openaiEfforts('gpt-6-luna').includes('none'));
  assert.ok(!openaiEfforts('gpt-6.1-sol').includes('none'));
  for(const model of ['gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna'])assert.deepEqual(openaiEfforts(model),['none','low','medium','high','xhigh','max']);
  assert.deepEqual(openaiEfforts('gpt-6-luna',{supported_reasoning_efforts:['low',{effort:'high'},'ultra','high']}),['low','high']);
  assert.deepEqual(openaiEfforts('gpt-6-luna',{supported_reasoning_efforts:[]}),[]);
  assert.deepEqual(openaiEfforts('unknown-model'),[]);
  assert.deepEqual(openaiEfforts('openai/gpt-4.1-mini'),[]);
  assert.deepEqual(geminiEfforts('gemini-3-pro-preview'),['low','high']);
  assert.equal(validateEffort('default',[]),'default');
  for(const v of ['ultra',null,3,{},'high'])assert.throws(()=>validateEffort(v,[]),/effort/);
});

test('ChatGPT effort persists by model and account, survives reopening, and invalidates the previous inference test',async()=>{
  const store=new MemoryStore(data),a=new ChatGPTAuth({store,fetcher:async()=>Response.json(catalog)});await a.ready;
  assert.equal(a.snapshot().selectedEffort,'default');
  await a.selectEffort('max');await a.markInference('p','gpt-6-luna','max');assert.equal(a.snapshot().verifiedEffort,'max');
  await a.selectEffort('high');assert.equal(a.snapshot().verifiedModel,null);
  await a.selectModel('gpt-6.1-sol');assert.equal(a.snapshot().selectedEffort,'default');await assert.rejects(()=>a.selectEffort('none'),/effort/);
  await a.selectEffort('low');await a.selectModel('gpt-6-luna');assert.equal(a.snapshot().selectedEffort,'high');
  await a.selectProfile('q');assert.equal(a.snapshot().selectedEffort,'default');await a.selectEffort('medium');
  await a.selectProfile('p');assert.equal(a.snapshot().selectedEffort,'high');
  const reopened=new ChatGPTAuth({store});await reopened.ready;assert.equal(reopened.snapshot().selectedEffort,'high');
  await a.selectModel('gpt-4.1-mini');await assert.rejects(()=>a.selectEffort('high'),/effort/);await a.selectEffort('default');
});

test('catalog refresh removes a stale effort without sending an unsupported value',async()=>{
  let efforts=['low','high'];const a=new ChatGPTAuth({store:new MemoryStore(data),fetcher:async()=>Response.json({models:[{slug:'gpt-6-luna',visibility:'list',supported_reasoning_efforts:efforts}]})});await a.ready;
  await a.selectEffort('high');efforts=['low'];await a.models({force:true});assert.equal(a.snapshot().selectedEffort,'default');assert.deepEqual(a.snapshot().effortOptions,['low']);
});

test('ChatGPT connection test, triage and research send the selected reasoning effort; default omits it',async()=>{
  const requests=[];let answer='OK';
  const service=new ChatGPTAuth({store:new MemoryStore(data),fetcher:async(url,options)=>{if(url.endsWith('/models'))return Response.json(catalog);requests.push(JSON.parse(options.body));return sse(answer);}});await service.ready;await service.selectEffort('high');
  assert.equal((await testChatGPT(service)).effort,'high');
  const auth={provider:'chatgpt',service,profileId:'p',model:'gpt-6-luna',effort:service.snapshot().selectedEffort};
  answer=JSON.stringify(triage);await detect(input,auth);answer=JSON.stringify(result);await check({claim:'Fato independente de data.'},[],null,auth);
  assert.equal(requests.length,3);for(const request of requests){assert.deepEqual(request.reasoning,{effort:'high'});assert.equal(request.model,'gpt-6-luna');assert.equal(request.max_output_tokens,undefined);}
  assert.equal(service.snapshot().verifiedEffort,'high');await service.selectEffort('default');answer='OK';await testChatGPT(service);assert.equal(requests.at(-1).reasoning,undefined);
});

test('Gemini stores the preference and maps effort to native budgets or levels in every research stage',async()=>{
  const store=new MemoryStore({activeId:'p',profiles:[{...profile(),scopes:googleScopes,selectedModel:'gemini-2.5-flash'}]});const g=new GeminiAuth({store});await g.ready;await g.selectEffort('high');
  const reopened=new GeminiAuth({store});await reopened.ready;assert.equal(reopened.snapshot().selectedEffort,'high');
  assert.deepEqual(geminiThinking('gemini-2.5-pro','high'),{thinkingConfig:{thinkingBudget:8192},maxOutputTokens:16384});
  assert.deepEqual(geminiThinking('gemini-3-pro-preview','low'),{thinkingConfig:{thinkingLevel:'LOW'}});
  assert.throws(()=>geminiThinking('gemini-3-pro-preview','medium'),/effort/);
  assert.deepEqual(geminiThinking('gemini-2.0-flash','default'),{});
  const requests=[],response=(text,groundingMetadata)=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text}]},groundingMetadata}]});
  const auth={provider:'gemini',model:'gemini-2.5-flash',effort:'high',service:{fetchAuthed:async(_path,opts)=>{const body=JSON.parse(opts.body);requests.push(body);return response(body.tools?'Pesquisa.':JSON.stringify(result),body.tools?{groundingChunks:[{web:{uri:'https://example.invalid/source'}}]}:undefined);},markInference:async()=>{}}};
  await geminiResponse(auth,{input:'fato',tools:[{type:'web_search'}]});assert.equal(requests.length,2);
  for(const request of requests){assert.deepEqual(request.generationConfig.thinkingConfig,{thinkingBudget:8192});assert.equal(request.generationConfig.maxOutputTokens,16384);}
  await geminiResponse({...auth,model:'gemini-3.8-flash',effort:'low'},{input:'teste'});assert.deepEqual(requests.at(-1).generationConfig.thinkingConfig,{thinkingLevel:'LOW'});
});

test('Gateway sends effort only to compatible text calls, keeps the real credential and leaves transcription unchanged',async t=>{
  const requests=[];t.mock.method(globalThis,'fetch',async(url,options)=>{requests.push({url,body:JSON.parse(options.body),authorization:options.headers.Authorization});return Response.json(url.endsWith('/v4/ai/transcription-model')?{text:'áudio'}:{output_text:JSON.stringify(requests.length===1?triage:result)});});
  const auth={provider:'gateway',key:'fake-gateway-key',efforts:{detector:'default',checker:'high'}};
  await detect(input,auth);await check({claim:'Fato independente de data.'},[],null,auth);await transcribe(Buffer.alloc(100),auth);
  assert.equal(requests[0].body.reasoning,undefined);assert.deepEqual(requests[1].body.reasoning,{effort:'high'});assert.ok(requests[1].body.max_output_tokens>2400);assert.equal(requests[2].body.reasoning,undefined);
  for(const r of requests)assert.equal(r.authorization,'Bearer fake-gateway-key');
});

test('engine pins effort to the session, prevents changes while active, and keeps the Gateway key private',async()=>{
  const oauth=new ChatGPTAuth({store:new MemoryStore(data),fetcher:async()=>Response.json(catalog)});await oauth.ready;await oauth.selectEffort('max');
  const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.kill=()=>{};
  const asr=new EventEmitter();asr.prepare=async()=>{};asr.snapshot=()=>({});
  const e=new LiveEngine({oauth,localAsr:asr,resolve:async()=>({url:'https://www.youtube.com/watch?v=BgjpOorIXoI',mediaUrl:'https://example.invalid/audio'}),capture:()=>c});
  await e.start({url:'https://www.youtube.com/watch?v=BgjpOorIXoI'});assert.equal(e.sessionAuth.effort,'max');assert.equal(e.snapshot().selectedEffort,'max');assert.throws(()=>e.configureEfforts({detector:'default',checker:'high'}),/Encerre/);e.stop();
  e.configure('fake-gateway-key');e.configureEfforts({detector:'default',checker:'high'});assert.equal(e.snapshot().gatewayEfforts.checker.effort,'high');assert.equal(JSON.stringify(e.snapshot()).includes('fake-gateway-key'),false);
  assert.throws(()=>e.configureEfforts({detector:'high',checker:'low'}),/effort/);assert.equal(e.snapshot().gatewayEfforts.checker.effort,'high');
});

test('paired extension can save effort only while the engine is idle',async()=>{
  let saved;const e={provider:'chatgpt',ensureIdle(){},oauth:{selectEffort:async v=>{saved=v;}},snapshot:()=>({selectedEffort:saved})};
  const request=()=>new Request('http://127.0.0.1:4310/api/extension',{method:'POST',headers:{origin:'chrome-extension://'+'a'.repeat(32),authorization:'Bearer '+extensionToken,'content-type':'application/json'},body:JSON.stringify({action:'effort',data:{effort:'high'}})});
  const r=await extensionRequest(request(),()=>e);assert.equal(r.status,200);assert.equal((await r.json()).selectedEffort,'high');
  e.ensureIdle=()=>{throw new Error('Encerre a sessão.');};assert.equal((await extensionRequest(request(),()=>e)).status,400);
});
