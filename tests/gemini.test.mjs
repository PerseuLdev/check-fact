import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {GeminiAuth,googleScopes} from '../lib/gemini-auth.mjs';
import {geminiResponse} from '../lib/gemini-ai.mjs';
import {check} from '../lib/ai.mjs';
import {LiveEngine} from '../lib/engine.mjs';
class MemoryStore{
  constructor(data={version:1,profiles:[],activeId:null}){this.data=structuredClone(data);this.tail=Promise.resolve();}
  async load(){return structuredClone(this.data);}
  transaction(fn){const task=this.tail.catch(()=>{}).then(async()=>{const d=structuredClone(this.data),result=await fn(d);this.data=d;return{data:structuredClone(d),result};});this.tail=task;return task;}
}
const client={installed:{client_id:'123-test.apps.googleusercontent.com',client_secret:'test-client-secret',project_id:'verifica-test',token_uri:'https://untrusted.invalid/token'}};
const profile={id:'p',accessToken:'test-access',refreshToken:'test-refresh',scopes:googleScopes,expiresAt:Date.now()+3600000,selectedModel:'gemini-2.5-flash'};
const saved=extra=>({version:1,activeId:'p',profiles:[{...profile,...extra}],config:{clientId:client.installed.client_id,clientSecret:client.installed.client_secret,projectId:client.installed.project_id}});
const token=extra=>({access_token:'new-access',refresh_token:'new-refresh',token_type:'Bearer',expires_in:3600,scope:googleScopes.join(' '),...extra});
const params=u=>new URLSearchParams({state:new URL(u).searchParams.get('state'),code:'test-code'});
const completed=(value,metadata)=>({candidates:[{finishReason:'STOP',content:{parts:[{text:value}]},...(metadata?{groundingMetadata:metadata}:{})}]});

test('Google requires a desktop OAuth client and never trusts endpoints imported in its JSON',async()=>{
  const g=new GeminiAuth({store:new MemoryStore()});await g.ready;
  await assert.rejects(()=>g.begin(),/JSON/);await assert.rejects(()=>g.configure({web:client.installed}),/Desktop/);
  await g.configure(client);const u=new URL((await g.begin()).authorizeUrl);
  assert.equal(u.origin,'https://accounts.google.com');assert.equal(u.searchParams.get('code_challenge_method'),'S256');assert.equal(u.searchParams.get('access_type'),'offline');assert.equal(u.searchParams.get('redirect_uri'),'http://127.0.0.1:4310/');
  assert.equal(u.searchParams.has('client_secret'),false);assert.equal(g.data.config.token_uri,undefined);assert.equal(JSON.stringify(g.snapshot()).includes('test-client-secret'),false);
});

test('Google rejects forged/replayed callbacks and keeps tokens out of public state',async()=>{
  let calls=0,form;
  const g=new GeminiAuth({store:new MemoryStore(),fetcher:async(url,options)=>{calls++;assert.equal(url,'https://oauth2.googleapis.com/token');form=new URLSearchParams(options.body);return Response.json(token());}});
  await g.configure(client);const {authorizeUrl}=await g.begin();
  await assert.rejects(()=>g.callback(new URLSearchParams({state:'forged',code:'x'})),/inválido/);assert.equal(calls,0);
  await g.callback(params(authorizeUrl));assert.equal(g.snapshot().connected,true);assert.equal(form.get('grant_type'),'authorization_code');assert.ok(form.get('code_verifier').length>=43);
  assert.equal(JSON.stringify(g.snapshot()).includes('new-access'),false);assert.equal(JSON.stringify(g.snapshot()).includes('new-refresh'),false);
  await assert.rejects(()=>g.callback(params(authorizeUrl)),/inválido/);assert.equal(calls,1);
});

test('Google identity-only consent and cancellation during exchange cannot activate a connection',async()=>{
  const identity=new GeminiAuth({store:new MemoryStore(),fetcher:async()=>Response.json(token({scope:'openid email'}))});await identity.configure(client);const u=await identity.begin();
  await assert.rejects(()=>identity.callback(params(u.authorizeUrl)),/não foi autorizado/);assert.equal(identity.snapshot().connected,false);
  let release;const g=new GeminiAuth({store:new MemoryStore(),fetcher:()=>new Promise(r=>{release=r;})});await g.configure(client);const b=await g.begin();const exchange=g.callback(params(b.authorizeUrl));await Promise.resolve();g.cancel();release(Response.json(token()));
  await assert.rejects(()=>exchange,/cancelada/);assert.equal(g.snapshot().connected,false);
});

test('Google refresh is serialized and preserves an existing refresh token when none is rotated',async()=>{
  let calls=0;const g=new GeminiAuth({store:new MemoryStore(saved({expiresAt:0})),fetcher:async()=>{calls++;await new Promise(r=>setTimeout(r,5));return Response.json(token({refresh_token:undefined}));}});await g.ready;
  const values=await Promise.all(Array.from({length:5},()=>g.accessToken()));assert.equal(calls,1);assert.equal(new Set(values).size,1);assert.equal(g.profile().refreshToken,'test-refresh');
});

test('Google terminal failures clear tokens; temporary failures preserve the saved connection',async()=>{
  for(const temporary of [false,true]){const g=new GeminiAuth({store:new MemoryStore(saved({expiresAt:0})),fetcher:async()=>Response.json({error:temporary?'server_error':'invalid_grant'},{status:temporary?503:400})});await g.ready;await assert.rejects(()=>g.accessToken());assert.equal(!!g.profile().accessToken,temporary);}
});

test('Google honors omitted initial scope, rejects reduced refresh scope and requests reauth without a refresh token',async()=>{
  const initial=new GeminiAuth({store:new MemoryStore(),fetcher:async()=>Response.json(token({scope:undefined}))});await initial.configure(client);const flow=await initial.begin();await initial.callback(params(flow.authorizeUrl));assert.equal(initial.snapshot().connected,true);
  const reduced=new GeminiAuth({store:new MemoryStore(saved({expiresAt:0})),fetcher:async()=>Response.json(token({scope:'openid email'}))});await reduced.ready;await assert.rejects(()=>reduced.accessToken(),e=>e.status===401);assert.equal(reduced.snapshot().connected,false);
  const expired=new GeminiAuth({store:new MemoryStore(saved({expiresAt:0,refreshToken:null}))});await expired.ready;await assert.rejects(()=>expired.accessToken(),e=>e.status===401);
});

test('Gemini catalog uses only returned generation models and never grants access to arbitrary endpoints',async()=>{
  let options;const g=new GeminiAuth({store:new MemoryStore(saved({selectedModel:null})),fetcher:async(url,o)=>{options=o;assert.match(url,/generativelanguage.googleapis.com\/v1beta\/models/);return Response.json({models:[{name:'models/gemini-2.5-flash',displayName:'Gemini Flash',supportedGenerationMethods:['generateContent']},{name:'models/embedding',supportedGenerationMethods:['embedContent']},{name:'models/gemini-image',supportedGenerationMethods:['generateContent']}]});}});await g.ready;
  await assert.rejects(()=>g.fetchAuthed('https://untrusted.invalid'),/não permitido/);await assert.rejects(()=>g.fetchAuthed('/models/../secrets'),/não permitido/);
  assert.deepEqual(await g.models(),[{id:'gemini-2.5-flash',name:'Gemini Flash'}]);assert.equal(g.snapshot().selectedModel,'gemini-2.5-flash');assert.equal(g.snapshot().verifiedModel,null);assert.equal(options.headers['x-goog-user-project'],'verifica-test');
  await assert.rejects(()=>g.selectModel('invented-model'),/catálogo/);
});

test('Gemini grounding is preserved across separate research and JSON calls; invented URLs are rejected',async()=>{
  const requests=[];let marked=0;
  const service={async fetchAuthed(path,o){requests.push(JSON.parse(o.body));return Response.json(requests.length===1?completed('Relatório apoiado pela fonte consultada.',{groundingChunks:[{web:{uri:'https://real.invalid/fonte',title:'Fonte primária'}}],webSearchQueries:['busca']}):completed(JSON.stringify({verdict:'correta',tags:[],explanation:'Explicação',context:'Contexto',evidence:[{url:'https://real.invalid/fonte',title:'Real',finding:'Achado real',relationship:'supports'},{url:'https://invented.invalid/fonte',title:'Inventada',finding:'Achado inventado',relationship:'supports'}]})));},async markInference(){marked++;}};
  const result=await check({quote:'A afirmação com período explícito.',claim:'Uma afirmação histórica.',kind:'factual'},[], '2020-01-01',{provider:'gemini',service,profileId:'p',model:'gemini-2.5-flash'});
  assert.equal(requests.length,2);assert.deepEqual(requests[0].tools,[{googleSearch:{}}]);assert.equal(requests[0].generationConfig.responseJsonSchema,undefined);assert.equal(requests[1].tools,undefined);assert.ok(requests[1].generationConfig.responseJsonSchema);assert.equal(result.evidence.length,1);assert.equal(marked,1);
});

test('Gemini refuses partial responses and abstains without a grounded source',async()=>{
  const auth={provider:'gemini',profileId:'p',model:'gemini-2.5-flash',service:{fetchAuthed:async()=>Response.json({candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:'partial'}]}}]}),markInference:async()=>{}}};
  await assert.rejects(()=>geminiResponse(auth,{input:'x'},undefined),/não concluiu/);
  let calls=0;auth.service.fetchAuthed=async()=>{calls++;return Response.json(completed('Um texto sem fontes registradas.'));};
  const response=await geminiResponse(auth,{input:'x',tools:[{type:'web_search'}]},undefined);assert.equal(calls,1);assert.equal(JSON.parse(response.output[0].content[0].text).verdict,'evidencias_insuficientes');
});

test('Google disconnect clears local tokens even when remote revocation fails',async()=>{
  const g=new GeminiAuth({store:new MemoryStore(saved()),fetcher:async()=>{throw new Error('offline');}});await g.ready;const result=await g.disconnect();assert.equal(result.revoked,false);assert.equal(g.snapshot().connected,false);assert.equal(g.snapshot().configured,true);
});

test('a Gemini session pins provider/model and prevents switching to another billing source while running',async()=>{
  const g=new EventEmitter();g.ready=Promise.resolve();g.snapshot=()=>({connected:true,activeId:'google-profile',selectedModel:'gemini-2.5-flash'});g.models=async()=>[{id:'gemini-2.5-flash'}];
  const c=new EventEmitter();c.stdout=new PassThrough();c.kill=()=>{};
  const asr=new EventEmitter();asr.snapshot=()=>({status:'ready'});asr.prepare=async()=>{};
  const e=new LiveEngine({gemini:g,localAsr:asr,resolve:async()=>({id:'BgjpOorIXoI'}),capture:()=>c});e.useGemini();
  await e.start({url:'https://www.youtube.com/watch?v=BgjpOorIXoI'});assert.equal(e.sessionAuth.provider,'gemini');assert.equal(e.sessionAuth.model,'gemini-2.5-flash');assert.equal(e.sessionAuth.profileId,'google-profile');assert.equal(e.provider,'gemini');assert.throws(()=>e.useChatGPT(),/Encerre/);e.stop();
});
