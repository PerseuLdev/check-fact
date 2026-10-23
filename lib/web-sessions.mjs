import { randomBytes, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { LiveEngine } from './engine.mjs';
import { ChatGPTAuth } from './chatgpt-auth.mjs';
import { LocalASR } from './local-asr.mjs';

export const isBusy = engine => ['connecting','preparing','running','draining'].includes(engine.state.status);

// The web service never opens the desktop application's saved credentials.
export class MemoryStore {
  constructor(){this.data={version:1,hostId:null,activeId:null,profiles:[]};this.tail=Promise.resolve();}
  async load(){return structuredClone(this.data);}
  transaction(fn){const task=this.tail.catch(()=>{}).then(async()=>{const data=await this.load(),result=await fn(data);this.data=structuredClone(data);return {data,result};});this.tail=task;return task;}
}

// One model in RAM; bounded, serialized jobs shared by isolated sessions.
export class TranscriptionPool {
  constructor(worker=new LocalASR()){this.worker=worker;this.tail=Promise.resolve();this.queued=0;}
  async transcribe(pcm,signal){
    if(this.queued>=8)throw new Error('A fila de transcrição está cheia. Tente novamente em instantes.');
    this.queued++;
    const task=this.tail.catch(()=>{}).then(()=>{signal?.throwIfAborted();return this.worker.transcribe(pcm,null,signal);});
    this.tail=task;try{return await task;}finally{this.queued--;}
  }
  facade(){
    const pool=this;
    return new class extends EventEmitter {
      constructor(){super();this.state={status:'idle',model:pool.worker.state.model,device:'cpu',lastProcessingSeconds:null,error:null};}
      snapshot(){return {...this.state};}
      update(values){Object.assign(this.state,values);this.emit('change');}
      async prepare(){this.update({status:'loading',error:null});try{const s=await pool.worker.prepare();this.update({status:'ready',model:s.model,device:s.device});return this.snapshot();}catch(e){this.update({status:'error',error:e.message});throw e;}}
      async transcribe(pcm,_auth,signal){const started=Date.now();const text=await pool.transcribe(pcm,signal);this.update({lastProcessingSeconds:(Date.now()-started)/1000});return text;}
    }();
  }
  close(){this.worker.shutdown();}
}

export class WebSessions {
  constructor({origin,pool=new TranscriptionPool(),maxSessions=80,maxActive=2,idleMs=30*60000,maxRunMs=2*3600000,createContext,now=Date.now}={}){
    this.origin=origin;this.pool=pool;this.maxSessions=maxSessions;this.maxActive=maxActive;this.idleMs=idleMs;this.maxRunMs=maxRunMs;this.now=now;this.entries=new Map();
    this.localPlan=new URL(origin).hostname==='127.0.0.1'&&new URL(origin).protocol==='http:';
    this.createContext=createContext||(()=>{
      const oauth=this.localPlan?new ChatGPTAuth({store:new MemoryStore(),origin}):null;
      const asr=this.pool.facade(),engine=new LiveEngine({oauth,localAsr:asr,record:false,localTranscription:true});
      engine.key=''; // A visitor never inherits an operator's API credential.
      return {oauth,engine,asr};
    });
  }
  key(token){return createHash('sha256').update(token).digest('hex');}
  create(ip='local'){
    this.sweep();
    if(this.entries.size>=this.maxSessions)throw Object.assign(new Error('O servidor está cheio. Tente novamente mais tarde.'),{status:503});
    if([...this.entries.values()].filter(s=>s.ip===ip).length>=12)throw Object.assign(new Error('Muitas sessões neste endereço. Aguarde as sessões anteriores expirarem.'),{status:429});
    const token=randomBytes(32).toString('hex'),id=this.key(token),context=this.createContext(id);
    const s={...context,id,ip,csrf:randomBytes(24).toString('hex'),touched:this.now(),starting:false,startedAt:null,streams:new Set(),buckets:new Map(),mutating:false,disposed:false,unlocked:false};
    this.entries.set(id,s);return {session:s,token};
  }
  get(token){if(!/^[a-f0-9]{64}$/.test(token||''))return null;const s=this.entries.get(this.key(token));if(!s||s.disposed)return null;if(this.now()-s.touched>this.idleMs){this.remove(s);return null;}s.touched=this.now();return s;}
  limit(s,name,max,windowMs=60000){const now=this.now(),b=s.buckets.get(name);if(!b||now>=b.until){s.buckets.set(name,{count:1,until:now+windowMs});return;}if(++b.count>max)throw Object.assign(new Error('Muitas solicitações. Aguarde um pouco e tente novamente.'),{status:429});}
  reserve(s){
    if(s.starting||isBusy(s.engine))throw Object.assign(new Error('Encerre a execução atual antes de começar outra.'),{status:409});
    const active=[...this.entries.values()].filter(x=>x!==s&&(x.starting||isBusy(x.engine))).length;
    if(active>=this.maxActive)throw Object.assign(new Error('O servidor está processando outras sessões. Tente novamente em instantes.'),{status:503});
    s.starting=true;s.startedAt=this.now();
  }
  remove(s){
    if(s.disposed)return;s.disposed=true;s.engine.stop();s.oauth?.cancel();
    for(const close of [...s.streams])close();s.streams.clear();
    s.engine.key='';s.engine.sessionAuth=null;s.engine.removeAllListeners();s.asr?.removeAllListeners();
    if(s.oauth){s.oauth.data={profiles:[],activeId:null};s.oauth.store.data={version:1,profiles:[],activeId:null};s.oauth.removeAllListeners();}
    this.entries.delete(s.id);
  }
  sweep(){for(const s of this.entries.values()){
    if(this.now()-s.touched>this.idleMs){this.remove(s);continue;}
    if(s.startedAt!==null&&this.now()-s.startedAt>this.maxRunMs&&(s.starting||isBusy(s.engine))){s.engine.fail('O tempo máximo desta execução foi atingido. Você pode iniciar outra.');s.startedAt=null;}
    if(s.engine.input==='capture'&&s.engine.state.status==='running'&&this.now()-(s.engine.inputLastAudioAt||s.engine.inputStartedAt)>45000)s.engine.fail('O envio de áudio foi interrompido. Reabra a fonte para continuar.');
  }}
  close(){for(const s of [...this.entries.values()])this.remove(s);this.pool.close();}
}
