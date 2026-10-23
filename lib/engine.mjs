import { EventEmitter } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseSourceUrl, normalized, trimOverlap, excerptContextIssue, isContextualReport, enforceClaimPolicy } from './policy.mjs';
import * as ai from './ai.mjs';
import { chatgptAuth } from './chatgpt-auth.mjs';
import { localAsr } from './local-asr.mjs';
import { geminiAuth } from './gemini-auth.mjs';
import {openaiEfforts,validateEffort} from './effort.mjs';

const exec=promisify(execFile),bytesPerSecond=32000;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function resolveSource(url) {
  const source=parseSourceUrl(url),local=join(process.cwd(),'.venv','Scripts','python.exe');
  let stdout;
  try { ({stdout}=await exec(process.env.CHECK_FACT_PYTHON||(existsSync(local)?local:'python'),[join(process.cwd(),'scripts','resolve.py'),source.url],{timeout:35000,maxBuffer:1000000,windowsHide:true,encoding:'utf8'})); }
  catch { throw new Error('Não foi possível acessar o áudio do YouTube. Verifique o link e a conexão; a plataforma pode estar bloqueando a leitura.'); }
  const info=JSON.parse(stdout);if(info.error)throw new Error(info.error);return {...info,url:source.url};
}
export function captureSource(info,offset=0,maxSeconds=0,realtime=true) {
  const headers=Object.entries(info.headers||{}).filter(([k,v])=>/^[\w-]+$/.test(k)&&!/[\r\n]/.test(String(v))).map(([k,v])=>`${k}: ${v}\r\n`).join('');
  const args=['-hide_banner','-loglevel','error','-nostdin',...(realtime?['-re']:[]),'-rw_timeout','15000000'];
  if(offset&&!info.isLive)args.push('-ss',String(offset));
  if(headers)args.push('-headers',headers);
  args.push('-i',info.mediaUrl,'-vn','-ac','1','-ar','16000','-acodec','pcm_s16le');
  if(maxSeconds)args.push('-t',String(maxSeconds));
  args.push('-f','s16le','pipe:1');
  const child=spawn(process.env.FFMPEG_PATH||'ffmpeg',args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stderr.resume(); // stderr can contain signed media addresses; never forward it.
  return child;
}
export class LiveEngine extends EventEmitter {
  constructor(deps={}) {
    super();this.deps={resolve:resolveSource,capture:captureSource,...ai,...deps};this.oauth=deps.oauth||null;this.localAsr=deps.localAsr||null;this.provider=this.oauth?'chatgpt':'gateway';this.key=process.env.AI_GATEWAY_API_KEY||'';this.generation=0;this.child=null;this.contextChild=null;this.reset();
    this.gemini=deps.gemini||null;this.gatewayEfforts={detector:'default',checker:'default'};
    this.oauth?.on('change',()=>{this.event('auth_changed');this.update();});this.gemini?.on('change',()=>{this.event('gemini_changed');this.update();});this.localAsr?.on('change',()=>this.update());
  }
  reset() {
    this.state={sessionId:null,status:'idle',message:'Cole uma URL para começar.',source:null,segments:[],cards:[],decisions:[],contextState:'Aguardando áudio',metrics:{audioSeconds:0,transcripts:0,detected:0,published:0,asrQueue:0,checkQueue:0,checking:0,skippedSilence:0,lastLatency:null},offset:0,probe:false,transcribeOnly:false};
    this.audioQueue=[];this.fresh=[];this.pendingContext=[];this.checkQueue=[];this.seen=new Set();this.captureDone=false;this.asrBusy=false;this.detectBusy=false;this.checking=0;this.previousPcm=Buffer.alloc(0);this.previousText='';
  }
  snapshot(){const a=this.oauth?.snapshot(),g=this.gemini?.snapshot(),account=this.provider==='gemini'?g:a;return {...this.state,provider:this.provider,aiConfigured:this.provider==='gemini'?!!(g?.connected&&g.selectedModel):this.provider==='chatgpt'?!!(a?.planEnabled&&a.selectedModel):!!this.key,models:ai.models,selectedModel:this.provider==='gemini'?g?.selectedModel:this.provider==='chatgpt'?a?.selectedModel:null,selectedEffort:this.provider==='gateway'?null:account?.selectedEffort||'default',effortOptions:this.provider==='gateway'?[]:account?.effortOptions||[],gatewayEfforts:Object.fromEntries(['detector','checker'].map(role=>[role,{model:ai.models[role],effort:this.gatewayEfforts?.[role]||'default',options:openaiEfforts(ai.models[role])}])),localAsr:this.localAsr?.snapshot()||null};}
  ensureIdle(){if(['running','connecting','preparing','draining'].includes(this.state.status))throw new Error('Encerre a sessão antes de alterar a conexão ou o modelo.');}
  useChatGPT(){this.ensureIdle();this.provider='chatgpt';this.update();}
  useGemini(){this.ensureIdle();if(!this.gemini?.snapshot().connected)throw new Error('Conecte o Google antes de selecionar Gemini.');this.provider='gemini';this.update();}
  event(type,detail={}){this.emit('event',{type,at:Date.now(),...detail});}
  update(){this.event('snapshot',{state:this.snapshot()});}
  configure(key){
    this.ensureIdle();
    if(typeof key!=='string'||key.trim().length<12||key.length>1000)throw new Error('Informe uma credencial válida.');
    this.key=key.trim();this.provider='gateway';this.update();
  }
  configureEfforts({detector,checker}={}){
    this.ensureIdle();const next={detector,checker};
    for(const role of ['detector','checker'])validateEffort(next[role],openaiEfforts(ai.models[role]));
    this.gatewayEfforts=next;this.update();
  }
  publicSource(info){const {mediaUrl,headers,...publicInfo}=info;return publicInfo;}
  async connect(url){return this.publicSource(await this.deps.resolve(url));}
  async primeContext(info,offset,gen){
    const duration=Math.min(90,offset);if(duration<12)return;
    const start=offset-duration;this.state.message='Preparando o contexto dos 90 segundos anteriores…';this.update();
    const child=this.deps.capture(info,start,duration,false),blockBytes=12*bytesPerSecond,overlapBytes=4*bytesPerSecond;this.contextChild=child;
    let buffer=Buffer.alloc(0),consumed=0,previousPcm=Buffer.alloc(0),previousText='',chain=Promise.resolve();
    const transcribe=async(pcm,freshBytes,carriedBytes,throughBytes)=>{
      if(gen!==this.generation)return;
      let text;
      if(this.provider!=='gateway'||this.state.transcribeOnly)text=await this.localAsr.transcribe(pcm,null,this.abort.signal);
      else text=await this.deps.transcribe(pcm,this.sessionAuth,this.abort.signal);
      if(gen!==this.generation)return;
      const unique=trimOverlap(previousText,text);previousText=text;
      if(!unique)return;
      const from=Math.max(start,start+(throughBytes-freshBytes-carriedBytes)/bytesPerSecond),to=start+throughBytes/bytesPerSecond;
      const segment={id:++this.state.metrics.transcripts,text:unique,start:from,end:Math.min(offset,Math.max(from,to)),endedAt:Date.now(),historical:true};
      if(segment.end>segment.start)this.state.segments.push(segment);
    };
    child.stderr.resume();
    try{
      for await(const chunk of child.stdout){if(gen!==this.generation){child.kill();return;}buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=blockBytes){const pcm=buffer.subarray(0,blockBytes);buffer=buffer.subarray(blockBytes);const carried=previousPcm,input=Buffer.concat([carried,pcm]);previousPcm=pcm.subarray(Math.max(0,pcm.length-overlapBytes));consumed+=pcm.length;const through=consumed;chain=chain.then(()=>transcribe(input,pcm.length,carried.length,through));}}
      await chain;
      if(gen!==this.generation)return;
      if(buffer.length>=4*bytesPerSecond){const pcm=buffer.subarray(0,buffer.length-buffer.length%2),carried=previousPcm;consumed+=pcm.length;await transcribe(Buffer.concat([carried,pcm]),pcm.length,carried.length,consumed);}
      if(gen===this.generation){this.state.segments=this.state.segments.filter(s=>s.end>=offset-180);this.update();}
    }finally{if(this.contextChild===child)this.contextChild=null;if(gen===this.generation)this.state.message='Contexto anterior preparado. Conectando ao trecho atual…';}
  }
  async start({url,offset=0,referenceDate='',contextHint='',probe=false,transcribeOnly=false,duration=0},attempt=0){
    parseSourceUrl(url);
    if(!Number.isInteger(duration)||duration<0||duration>120)throw new Error('A duração do teste deve ser de 1 a 120 segundos, ou zero para execução contínua.');
    if(!probe&&!transcribeOnly){
      if(this.provider==='gemini'){
        await this.gemini?.ready;const available=await this.gemini?.models(),account=this.gemini?.snapshot();
        if(!account?.connected||!account.selectedModel||!available?.some(m=>m.id===account.selectedModel))throw new Error('Conecte o Google e selecione um modelo disponível para a Gemini API.');
      }else if(this.provider==='chatgpt'){
        await this.oauth?.ready;let account=this.oauth?.snapshot();
        if(!account?.planEnabled)throw new Error('Entre com ChatGPT e autorize o uso do plano para iniciar a checagem.');
        const available=await this.oauth.models();account=this.oauth.snapshot();
        if(!account.selectedModel)throw new Error('Selecione um modelo disponível na sua conta do ChatGPT.');
        if(!available.some(m=>m.id===account.selectedModel))throw new Error('O modelo selecionado não está disponível nesta conta. Atualize a lista de modelos.');
      }else if(!this.key)throw new Error('Configure a credencial de IA para iniciar a checagem real. O teste de áudio pode ser feito sem ela.');
    }
    if(!Number.isFinite(Number(offset))||Number(offset)<0)throw new Error('O início deve ser um número de segundos maior ou igual a zero.');
    if(referenceDate&&!/^\d{4}-\d{2}-\d{2}$/.test(referenceDate))throw new Error('Data de referência inválida.');
    if(typeof contextHint!=='string'||contextHint.length>800)throw new Error('O contexto deve ter no máximo 800 caracteres.');
    this.stop(false);const gen=++this.generation;this.reset();this.abort=new AbortController();
    const account=(this.provider==='gemini'?this.gemini:this.oauth)?.snapshot();this.sessionAuth=this.provider==='gateway'?{provider:'gateway',key:this.key,efforts:{...this.gatewayEfforts}}:{provider:this.provider,service:this.provider==='gemini'?this.gemini:this.oauth,profileId:account?.activeId,model:account?.selectedModel,effort:account?.selectedEffort||'default',effortOptions:account?.effortOptions};
    Object.assign(this.state,{sessionId:randomUUID(),status:'connecting',message:attempt?'Renovando a conexão com o áudio do YouTube…':'Conectando ao áudio do YouTube…',probe:!!probe,transcribeOnly:!!transcribeOnly,duration,contextHint,offset:Number(offset)});this.referenceDate=referenceDate;this.update();
    if(!probe&&(this.provider!=='gateway'||transcribeOnly)){
      if(!this.localAsr){this.fail('A transcrição local não está configurada.');return;}
      this.state.status='preparing';this.state.message='Preparando a transcrição local antes de abrir o áudio…';this.update();
      try{await this.localAsr.prepare();}catch(e){if(gen===this.generation)this.fail(e.message);throw e;}
      if(gen!==this.generation)return;this.state.status='connecting';this.state.message='Transcrição local pronta. Conectando à URL…';this.update();
    }
    let info;
    try{info=await this.deps.resolve(url);}catch(error){if(gen===this.generation)this.fail(error.message);throw error;}
    if(gen!==this.generation)return;
    if(info.duration&&Number(offset)>=info.duration){this.fail('O ponto inicial está além da duração do vídeo.');return;}
    this.state.source=this.publicSource(info);if(info.isLive)this.state.offset=0;
    if(!probe&&!transcribeOnly&&this.state.offset>0){
      try{await this.primeContext(info,this.state.offset,gen);}catch{if(gen!==this.generation)return;this.state.message='Contexto anterior indisponível. Continuando a partir do trecho escolhido…';this.update();}
      if(gen!==this.generation)return;
    }
    this.state.status='running';this.state.message=probe?'Testando 8 segundos de áudio, sem checagem factual.':'Aguardando o primeiro bloco de áudio…';this.update();
    const child=this.deps.capture(info,this.state.offset,probe?8:transcribeOnly?12:duration);this.child=child;
    const startup=setTimeout(()=>{if(gen===this.generation)this.fail('A conexão não entregou áudio em 25 segundos. Tente reconectar a URL.');},25000);
    startup.unref?.();
    let buffer=Buffer.alloc(0),emitted=0,origin=0,chain=Promise.resolve();
    const release=async pcm=>{
      if(gen!==this.generation)return;
      const duration=pcm.length/bytesPerSecond,due=origin+(emitted+duration)*1000;
      if(due>Date.now())await sleep(due-Date.now()); // no access to future audio, even if prebuffered
      if(gen!==this.generation)return;
      const start=this.state.offset+emitted;emitted+=duration;this.state.metrics.audioSeconds=emitted;
      if(probe){this.state.message=`Áudio recebido: ${emitted.toFixed(1)} s. Nenhuma checagem foi executada.`;this.update();return;}
      if(this.audioQueue.reduce((n,b)=>n+b.pcm.length/bytesPerSecond,0)+duration>48){this.fail('A transcrição ficou mais de 48 segundos atrás do áudio. A sessão foi interrompida para evitar resultados cada vez mais atrasados.');return;}
      this.audioQueue.push({pcm,start,end:start+duration,endedAt:due});this.state.metrics.asrQueue=this.audioQueue.length;
      this.state.message=transcribeOnly?'Áudio conectado. Transcrição local em andamento, sem checagem factual.':'Áudio conectado. Checagem automática em andamento.';this.update();void this.pumpAudio(gen);
    };
    child.stdout.on('data',chunk=>{
      if(gen!==this.generation)return;
      if(!origin){clearTimeout(startup);origin=Date.now();this.event('audio_started',{offset:this.state.offset,isLive:!!info.isLive});}
      buffer=Buffer.concat([buffer,chunk]);
      // Short ASR windows can invent sentence endings before a number/unit finishes.
      // Larger recognition windows preserve complete clauses and numeric units.
      const blockBytes=(probe?4:12)*bytesPerSecond;
      while(buffer.length>=blockBytes){const pcm=buffer.subarray(0,blockBytes);buffer=buffer.subarray(blockBytes);chain=chain.then(()=>release(pcm));}
    });
    child.on('error',()=>{clearTimeout(startup);if(gen===this.generation)this.fail('Não foi possível iniciar o leitor de áudio. Verifique a instalação do FFmpeg.');});
    child.on('close',code=>{void(async()=>{
      clearTimeout(startup);await chain;if(gen!==this.generation)return;
      if(buffer.length>=bytesPerSecond/2)await release(buffer.subarray(0,buffer.length-buffer.length%2));
      if(gen!==this.generation)return;this.child=null;this.captureDone=true;
      if(code!==0){
        if(!emitted&&attempt===0){void this.start({url,offset,referenceDate,contextHint,probe,transcribeOnly,duration},1).catch(()=>{});return;}
        this.fail('A plataforma interrompeu a leitura do áudio. Reconecte a URL para tentar novamente.');return;
      }
      if(!this.state.metrics.audioSeconds){this.fail('A conexão terminou sem áudio.');return;}
      this.state.status='draining';this.finishIfDone();this.update();
    })().catch(()=>{if(gen===this.generation)this.fail('Falha ao finalizar a leitura.');});});
  }
  stop(emit=true){
    this.generation++;this.abort?.abort();this.child?.kill();this.contextChild?.kill();this.child=null;this.contextChild=null;this.state.status='stopped';this.state.message='Sessão encerrada.';
    if(emit){this.cancelCards();this.update();}
  }
  cancelCards(){this.state.cards=this.state.cards.map(c=>['checking','queued','rechecking'].includes(c.status)?{...c,status:'cancelled'}:c);Object.assign(this.state.metrics,{asrQueue:0,checkQueue:0,checking:0});}
  fail(message){this.stop(false);this.state.status='error';this.state.message=message;this.cancelCards();this.update();}
  async pumpAudio(gen){
    if(this.asrBusy)return;this.asrBusy=true;
    try{
      while(this.audioQueue.length&&gen===this.generation){
        const block=this.audioQueue.shift();this.state.metrics.asrQueue=this.audioQueue.length;
        let sum=0;for(let i=0;i<block.pcm.length;i+=2)sum+=block.pcm.readInt16LE(i)**2;
        if(Math.sqrt(sum/(block.pcm.length/2))<120){this.state.metrics.skippedSilence++;this.previousPcm=Buffer.alloc(0);continue;}
        const overlap=this.previousPcm;this.previousPcm=block.pcm.subarray(Math.max(0,block.pcm.length-4*bytesPerSecond));
        const raw=(this.provider!=='gateway'||this.state.transcribeOnly)?await this.localAsr.transcribe(Buffer.concat([overlap,block.pcm]),null,this.abort.signal):await this.deps.transcribe(Buffer.concat([overlap,block.pcm]),this.sessionAuth,this.abort.signal);
        if(gen!==this.generation)return;
        const text=trimOverlap(this.previousText,raw);this.previousText=raw;if(!text)continue;
        const segment={id:++this.state.metrics.transcripts,text,start:Math.max(this.state.offset,block.start-overlap.length/bytesPerSecond),end:block.end,endedAt:block.endedAt};
        this.state.segments.push(segment);this.state.segments=this.state.segments.filter(s=>s.end>=block.end-180);
        if(!this.state.transcribeOnly){this.fresh.push(segment.id);void this.pumpDetect(gen);}this.update();
      }
    }catch(error){if(gen===this.generation)this.fail(error.message);}
    finally{if(gen===this.generation){this.asrBusy=false;this.finishIfDone();this.update();}}
  }
  async pumpDetect(gen){
    if(this.detectBusy)return;this.detectBusy=true;
    try{
      while(this.fresh.length&&gen===this.generation){
        const arrived=this.fresh.splice(0),max=Math.max(...arrived),cutoff=this.state.segments.find(s=>s.id===max)?.end||0;
        const ids=[...new Set([...this.pendingContext,...arrived])].filter(id=>this.state.segments.some(s=>s.id===id));
        const all=this.state.segments.filter(s=>s.id<=max),known=this.state.cards.filter(c=>c.end>=cutoff-90).map(c=>({id:c.id,claim:c.claim,quote:c.quote,correctionReason:c.correctionReason||null,contextThrough:c.contextThrough||0}));
        const sourceContext={title:this.state.source?.title||'',channel:this.state.source?.channel||'',hint:this.state.contextHint||''};
        let selected=all.filter(s=>s.end>=cutoff-90||ids.includes(s.id));this.state.contextState='Identificando afirmações e perguntas · últimos 90 s';this.update();
        let result=await this.deps.detect({segments:selected,freshIds:ids,known,sourceContext,expanded:false,referenceDate:this.referenceDate},this.sessionAuth,this.abort.signal);
        if(gen!==this.generation)return;
        if(result.state==='need_past'){
          this.state.contextState='Recuperando até 3 minutos de contexto anterior';this.update();selected=all;
          result=await this.deps.detect({segments:selected,freshIds:ids,known,sourceContext,expanded:true,referenceDate:this.referenceDate},this.sessionAuth,this.abort.signal);
        }
        if(gen!==this.generation)return;
        this.state.contextState=result.state==='wait'?'Aguardando continuação: '+result.reason:result.state==='none'?'Nenhuma nova afirmação verificável':result.reason||'Contexto suficiente';
        this.pendingContext=[...new Set([...(['wait','need_past'].includes(result.state)?ids:[]),...(result.waitingSegmentIds||[])])].filter(id=>all.some(s=>s.id===id));
        const combined=normalized(selected.map(s=>s.text).join(' '));
        const heldIds=[],holdReasons=new Set();let accepted=0;
        if(result.state==='ready')for(const detected of(result.claims||[]).slice(0,6)){
          const candidate=isContextualReport(detected)?{...detected,kind:'reported_speech'}:detected;
          const refs=selected.filter(s=>candidate.segmentIds?.includes(s.id));
          if(!refs.length||!refs.some(s=>ids.includes(s.id))||!candidate.quote||!candidate.claim||!combined.includes(normalized(candidate.quote))||!normalized(refs.map(s=>s.text).join(' ')).includes(normalized(candidate.quote)))continue;
          const identity=normalized(candidate.claim);if(this.seen.has(identity))continue;
          const issue=excerptContextIssue(candidate.quote,selected);
          if(issue){heldIds.push(...refs.map(s=>s.id));holdReasons.add(issue);continue;}
          this.seen.add(identity);accepted++;
          const interpretations=(candidate.interpretations||[]).filter(i=>i.heard&&i.possible&&normalized(candidate.quote).includes(normalized(i.heard))).slice(0,3);
          const last=refs.at(-1),card={id:randomUUID(),quote:candidate.quote,claim:candidate.claim,kind:candidate.kind,interpretations,videoTitle:this.state.source?.title||'',videoChannel:this.state.source?.channel||'',start:refs[0].start,end:last.end,endedAt:last.endedAt,detectedAt:Date.now(),status:'queued',revision:0,version:0,contextThrough:max,context:selected.map(s=>({id:s.id,start:s.start,end:s.end,text:s.text}))};
          this.state.cards.push(card);this.state.metrics.detected++;
          if(this.checkQueue.length>=8){card.status='deferred';card.error='A fila de pesquisa atingiu o limite. Esta afirmação ficou sem checagem.';}else this.checkQueue.push(card.id);
        }
        this.pendingContext=[...new Set([...this.pendingContext,...heldIds])];
        const decisionState=heldIds.length&&!accepted?'wait':result.state;
        const decisionReason=heldIds.length?[result.reason,...holdReasons].filter(Boolean).join(' '):result.reason;
        if(heldIds.length)this.state.contextState='Aguardando contexto: '+[...holdReasons].join(' ');
        this.state.decisions.push({through:max,at:Date.now(),state:decisionState,reason:decisionReason,segmentIds:ids});this.state.decisions=this.state.decisions.slice(-20);
        for(const revision of result.revisions||[]){
          const card=this.state.cards.find(c=>c.id===revision.id&&!['cancelled','failed','deferred'].includes(c.status));
          if(card&&max>card.contextThrough){
            const inFlight=card.inFlight;card.status='rechecking';card.revision++;card.version++;card.contextThrough=max;card.correctionReason=revision.reason;card.context=selected.map(s=>({id:s.id,start:s.start,end:s.end,text:s.text}));
            if(!inFlight&&!this.checkQueue.includes(card.id))this.checkQueue.push(card.id);
          }
        }
        this.state.metrics.checkQueue=this.checkQueue.length;this.update();this.pumpChecks(gen);
      }
    }catch(error){if(gen===this.generation)this.fail(error.message);}
    finally{if(gen===this.generation){this.detectBusy=false;this.finishIfDone();this.update();}}
  }
  pumpChecks(gen){
    while(this.checking<2&&this.checkQueue.length&&gen===this.generation){
      const id=this.checkQueue.shift(),card=this.state.cards.find(c=>c.id===id);if(!card)continue;
      const version=card.version;card.inFlight=true;
      this.checking++;card.status=card.revision?'rechecking':'checking';this.state.metrics.checking=this.checking;this.state.metrics.checkQueue=this.checkQueue.length;this.update();
      void(async()=>{
        try{
          const result=await this.deps.check({quote:card.quote,claim:card.claim,kind:card.kind,interpretations:card.interpretations||[],correctionReason:card.correctionReason||null},card.context,this.referenceDate,this.sessionAuth,this.abort.signal);
          if(gen!==this.generation)return;
          if(version!==card.version){this.checkQueue.push(card.id);return;}
          const alreadyPublished=!!card.publishedAt;
          card.result=enforceClaimPolicy(card,result);card.status='published';card.publishedAt=Date.now();card.latency=+(Math.max(0,card.publishedAt-card.endedAt)/1000).toFixed(1);
          if(!alreadyPublished)this.state.metrics.published++;this.state.metrics.lastLatency=card.latency;this.event('published',{card});
          await mkdir(join(process.cwd(),'data'),{recursive:true});await appendFile(join(process.cwd(),'data',this.state.sessionId+'.jsonl'),JSON.stringify({source:this.state.source,referenceDate:this.referenceDate||null,card})+'\n');
        }catch(error){if(gen===this.generation){if(version!==card.version)this.checkQueue.push(card.id);else{card.status='failed';card.error=error.message;if(this.provider!=='gateway'&&(/^(subscription_sharing_|chatpass_)/.test(error.code||'')||['invalid_grant','invalid_client'].includes(error.code)||[401,403,429].includes(error.status)))this.fail(error.message);}}}
        finally{if(gen===this.generation){card.inFlight=false;this.checking--;this.state.metrics.checking=this.checking;this.state.metrics.checkQueue=this.checkQueue.length;this.update();this.pumpChecks(gen);this.finishIfDone();}}
      })();
    }
  }
  finishIfDone(){if(this.captureDone&&!this.audioQueue.length&&!this.asrBusy&&!this.fresh.length&&!this.detectBusy&&!this.checkQueue.length&&!this.checking){this.state.status='completed';this.state.message=this.state.probe?'Teste de áudio concluído. Nenhuma checagem factual foi executada.':this.state.transcribeOnly?'Teste de transcrição local concluído. Nenhuma checagem factual foi executada.':this.pendingContext.length?'Reprodução encerrada. Trechos sem contexto ou continuação suficientes ficaram sem checagem.':'Reprodução encerrada e fila processada.';this.update();}}
}
let instance;
export function engine(){return instance ||= new LiveEngine({oauth:chatgptAuth(),gemini:geminiAuth(),localAsr:localAsr()});}
