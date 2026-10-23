import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveEngine } from '../lib/engine.mjs';
import { excerptContextIssue } from '../lib/policy.mjs';

const full='A taxa de desemprego no estado passou de cinco para dez por cento entre 2010 e 2012.';
const segment=(id,text)=>({id,text,start:(id-1)*12,end:id*12,endedAt:Date.now()});
const candidate=(quote,segmentIds,claim=quote)=>({quote,segmentIds,claim,kind:'factual',interpretations:[]});
function engine(detect){
  const e=new LiveEngine({detect});
  e.abort=new AbortController();e.pumpChecks=()=>{};
  return e;
}

test('length thresholds apply to the literal excerpt, regardless of surrounding context or paraphrase',async()=>{
  const e=engine(async()=>({state:'ready',reason:'Pronto',claims:[candidate('Esse número dobrou.',[2],full)]}));
  e.state.segments=[segment(1,full),segment(2,'Esse número dobrou.'),segment(3,'O assunto seguinte é a educação.')];e.fresh=[2,3];
  await e.pumpDetect(e.generation);
  assert.equal(e.state.cards.length,0);assert.equal(e.checkQueue.length,0);assert.equal(e.seen.size,0);
  assert.deepEqual(e.pendingContext,[2]);assert.equal(e.state.decisions.at(-1).state,'wait');
  assert.match(e.state.contextState,/curto demais/);
});

test('a held short excerpt can be reconsidered as a complete literal passage without deduplication loss',async()=>{
  const calls=[],short='Esse número dobrou.',continuation='A taxa de desemprego no estado passou de cinco para dez por cento entre 2010 e 2012.';
  const e=engine(async input=>{calls.push(input);return{state:'ready',claims:[candidate(calls.length===1?short:short+' '+continuation,calls.length===1?[1]:[1,2],full)]};});
  e.state.segments=[segment(1,short)];e.fresh=[1];await e.pumpDetect(e.generation);
  assert.equal(e.state.cards.length,0);
  e.state.segments.push(segment(2,continuation),segment(3,'Agora vamos discutir outro assunto.'));e.fresh=[2,3];
  await e.pumpDetect(e.generation);
  assert.deepEqual(calls[1].freshIds,[1,2,3]);assert.equal(e.state.cards.length,1);
  assert.equal(e.state.cards[0].quote,short+' '+continuation);assert.deepEqual(e.pendingContext,[]);
});

test('a long excerpt also waits for a later block, even with ASR sentence punctuation',async()=>{
  const e=engine(async()=>({state:'ready',claims:[candidate(full,[1,2])]}));
  e.state.segments=[segment(1,full)];e.fresh=[1];await e.pumpDetect(e.generation);
  assert.equal(e.state.cards.length,0);assert.deepEqual(e.pendingContext,[1]);
  assert.match(e.state.contextState,/próximo bloco/);
  e.state.segments.push(segment(2,'Esses são os números daquele período.'));e.fresh=[2];
  await e.pumpDetect(e.generation);
  assert.equal(e.state.cards.length,1);assert.equal(e.checkQueue.length,1);
});

test('a quote crossing blocks must wait until after its actual end',()=>{
  const segments=[segment(1,'A taxa de desemprego no estado'),segment(2,'passou de cinco para dez por cento entre 2010 e 2012.')];
  assert.match(excerptContextIssue(full,segments),/próximo bloco/);
  assert.equal(excerptContextIssue(full,[...segments,segment(3,'Vamos ao próximo tema.')]),null);
  assert.match(excerptContextIssue('Sim não eu vi ele foi lá mas eu sei que é.',segments),/curto demais/);
});

test('complete items proceed while short items stay pending in the same detector round',async()=>{
  const e=engine(async()=>({state:'ready',claims:[candidate(full,[1]),candidate('E a educação?',[2])]}));
  e.state.segments=[segment(1,full),segment(2,'E a educação?')];e.fresh=[1,2];
  await e.pumpDetect(e.generation);
  assert.equal(e.state.cards.length,1);assert.equal(e.state.cards[0].quote,full);
  assert.deepEqual(e.pendingContext,[2]);assert.equal(e.state.decisions.at(-1).state,'ready');
});

test('unrelated segment references cannot validate a quote or bypass its provenance',async()=>{
  const e=engine(async()=>({state:'ready',claims:[candidate(full,[2])]}));
  e.state.segments=[segment(1,full),segment(2,'Vamos ao próximo tema.')];e.fresh=[2];
  await e.pumpDetect(e.generation);
  assert.equal(e.state.cards.length,0);assert.equal(e.checkQueue.length,0);
});

test('skipping an intervening segment cannot manufacture a contiguous quotation',async()=>{
  const first='A taxa de desemprego no estado',last='passou de cinco para dez por cento entre 2010 e 2012.';
  const e=engine(async()=>({state:'ready',claims:[candidate(first+' '+last,[1,3])]}));
  e.state.segments=[segment(1,first),segment(2,'Não foi isso que eu disse.'),segment(3,last),segment(4,'Agora vamos ao próximo tema.')];e.fresh=[3,4];
  await e.pumpDetect(e.generation);
  assert.equal(e.state.cards.length,0);
});

test('end of capture does not force a pending fragment into research',async()=>{
  const e=engine(async()=>({state:'ready',claims:[candidate('Esse número dobrou.',[1])]}));
  e.state.segments=[segment(1,'Esse número dobrou.')];e.fresh=[1];e.captureDone=true;
  await e.pumpDetect(e.generation);
  assert.equal(e.state.status,'completed');assert.equal(e.state.metrics.published,0);
  assert.equal(e.state.cards.length,0);assert.equal(e.checkQueue.length,0);
  assert.match(e.state.message,/sem checagem/);
});
