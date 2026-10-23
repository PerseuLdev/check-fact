import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { parseSourceUrl, gateEvidence, trimOverlap } from '../lib/policy.mjs';
import { LiveEngine } from '../lib/engine.mjs';
import { check } from '../lib/ai.mjs';
import { needsReferenceDate } from '../lib/policy.mjs';
const url='https://www.youtube.com/watch?v=BgjpOorIXoI';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function child(){const c=new EventEmitter();c.stdout=new PassThrough();c.kill=()=>{};return c;}
function speaking(seconds){const pcm=Buffer.alloc(seconds*32000);for(let i=0;i<pcm.length;i+=2)pcm.writeInt16LE(1200,i);return pcm;}
test('URL entry accepts YouTube variants and rejects local, deceptive and credential-bearing URLs',()=>{
  assert.equal(parseSourceUrl('https://youtu.be/BgjpOorIXoI?t=40').url,url);
  assert.equal(parseSourceUrl('https://www.youtube.com/live/BgjpOorIXoI').id,'BgjpOorIXoI');
  for(const u of ['file:///C:/Windows/a','http://127.0.0.1','https://youtube.com.evil.example/watch?v=BgjpOorIXoI','https://user:pass@youtube.com/watch?v=BgjpOorIXoI'])assert.throws(()=>parseSourceUrl(u));
});
test('a model cannot publish a verdict using a fabricated or non-web source URL',()=>{
  const r={verdict:'falsa',explanation:'A fonte contradiz.',tags:['exagero'],evidence:[{url:'https://inventada.example/a',finding:'Conclusão inventada.'}]};
  assert.equal(gateEvidence(r,['https://real.example/a']).verdict,'evidencias_insuficientes');
  assert.equal(gateEvidence(r,['https://inventada.example/a']).verdict,'falsa');
  assert.equal(gateEvidence({...r,evidence:[{url:'javascript:alert(1)',finding:'x'}]},['javascript:alert(1)']).evidence.length,0);
});
test('short overlapping transcription does not repeat a sentence boundary',()=>{
  assert.equal(trimOverlap('A taxa de desemprego aumentou','desemprego aumentou no último ano'),'no último ano');
});

test('relative periods without a speech date abstain before inference, regardless of the model',async()=>{
  const claim={quote:'O PT já governa esse país há 20 anos, dos últimos 24.',claim:'O PT governou por 20 dos 24 anos mencionados.'};
  assert.equal(needsReferenceDate(claim),true);
  assert.equal(needsReferenceDate({claim:'O atual governo aumentou o valor hoje.'}),true);
  assert.equal(needsReferenceDate({claim:'O mandato começou em 2003 e terminou em 2011.'}),false);
  const result=await check(claim,[], '',null);
  assert.equal(result.verdict,'evidencias_insuficientes');assert.equal(result.evidence.length,0);
  assert.match(result.explanation,/data da fala/);
});
test('audio probe consumes a URL at wall-clock speed without invoking any AI',async()=>{
  const c=child();let calls=0;
  const e=new LiveEngine({resolve:async()=>({id:'BgjpOorIXoI',url,mediaUrl:'https://private.example/signed',headers:{},duration:100}),capture:()=>c,transcribe:async()=>{calls++;return'oi';}});
  await e.start({url,probe:true});c.stdout.write(speaking(.6));c.emit('close',0);
  await wait(100);assert.equal(e.state.metrics.audioSeconds,0);
  await wait(700);assert.equal(e.state.status,'completed');assert.equal(e.state.metrics.audioSeconds,.6);assert.equal(calls,0);assert.equal(e.snapshot().source.mediaUrl,undefined);
});
test('missing context requests older speech; stop prevents a delayed result from being published',async()=>{
  let finishCheck;const c=child();const calls=[];
  const e=new LiveEngine({resolve:async()=>({id:'BgjpOorIXoI',duration:100}),capture:()=>c,
    detect:async input=>{calls.push(input);return input.expanded?{state:'ready',reason:'Contexto completo',claims:[{quote:'O desemprego no estado no período citado. Esse número dobrou de cinco para dez por cento entre 2010 e 2012.',claim:'O desemprego dobrou no estado no período citado',kind:'comparison',segmentIds:[1,2]}],revisions:[]}:{state:'need_past',reason:'Qual número?',claims:[],revisions:[]};},
    check:()=>new Promise(resolve=>{finishCheck=resolve;})});
  e.configure('test-key-not-a-real-credential');await e.start({url});const gen=e.generation;
  e.state.segments=[{id:1,start:0,end:4,endedAt:Date.now(),text:'O desemprego no estado no período citado.'},{id:2,start:100,end:112,endedAt:Date.now(),text:'Esse número dobrou de cinco para dez por cento entre 2010 e 2012.'},{id:3,start:112,end:124,endedAt:Date.now(),text:'Esses são os números que estamos discutindo.'}];e.fresh=[2,3];
  await e.pumpDetect(gen);assert.equal(calls.length,2);assert.equal(calls[0].segments.length,2);assert.equal(calls[1].segments.length,3);assert.equal(e.state.cards.length,1);
  e.stop();finishCheck({verdict:'falsa',tags:[],evidence:[],explanation:'x'});await wait(30);
  assert.equal(e.state.cards[0].status,'cancelled');assert.equal(e.state.metrics.published,0);
});
test('claim extraction cannot invent quotations or publish without credentials',async()=>{
  const e=new LiveEngine();e.key='';await assert.rejects(()=>e.start({url}),/credencial/);
  const c=child(),v=new LiveEngine({resolve:async()=>({id:'BgjpOorIXoI'}),capture:()=>c,detect:async()=>({state:'ready',claims:[{quote:'Uma fala que não aconteceu',claim:'Algo inventado',segmentIds:[1]}],revisions:[]})});
  v.configure('test-key-not-a-real-credential');await v.start({url});v.state.segments=[{id:1,start:0,end:4,text:'Boa noite a todos.'}];v.fresh=[1];await v.pumpDetect(v.generation);assert.equal(v.state.cards.length,0);v.stop();
});
test('a correction arriving during research invalidates the stale result before publication',async()=>{
  const c=child(),replies=[];
  const e=new LiveEngine({resolve:async()=>({id:'BgjpOorIXoI'}),capture:()=>c,
    detect:async()=>({state:'ready',claims:[],revisions:[{id:'claim-1',reason:'A pessoa corrigiu a unidade na continuação.'}]}),
    check:()=>new Promise(resolve=>replies.push(resolve))});
  e.configure('test-key-not-a-real-credential');await e.start({url});
  e.state.cards.push({id:'claim-1',quote:'Foram dez milhões',claim:'Foram dez milhões',status:'queued',revision:0,version:0,contextThrough:1,start:0,end:4,endedAt:Date.now(),context:[]});
  e.checkQueue=['claim-1'];e.pumpChecks(e.generation);assert.equal(replies.length,1);
  e.state.segments=[{id:2,start:4,end:8,text:'Corrigindo: foram dez mil.'}];e.fresh=[2];await e.pumpDetect(e.generation);
  replies[0]({verdict:'falsa',tags:[],evidence:[],explanation:'Resultado com contexto antigo'});await wait(20);
  assert.equal(e.state.metrics.published,0);assert.equal(e.state.cards[0].status,'rechecking');assert.equal(replies.length,2);
  e.stop();replies[1]({verdict:'correta',tags:[],evidence:[],explanation:'Novo contexto'});await wait(20);assert.equal(e.state.metrics.published,0);
});
test('an unavailable audio address is renewed once, without an endless retry loop',async()=>{
  const children=[child(),child()];let resolved=0,captured=0;
  const e=new LiveEngine({resolve:async()=>{resolved++;return{id:'BgjpOorIXoI'};},capture:()=>children[captured++]});
  await e.start({url,probe:true});children[0].emit('close',1);await wait(20);
  assert.equal(resolved,2);assert.equal(captured,2);children[1].emit('close',1);await wait(20);
  assert.equal(e.state.status,'error');assert.equal(resolved,2);
});

test('waiting preserves an earlier item when only its continuation is newly transcribed',async()=>{
  const c=child(),calls=[];let resolveCheck;const quote='Qual é o valor do benefício assistencial pago às pessoas com deficiência no Brasil?';
  const e=new LiveEngine({resolve:async()=>({id:'BgjpOorIXoI',title:'Debate sobre Previdência'}),capture:()=>c,
    detect:async input=>{calls.push(input);return calls.length===1?{state:'wait',reason:'Falta a continuação',claims:[]}:{state:'ready',reason:'Contexto suficiente',claims:[{quote,claim:quote,kind:'question',segmentIds:[1],interpretations:[]}],waitingSegmentIds:[2]};},
    check:(claim)=>{assert.equal(claim.kind,'question');return new Promise(r=>{resolveCheck=r;});}});
  e.configure('test-key-not-a-real-credential');await e.start({url,contextHint:'INSS'});
  e.state.segments=[{id:1,start:0,end:8,endedAt:Date.now(),text:quote}];e.fresh=[1];await e.pumpDetect(e.generation);
  assert.deepEqual(e.pendingContext,[1]);
  e.state.segments.push({id:2,start:8,end:16,endedAt:Date.now(),text:'Do benefício que mencionamos. Outra frase incompleta...'});e.fresh=[2];await e.pumpDetect(e.generation);
  assert.deepEqual(calls[1].freshIds,[1,2]);assert.equal(calls[1].sourceContext.hint,'INSS');
  assert.equal(e.state.cards.length,1);assert.equal(e.state.cards[0].kind,'question');assert.deepEqual(e.pendingContext,[2]);assert.equal(e.state.decisions.length,2);
  e.stop();resolveCheck({verdict:'resposta_contextual',evidence:[],tags:[],explanation:'Resposta'});await wait(10);
});

test('an uncertain acronym interpretation cannot turn into a factual verdict',async()=>{
  const r=await check({quote:'O NSS mudou?',claim:'O INSS mudou?',kind:'question',interpretations:[{heard:'NSS',possible:'INSS',reason:'Tema previdenciário, mas áudio truncado.'}]},[], '2026-10-19',null);
  assert.equal(r.verdict,'evidencias_insuficientes');assert.match(r.context,/NSS.*INSS/);assert.match(r.explanation,/hipótese/);
});

test('local transcription includes four seconds of earlier audio across an eight-second boundary',async()=>{
  const sizes=[];const e=new LiveEngine({localAsr:{on(){},snapshot(){return{};},async transcribe(pcm){sizes.push(pcm.length);return sizes.length===1?'A sigla é INSS':'A sigla é INSS e o benefício.';}}});
  e.provider='chatgpt';e.abort=new AbortController();e.state.transcribeOnly=true;
  e.audioQueue=[{pcm:speaking(8),start:0,end:8,endedAt:Date.now()},{pcm:speaking(8),start:8,end:16,endedAt:Date.now()}];
  await e.pumpAudio(e.generation);assert.deepEqual(sizes,[8*32000,12*32000]);assert.equal(e.state.segments[1].text,'e o benefício.');
});
