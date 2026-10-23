import { PCMEncoder } from './pcm-codec.js';
class VerificaPCM extends AudioWorkletProcessor {
  constructor(){super();this.frames=0;this.energy=0;this.encoder=new PCMEncoder(sampleRate,pcm=>this.port.postMessage({type:'pcm',buffer:pcm.buffer},[pcm.buffer]));
    this.port.onmessage=event=>{if(event.data==='flush'){this.encoder.flush();this.port.postMessage({type:'flushed'});}};
  }
  process(inputs){const channels=inputs[0];if(!channels?.length)return true;
    const mono=new Float32Array(channels[0].length);
    for(const channel of channels)for(let i=0;i<mono.length;i++)mono[i]+=channel[i]/channels.length;
    this.encoder.push(mono);for(const sample of mono)this.energy+=sample*sample;this.frames+=mono.length;
    if(this.frames>=sampleRate/10){this.port.postMessage({type:'level',value:Math.sqrt(this.energy/this.frames)});this.frames=0;this.energy=0;}
    return true;
  }
}
registerProcessor('verifica-pcm',VerificaPCM);
