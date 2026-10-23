export class AudioCapture {
  static async prepare({mode,element,onChunk,onLevel,onEnded}){
    if(!window.isSecureContext)throw new Error('A captura exige HTTPS. No computador, localhost também é permitido.');
    if(!window.AudioContext||!window.AudioWorkletNode)throw new Error('Este navegador não oferece o processamento de áudio necessário.');
    const capture=new AudioCapture();capture.element=element;capture.onEnded=onEnded;capture.onChunk=onChunk;capture.onLevel=onLevel;capture.mode=mode;
    try{
      capture.context=new AudioContext();const resume=capture.context.resume();
      if(mode==='microphone'){
        if(!navigator.mediaDevices?.getUserMedia)throw new Error('Microfone indisponível neste navegador.');
        capture.stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
      }else if(mode==='tab'){
        if(!navigator.mediaDevices?.getDisplayMedia)throw new Error('Este navegador não permite compartilhar áudio de aba. Use um arquivo, microfone ou um computador compatível.');
        capture.stream=await navigator.mediaDevices.getDisplayMedia({video:true,audio:true,systemAudio:'include'});
        if(!capture.stream.getAudioTracks().length)throw new Error('A seleção não compartilhou áudio. Tente selecionar uma aba e ativar “Compartilhar áudio”.');
      }else if(mode!=='file')throw new Error('Fonte de áudio inválida.');
      // Called from the user's gesture, before server preparation can take time.
      if(mode==='file'){const play=element.play();await play;element.pause();}
      await resume;await capture.context.audioWorklet.addModule('/pcm-worklet.js');
      capture.source=mode==='file'?capture.context.createMediaElementSource(element):capture.context.createMediaStreamSource(new MediaStream(capture.stream.getAudioTracks()));
      capture.worklet=new AudioWorkletNode(capture.context,'verifica-pcm');
      capture.worklet.port.onmessage=event=>{
        if(event.data.type==='pcm')onChunk(event.data.buffer);
        else if(event.data.type==='level')onLevel?.(event.data.value);
        else if(event.data.type==='flushed')capture.flushed?.();
      };
      capture.silent=capture.context.createGain();capture.silent.gain.value=0;
      capture.worklet.connect(capture.silent).connect(capture.context.destination);
      if(mode==='file')capture.source.connect(capture.context.destination);
      capture.end=()=>{if(!capture.closing)onEnded?.();};
      for(const track of capture.stream?.getTracks()||[])track.addEventListener('ended',capture.end,{once:true});
      if(mode==='file')element.addEventListener('ended',capture.end,{once:true});
      return capture;
    }catch(error){await capture.close();if(error.name==='NotAllowedError')throw new Error('A captura não foi autorizada. Permita o acesso para começar.');if(error.name==='NotFoundError')throw new Error('Nenhuma entrada de áudio foi encontrada.');throw error;}
  }
  async start(){this.source.connect(this.worklet);await this.context.resume();if(this.mode==='file')await this.element.play();}
  async close({flush=false}={}){
    if(this.closing)return;this.closing=true;
    this.source?.disconnect();this.element?.removeEventListener('ended',this.end);
    if(this.mode==='file')this.element?.pause();
    for(const track of this.stream?.getTracks()||[])track.stop();
    if(flush&&this.worklet)await new Promise(resolve=>{const timer=setTimeout(resolve,1500);this.flushed=()=>{clearTimeout(timer);resolve();};this.worklet.port.postMessage('flush');});
    this.worklet?.disconnect();this.silent?.disconnect();await this.context?.close();
  }
}
