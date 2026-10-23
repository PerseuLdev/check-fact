(() => {
  let host=null,card=null,expires=0,dismissed='';
  const names={correta:'Correta',correta_com_ressalvas:'Correta com ressalvas',parcialmente_correta:'Parcialmente correta',falsa:'Falsa',evidencias_insuficientes:'Evidências insuficientes',inconclusiva:'Inconclusiva',resposta_contextual:'Resposta com contexto',informacao_contextual:'Informação de contexto'};
  const colors={correta:'#8de0a1',resposta_contextual:'#8de0a1',informacao_contextual:'#79c8e8',correta_com_ressalvas:'#f2c66d',parcialmente_correta:'#f2c66d',falsa:'#ff8585',evidencias_insuficientes:'#c0a2ff',inconclusiva:'#c0a2ff'};
  function video(){const u=new URL(location.href),id=u.searchParams.get('v')||u.pathname.match(/^\/(?:shorts|live)\/([\w-]{11})/)?.[1],v=document.querySelector('video');return /^[\w-]{11}$/.test(id||'')&&v?{id,url:'https://www.youtube.com/watch?v='+id,offset:Number.isFinite(v.currentTime)?v.currentTime:0,title:document.title.replace(/ - YouTube$/,'')}:null;}
  function hide(){host?.remove();host=null;card=null;}
  function show(c){
    if(!c||c.status!=='published'){hide();return;}
    const key=c.id+':'+c.revision;if(key===dismissed)return;
    const player=document.querySelector('#movie_player');if(!player)return;
    if(!host){host=document.createElement('div');host.style.cssText='position:absolute;inset:0;pointer-events:none;z-index:60';const shadow=host.attachShadow({mode:'closed'}),style=document.createElement('style');style.textContent='article{--status:#b6f38b;position:absolute;bottom:12%;left:4%;width:80%;max-width:760px;max-height:55%;overflow:auto;pointer-events:auto;box-sizing:border-box;background:rgba(12,20,22,.96);border:1px solid #405348;border-left:5px solid var(--status);border-radius:10px;padding:16px 20px;color:#eef3ee;font:14px/1.5 system-ui;box-shadow:0 8px 30px #0005}strong{color:var(--status);text-transform:uppercase;font-size:11px;letter-spacing:1px}p{margin:8px 0}small{color:#aabbb0;font-size:10px}a{display:block;color:#b6f38b;font-size:11px;overflow-wrap:anywhere}button{float:right;color:#eef3ee;background:transparent;border:0;font-size:18px;cursor:pointer}';card=document.createElement('article');shadow.append(style,card);player.append(host);}
    card.style.setProperty('--status',colors[c.result.verdict]||'#91a4ad');card.replaceChildren();const close=document.createElement('button');close.textContent='×';close.setAttribute('aria-label','Ocultar checagem');close.onclick=()=>{dismissed=key;hide();};card.append(close);
    const add=(tag,value)=>{const e=document.createElement(tag);e.textContent=value;card.append(e);};add('strong','Verifica · '+(names[c.result.verdict]||c.result.verdict));add('p','“'+c.quote+'”');if(c.videoTitle)add('small',c.videoChannel?`${c.videoTitle} · ${c.videoChannel}`:c.videoTitle);add('p',c.result.explanation);
    for(const source of (c.result.evidence||[]).slice(0,2)){try{const url=new URL(source.url);if(!['https:','http:'].includes(url.protocol))continue;const a=document.createElement('a');a.href=url.href;a.textContent=(source.title||url.hostname)+' ↗';a.target='_blank';a.rel='noopener noreferrer';card.append(a);}catch{}}
    add('small','CHECAGEM AUTOMÁTICA · pode ser corrigida com novo contexto');expires=Math.min(Date.now()+6000,c.publishedAt+30000);
  }
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{if(sender.id!==chrome.runtime.id)return;if(message.type==='verifica-video')respond(video());if(message.type==='verifica-overlay'){show(message.card);respond({ok:true});}});
  document.addEventListener('yt-navigate-start',hide);setInterval(()=>{if(host&&Date.now()>expires)hide();},1000);
})();
