const names={correta:'Correta',correta_com_ressalvas:'Correta com ressalvas',parcialmente_correta:'Parcialmente correta',falsa:'Falsa',evidencias_insuficientes:'Evidências insuficientes',inconclusiva:'Inconclusiva',resposta_contextual:'Resposta com contexto',informacao_contextual:'Informação de contexto',demo:'Teste visual · sem avaliação factual'};
export function createOverlay(root,{preview=false}={}){
  root.innerHTML='<article class="overlay-card" hidden><div class="overlay-head"><span data-role="verdict"></span><span>verifica.</span></div><p data-role="quote"></p><p data-role="explanation"></p><div data-role="sources"></div><p data-role="label"></p></article>';
  const card=root.querySelector('article'),part=role=>root.querySelector(`[data-role="${role}"]`);let current='',timer,demo=false,lastState;
  function show(c){
    if(!c||c.status!=='published'){card.hidden=true;current='';return;}
    const token=c.id+':'+c.revision;if(token===current)return;current=token;card.dataset.verdict=c.result.verdict;
    part('verdict').textContent=names[c.result.verdict]||c.result.verdict;part('quote').textContent='“'+c.quote+'”';part('explanation').textContent=c.result.explanation;
    part('sources').replaceChildren();for(const e of (c.result.evidence||[]).slice(0,2)){let url;try{url=new URL(e.url);if(url.protocol!=='https:'||url.username||url.password)continue;}catch{continue;}const a=document.createElement('a');a.href=url.href;a.textContent=e.title+' · '+url.hostname;a.target='_blank';a.rel='noopener noreferrer';part('sources').append(a,document.createElement('br'));}
    part('label').textContent=demo?'DEMONSTRAÇÃO LOCAL · SEM IA · NÃO ENVIADA AO OBS':(preview?'PRÉVIA DA ÚLTIMA CHECAGEM · ':'')+'CHECAGEM AUTOMÁTICA'+(c.revision?' · ATUALIZADA COM NOVO CONTEXTO':'')+' · '+c.latency+'s após o bloco da fala';
    card.hidden=false;clearTimeout(timer);if(!preview&&!demo)timer=setTimeout(()=>card.hidden=true,30000);
  }
  function render(s){lastState=s;if(demo)return;if(!s?.sessionId||s.probe){show(null);return;}
    const latest=s.cards.filter(c=>c.status==='published').sort((a,b)=>b.publishedAt-a.publishedAt)[0];if(!latest||(!preview&&Date.now()-latest.publishedAt>30000)){show(null);return;}show(latest);
  }
  function setDemo(value){demo=value;current='';clearTimeout(timer);if(demo)show({id:'visual-demo',revision:0,status:'published',quote:'É aqui que as checagens aparecem sobre o vídeo.',result:{verdict:'demo',explanation:'Este cartão testa somente a posição e a transparência do overlay. Não é uma avaliação de nenhuma fala do vídeo.',evidence:[]}});else render(lastState);}
  return{render,setDemo,hide(){clearTimeout(timer);show(null);}};
}
