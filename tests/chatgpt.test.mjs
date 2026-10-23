import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { ChatGPTAuth } from '../lib/chatgpt-auth.mjs';
import { chatgptBody, completedResponse } from '../lib/response-stream.mjs';
import { CredentialStore } from '../lib/credential-store.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';

class MemoryStore{
  constructor(data={version:1,hostId:null,activeId:null,profiles:[]}){this.data=structuredClone(data);this.tail=Promise.resolve();}
  async load(){return structuredClone(this.data);}
  transaction(fn){const task=this.tail.then(async()=>{const d=structuredClone(this.data),result=await fn(d);this.data=d;return{data:structuredClone(d),result};});this.tail=task.catch(()=>{});return task;}
}
const keys=await generateKeyPair('RS256'),jwk=await exportJWK(keys.publicKey);jwk.kid='test';
const keySet=createLocalJWKSet({keys:[jwk]});
const fullScope='openid email profile resource.invoke chatgpt.tokens.use.direct offline_access';
async function signed(nonce,overrides={}){return new SignJWT({nonce,email:'tester@example.invalid',...overrides}).setProtectedHeader({alg:'RS256',kid:'test'}).setSubject('user-test').setIssuer('https://auth.openai.com').setAudience('oaiapp_test').setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);}
function callbacks(state){return new URLSearchParams({state,code:'one-time-code',client_id:'oaiapp_test'});}
function metadata(){return Response.json({issuer:'https://auth.openai.com',jwks_uri:'https://auth.openai.com/.well-known/jwks.json',revocation_endpoint:'https://auth.openai.com/api/accounts/oauth/revoke'});}
function profile(extra={}){return{id:'p',clientId:'oaiapp_test',label:'Conexão 1',subject:'user-test',email:'tester@example.invalid',idToken:'test-identity',accessToken:'test-access',refreshToken:'test-refresh',expiresAt:Date.now()+3600000,scopes:fullScope.split(' '),...extra};}
function data(p=profile()){return{version:1,hostId:'urn:uuid:host-test',activeId:p.id,profiles:[p]};}

test('new login uses PKCE and a persistent host; returning login reuses the issued client',async()=>{
  const store=new MemoryStore();const a=new ChatGPTAuth({store});await a.ready;
  const first=new URL((await a.begin()).authorizeUrl),host=first.searchParams.get('ext_agent_host_id');
  assert.equal(first.origin,'https://auth.openai.com');assert.equal(first.searchParams.get('client_id'),'dynamic_agent_client');assert.equal(first.searchParams.get('code_challenge_method'),'S256');assert.equal(first.searchParams.get('redirect_uri'),'http://127.0.0.1:4310/auth/callback');assert.match(host,/^urn:uuid:/);
  const state=first.searchParams.get('state');const second=new URL((await a.begin()).authorizeUrl);assert.equal(second.searchParams.get('ext_agent_host_id'),host);assert.notEqual(second.searchParams.get('state'),state);
  const b=new ChatGPTAuth({store:new MemoryStore(data())});await b.ready;const returning=new URL((await b.begin({profileId:'p'})).authorizeUrl);
  assert.equal(returning.searchParams.get('client_id'),'oaiapp_test');assert.equal(returning.searchParams.has('agent_name_hint'),false);assert.equal(returning.searchParams.has('id_token_hint'),false);
});
test('a forged callback is rejected before token exchange, and accepted callbacks cannot be replayed',async()=>{
  let nonce,calls=0;
  const a=new ChatGPTAuth({store:new MemoryStore(),keySet,fetcher:async url=>{if(url.includes('openid-configuration'))return metadata();calls++;return Response.json({access_token:'test-access',refresh_token:'test-refresh',id_token:await signed(nonce),expires_in:3600,scope:fullScope});}});
  await a.ready;const u=new URL((await a.begin()).authorizeUrl);nonce=u.searchParams.get('nonce');
  await assert.rejects(()=>a.callback(callbacks('forged-state')),/inválida/);assert.equal(calls,0);
  await a.callback(callbacks(u.searchParams.get('state')));assert.equal(a.snapshot().planEnabled,true);assert.equal(calls,1);
  assert.equal(JSON.stringify(a.snapshot()).includes('test-access'),false);assert.equal(JSON.stringify(a.snapshot()).includes('test-refresh'),false);
  await assert.rejects(()=>a.callback(callbacks(u.searchParams.get('state'))),/inválida/);assert.equal(calls,1);
});
test('a signed identity with a wrong nonce is not activated',async()=>{
  const a=new ChatGPTAuth({store:new MemoryStore(),keySet,fetcher:async url=>url.includes('openid-configuration')?metadata():Response.json({access_token:'test-access',id_token:await signed('wrong-nonce'),expires_in:3600,scope:fullScope})});
  await a.ready;const u=new URL((await a.begin()).authorizeUrl);await assert.rejects(()=>a.callback(callbacks(u.searchParams.get('state'))),/validar/);
  assert.equal(a.snapshot().connected,false);assert.equal(a.snapshot().planEnabled,false);
});
test('identity-only consent is retained but cannot make inference requests',async()=>{
  let nonce,apiCalls=0;
  const a=new ChatGPTAuth({store:new MemoryStore(),keySet,fetcher:async url=>{if(url.includes('api.openai.com'))apiCalls++;if(url.includes('openid-configuration'))return metadata();return Response.json({id_token:await signed(nonce),scope:'openid email profile'});}});
  await a.ready;const u=new URL((await a.begin()).authorizeUrl);nonce=u.searchParams.get('nonce');await a.callback(callbacks(u.searchParams.get('state')));
  assert.equal(a.snapshot().connected,true);assert.equal(a.snapshot().planEnabled,false);await assert.rejects(()=>a.fetchAuthed('/models'),/autorize/);assert.equal(apiCalls,0);
});
test('parallel requests serialize refresh and save both replacement tokens',async()=>{
  let count=0,form;
  const a=new ChatGPTAuth({store:new MemoryStore(data(profile({expiresAt:Date.now()-1}))),fetcher:async(_u,opts)=>{count++;form=new URLSearchParams(opts.body);await new Promise(r=>setTimeout(r,10));return Response.json({access_token:'rotated-access',refresh_token:'rotated-refresh',expires_in:3600,scope:fullScope});}});
  await a.ready;const tokens=await Promise.all(Array.from({length:5},()=>a.accessToken()));assert.equal(count,1);assert.equal(new Set(tokens).size,1);assert.equal(a.profile().refreshToken,'rotated-refresh');assert.equal(form.get('client_id'),'oaiapp_test');assert.equal(form.has('scope'),false);
});
test('terminal refresh failure clears credentials; a temporary failure preserves them',async()=>{
  for(const temporary of [false,true]){
    const a=new ChatGPTAuth({store:new MemoryStore(data(profile({expiresAt:0}))),fetcher:async()=>Response.json({error:temporary?{code:'subscription_sharing_usage_unavailable'}:'invalid_grant'},{status:temporary?503:400})});await a.ready;
    await assert.rejects(()=>a.accessToken());assert.equal(!!a.profile().accessToken,temporary);assert.equal(a.profile().clientId,'oaiapp_test');
  }
});
test('model choices come from the account catalog; Luna is not claimed accessible before inference',async()=>{
  const a=new ChatGPTAuth({store:new MemoryStore(data()),fetcher:async()=>Response.json({models:[{slug:'gpt-6-luna',display_name:'GPT-6 Luna',visibility:'list'},{slug:'hidden-model',visibility:'hide'}]})});await a.ready;
  const models=await a.models();assert.deepEqual(models,[{id:'gpt-6-luna',name:'GPT-6 Luna',effortOptions:['none','low','medium','high','xhigh','max']}]);assert.equal(a.snapshot().selectedModel,'gpt-6-luna');assert.equal(a.snapshot().verifiedModel,null);
  await assert.rejects(()=>a.selectModel('invented-model'));assert.equal(a.snapshot().selectedModel,'gpt-6-luna');
});
test('OAuth request contract removes unsupported fields and uses explicit context and streaming',()=>{
  const body=chatgptBody({input:'texto',instructions:'regra',max_output_tokens:100,temperature:0,previous_response_id:'old',tools:[{type:'web_search'}]},'gpt-6-luna');
  assert.equal(body.store,false);assert.equal(body.stream,true);assert.deepEqual(body.input,[{role:'user',content:'texto'}]);assert.equal(body.max_output_tokens,undefined);assert.equal(body.temperature,undefined);assert.equal(body.previous_response_id,undefined);
});
function sse(events){const bytes=new TextEncoder().encode(events.map(e=>'data: '+JSON.stringify(e)+'\r\n\r\n').join(''));let offset=0;return new Response(new ReadableStream({pull(c){if(offset>=bytes.length){c.close();return;}c.enqueue(bytes.subarray(offset,offset+3));offset+=3;}}),{headers:{'Content-Type':'text/event-stream'}});}
test('stream parser handles split UTF-8/CRLF and accepts only response.completed',async()=>{
  const result={status:'completed',output:[{type:'message',content:[{type:'output_text',text:'ação'}]}]};assert.deepEqual(await completedResponse(sse([{type:'response.completed',response:result}])),result);
  await assert.rejects(()=>completedResponse(sse([{type:'response.output_text.delta',delta:'{"verdict":"falsa"}'}])),/sem a confirmação/);
  await assert.rejects(()=>completedResponse(sse([{type:'response.output_text.delta',delta:'resultado'},{type:'response.failed',response:{error:{code:'subscription_sharing_usage_limit_exceeded'}}}])),/limite/);
});
test('empty terminal output retains completed streamed messages and web-search provenance',async()=>{
  const tool={type:'web_search_call',id:'search',status:'completed',action:{sources:[{url:'https://example.invalid/source'}]}};
  const message={type:'message',id:'answer',role:'assistant',content:[{type:'output_text',text:'{"state":"none"}'}]};
  const result=await completedResponse(sse([{type:'response.output_item.done',output_index:0,item:tool},{type:'response.output_item.done',output_index:1,item:message},{type:'response.completed',response:{status:'completed',output:[]}}]));
  assert.deepEqual(result.output,[tool,message]);
  const textOnly=await completedResponse(sse([{type:'response.output_text.delta',output_index:0,content_index:0,delta:'{"state":'},{type:'response.output_text.done',output_index:0,content_index:0,text:'{"state":"none"}'},{type:'response.completed',response:{status:'completed',output:[]}}]));
  assert.equal(textOnly.output[0].content[0].text,'{"state":"none"}');
});
test('saved Windows credentials are encrypted and can be reopened',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'verifica-oauth-test-'));
  try{const store=new CredentialStore({dir});await store.save(data());const bytes=await readFile(join(dir,'connections.dat'));if(process.platform==='win32')assert.equal(bytes.includes(Buffer.from('test-refresh')),false);assert.equal((await store.load()).profiles[0].clientId,'oaiapp_test');}
  finally{assert.equal(dirname(dir),resolve(tmpdir()));assert.ok(basename(dir).startsWith('verifica-oauth-test-'));await rm(dir,{recursive:true,force:true});}
});
test('reduced scopes after refresh do not authorize an inference request',async()=>{
  let apiCalls=0;const a=new ChatGPTAuth({store:new MemoryStore(data(profile({expiresAt:0}))),fetcher:async url=>{if(url.includes('api.openai.com'))apiCalls++;return Response.json({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600,scope:'openid email'});}});await a.ready;
  await assert.rejects(()=>a.fetchAuthed('/models'),/não está autorizado/);assert.equal(apiCalls,0);assert.equal(a.snapshot().planEnabled,false);
});
test('cancelling an in-flight exchange preserves the previously active account',async()=>{
  let nonce,finishToken;
  const a=new ChatGPTAuth({store:new MemoryStore(),keySet,fetcher:async url=>url.includes('openid-configuration')?metadata():new Promise(resolve=>{finishToken=resolve;})});await a.ready;
  const u=new URL((await a.begin()).authorizeUrl);nonce=u.searchParams.get('nonce');const pending=a.callback(callbacks(u.searchParams.get('state')));
  await new Promise(r=>setTimeout(r,10));assert.equal(a.snapshot().pending,true);a.cancel();finishToken(Response.json({access_token:'test-access',refresh_token:'test-refresh',id_token:await signed(nonce),expires_in:3600,scope:fullScope}));
  await assert.rejects(()=>pending,/cancelado/);assert.equal(a.snapshot().connected,false);
});
