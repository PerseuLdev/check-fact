import {createOverlay} from '/overlay-client.js';
const $=id=>document.getElementById(id),query=new URLSearchParams(location.search);
const id=/^[\w-]{11}$/.test(query.get('video')||'')?query.get('video'):'BgjpOorIXoI';
const offset=Math.max(0,Number(query.get('offset'))||0);let player,snapshot,demo=false,sharedStream=null;const overlay=createOverlay($('overlay-layer'),{preview:true});
$('obs-url').textContent=location.origin+'/overlay';
function status(){if(demo){$('overlay-status').textContent='TESTE VISUAL · não é uma checagem';$('overlay-detail').textContent='Cartão de demonstração sobre o player. Ele não usa IA nem é enviado ao overlay do OBS.';return;}
  const s=snapshot,latest=s?.cards?.filter(c=>c.status==='published').sort((a,b)=>b.publishedAt-a.publishedAt)[0];
  const mismatch=s?.source?.id&&s.source.id!==id;
  $('overlay-layer').hidden=!!mismatch;
  $('overlay-status').textContent=mismatch?'O motor está checando outro vídeo':latest?'Modo real · última checagem publicada':'Modo real · aguardando checagens';
  $('overlay-detail').textContent=mismatch?'Volte ao painel e abra esta página a partir da URL em análise.':latest?'Nesta prévia o último cartão permanece visível. No OBS ele aparece por 30 segundos.':'Inicie a checagem no painel ou use “Testar overlay visual” para conferir a camada sem consumir IA.';
}
$('demo').onclick=()=>{demo=true;$('overlay-layer').hidden=false;overlay.setDemo(true);$('demo').classList.add('demo-active');status();};
$('real').onclick=()=>{demo=false;overlay.setDemo(false);$('demo').classList.remove('demo-active');status();};
$('fullscreen').onclick=async()=>{try{await $('stage').requestFullscreen();}catch{$('player-status').textContent='O navegador bloqueou a tela cheia. Abra esta página em uma janela do navegador e tente novamente.';}};
$('exit-fullscreen').onclick=()=>document.exitFullscreen();
window.onYouTubeIframeAPIReady=()=>{player=new YT.Player('video',{videoId:id,playerVars:{origin:location.origin,playsinline:1,rel:0,start:Math.floor(offset)},events:{onReady(){const t=snapshot?.source?.id===id&&['running','draining'].includes(snapshot.status)?snapshot.offset+snapshot.metrics.audioSeconds:offset;player.seekTo(t,true);$('player-status').textContent='Player carregado. Use os controles do vídeo para reproduzir.';},onError(e){$('player-status').textContent=`O YouTube não permitiu reproduzir este vídeo incorporado (código ${e.data}). O overlay pode ser testado aqui; para usar o vídeo original na live, capture a janela dele no OBS.`;}}});};
const script=document.createElement('script');script.src='https://www.youtube.com/iframe_api';document.head.append(script);
const events=new EventSource('/api/events');events.onmessage=e=>{const v=JSON.parse(e.data);if(v.type==='snapshot'){snapshot=v.state;overlay.render(snapshot);status();}};
events.onerror=()=>{if(!demo){overlay.hide();$('overlay-status').textContent='Reconectando ao motor…';$('overlay-detail').textContent='A prévia será atualizada quando a conexão voltar.';}};

function stopSharing(){const stream=sharedStream;sharedStream=null;for(const track of stream?.getTracks()||[])track.stop();$('tab-video').srcObject=null;$('tab-video').hidden=true;document.getElementById('video').hidden=false;$('share-tab').hidden=false;$('stop-share').hidden=true;}
$('share-tab').onclick=async()=>{if(!navigator.mediaDevices?.getDisplayMedia){$('player-status').textContent='Este navegador não oferece compartilhamento de aba. Abra esta página no Chrome ou Edge para selecionar a aba do YouTube.';return;}try{const stream=await navigator.mediaDevices.getDisplayMedia({video:{displaySurface:'browser'},audio:false});stopSharing();sharedStream=stream;$('tab-video').srcObject=stream;$('tab-video').hidden=false;document.getElementById('video').hidden=true;$('share-tab').hidden=true;$('stop-share').hidden=false;await $('tab-video').play();for(const track of stream.getVideoTracks())track.addEventListener('ended',()=>{if(sharedStream===stream){stopSharing();$('player-status').textContent='Compartilhamento encerrado.';}});$('player-status').textContent='Aba compartilhada localmente. Reproduza o vídeo na aba original; o som continua nela. Use Tela cheia com overlay para ampliar.';}catch{stopSharing();$('player-status').textContent='O compartilhamento não foi iniciado. Se desejar, tente novamente e escolha somente a aba do vídeo.';}};
$('stop-share').onclick=stopSharing;window.addEventListener('pagehide',stopSharing);
