const $=id=>document.getElementById(id);
const effortLabels={default:'Padrão do modelo',none:'Sem raciocínio · none',minimal:'Mínimo · minimal',low:'Baixo · low',medium:'Médio · medium',high:'Alto · high',xhigh:'Muito alto · xhigh',max:'Máximo · max'};
function renderEffort(id,selected,options=[],disabled=false,model=''){
  const select=$(id),html=['default',...options].map(v=>`<option value="${esc(v)}">${esc(effortLabels[v]||v)}</option>`).join('');
  if(select.innerHTML!==html)select.innerHTML=html;
  select.value=selected||'default';select.disabled=disabled||!options.length;
  $(id+'-help').textContent=(model?model+' · ':'')+(options.length?'Níveis maiores podem aumentar o tempo e o consumo. Padrão usa a configuração do modelo.':'Este modelo não tem ajuste de effort confirmado nesta integração. Será usado o padrão.');
}
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clock=n=>`${Math.floor(n/60).toString().padStart(2,'0')}:${Math.floor(n%60).toString().padStart(2,'0')}`;
const names={correta:'Correta',correta_com_ressalvas:'Correta com ressalvas',parcialmente_correta:'Parcialmente correta',falsa:'Falsa',evidencias_insuficientes:'Evidências insuficientes',inconclusiva:'Inconclusiva',resposta_contextual:'Resposta com contexto',informacao_contextual:'Informação de contexto',queued:'Na fila',checking:'Em pesquisa',rechecking:'Reavaliando contexto',failed:'Pesquisa interrompida',cancelled:'Cancelada'};
let state,source,player,ytReady=false,lastCards='',lastSegments='',authState=null,loginPoll=null,authPopup=null,authRequest=null,modelItems=[],lastLoginMessage='',loginInProgress=false;
let geminiState=null,geminiModels=[],geminiRequest=null,geminiPoll=null,geminiPopup=null,geminiLogin=false;
const empty=$('cards').innerHTML;
async function api(path,body){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw new Error(d.error||'Falha na conexão.');return d;}
function notice(text,error=false){$('notice').textContent=text;$('notice').classList.toggle('error',error);}
function cardHtml(c){const r=c.result,shown=c.status==='published',v=shown?r.verdict:c.status;return `<article class="fact-card ${esc(shown?r.verdict:'')}"><div class="card-top"><span class="verdict">${esc(names[v]||v)}</span><span class="time">${clock(c.start)} — ${clock(c.end)}</span></div>${c.kind==='reported_speech'?'<p class="item-kind">Declaração · pesquisa de contexto</p>':''}${c.kind==='question'?'<p class="item-kind">Pergunta factual</p>':c.kind==='question_premise'?'<p class="item-kind">Premissa de uma pergunta</p>':''}${c.revision?`<p class="revision">Atualização ${c.revision} · ${esc(c.correctionReason)}</p>`:''}<p class="quote">“${esc(c.quote)}”</p><p class="explanation">${esc(shown?r.explanation:c.error||'Aguardando evidências e contexto suficientes para concluir.')}</p>${shown?`<div class="tag-row">${r.tags.map(t=>`<span class="tag">${esc(t.replaceAll('_',' '))}</span>`).join('')}</div><p class="muted">${esc(r.context)}</p><div class="evidence">${r.evidence.map(e=>`<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.title||new URL(e.url).hostname)} ↗</a><p>${esc(e.finding)}</p>`).join('')||'<p>Nenhuma fonte suficiente para uma conclusão.</p>'}</div>`:''}<details><summary>Ver afirmação interpretada e contexto utilizado</summary><p>${esc(c.claim)}</p>${(c.interpretations||[]).map(i=>`<p>Hipótese de transcrição: “${esc(i.heard)}” pode ser “${esc(i.possible)}”. ${esc(i.reason)}</p>`).join('')}${c.context.map(s=>`<p><span class="time">${clock(s.start)}</span> ${esc(s.text)}</p>`).join('')}</details><div class="card-bottom"><span>Checagem automática · voz não identificada</span><span>${shown?`${c.latency}s após o bloco da fala`:'Sem veredito publicado'}</span></div></article>`;}
function render(s){state=s;const busy=['running','connecting','preparing','draining'].includes(s.status);$('connection').textContent='Painel conectado';$('connection').className='pill active';$('start').disabled=busy||!s.aiConfigured||!!authState?.pending||!!geminiState?.pending;$('probe').disabled=busy;$('connect').disabled=busy;$('stop').hidden=!busy;$('configure').disabled=busy;$('url').disabled=busy;$('offset').disabled=busy;$('reference-date').disabled=busy;$('context-hint').disabled=busy;
  $('engine-status').textContent=({idle:'Aguardando',connecting:'Conectando',preparing:'Preparando',running:s.probe?'Teste de áudio':s.transcribeOnly?'Transcrevendo':'Em execução',draining:'Finalizando',completed:'Concluído',stopped:'Encerrado',error:'Erro'})[s.status]||s.status;$('engine-status').className='pill'+(busy?' active':s.status==='error'?' error':'');
  $('engine-message').textContent=s.message;$('audio-seconds').textContent=clock(s.metrics.audioSeconds);$('latency').textContent=s.metrics.lastLatency===null?'—':s.metrics.lastLatency+'s';$('claims').textContent=s.metrics.detected;$('queue').textContent=s.metrics.checkQueue+s.metrics.checking;$('published-count').textContent=s.metrics.published;$('context-state').textContent=s.contextState;
  const ckey=JSON.stringify(s.cards);if(ckey!==lastCards){$('cards').innerHTML=s.cards.length?[...s.cards].reverse().map(cardHtml).join(''):empty;lastCards=ckey;}
  const skey=JSON.stringify(s.segments);if(skey!==lastSegments){$('transcript').innerHTML=s.segments.length?[...s.segments].reverse().map(t=>`<div class="transcript-item"><span class="time">${clock(t.start)} — ${clock(t.end)}</span>${esc(t.text)}</div>`).join(''):'<p class="muted">Os trechos aparecem conforme o áudio chega.</p>';lastSegments=skey;}
  if(s.source){source=s.source;$('source-info').textContent=`${source.title} · ${source.channel||'YouTube'} · ${source.isLive?'AO VIVO':clock(source.duration||0)}`;}
  $('decisions').replaceChildren();for(const d of [...(s.decisions||[])].reverse().slice(0,6)){const p=document.createElement('p');p.className='decision-item';p.textContent=({ready:'Itens encaminhados',wait:'Aguardando continuação',none:'Sem novo item verificável',need_past:'Contexto insuficiente'})[d.state]+': '+(d.reason||'');$('decisions').append(p);}
  const asr=s.localAsr;
  $('prepare-asr').disabled=busy||asr?.status==='loading';$('test-asr').disabled=busy||asr?.status==='loading';
  $('asr-status').textContent=asr?.status==='ready'?`Transcrição pronta · ${asr.model} · CPU${asr.lastProcessingSeconds!==null?' · último bloco processado em '+asr.lastProcessingSeconds+' s':''}. O áudio permanece neste computador nos modos ChatGPT e Gemini.`:asr?.status==='loading'?'Carregando o modelo local. Na primeira execução, os arquivos podem precisar ser baixados.':asr?.error||'O modelo é carregado antes de abrir o áudio. Nenhum áudio é enviado à API nos modos ChatGPT e Gemini.';
  if(s.status==='error')notice(s.message,true);else if(s.transcribeOnly&&s.status==='completed')notice('Transcrição local concluída. Os trechos são automáticos e não foram revisados; nenhuma checagem factual foi executada.');else if(!s.aiConfigured)notice('Conecte um provedor e escolha um modelo para checar. Os testes de áudio e transcrição local funcionam sem login.');else notice(s.provider==='gemini'?`Gemini · ${s.selectedModel}. Usa a conexão Google selecionada. O áudio é transcrito localmente.`:s.provider==='chatgpt'?`ChatGPT · ${s.selectedModel}. A análise usará os limites do seu plano; o áudio será transcrito localmente.`:'Gateway selecionado explicitamente. As chamadas podem consumir créditos dessa conta.');
  for(const role of ['detector','checker']){const g=s.gatewayEfforts?.[role];if(g)renderEffort(role+'-effort',g.effort,g.options,busy,g.model);}
  $('save-gateway-effort').disabled=busy;
  renderAuth();renderGemini();
}
const stream=new EventSource('/api/events');stream.onmessage=e=>{const event=JSON.parse(e.data);if(event.type==='snapshot')render(event.state);if(event.type==='auth_changed')void loadAuth(true);if(event.type==='gemini_changed')void loadGemini(true);if(event.type==='audio_started'&&player&&!state?.probe){if(!event.isLive)player.seekTo(event.offset,true);player.playVideo();}};stream.onerror=()=>{$('connection').textContent='Reconectando…';$('connection').className='pill';};
$('source-form').onsubmit=async e=>{e.preventDefault();$('connect').disabled=true;notice('Consultando a URL…');try{const d=await api('/api/connect',{url:$('url').value});source=d.source;$('source-info').textContent=`${source.title} · ${source.channel} · ${source.isLive?'AO VIVO':clock(source.duration||0)}`;loadPlayer(source.id);notice('URL conectada. Você pode testar o áudio ou iniciar a checagem.');}catch(err){notice(err.message,true);}finally{$('connect').disabled=false;}};
async function start(probe,transcribeOnly=false,duration=0){try{const body={url:$('url').value,offset:Number($('offset').value),referenceDate:$('reference-date').value,contextHint:$('context-hint').value,probe,transcribeOnly,duration};$('start').disabled=true;$('probe').disabled=true;await api('/api/start',body);}catch(err){notice(err.message,true);$('start').disabled=!state?.aiConfigured;$('probe').disabled=false;}}
$('start').onclick=()=>start(false);$('probe').onclick=()=>start(true);$('stop').onclick=async()=>{try{await api('/api/stop',{});player?.pauseVideo();}catch(err){notice(err.message,true);}};
$('configure').onclick=()=>{$('settings').showModal();void loadAuth(true);void loadGemini(true);};$('close-settings').onclick=()=>$('settings').close();$('settings-form').onsubmit=async e=>{e.preventDefault();try{await api('/api/config',{key:$('api-key').value});$('api-key').value='';$('settings-error').textContent='';$('settings').close();}catch(err){$('settings-error').textContent=err.message;}};
function renderAuth(){
  if(!authState)return;const a=authState,busy=['running','connecting','preparing','draining'].includes(state?.status),active=a.profiles.find(p=>p.id===a.activeId);
  $('account-picker').hidden=!a.profiles.length;const options=a.profiles.map(p=>`<option value="${esc(p.id)}">${esc(p.label)}${p.email?' · '+esc(p.email):''}</option>`).join('');if($('chatgpt-profile').innerHTML!==options)$('chatgpt-profile').innerHTML=options;$('chatgpt-profile').value=a.activeId||'';$('chatgpt-profile').disabled=busy||a.pending||!!geminiState?.pending;
  $('start').disabled=busy||!state?.aiConfigured||a.pending||!!geminiState?.pending;
  $('test-check').disabled=busy||!state?.aiConfigured||a.pending||!!geminiState?.pending;
  if(a.loginMessage!==lastLoginMessage){if(a.loginError)$('settings-error').textContent=a.loginMessage;else if(a.connected)$('settings-error').textContent='';lastLoginMessage=a.loginMessage;}
  $('auth-status').textContent=a.error||(a.pending?'Conclua o login e a autorização na janela do ChatGPT.':a.connected?(a.planEnabled?`${active?.label||'Conta conectada'}${active?.email?' · '+active.email:''}. Uso do plano autorizado.`:'Conta identificada. Autorize o uso do plano para realizar a análise.'):a.loginMessage||'Nenhuma conta conectada.');
  $('chatgpt-login').hidden=a.connected&&a.planEnabled&&state?.provider==='chatgpt';$('chatgpt-login').disabled=busy||a.pending||!!geminiState?.pending;
  $('chatgpt-login').textContent=a.connected&&a.planEnabled?'Usar esta conta':a.connected?'Autorizar uso do plano':active?'Reconectar com ChatGPT':'Continuar com ChatGPT';
  $('chatgpt-add').hidden=!a.profiles.length;$('chatgpt-add').disabled=busy||a.pending||!!geminiState?.pending;$('chatgpt-disconnect').hidden=!a.connected;$('chatgpt-disconnect').disabled=busy||a.pending||!!geminiState?.pending;$('chatgpt-cancel').hidden=!a.pending;
  $('chatgpt-open-login').hidden=!a.pending||!$('chatgpt-open-login').getAttribute('href');
  $('model-settings').hidden=!a.planEnabled;$('chatgpt-model').disabled=busy||a.pending||!!geminiState?.pending;$('refresh-models').disabled=busy||a.pending||!!geminiState?.pending;$('test-model').disabled=busy||a.pending||!!geminiState?.pending||!a.selectedModel;
  const modelOptions='<option value="">Selecione um modelo disponível</option>'+modelItems.map(m=>`<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');if($('chatgpt-model').innerHTML!==modelOptions)$('chatgpt-model').innerHTML=modelOptions;$('chatgpt-model').value=a.selectedModel||'';
  renderEffort('chatgpt-effort',a.selectedEffort,a.effortOptions,busy||a.pending||!!geminiState?.pending||!a.selectedModel);
  $('model-status').textContent=a.verifiedModel&&a.verifiedModel===a.selectedModel&&a.verifiedEffort===a.selectedEffort?'Modelo e effort confirmados por uma resposta concluída.':'Modelo e effort ainda não testados nesta conexão.';
}
async function loadAuth(withModels=false){
  if(authRequest){await authRequest;if(withModels&&!modelItems.length)return loadAuth(true);return authState;}
  authRequest=(async()=>{try{const r=await fetch('/api/auth/state',{cache:'no-store'});if(!r.ok)throw new Error('Não foi possível consultar a conexão.');authState=await r.json();renderAuth();
    if(loginInProgress&&!authState.pending){
      loginInProgress=false;
      if(authState.connected&&authState.planEnabled&&!authState.loginError){
        try{authPopup?.close();}catch{}authPopup=null;
        $('settings').close();$('settings-error').textContent='';
      }
    }
    if(withModels&&authState.planEnabled){const response=await fetch('/api/auth/models',{cache:'no-store'}),data=await response.json();if(!response.ok)throw new Error(data.error);modelItems=data.models;authState=data.auth;renderAuth();$('model-error').textContent='';}
    if(!authState.pending&&loginPoll){clearInterval(loginPoll);loginPoll=null;}return authState;
  }catch(e){$('settings-error').textContent=e.message;}finally{authRequest=null;}})();return authRequest;
}
async function login(fresh=false){
  $('settings-error').textContent='';
  if(!fresh&&authState?.connected&&authState.planEnabled){try{await api('/api/auth/use',{});$('settings').close();await loadAuth(true);}catch(e){$('settings-error').textContent=e.message;}return;}
  $('chatgpt-open-login').removeAttribute('href');$('chatgpt-open-login').hidden=true;
  authPopup=window.open('about:blank','_blank','popup,width=680,height=800');if(authPopup)authPopup.opener=null;
  try{const d=await api('/api/auth/begin',{profileId:fresh?null:authState?.activeId,reauthorize:!fresh&&authState?.connected&&!authState?.planEnabled});
    const authorize=new URL(d.authorizeUrl);if(authorize.origin!=='https://auth.openai.com')throw new Error('Endereço de autorização inesperado.');
    $('chatgpt-open-login').href=authorize.href;$('chatgpt-open-login').hidden=false;
    try{if(authPopup)authPopup.location.href=authorize.href;}catch{$('settings-error').textContent='Use o link de autorização acima para continuar.';}
    loginInProgress=true;await loadAuth();clearInterval(loginPoll);loginPoll=authState?.pending?setInterval(()=>void loadAuth(true),1800):null;
  }catch(e){loginInProgress=false;authPopup?.close();$('settings-error').textContent=e.message;}
}
$('chatgpt-login').onclick=()=>login(false);$('chatgpt-add').onclick=()=>login(true);
$('chatgpt-cancel').onclick=async()=>{try{await api('/api/auth/cancel',{});loginInProgress=false;authPopup?.close();await loadAuth();}catch(e){$('settings-error').textContent=e.message;}};
$('chatgpt-profile').onchange=async()=>{try{await api('/api/auth/profile',{id:$('chatgpt-profile').value});modelItems=[];await loadAuth(true);}catch(e){$('settings-error').textContent=e.message;}};
$('chatgpt-model').onchange=async()=>{if(!$('chatgpt-model').value)return;try{await api('/api/auth/model',{model:$('chatgpt-model').value});await loadAuth();}catch(e){$('model-error').textContent=e.message;}};
$('chatgpt-effort').onchange=async()=>{const effort=$('chatgpt-effort').value;$('chatgpt-effort').disabled=true;try{const d=await api('/api/auth/effort',{effort});authState=d.auth;$('model-error').textContent='';}catch(e){$('model-error').textContent=e.message;}finally{renderAuth();}};
$('gateway-effort-form').onsubmit=async e=>{e.preventDefault();$('save-gateway-effort').disabled=true;try{await api('/api/config/effort',{detector:$('detector-effort').value,checker:$('checker-effort').value});$('gateway-effort-status').textContent='Effort salvo para as próximas chamadas do Gateway.';$('settings-error').textContent='';}catch(e){$('settings-error').textContent=e.message;}finally{$('save-gateway-effort').disabled=['running','connecting','preparing','draining'].includes(state?.status);}};
$('refresh-models').onclick=async()=>{try{const r=await fetch('/api/auth/models?refresh=1',{cache:'no-store'}),d=await r.json();if(!r.ok)throw new Error(d.error);modelItems=d.models;authState=d.auth;renderAuth();$('model-error').textContent='';}catch(e){$('model-error').textContent=e.message;}};
$('test-model').onclick=async()=>{$('test-model').disabled=true;$('model-status').textContent='Aguardando uma resposta concluída…';try{const d=await api('/api/auth/test',{});$('model-status').textContent='Acesso confirmado: '+d.model;await loadAuth();}catch(e){$('model-error').textContent=e.message;}finally{$('test-model').disabled=false;}};
$('chatgpt-disconnect').onclick=async()=>{try{const d=await api('/api/auth/disconnect',{});modelItems=[];await loadAuth();$('settings-error').textContent=d.revoked?'':d.message;}catch(e){$('settings-error').textContent=e.message;}};
$('prepare-asr').onclick=async()=>{$('prepare-asr').disabled=true;try{await api('/api/asr/prepare',{});}catch(e){$('settings-error').textContent=e.message;}finally{$('prepare-asr').disabled=false;}};
$('test-asr').onclick=()=>{$('settings').close();void start(false,true);};
$('test-check').onclick=()=>{$('settings').close();void start(false,false,30);};
void loadAuth();
if(new URLSearchParams(location.search).get('settings')==='chatgpt'){ $('settings').showModal(); void loadAuth(true); }
$('copy-overlay').onclick=async()=>{try{await navigator.clipboard.writeText(location.origin+'/overlay');notice('URL do overlay copiada. No OBS, adicione uma fonte de navegador de 1920 × 1080.');}catch{notice('URL do overlay: '+location.origin+'/overlay');}};
window.onYouTubeIframeAPIReady=()=>{ytReady=true;if(source)loadPlayer(source.id);};
function loadPlayer(id){$('player-box').hidden=false;if(!ytReady)return;if(player){player.cueVideoById({videoId:id,startSeconds:Number($('offset').value)});return;}player=new YT.Player('player',{videoId:id,playerVars:{origin:location.origin,playsinline:1,rel:0,start:Number($('offset').value)}});}
const script=document.createElement('script');script.src='https://www.youtube.com/iframe_api';document.head.append(script);

$('watch-link').onclick=e=>{try{const u=new URL($('url').value);const id=u.hostname==='youtu.be'?u.pathname.split('/')[1]:['youtube.com','www.youtube.com','m.youtube.com'].includes(u.hostname)?u.searchParams.get('v')||u.pathname.split('/').at(-1):null;if(!/^[\w-]{11}$/.test(id||''))throw new Error();$('watch-link').href='/assistir?'+new URLSearchParams({video:id,offset:$('offset').value});}catch{e.preventDefault();notice('Informe uma URL válida do YouTube para abrir o vídeo com overlay.',true);}};

function renderGemini(){
  if(!geminiState)return;const g=geminiState,busy=['running','connecting','preparing','draining'].includes(state?.status),pending=g.pending||!!authState?.pending;
  const local=g.connectionMode==='local';
  $('gemini-status').textContent=g.error||(g.pending?(g.message||'Conclua a autorização na janela do Google.'):g.connected?(local?'Google conectado. Gemini pronto para usar.':`API Google conectada · projeto ${g.projectId}. Usa as cotas da API.`):local?(g.message||'Clique em Conectar Gemini para entrar com sua conta Google.'):(g.message||'Configure o cliente Google Cloud na opção avançada.'));
  $('gemini-login').textContent=g.unavailable?'Conexão em atualização':g.pending?'Conectando…':local?'Conectar Gemini':'Conectar à API Google';
  $('gemini-local').hidden=local;$('gemini-local').disabled=busy||pending;
  if(local){if(g.authorizeUrl)$('gemini-open-login').href=g.authorizeUrl;else $('gemini-open-login').removeAttribute('href');}
  $('gemini-import').disabled=busy||pending||g.connected;$('gemini-credentials').disabled=busy||pending||g.connected;
  $('gemini-login').hidden=g.connected;$('gemini-login').disabled=busy||pending||!g.configured;
  $('gemini-cancel').hidden=!g.pending;$('gemini-disconnect').hidden=!g.connected;$('gemini-disconnect').disabled=busy||pending;
  $('gemini-open-login').hidden=!g.pending||!$('gemini-open-login').getAttribute('href');
  $('gemini-model-settings').hidden=!g.connected;
  const options='<option value="">Selecione um modelo disponível</option>'+geminiModels.map(m=>`<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');if($('gemini-model').innerHTML!==options)$('gemini-model').innerHTML=options;$('gemini-model').value=g.selectedModel||'';
  $('gemini-model').disabled=busy||pending;$('gemini-refresh').disabled=busy||pending;
  $('gemini-test').disabled=busy||pending||!g.selectedModel;$('gemini-use').disabled=busy||pending||!g.selectedModel;
  $('gemini-use').textContent=state?.provider==='gemini'?'Gemini selecionado':'Usar Gemini na checagem';
  renderEffort('gemini-effort',g.selectedEffort,g.effortOptions,busy||pending||!g.selectedModel);
  $('gemini-model-status').textContent=g.verifiedModel===g.selectedModel&&g.verifiedModel&&g.verifiedEffort===g.selectedEffort?'Modelo e effort confirmados por uma resposta concluída. Pesquisa web depende do modelo e da conta.':'Modelo e effort ainda não testados nesta conexão.';
  $('start').disabled=busy||!state?.aiConfigured||pending;$('test-check').disabled=busy||!state?.aiConfigured||pending;
}
async function loadGemini(withModels=false){
  if(geminiRequest)return geminiRequest;
  geminiRequest=(async()=>{try{const r=await fetch('/api/gemini/state',{cache:'no-store'});if(!r.ok)throw new Error('Não foi possível consultar o Google.');geminiState=await r.json();renderGemini();
    if(withModels&&geminiState.connected){const r=await fetch('/api/gemini/models',{cache:'no-store'}),d=await r.json();if(!r.ok)throw new Error(d.error);geminiModels=d.models;geminiState=d.auth;renderGemini();}
    if(geminiLogin&&!geminiState.pending){geminiLogin=false;try{geminiPopup?.close();}catch{}geminiPopup=null;if(geminiState.connected&&geminiState.selectedModel){await api('/api/gemini/use',{});$('settings').close();}}
    if(!geminiState.pending&&geminiPoll){clearInterval(geminiPoll);geminiPoll=null;}
  }catch(e){$('gemini-error').textContent=e.message;}finally{geminiRequest=null;}})();return geminiRequest;
}
$('gemini-import').onclick=async()=>{try{const file=$('gemini-credentials').files[0];if(!file||file.size>12000)throw new Error('Selecione o JSON original do cliente OAuth Desktop (até 12 KB).');const credentials=JSON.parse(await file.text());geminiState=await api('/api/gemini/config',{credentials});$('gemini-credentials').value='';$('gemini-error').textContent='';renderGemini();}catch(e){$('gemini-error').textContent=e instanceof SyntaxError?'O arquivo selecionado não contém JSON válido.':e.message;}};
$('gemini-login').onclick=async()=>{
  $('gemini-error').textContent='';
  if(geminiState?.connectionMode!=='local'){geminiPopup=window.open('about:blank','_blank','popup,width=680,height=800');if(geminiPopup)geminiPopup.opener=null;}
  try{const d=await api('/api/gemini/begin',{});if(d.authorizeUrl){const url=new URL(d.authorizeUrl);if(url.origin!=='https://accounts.google.com')throw new Error('Endereço Google inesperado.');$('gemini-open-login').href=url.href;$('gemini-open-login').hidden=false;try{if(geminiPopup)geminiPopup.location.href=url.href;}catch{}}geminiLogin=true;await loadGemini(true);clearInterval(geminiPoll);geminiPoll=geminiState?.pending?setInterval(()=>void loadGemini(true),1800):null;
  }catch(e){geminiLogin=false;try{geminiPopup?.close();}catch{}$('gemini-error').textContent=e.message;}
};
$('gemini-local').onclick=async()=>{try{geminiState=await api('/api/gemini/local',{});await loadGemini(true);$('gemini-error').textContent='';}catch(e){$('gemini-error').textContent=e.message;}};
$('gemini-cancel').onclick=async()=>{try{await api('/api/gemini/cancel',{});geminiLogin=false;try{geminiPopup?.close();}catch{}await loadGemini();}catch(e){$('gemini-error').textContent=e.message;}};
$('gemini-model').onchange=async()=>{if(!$('gemini-model').value)return;try{await api('/api/gemini/model',{model:$('gemini-model').value});await loadGemini();$('gemini-error').textContent='';}catch(e){$('gemini-error').textContent=e.message;}};
$('gemini-effort').onchange=async()=>{const effort=$('gemini-effort').value;$('gemini-effort').disabled=true;try{geminiState=await api('/api/gemini/effort',{effort});$('gemini-error').textContent='';}catch(e){$('gemini-error').textContent=e.message;}finally{renderGemini();}};
$('gemini-refresh').onclick=async()=>{try{const r=await fetch('/api/gemini/models?refresh=1',{cache:'no-store'}),d=await r.json();if(!r.ok)throw new Error(d.error);geminiState=d.auth;geminiModels=d.models;renderGemini();$('gemini-error').textContent='';}catch(e){$('gemini-error').textContent=e.message;}};
$('gemini-test').onclick=async()=>{$('gemini-test').disabled=true;try{await api('/api/gemini/test',{});await loadGemini();$('gemini-error').textContent='';}catch(e){$('gemini-error').textContent=e.message;}finally{renderGemini();}};
$('gemini-use').onclick=async()=>{try{await api('/api/gemini/use',{});$('settings').close();}catch(e){$('gemini-error').textContent=e.message;}};
$('gemini-disconnect').onclick=async()=>{try{const d=await api('/api/gemini/disconnect',{});geminiModels=[];await loadGemini();$('gemini-error').textContent=d.revoked?'':d.message;}catch(e){$('gemini-error').textContent=e.message;}};
void loadGemini();
