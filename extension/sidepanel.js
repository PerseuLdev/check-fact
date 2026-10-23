import {names,videoId,safeUrl,latestCard} from './shared.js';
const $=id=>document.getElementById(id),base='http://127.0.0.1:4310';
let token='',video=null,state=null,polling=false,starting=false,lastCards='';
const busy=()=>['running','connecting','preparing','draining'].includes(state?.status);
function note(text){$('notice').textContent=text;}
async function api(action,data){
  if(!token)throw new Error('Conecte o motor com o código de pareamento.');
  const r=await fetch(base+'/api/extension',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({action,data}),signal:AbortSignal.timeout(action==='start'?180000:action==='effort'?30000:8000)});
  const result=await r.json();if(!r.ok)throw new Error(result.error||'Falha no motor local.');return result;
}
function controls(){const active=busy(),ready=state?.provider==='chatgpt'&&state?.aiConfigured;$('connect-chatgpt').hidden=!!ready||active||starting;$('start').hidden=!ready||active;$('start').disabled=starting||!video;$('probe').disabled=starting||active||!video||!state;$('stop').hidden=!active&&!starting;$('date').disabled=active||starting;$('context').disabled=active||starting;}
async function readVideo(){
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});video=null;
  if(tab?.id){try{const result=await chrome.tabs.sendMessage(tab.id,{type:'verifica-video'});if(result?.id)video={...result,tabId:tab.id};}catch{}}
  $('video').textContent=video?`${video.title} · ${Math.floor(video.offset)} s`:'Abra um vídeo do YouTube e clique em Atualizar. Se a aba já estava aberta ao instalar, recarregue-a.';controls();
}
function text(tag,value,className){const e=document.createElement(tag);e.textContent=value??'';if(className)e.className=className;return e;}
function render(s){
  state=s;$('connection').textContent='Conectado';$('pairing').open=false;controls();note(s.provider==='chatgpt'&&s.aiConfigured?'ChatGPT conectado. Pronto para verificar.':'Conecte sua conta ChatGPT para começar.');
  const labels={default:'Padrão do modelo',none:'Sem raciocínio · none',minimal:'Mínimo · minimal',low:'Baixo · low',medium:'Médio · medium',high:'Alto · high',xhigh:'Muito alto · xhigh',max:'Máximo · max'};
  const effort=$('effort'),values=['default',...(s.effortOptions||[])];
  if([...effort.options].map(o=>o.value).join()!==values.join())effort.replaceChildren(...values.map(value=>{const o=document.createElement('option');o.value=value;o.textContent=labels[value]||value;return o;}));
  effort.value=s.selectedEffort||'default';effort.disabled=busy()||starting||s.provider!=='chatgpt'||!s.aiConfigured||!s.effortOptions?.length;
  $('effort-model').textContent=s.selectedModel?`${s.selectedModel} · Níveis maiores podem aumentar o tempo e o consumo.`:'Selecione um modelo nas configurações.';
  const matching=video&&videoId(s.source?.url)===video.id;
  if(s.source&&!matching&&busy())note('O motor está acompanhando outro vídeo. Encerre essa sessão antes de iniciar nesta aba.');
  const cards=matching?s.cards:[];const key=JSON.stringify(cards);
  $('count').textContent=cards.filter(c=>c.status==='published').length;
  if(key!==lastCards){lastCards=key;$('cards').replaceChildren();if(!cards.length)$('cards').append(text('p','Aguardando afirmações deste vídeo.','hint'));
    for(const c of [...cards].reverse()){
      const r=c.status==='published'?c.result:null,verdict=r?.verdict||c.status,el=text('article','','fact');el.dataset.verdict=verdict;el.append(text('span',names[verdict]||verdict,'verdict'));
      const title=c.videoTitle||s.source?.title,channel=c.videoChannel||s.source?.channel;if(title)el.append(text('p',channel?`${title} · ${channel}`:title,'source-meta'));
      el.append(text('p','“'+c.quote+'”','quote'),text('p',r?.explanation||c.error||'Aguardando pesquisa e contexto.','explanation'));
      for(const source of r?.evidence||[]){const url=safeUrl(source.url);if(!url)continue;const a=text('a',(source.title||new URL(url).hostname)+' ↗');a.href=url;a.target='_blank';a.rel='noopener noreferrer';el.append(a,text('p',source.finding,'hint'));}
      const detail=document.createElement('details');detail.append(text('summary','Afirmação e contexto'),text('p',c.claim));for(const seg of c.context||[])detail.append(text('p',seg.text,'hint'));el.append(detail,text('p',c.revision?'Atualizada com novo contexto · checagem automática':'Falante não identificado · esta versão analisa só o áudio, sem separar vozes.','hint'));$('cards').append(el);
    }
  }
  $('transcript').replaceChildren(...(matching?s.segments||[]:[]).slice(-15).reverse().map(seg=>text('p',seg.text,'hint')));
  if(video)void chrome.tabs.sendMessage(video.tabId,{type:'verifica-overlay',card:$('overlay').checked?latestCard(s,video.id):null}).catch(()=>{});
}
async function poll(){if(polling)return;polling=true;try{render(await api('state'));}catch(e){state=null;controls();$('connection').textContent='Motor desconectado';$('pairing').open=true;note(e instanceof TypeError?'Não foi possível acessar o servidor. Execute npm.cmd run dev na pasta do projeto.':e.message);if(video)void chrome.tabs.sendMessage(video.tabId,{type:'verifica-overlay',card:null}).catch(()=>{});}finally{polling=false;}}
$('pair-form').onsubmit=async e=>{e.preventDefault();token=$('token').value.trim();try{const s=await api('state');await chrome.storage.local.set({token});$('token').value='';render(s);}catch(e){note(e.message);}};
$('refresh').onclick=async()=>{await readVideo();await poll();};
function openSettings(){void chrome.tabs.create({url:base+'/?settings=chatgpt'});}
$('connect-chatgpt').onclick=openSettings;
$('settings-link').onclick=e=>{e.preventDefault();openSettings();};
async function start(probe){starting=true;controls();try{await readVideo();if(!video)throw new Error('Abra um vídeo do YouTube.');note('Conectando ao áudio e preparando o motor…');render(await api('start',{url:video.url,offset:Math.floor(video.offset),referenceDate:$('date').value,contextHint:$('context').value,probe}));}catch(e){note(e.message);}finally{starting=false;controls();}}
$('start').onclick=()=>start(false);$('probe').onclick=()=>start(true);
$('stop').onclick=async()=>{try{render(await api('stop'));}catch(e){note(e.message);}};
$('overlay').onchange=async()=>{await chrome.storage.local.set({overlay:$('overlay').checked});if(state)render(state);};
$('effort').onchange=async()=>{const effort=$('effort').value;$('effort').disabled=true;try{render(await api('effort',{effort}));note('Effort salvo para as próximas checagens.');}catch(e){if(state)render(state);note(e.message);}};
chrome.tabs.onActivated.addListener(()=>{void readVideo().then(poll);});
chrome.tabs.onUpdated.addListener((id,info)=>{if(info.url||info.status==='complete')void readVideo().then(poll);});
const saved=await chrome.storage.local.get(['token','overlay']);token=saved.token||'';$('overlay').checked=saved.overlay!==false;await readVideo();await poll();setInterval(poll,2000);
