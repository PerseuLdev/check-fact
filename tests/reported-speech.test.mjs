import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, detect } from '../lib/ai.mjs';
import { LiveEngine } from '../lib/engine.mjs';
import { isContextualReport, enforceClaimPolicy } from '../lib/policy.mjs';

const quote='Lula fala que o pai de Flávio deveria votar nele durante a conversa sobre a eleição.';
const claim={quote,claim:quote,kind:'reported_speech',interpretations:[]};
// Fictional fixtures: these are not claims about any real person's custody.
const source='https://fonte.invalid/situacao';
const fact={url:source,title:'Registro de custódia de pessoa fictícia',finding:'A pessoa fictícia foi transferida para a unidade Alfa em 10/02/2020.',relationship:'supports'};
const information={verdict:'informacao_contextual',informationBasis:'independent_context',tags:[],explanation:fact.finding,context:'Situação fictícia verificada na data da pesquisa.',evidence:[fact]};

function auth(reply,{consulted=[source],completed=true}={}) {
  const requests=[];
  const service={
    profile:()=>({verifiedModel:'test-model',verifiedEffort:'default'}),
    async fetchAuthed(path,options) {
      requests.push(JSON.parse(options.body));
      const response={status:'completed',output:[
        {type:'web_search_call',status:completed?'completed':'in_progress',action:{sources:consulted.map(url=>({url}))}},
        {type:'message',content:[{type:'output_text',text:JSON.stringify(reply)}]},
      ]};
      return new Response('data: '+JSON.stringify({type:'response.completed',response})+'\n\n');
    },
  };
  return {key:{provider:'chatgpt',service,profileId:'test-profile',model:'test-model'},requests};
}

test('reported news and legacy attributions are contextual; extracted facts and questions retain their policy',()=>{
  assert.equal(isContextualReport(claim),true);
  assert.equal(isContextualReport({...claim,kind:'attribution'}),true);
  assert.equal(isContextualReport({...claim,kind:'factual'}),true);
  assert.equal(isContextualReport({kind:'factual',claim:'Ministra afirmou que o programa deveria continuar.'}),true);
  assert.equal(isContextualReport({...claim,kind:'factual',claim:'O desemprego foi de cinco por cento em 2020.'}),false);
  assert.equal(isContextualReport({...claim,kind:'question',claim:'O que Lula disse que deveria acontecer?'}),false);
  assert.equal(isContextualReport({...claim,kind:'question_premise'}),false);
});

test('triage explicitly separates reported speech from the checkable facts within it',async()=>{
  const a=auth({state:'ready',reason:'Relato com contexto factual pesquisável',claims:[{...claim,segmentIds:[1]}],waitingSegmentIds:[],revisions:[]});
  const result=await detect({segments:[{id:1,text:quote}],freshIds:[1],known:[]},a.key);
  assert.equal(result.claims[0].kind,'reported_speech');
  const request=a.requests[0];
  assert.ok(request.text.format.schema.properties.claims.items.properties.kind.enum.includes('reported_speech'));
  assert.match(request.instructions,/extraia essa alegação separadamente/);
  assert.match(request.instructions,/não transforme "deveria votar" em fato/);
});

test('research seeks underlying context with an explicit research date and allows older primary sources',async()=>{
  const a=auth(information);
  const result=await check(claim,[],null,a.key);
  assert.equal(result.verdict,'informacao_contextual');
  assert.equal(result.explanation,fact.finding);
  const request=a.requests[0],input=JSON.parse(request.input[0].content);
  assert.equal(input.researchMode,'contextual_information');
  assert.equal(input.referenceDate,'Data da fala não confirmada');
  assert.match(input.researchDate,/^\d{4}-\d{2}-\d{2}$/);
  assert.match(request.instructions,/mesmo anteriores à manchete/);
  assert.match(request.instructions,/Não assuma que esteja preso, que esteja na Papuda, nem uma data/);
  assert.match(request.instructions,/Distinga prisão inicial, transferência/);
  assert.equal(request.tool_choice,'required');
});

test('relative wording in a news report permits dated context research without assigning a date to the speech',async()=>{
  const a=auth(information);
  const result=await check({...claim,quote:'Hoje '+quote,claim:'Hoje '+quote},[],null,a.key);
  assert.equal(a.requests.length,1);assert.equal(result.verdict,'informacao_contextual');
  const input=JSON.parse(a.requests[0].input[0].content);
  assert.equal(input.referenceDate,'Data da fala não confirmada');
});

test('a factual date-dependent claim still abstains before inference',async()=>{
  const a=auth(information);
  const result=await check({quote:'Ele está preso hoje.',claim:'Ele está preso hoje.',kind:'factual'},[],null,a.key);
  assert.equal(result.verdict,'evidencias_insuficientes');assert.equal(a.requests.length,0);
});

test('no truth or falsehood grade can be published for reported speech, even with traceable URLs',async()=>{
  for(const verdict of ['correta','correta_com_ressalvas','parcialmente_correta','falsa','resposta_contextual']) {
    const a=auth({...information,verdict});
    const result=await check({...claim,kind:'factual'},[],'2026-01-01',a.key);
    assert.equal(result.verdict,'evidencias_insuficientes',verdict);
    assert.deepEqual(result.evidence,[]);assert.match(result.explanation,/além de repetir a fala/);
    assert.equal(JSON.parse(a.requests[0].input[0].content).claim.kind,'reported_speech');
  }
});

test('a headline repetition cannot become useful context merely by changing its verdict label',async()=>{
  for(const informationBasis of ['speech_only','not_applicable',undefined]) {
    const a=auth({...information,informationBasis,explanation:'A notícia confirma que a declaração foi feita.'});
    const result=await check(claim,[],null,a.key);
    assert.equal(result.verdict,'evidencias_insuficientes');assert.deepEqual(result.evidence,[]);
  }
});

test('context facts require consulted sources and completed web research',async()=>{
  for(const options of [{consulted:[]},{consulted:['https://outra.invalid/fonte']},{completed:false}]) {
    const a=auth(information,options),result=await check(claim,[],null,a.key);
    assert.equal(result.verdict,'evidencias_insuficientes');assert.deepEqual(result.evidence,[]);
  }
});

test('unresolved transcripts and conflicting context do not turn into confirmed information',async()=>{
  const a=auth({...information,verdict:'inconclusiva'});
  assert.equal((await check(claim,[],null,a.key)).verdict,'inconclusiva');
  const ambiguous=await check({...claim,interpretations:[{heard:'Flávio',possible:'outro nome',reason:'Áudio truncado.'}]},[],null,a.key);
  assert.equal(ambiguous.verdict,'evidencias_insuficientes');assert.equal(a.requests.length,1);
});

test('independently extracted facts retain factual verdicts despite attribution in the original quotation',async()=>{
  const factual={...claim,kind:'factual',claim:'A pessoa fictícia foi transferida em 10/02/2020.'};
  const a=auth({...information,verdict:'correta',informationBasis:'not_applicable'});
  const result=await check(factual,[],'2020-02-11',a.key);
  assert.equal(result.verdict,'correta');
  assert.equal(enforceClaimPolicy(factual,result),result);
});

test('the engine reclassifies a mislabelled news report before enqueueing it',async()=>{
  const e=new LiveEngine({detect:async()=>({state:'ready',claims:[{...claim,kind:'factual',segmentIds:[1]}]})});
  e.abort=new AbortController();e.pumpChecks=()=>{};
  e.state.segments=[{id:1,text:quote,start:0,end:12,endedAt:Date.now()},{id:2,text:'A conversa segue para o próximo tema.',start:12,end:24,endedAt:Date.now()}];e.fresh=[1,2];
  await e.pumpDetect(e.generation);
  assert.equal(e.state.cards.length,1);assert.equal(e.state.cards[0].kind,'reported_speech');
  assert.equal(e.state.cards[0].quote,quote);assert.equal(e.checkQueue.length,1);
});

test('the publication boundary blocks a checker that returns a factual grade for reported speech',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'verifica-reported-'));
  const previous=process.cwd();
  try {
    process.chdir(directory);
    const e=new LiveEngine({check:async()=>({...information,verdict:'correta'})});
    e.abort=new AbortController();e.state.sessionId='regression';
    e.state.cards=[{...claim,id:'report',status:'queued',revision:0,version:0,endedAt:Date.now(),context:[]}];
    e.checkQueue=['report'];
    const published=new Promise(resolve=>e.once('event',function onEvent(event){if(event.type==='published')resolve(event);else e.once('event',onEvent);}));
    e.pumpChecks(e.generation);await published;
    while(e.checking)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(e.state.cards[0].result.verdict,'evidencias_insuficientes');
    assert.deepEqual(e.state.cards[0].result.evidence,[]);
  } finally {process.chdir(previous);await rm(directory,{recursive:true,force:true});}
});
