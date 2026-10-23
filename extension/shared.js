export const names={correta:'Correta',correta_com_ressalvas:'Correta com ressalvas',parcialmente_correta:'Parcialmente correta',falsa:'Falsa',evidencias_insuficientes:'Evidências insuficientes',inconclusiva:'Inconclusiva',resposta_contextual:'Resposta com contexto',informacao_contextual:'Informação de contexto',queued:'Na fila',checking:'Em pesquisa',rechecking:'Reavaliando contexto',failed:'Pesquisa interrompida',cancelled:'Cancelada'};
export function videoId(url){try{const u=new URL(url);if(!['www.youtube.com','m.youtube.com','youtube.com','youtu.be'].includes(u.hostname))return null;const id=u.hostname==='youtu.be'?u.pathname.slice(1):u.searchParams.get('v')||u.pathname.match(/^\/(?:shorts|live)\/([\w-]{11})/)?.[1];return /^[\w-]{11}$/.test(id||'')?id:null;}catch{return null;}}
export function safeUrl(value){try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)?u.href:null;}catch{return null;}}
export function latestCard(state,id,now=Date.now()){
  if(!id||videoId(state?.source?.url)!==id||state?.probe)return null;
  return (state.cards||[]).filter(c=>c.status==='published'&&now-c.publishedAt<30000).sort((a,b)=>b.publishedAt-a.publishedAt)[0]||null;
}
