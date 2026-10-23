import test from 'node:test';
import assert from 'node:assert/strict';
import {extensionAccess,extensionRequest,extensionToken} from '../lib/extension-bridge.mjs';
import {videoId,safeUrl,latestCard} from '../extension/shared.js';
const origin='chrome-extension://'+'a'.repeat(32);
function request(action,overrides={}){return new Request('http://127.0.0.1:4310/api/extension',{method:'POST',headers:{origin,authorization:'Bearer '+extensionToken,'content-type':'application/json',...overrides},body:JSON.stringify(action)});}
test('extension bridge rejects websites and incorrect credentials before accessing the engine',async()=>{
  for(const headers of [{origin:'https://www.youtube.com'},{authorization:'Bearer wrong'},{authorization:'Bearer '+'é'.repeat(64)},{origin:'null'}]){
    assert.equal(extensionAccess(request({action:'state'},headers)),false);
    const r=await extensionRequest(request({action:'state'},headers),()=>{throw new Error('must not access');});assert.equal(r.status,403);
  }
  assert.equal(extensionAccess(request({action:'state'})),true);
});
test('paired extension can read state, start and stop; arbitrary operations are rejected',async()=>{
  let started,stopped=false;const engine={snapshot:()=>({status:'idle'}),start:async d=>{started=d;},stop:()=>{stopped=true;}};
  const r=await extensionRequest(request({action:'start',data:{url:'https://youtube.com/watch?v=BgjpOorIXoI',offset:120}}),()=>engine);
  assert.equal(r.status,200);assert.equal(started.offset,120);assert.equal(r.headers.get('access-control-allow-origin'),origin);
  await extensionRequest(request({action:'stop'}),()=>engine);assert.equal(stopped,true);
  const bad=await extensionRequest(request({action:'auth/disconnect'}),()=>engine);assert.equal(bad.status,400);
});
test('preflight allows only extension origins and explicitly names allowed headers',async()=>{
  const r=await extensionRequest(new Request('http://127.0.0.1:4310/api/extension',{method:'OPTIONS',headers:{origin}}),()=>{throw new Error();});assert.equal(r.status,204);assert.match(r.headers.get('access-control-allow-headers'),/authorization/);
  const denied=await extensionRequest(new Request('http://127.0.0.1:4310/api/extension',{method:'OPTIONS',headers:{origin:'https://example.com'}}));assert.equal(denied.status,403);assert.equal(denied.headers.get('access-control-allow-origin'),null);
});
test('overlay isolates video identity, revisions, freshness and rechecking',()=>{
  const url='https://www.youtube.com/watch?v=BgjpOorIXoI',now=100000;
  const card={id:'one',revision:0,status:'published',publishedAt:now-1000};
  const state={source:{url},cards:[card]};assert.equal(latestCard(state,'BgjpOorIXoI',now),card);
  assert.equal(latestCard(state,'aaaaaaaaaaa',now),null);assert.equal(latestCard(state,'BgjpOorIXoI',now+31000),null);
  assert.equal(latestCard({...state,cards:[{...card,status:'rechecking'}]},'BgjpOorIXoI',now),null);
  assert.equal(latestCard({...state,probe:true},'BgjpOorIXoI',now),null);
  assert.equal(videoId('https://youtube.com.evil.com/watch?v=BgjpOorIXoI'),null);assert.equal(safeUrl('javascript:alert(1)'),null);
});
