import test from 'node:test';
import assert from 'node:assert/strict';
import {GeminiLocal,nativePermission} from '../lib/gemini-local.mjs';
import {GeminiConnection} from '../lib/gemini-auth.mjs';
import {EventEmitter} from 'node:events';
const tick=()=>new Promise(r=>setTimeout(r,10));
test('native Google login is delegated to its advertised OAuth method without requesting a client file',async()=>{
  const g=new GeminiLocal(),calls=[];g.launch=async()=>{};g.request=async(method,params)=>{calls.push({method,params});return method==='session/new'?{models:{currentModelId:'auto-gemini',availableModels:[{modelId:'gemini-2.5-flash',name:'Flash'}]}}:{};};
  await g.begin();await tick();assert.equal(g.snapshot().connected,true);assert.equal(g.snapshot().selectedModel,'gemini-2.5-flash');assert.equal(calls[0].method,'authenticate');assert.equal(calls[0].params.methodId,'oauth-personal');assert.equal(g.snapshot().connectionMode,'local');g.cancel();
});
test('cancelled native authorization cannot reconnect later',async()=>{
  const g=new GeminiLocal();let release;g.launch=async()=>{};g.request=()=>new Promise(r=>{release=r;});await g.begin();await tick();g.cancel();release({});await tick();assert.equal(g.snapshot().connected,false);
});
test('native permission requests deny file and shell tools and permit only a Google search once',()=>{
  const options=[{kind:'allow_once',optionId:'once'}];
  assert.equal(nativePermission({toolCall:{title:'run_shell_command'},options}).outcome.outcome,'cancelled');
  assert.equal(nativePermission({toolCall:{title:'read_file'},options}).outcome.outcome,'cancelled');
  assert.deepEqual(nativePermission({toolCall:{title:'GoogleSearch: inflation'},options}).outcome,{outcome:'selected',optionId:'once'});
});
test('native provenance accepts only completed search tool output, not answer text or other tools',()=>{
  const g=new GeminiLocal(),turn={text:'',tools:new Map(),sources:new Set()};g.turns.set('s',turn);
  const update=value=>g.receive({method:'session/update',params:{sessionId:'s',update:value}});
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'https://invented.invalid'}});
  update({sessionUpdate:'tool_call',toolCallId:'t',title:'GoogleSearch'});
  update({sessionUpdate:'tool_call_update',toolCallId:'t',status:'completed',content:[{type:'content',content:{type:'text',text:'Source: https://real.invalid/fact'}}]});
  assert.deepEqual([...turn.sources],['https://real.invalid/fact']);
});
test('simple connection is the default; advanced API is selected only after explicit valid configuration',async()=>{
  const local=new EventEmitter(),api=new EventEmitter();local.ready=api.ready=Promise.resolve();local.snapshot=()=>({connectionMode:'local',pending:false});local.cancel=()=>{};api.snapshot=()=>({configured:true,pending:false});api.configure=async()=>{};
  const g=new GeminiConnection({local,api});assert.equal(g.snapshot().connectionMode,'local');await g.configure({});assert.equal(g.snapshot().connectionMode,'api');g.useLocal();assert.equal(g.snapshot().connectionMode,'local');
});

test('server facade blocks retired personal OAuth and never advertises it as ready',()=>{
 const local=new EventEmitter(),api=new EventEmitter();local.ready=api.ready=Promise.resolve();local.snapshot=()=>({configured:true,connected:true,pending:true});
 const g=new GeminiConnection({local,api});assert.equal(g.snapshot().unavailable,true);assert.equal(g.snapshot().configured,false);assert.equal(g.snapshot().connected,false);assert.equal(g.snapshot().pending,false);assert.throws(()=>g.begin(),/não está disponível/);
});
