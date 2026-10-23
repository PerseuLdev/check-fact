// Streaming interpolation keeps one sample clock across AudioWorklet callbacks.
// A fresh resampler per callback would drop samples and drift over long sessions.
export class PCMEncoder {
  constructor(inputRate,onChunk,{outputRate=16000,chunkSamples=16000}={}){
    if(!Number.isFinite(inputRate)||inputRate<=0)throw new Error('Taxa de áudio inválida.');
    this.step=inputRate/outputRate;this.next=0;this.index=0;this.previous=0;this.buffer=new Int16Array(chunkSamples);this.used=0;this.onChunk=onChunk;
  }
  push(samples){for(const current of samples){
    while(this.next<=this.index){const fraction=this.index===0?1:this.next-(this.index-1);const value=this.index===0?current:this.previous+(current-this.previous)*fraction;
      const clamped=Math.max(-1,Math.min(1,Number.isFinite(value)?value:0));this.buffer[this.used++]=Math.round(clamped*(clamped<0?32768:32767));
      if(this.used===this.buffer.length){const chunk=this.buffer;this.buffer=new Int16Array(chunk.length);this.used=0;this.onChunk(chunk);}this.next+=this.step;
    }
    this.previous=current;this.index++;
  }}
  flush(){if(this.used){const chunk=this.buffer.slice(0,this.used);this.used=0;this.onChunk(chunk);}}
}
