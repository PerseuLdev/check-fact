import { serviceError } from './chatgpt-auth.mjs';

export function chatgptBody(body,model){
  // SIWC is a distinct Responses contract. Never forward gateway-only fields.
  const allowed=['instructions','text','tools','tool_choice','include','reasoning'];
  const out={model,store:false,stream:true,input:Array.isArray(body.input)?body.input:[{role:'user',content:body.input}]};
  for(const k of allowed)if(body[k]!==undefined)out[k]=body[k];return out;
}
export async function completedResponse(response,{signal}={}){
  if(!response.body)throw new Error('O ChatGPT não abriu um fluxo de resposta.');
  const reader=response.body.getReader(),decoder=new TextDecoder(),items=new Map(),texts=new Map();let pending='',completed=null,bytes=0;
  try{
    while(true){
      if(signal?.aborted)throw new DOMException('Cancelado','AbortError');
      const {value,done}=await reader.read();if(done)break;
      bytes+=value.length;if(bytes>12*1024*1024)throw new Error('A resposta excedeu o limite de processamento local.');
      pending+=decoder.decode(value,{stream:true});
      let boundary;
      while((boundary=/\r?\n\r?\n/.exec(pending))){
        const frame=pending.slice(0,boundary.index);pending=pending.slice(boundary.index+boundary[0].length);
        const data=frame.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
        if(!data||data==='[DONE]')continue;
        let event;try{event=JSON.parse(data);}catch{throw new Error('O fluxo do ChatGPT retornou um evento inválido.');}
        if(event.type==='response.failed')throw serviceError(400,{error:event.response?.error||{code:'response_failed'}},response.headers.get('x-request-id'));
        if(event.type==='error')throw serviceError(400,{error:event.error||event},response.headers.get('x-request-id'));
        if(event.type==='response.incomplete')throw new Error('O ChatGPT encerrou a resposta antes de concluí-la. Nenhum veredito foi publicado.');
        if(event.type==='response.output_item.done'&&event.item)items.set(event.output_index??items.size,event.item);
        if(['response.output_text.delta','response.output_text.done'].includes(event.type)){
          const key=(event.output_index??0)+':'+(event.content_index??0);
          texts.set(key,event.type==='response.output_text.done'?event.text:(texts.get(key)||'')+(event.delta||''));
        }
        if(event.type==='response.completed'){
          if(event.response?.status!=='completed')throw new Error('O ChatGPT não confirmou a conclusão da resposta.');
          completed={...event.response};
          // SIWC may finish with output:[]; completed streamed items carry the result.
          if(!completed.output?.length)completed.output=[...items.entries()].sort((a,b)=>a[0]-b[0]).map(([,item])=>item);
          const hasText=completed.output.some(o=>o.type==='message'&&o.content?.some(c=>c.type==='output_text'&&c.text));
          if(!hasText&&texts.size)completed.output.push({type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:[...texts.values()].join('')}]});
          return completed;
        }
      }
    }
    if(!completed)throw new Error('A conexão terminou sem a confirmação de conclusão do ChatGPT. Nenhum veredito foi publicado.');return completed;
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
