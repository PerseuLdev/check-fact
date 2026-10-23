import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pythonPath } from './credential-store.mjs';

export class LocalASR extends EventEmitter {
  constructor(){super();this.child=null;this.loading=null;this.pending=new Map();this.state={status:'idle',model:process.env.LOCAL_ASR_MODEL||'small',device:'cpu',lastProcessingSeconds:null,error:null};}
  snapshot(){return {...this.state};}
  update(values){Object.assign(this.state,values);this.emit('change');}
  async prepare(){
    if(this.state.status==='ready'&&this.child)return this.snapshot();if(this.loading)return this.loading;
    this.update({status:'loading',error:null});
    const child=spawn(pythonPath(),['-u',join(process.cwd(),'scripts','asr_worker.py')],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8'}});this.child=child;child.stderr.resume();child.stdin.on('error',()=>{});
    this.loading=new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{child.kill();reject(new Error('A preparação da transcrição local excedeu dois minutos. Verifique os arquivos do modelo.'));},120000);timeout.unref?.();
      const fail=message=>{clearTimeout(timeout);this.update({status:'error',error:message});for(const p of this.pending.values())p.reject(new Error(message));this.pending.clear();reject(new Error(message));};
      const lines=createInterface({input:child.stdout});
      lines.on('line',line=>{
        let event;try{event=JSON.parse(line);}catch{return;}
        if(event.type==='ready'){clearTimeout(timeout);this.update({status:'ready',model:event.model,device:event.device,loadSeconds:event.loadSeconds,error:null});resolve(this.snapshot());}
        else if(event.type==='startup_error')fail(event.error);
        else if(event.id){const p=this.pending.get(event.id);if(!p)return;this.pending.delete(event.id);
          if(event.type==='error')p.reject(new Error(event.error));else{this.update({lastProcessingSeconds:event.processingSeconds});p.resolve(event.text);}
        }
      });
      child.on('error',()=>fail('Não foi possível iniciar o Python da transcrição local.'));
      child.on('close',()=>{if(this.child===child)this.child=null;if(this.state.status!=='idle')fail('O processo de transcrição local foi encerrado.');lines.close();});
    });
    try{return await this.loading;}finally{this.loading=null;}
  }
  async transcribe(pcm,_auth,signal){
    if(signal?.aborted)throw new DOMException('Cancelado','AbortError');await this.prepare();if(signal?.aborted)throw new DOMException('Cancelado','AbortError');
    const id=randomUUID();
    return new Promise((resolve,reject)=>{
      const finish=(fn,value)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);fn(value);};
      const abort=()=>{this.pending.delete(id);finish(reject,new DOMException('Cancelado','AbortError'));};
      const timer=setTimeout(()=>{this.pending.delete(id);finish(reject,new Error('A transcrição local demorou mais de 30 segundos para este bloco.'));},30000);
      this.pending.set(id,{resolve:text=>finish(resolve,text),reject:error=>finish(reject,error)});signal?.addEventListener('abort',abort,{once:true});
      this.child.stdin.write(JSON.stringify({id,audio:pcm.toString('base64')})+'\n',error=>{if(error){this.pending.delete(id);finish(reject,new Error('O processo de transcrição local não está disponível.'));}});
    });
  }
  shutdown(){this.update({status:'idle'});this.child?.kill();this.child=null;for(const p of this.pending.values())p.reject(new Error('Transcrição encerrada.'));this.pending.clear();}
}
let instance;
export function localAsr(){return instance ||= new LocalASR();}
