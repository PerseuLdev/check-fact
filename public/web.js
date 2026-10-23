import {AudioCapture} from './audio-capture.js';
import {createOverlay} from './overlay-client.js';
const $=id=>document.getElementById(id),busy=s=>['running','connecting','preparing','draining'].includes(s?.status);
const labels={correta:'Correta',correta_com_ressalvas:'Correta com ressalvas',parcialmente_correta:'Parcialmente correta',falsa:'Falsa',evidencias_insuficientes:'Evidências insuficientes',inconclusiva:'Inconclusiva',resposta_contextual:'Resposta com contexto',informacao_contextual:'Informação de contexto',checking:'Pesquisando',queued:'Na fila',rechecking:'Reavaliando',cancelled:'Cancelada',failed:'Não concluída'};
const clock=n=>{n=Math.max(0,Math.floor(n||0));return `${Math.floor(n/60).toString().padStart(2,'0')}:${(n%60).toString().padStart(2,'0')}`;};
function text(tag,value,cls){const el=document.createElement(tag);el.textContent=value??'';if(cls)el.className=cls;return el;}
function safeUrl(v){try{const u=new URL(v);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch{return null;}}
function videoId(v){try{const u=new URL(v);if(u.protocol!=='https:'||u.username||u.password)return null;const id=u.hostname==='youtu.be'?u.pathname.split('/')[1]:['youtube.com','www.youtube.com','m.youtube.com'].includes(u.hostname)?u.searchParams.get('v')||/^\/(?:live|shorts|embed)\/([^/]+)/.exec(u.pathname)?.[1]:null;return /^[\w-]{11}$/.test(id||'')?id:null;}catch{return null;}}
let session,state,auth,models=[],events,player,playerId,playerLoading,media,capture,transport,fileUrl,operation=0,starting=false,stopping=false,locked=false,poll,allTranscripts=new Map(),lastCards='',lastSegments='',activeSessionId=null,stageSessionId=null,lastError='';
const overlay=createOverlay($('overlay-layer'));
const mode=()=>document.querySelector('input[name=source]:checked').value;
function notice(message,error=false){$('notice').textContent=message;$('notice').dataset.error=String(error);}
async function api(path,data,{raw=false,headers={}}={}){
  const r=await fetch('/api/web/'+path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':raw?'application/octet-stream':'application/json','x-csrf-token':session.csrf,...headers},body:raw?data:JSON.stringify(data||{}),signal:AbortSignal.timeout(path==='start'?180000:30000)}),d=await r.json();
  if(!r.ok)throw new Error(d.error||'Não foi possível concluir a operação.');return d;
}
function controls(){
  const running=busy(state),disabled=running||starting||stopping||locked||!session,check=$('run-mode').value==='check';
  $('source-options').disabled=disabled;for(const id of ['youtube-url','load-video','file-input','run-mode','reference-date','offset','context-hint','settings-open'])$(id).disabled=disabled;
  $('start').textContent=check?'Começar verificação':'Começar transcrição';$('start').hidden=running||starting||stopping;$('stop').hidden=!running&&!starting&&!stopping;$('stop').disabled=stopping;$('start').disabled=disabled||(check&&!state?.aiConfigured);
  $('dock-title').textContent=starting?'Preparando sua fonte…':stopping?'Encerrando a captura…':running?(state.transcribeOnly?'Transcrição em andamento':'Verificação em andamento'):'Pronto para começar';
  if(!lastError){if(check&&!state?.aiConfigured)notice('Abra “Configurar IA” para conectar um provedor antes de checar.');else if(!running&&!starting&&!stopping)notice(check?'A pesquisa usa a conexão de IA selecionada.':'Só transcrever funciona sem conexão de IA.');}
}
function sourceFields(){
  const m=mode();$('youtube-fields').hidden=m!=='youtube';$('file-fields').hidden=m!=='file';$('capture-help').hidden=['youtube','file'].includes(m);$('offset-label').hidden=m!=='youtube';
  $('capture-help').textContent=m==='tab'?'Escolha a aba desejada e ative o compartilhamento de áudio. A seleção também pode oferecer som do sistema. A prévia de imagem fica neste navegador.':'Autorize o microfone para transcrever uma conversa ou o som de uma TV. Evite ruído e conversas sobrepostas.';
  $('player-note').textContent=m==='youtube'?'O áudio da URL é lido por uma conexão própria. Ao pausar ou mudar de trecho, encerre e reinicie a checagem no novo ponto.':m==='file'?'O arquivo é reproduzido aqui. Pausas interrompem a chegada de som; os tempos da transcrição contam desde o início da captura.':m==='tab'?'Os cartões aparecem nesta página, sobre a prévia compartilhada. Não aparecem sobre o aplicativo original. Conteúdo protegido pode impedir áudio ou imagem.':'Você pode acompanhar a transcrição sem vídeo. O áudio do microfone é enviado ao servidor desta instalação.';controls();
}
function replaceMedia(el){stageSessionId=null;overlay.hide();$('caption').hidden=true;player?.destroy?.();player=null;playerId=null;$('video-host').replaceChildren(el);media=el;}
function makeFileMedia(){if(!fileUrl)throw new Error('Escolha um arquivo de áudio ou vídeo.');const position=media?.currentTime||0,el=document.createElement('video');el.src=fileUrl;el.controls=true;el.playsInline=true;el.preload='metadata';el.setAttribute('aria-label','Arquivo selecionado');replaceMedia(el);el.addEventListener('loadedmetadata',()=>{if(position<el.duration)el.currentTime=position;},{once:true});return el;}
async function loadYouTube(){
  const id=videoId($('youtube-url').value);if(!id)throw new Error('Informe um link HTTPS válido do YouTube.');lastError='';$('source-message').textContent='Abrindo o vídeo…';
  if(!window.YT?.Player){playerLoading ||= new Promise((resolve,reject)=>{const timer=setTimeout(()=>{playerLoading=null;reject(new Error('O player não carregou. Confira a conexão ou tente outra fonte.'));},15000);window.onYouTubeIframeAPIReady=()=>{clearTimeout(timer);resolve();};const script=document.createElement('script');script.src='https://www.youtube.com/iframe_api';script.onerror=()=>{clearTimeout(timer);playerLoading=null;reject(new Error('Não foi possível carregar o player.'));};document.head.append(script);});await playerLoading;}
  stageSessionId=null;overlay.hide();$('caption').hidden=true;player?.destroy?.();player=null;media=null;const host=document.createElement('div');host.id='youtube-player';$('video-host').replaceChildren(host);playerId=id;
  player=new YT.Player(host,{host:'https://www.youtube-nocookie.com',videoId:id,playerVars:{origin:location.origin,playsinline:1,rel:0,fs:0,start:Number($('offset').value)||0},events:{onReady(){ $('source-message').textContent='Vídeo aberto. Escolha como acompanhar e clique em começar.';},onError(){ $('source-message').textContent='Este vídeo não pôde ser incorporado. Use outro vídeo ou, em um computador compatível, escolha “Áudio de uma aba”.';}}});
  void api('connect',{url:$('youtube-url').value}).then(({source})=>{$('source-message').textContent=`${source.title} · ${source.channel||'YouTube'}`;}).catch(e=>{$('source-message').textContent=e.message;});
}
function renderCards(cards){
  const key=JSON.stringify(cards);if(key===lastCards)return;lastCards=key;$('cards').replaceChildren();
  if(!cards.length){const empty=text('div','','empty-state');empty.append(text('span','↗'),text('h3',state?.transcribeOnly?'Você está no modo de transcrição.':'Aguardando uma fala com contexto.'),text('p',state?.transcribeOnly?'O texto aparece na transcrição. Nenhuma checagem factual é feita neste modo.':'Os resultados podem aguardar continuação ou indicar evidências insuficientes.'));$('cards').append(empty);return;}
  for(const c of [...cards].reverse()){
    const r=c.status==='published'?c.result:null,el=text('article','','fact');el.dataset.verdict=r?.verdict||c.status;el.append(text('span',labels[r?.verdict||c.status]||c.status,'verdict'));if(c.videoTitle||state.source?.title)el.append(text('p',c.videoTitle||state.source.title,'hint'));el.append(text('p','“'+c.quote+'”','quote'),text('p',r?.explanation||c.error||'Aguardando pesquisa e contexto.','explanation'));
    for(const ev of r?.evidence||[]){const url=safeUrl(ev.url);if(!url)continue;const a=text('a',(ev.title||new URL(url).hostname)+' ↗');a.href=url;a.target='_blank';a.rel='noopener noreferrer';el.append(a);if(ev.finding)el.append(text('p',ev.finding,'hint'));}
    const detail=document.createElement('details');detail.append(text('summary','Afirmação e contexto'),text('p',c.claim));for(const seg of c.context||[])detail.append(text('p',seg.text));el.append(detail,text('p',`${clock(c.start)} — ${clock(c.end)} · ${c.revision?'Atualizada com novo contexto':'Checagem automática · voz não identificada'}`,'meta'));$('cards').append(el);
  }
}
function render(s){
  if(!s)return;state=s;if(s.sessionId!==activeSessionId){activeSessionId=s.sessionId;allTranscripts.clear();lastCards='';lastSegments='';overlay.setDemo(false);}
  $('engine-status').textContent=({idle:'Aguardando',connecting:'Conectando',preparing:'Preparando',running:'Em execução',draining:'Finalizando',completed:'Concluído',stopped:'Encerrado',error:'Erro'})[s.status]||s.status;$('engine-status').className='pill'+(busy(s)?' active':'');
  $('engine-message').textContent=s.message;$('audio-seconds').textContent=clock(s.metrics.audioSeconds);$('transcript-count').textContent=s.metrics.transcripts;$('card-count').textContent=s.metrics.published;$('context-state').textContent=s.contextState;
  if(['completed','stopped'].includes(s.status)&&s.source?.kind==='capture')$('source-message').textContent='Captura encerrada. Os resultados recebidos continuam disponíveis nesta sessão.';
  for(const seg of s.segments)allTranscripts.set(seg.id,seg);$('download-transcript').disabled=!allTranscripts.size;
  const key=JSON.stringify(s.segments);if(key!==lastSegments){lastSegments=key;$('transcript').replaceChildren();if(!s.segments.length)$('transcript').append(text('p','Os trechos aparecem conforme o áudio é processado.','hint'));for(const seg of [...s.segments].reverse()){const row=text('div','','transcript-item');row.append(text('time',`${clock(seg.start)} — ${clock(seg.end)}`),document.createTextNode(seg.text));$('transcript').append(row);}$('caption').textContent=s.segments.at(-1)?.text||'';}
  const matching=stageSessionId===s.sessionId||(mode()==='youtube'&&playerId&&playerId===videoId(s.source?.url));
  renderCards(s.cards);overlay.render($('overlay-toggle').checked&&matching?s:null);$('caption').hidden=!matching||!s.segments.length||(!s.transcribeOnly&&s.cards.some(c=>c.status==='published'&&Date.now()-c.publishedAt<30000)&&$('overlay-toggle').checked);
  if(s.status==='error'){lastError=s.message;notice(s.message,true);if(capture&&!stopping)void stopCapture(false);}controls();
}
function renderAuth(){
  $('local-chatgpt').hidden=!session?.localPlan;$('hosted-auth-note').hidden=!!session?.localPlan;$('gateway-disconnect').hidden=state?.provider!=='gateway'||!state?.aiConfigured;
  if(!auth)return;const p=auth.profiles.find(p=>p.id===auth.activeId);$('auth-status').textContent=auth.error||auth.loginMessage||(auth.pending?'Conclua a autorização na janela do ChatGPT.':auth.planEnabled?`Conta conectada${p?.email?' · '+p.email:''}.`:auth.connected?'A conta foi identificada. Autorize o uso do plano.':'Nenhuma conta conectada.');
  $('auth-login').disabled=auth.pending||busy(state);$('auth-disconnect').hidden=!auth.connected;$('auth-cancel').hidden=!auth.pending;$('auth-models').hidden=!auth.planEnabled;
  $('model').replaceChildren(new Option('Selecione um modelo',''),...models.map(m=>new Option(m.name,m.id)));$('model').value=auth.selectedModel||'';$('effort').replaceChildren(...(auth.effortOptions||[]).map(v=>new Option(v==='default'?'Padrão do modelo':v,v)));$('effort').value=auth.selectedEffort||'default';$('effort').disabled=!auth.selectedModel;
}
async function refreshState(){try{const r=await fetch('/api/web/state',{cache:'no-store'}),d=await r.json();if(!r.ok)throw new Error(d.error);auth=d.auth;render(d.state);renderAuth();$('connection').textContent='Sessão conectada';}catch(e){$('connection').textContent='Sem conexão';if(!starting&&!stopping){lastError=e.message;notice(e.message,true);}}}
async function loadModels(force=false){if(!auth?.planEnabled)return;const d=await api('auth/models',{force});models=d.models;auth=d.auth;renderAuth();}
function connectEvents(){events?.close();events=new EventSource('/api/web/events');events.onmessage=event=>{const d=JSON.parse(event.data);if(d.type==='snapshot')render(d.state);if(d.type==='auth_changed')void refreshState();if(d.type==='audio_started'&&player&&mode()==='youtube'){try{if(!d.isLive)player.seekTo(d.offset,true);player.playVideo();}catch{}}};events.onopen=()=>{$('connection').textContent='Sessão conectada';};events.onerror=()=>{$('connection').textContent='Reconectando…';};}
function enqueuePCM(buffer){
  const t=transport;if(!t||t.closed)return;t.pending+=buffer.byteLength;if(t.pending>48*32000){captureError(new Error('A conexão está atrasando o áudio. Tente novamente com uma rede mais estável.'));return;}
  const seq=t.sequence++;t.tail=t.tail.then(async()=>{if(!t.closed)await api('audio',buffer,{raw:true,headers:{'x-stream-id':t.id,'x-audio-sequence':String(seq)}});}).catch(captureError).finally(()=>{t.pending-=buffer.byteLength;});
}
function captureError(e){if(transport?.closed)return;if(transport)transport.closed=true;lastError=e.message;notice(e.message,true);void stopCapture(false);}
async function start(){
  const op=++operation,m=mode();starting=true;lastError='';overlay.setDemo(false);controls();let prepared;
  try{
    if(m==='youtube'){const id=videoId($('youtube-url').value);if(!id)throw new Error('Informe um link válido do YouTube.');if(playerId!==id)await loadYouTube();}
    else{
      if(m==='file')makeFileMedia();else if(m==='microphone'){const box=text('div','','player-empty');box.append(text('span','◉','play-symbol'),text('p','Ouvindo pelo microfone'));replaceMedia(box);}
      prepared=await AudioCapture.prepare({mode:m,element:media,onChunk:enqueuePCM,onLevel:v=>{$('audio-meter-fill').style.transform=`scaleX(${Math.min(1,v*8)})`;$('audio-level-label').textContent=v>.005?'Áudio detectado.':'Aguardando som da fonte selecionada.';},onEnded:()=>void stopCapture(true)});
      if(op!==operation){await prepared.close();return;}capture=prepared;
      if(m==='tab'){const video=document.createElement('video');video.muted=true;video.playsInline=true;video.autoplay=true;video.srcObject=prepared.stream;replaceMedia(video);await video.play();}
    }
    if(op!==operation)return;
    const d=await api('start',{input:m==='youtube'?'youtube':'capture',url:$('youtube-url').value,title:m==='file'?$('file-input').files[0]?.name:m==='microphone'?'Áudio do microfone':'Áudio compartilhado',offset:m==='youtube'?Math.floor(player?.getCurrentTime?.()||Number($('offset').value)||0):0,referenceDate:$('reference-date').value,contextHint:$('context-hint').value,transcribeOnly:$('run-mode').value==='transcribe'});
    if(op!==operation)return;stageSessionId=d.state.sessionId;render(d.state);if(d.state.status!=='running')throw new Error(d.state.message);if(prepared){transport={id:d.state.sessionId,sequence:0,pending:0,tail:Promise.resolve(),closed:false};await prepared.start();}
    $('source-message').textContent=m==='youtube'?'A transcrição acompanha uma conexão própria com a URL.':'Captura autorizada em andamento. Encerre para parar de enviar áudio.';
  }catch(e){if(op===operation){lastError=e.message;notice(e.message,true);await prepared?.close();capture=null;await api('stop').catch(()=>{});}}
  finally{if(op===operation){starting=false;controls();}}
}
async function stopCapture(flush=true){
  if(stopping)return;const wasStarting=starting;++operation;starting=false;stopping=true;controls();const c=capture,t=transport;capture=null;
  try{if(!flush&&t)t.closed=true;await c?.close({flush:flush&&!wasStarting});if(flush&&t&&!t.closed&&!wasStarting){await t.tail;if(!t.closed)await api('end-audio',{streamId:t.id});}else await api('stop');if(t)t.closed=true;transport=null;player?.pauseVideo?.();if(media?.srcObject){media.srcObject=null;media.load();}$('audio-meter-fill').style.transform='scaleX(0)';$('audio-level-label').textContent='Captura encerrada.';await refreshState();}
  catch(e){lastError=e.message;notice(e.message,true);await api('stop').catch(()=>{});}finally{if(t)t.closed=true;transport=null;stopping=false;controls();}
}
async function bootstrap(){
  const r=await fetch('/api/web/session',{cache:'no-store'}),d=await r.json();if(!r.ok)throw new Error(d.error);session=d;auth=d.auth;locked=d.locked;$('access-box').hidden=!locked;
  $('processing-note').textContent=d.localPlan?'O áudio é transcrito no computador que executa este servidor. Ao checar, texto e contexto são enviados à conexão de IA selecionada.':'O áudio capturado é enviado ao servidor desta instalação para transcrição. Ao checar, texto e contexto também são enviados à API selecionada.';
  render(d.state);renderAuth();if(!locked){connectEvents();clearInterval(poll);poll=setInterval(()=>void refreshState(),20000);await loadModels();}
}
$('load-video').onclick=()=>void loadYouTube().catch(e=>{$('source-message').textContent=e.message;});document.querySelectorAll('input[name=source]').forEach(el=>el.onchange=()=>{lastError='';stageSessionId=null;overlay.setDemo(false);overlay.hide();$('caption').hidden=true;sourceFields();});
$('file-input').onchange=()=>{if(fileUrl)URL.revokeObjectURL(fileUrl);const file=$('file-input').files[0];fileUrl=file?URL.createObjectURL(file):null;if(file){makeFileMedia();$('source-message').textContent=file.name;}};
$('run-mode').onchange=()=>{lastError='';controls();};$('start').onclick=start;$('stop').onclick=()=>void stopCapture(true);$('overlay-toggle').onchange=()=>render(state);
$('demo').onclick=()=>{overlay.setDemo(true);$('caption').hidden=true;$('player-note').textContent='Demonstração visual: este cartão não usa IA nem representa uma checagem real.';};
async function expand(){const el=$('stage');if(document.fullscreenElement){await document.exitFullscreen();return;}if(el.classList.contains('expanded')){el.classList.remove('expanded');return;}try{if(el.requestFullscreen)await el.requestFullscreen();else el.classList.add('expanded');}catch{el.classList.add('expanded');}}
$('fullscreen').onclick=expand;$('stage').ondblclick=e=>{if(!e.target.closest('.overlay-card'))void expand();};document.addEventListener('keydown',e=>{if(e.key==='Escape')$('stage').classList.remove('expanded');});
$('download-transcript').onclick=()=>{const content=[...allTranscripts.values()].sort((a,b)=>a.start-b.start).map(s=>`[${clock(s.start)} — ${clock(s.end)}] ${s.text}`).join('\n\n'),url=URL.createObjectURL(new Blob(['Transcrição automática · sujeita a erros\n\n'+content],{type:'text/plain;charset=utf-8'})),link=document.createElement('a');link.href=url;link.download='verifica-transcricao.txt';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
const settingsError=e=>{$('settings-message').textContent=e.message;};
$('settings-open').onclick=()=>{$('settings').showModal();renderAuth();void loadModels().catch(settingsError);};$('settings-close').onclick=()=>$('settings').close();
$('gateway-form').onsubmit=async e=>{e.preventDefault();try{const d=await api('gateway',{key:$('gateway-key').value});$('gateway-key').value='';render(d.state);renderAuth();$('settings-message').textContent='API selecionada. As próximas checagens usarão os créditos dessa conta.';$('run-mode').value='check';controls();}catch(e){settingsError(e);}};
$('gateway-disconnect').onclick=async()=>{try{const d=await api('gateway/disconnect');render(d.state);renderAuth();$('settings-message').textContent='Chave removida desta sessão.';}catch(e){settingsError(e);}};
$('auth-login').onclick=async()=>{const popup=window.open('about:blank','_blank','popup,width=680,height=800');if(popup)popup.opener=null;try{const d=await api('auth/begin'),u=new URL(d.authorizeUrl);if(u.origin!=='https://auth.openai.com')throw new Error('Endereço de autorização inesperado.');$('auth-link').href=u.href;$('auth-link').hidden=false;if(popup)popup.location.href=u.href;await refreshState();}catch(e){popup?.close();settingsError(e);}};
$('auth-cancel').onclick=async()=>{try{await api('auth/cancel');await refreshState();}catch(e){settingsError(e);}};
$('auth-disconnect').onclick=async()=>{try{const d=await api('auth/disconnect');models=[];await refreshState();$('settings-message').textContent=d.message;}catch(e){settingsError(e);}};
$('model-refresh').onclick=()=>void loadModels(true).catch(settingsError);$('model').onchange=async()=>{if(!$('model').value)return;try{auth=(await api('auth/model',{model:$('model').value})).auth;await refreshState();}catch(e){settingsError(e);}};
$('effort').onchange=async()=>{try{auth=(await api('auth/effort',{effort:$('effort').value})).auth;renderAuth();}catch(e){settingsError(e);}};
$('model-test').onclick=async()=>{$('model-test').disabled=true;try{const d=await api('auth/test');$('settings-message').textContent='Conexão confirmada: '+d.model;$('run-mode').value='check';await refreshState();}catch(e){settingsError(e);}finally{$('model-test').disabled=false;}};
$('access-form').onsubmit=async e=>{e.preventDefault();try{await api('unlock',{code:$('access-code').value});$('access-code').value='';await bootstrap();}catch(e){$('access-error').textContent=e.message;}};
$('delete-session').onclick=async()=>{try{events?.close();clearInterval(poll);await stopCapture(false);await api('session/delete');location.reload();}catch(e){lastError=e.message;notice(e.message,true);}};
window.addEventListener('pagehide',()=>{events?.close();clearInterval(poll);if(transport)transport.closed=true;void capture?.close();if(session?.csrf&&busy(state))void fetch('/api/web/stop',{method:'POST',keepalive:true,headers:{'Content-Type':'application/json','x-csrf-token':session.csrf},body:'{}'}).catch(()=>{});if(fileUrl)URL.revokeObjectURL(fileUrl);});window.addEventListener('pageshow',e=>{if(e.persisted)location.reload();});document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!locked)void refreshState();});
if(!navigator.mediaDevices?.getDisplayMedia)$('tab-option').hidden=true;sourceFields();void bootstrap().then(()=>{if(new URLSearchParams(location.search).has('connected')){history.replaceState({},'', '/');$('settings').showModal();}}).catch(e=>{lastError=e.message;notice(e.message,true);});
