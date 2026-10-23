import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { WebSessions } from './web-sessions.mjs';
import { testChatGPT } from './ai.mjs';

const assets=new Map([
  ['/', ['web.html','text/html; charset=utf-8']],['/web.js',['web.js','text/javascript; charset=utf-8']],
  ['/web.css',['web.css','text/css; charset=utf-8']],['/audio-capture.js',['audio-capture.js','text/javascript; charset=utf-8']],
  ['/pcm-worklet.js',['pcm-worklet.js','text/javascript; charset=utf-8']],['/pcm-codec.js',['pcm-codec.js','text/javascript; charset=utf-8']],
  ['/overlay-client.js',['overlay-client.js','text/javascript; charset=utf-8']],['/manifest.webmanifest',['manifest.webmanifest','application/manifest+json']],
  ['/icon.svg',['icon.svg','image/svg+xml']],['/privacy',['privacy.html','text/html; charset=utf-8']],
]);
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const json=(d,status=200)=>Response.json(d,{status});
const failure=(message,status=400)=>Object.assign(new Error(message),{status});
export function cookieToken(request){const name=new URL(request.url).protocol==='https:'?'__Host-verifica_session':'verifica_session';return new RegExp(`(?:^|;\\s*)${name}=([a-f0-9]{64})(?:;|$)`).exec(request.headers.get('cookie')||'')?.[1];}
export async function boundedBody(request,max=16000){
  const reader=request.body?.getReader();if(!reader)return Buffer.alloc(0);const chunks=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();throw failure('Requisição muito grande.',413);}chunks.push(Buffer.from(value));}return Buffer.concat(chunks);}finally{reader.releaseLock();}
}
export function createWebApp({origin='http://127.0.0.1:4311',sessions=new WebSessions({origin}),accessCode='',publicDir=join(process.cwd(),'public')}={}){
  const base=new URL(origin);if(base.origin!==origin||base.username||base.password||(!['127.0.0.1','localhost','[::1]'].includes(base.hostname)&&base.protocol!=='https:'))throw new Error('APP_PUBLIC_ORIGIN deve ser uma origem HTTPS, sem caminho. HTTP só é permitido em loopback.');
  const secure=base.protocol==='https:';
  function cookie(token,maxAge=8*3600){return `${secure?'__Host-':''}verifica_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure?'; Secure':''}`;}
  function guarded(request,mutate=false){
    if(new URL(request.url).origin!==origin)throw failure('Endereço não autorizado.',403);
    if(request.headers.get('sec-fetch-site')==='cross-site')throw failure('Abra o Verifica diretamente pelo seu endereço.',403);
    const from=request.headers.get('origin');if(from&&from!==origin)throw failure('Origem não permitida.',403);
    if(mutate&&from!==origin)throw failure('Origem obrigatória.',403);
  }
  function headers(response){
    response.headers.set('Cache-Control','no-store');response.headers.set('X-Content-Type-Options','nosniff');response.headers.set('Referrer-Policy','no-referrer');
    response.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self' https://www.youtube.com https://s.ytimg.com; style-src 'self'; img-src 'self' data: https://i.ytimg.com; frame-src https://www.youtube.com https://www.youtube-nocookie.com; connect-src 'self' https://www.youtube.com https://www.youtube-nocookie.com; media-src 'self' blob:; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    response.headers.set('Permissions-Policy','microphone=(self), camera=(), display-capture=(self), fullscreen=(self "https://www.youtube.com" "https://www.youtube-nocookie.com")');
    if(secure)response.headers.set('Strict-Transport-Security','max-age=31536000');return response;
  }
  async function handle(request,{ip='local'}={}){
    const path=new URL(request.url).pathname;
    if(request.method==='GET'&&assets.has(path)){const [file,type]=assets.get(path);return new Response(await readFile(join(publicDir,file)),{headers:{'Content-Type':type}});}
    if(path==='/healthz'&&request.method==='GET')return json({ok:true});
    // OAuth returns by top-level navigation from auth.openai.com; state+PKCE,
    // bound to the existing browser cookie, protect this one cross-site route.
    if(path==='/auth/callback'&&request.method==='GET'){
      const s=sessions.get(cookieToken(request));if(!s?.oauth)throw failure('Esta tentativa de login expirou. Volte ao Verifica e inicie novamente.',401);
      await s.oauth.callback(new URL(request.url).searchParams);
      return new Response(null,{status:303,headers:{Location:'/?connected=1'}});
    }
    guarded(request,request.method!=='GET');
    if(path==='/api/web/session'&&request.method==='GET'){
      let s=sessions.get(cookieToken(request)),token;
      if(!s)({session:s,token}=sessions.create(ip));
      const r=json({csrf:s.csrf,localPlan:sessions.localPlan,locked:!!accessCode&&!s.unlocked,transcription:'server',state:s.engine.snapshot(),auth:s.oauth?.snapshot()||null});
      if(token)r.headers.set('Set-Cookie',cookie(token));return r;
    }
    const s=sessions.get(cookieToken(request));if(!s)throw failure('Sua sessão expirou. Recarregue a página para continuar.',401);
    if(request.method!=='GET'&&!same(request.headers.get('x-csrf-token'),s.csrf))throw failure('Sessão inválida. Recarregue a página.',403);
    if(path==='/api/web/unlock'&&request.method==='POST'){
      sessions.limit(s,'unlock',5);const d=JSON.parse((await boundedBody(request)).toString());if(!same(String(d.code||''),accessCode))throw failure('Código de acesso inválido.',403);s.unlocked=true;return json({ok:true});
    }
    if(accessCode&&!s.unlocked)throw failure('Informe o código de acesso para continuar.',403);
    const e=s.engine;
    if(path==='/api/web/state'&&request.method==='GET')return json({state:e.snapshot(),auth:s.oauth?.snapshot()||null});
    if(path==='/api/web/events'&&request.method==='GET'){
      if(s.streams.size>=3)throw failure('Muitas abas abertas nesta sessão.',429);
      let listener,timer,close,stopped=false;const encoder=new TextEncoder();
      const stream=new ReadableStream({start(controller){
        close=()=>{if(stopped)return;stopped=true;clearInterval(timer);e.off('event',listener);s.streams.delete(close);request.signal.removeEventListener('abort',close);try{controller.close();}catch{}};
        const send=event=>{if(!stopped)try{controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));}catch{close();}};
        listener=send;s.streams.add(close);send({type:'snapshot',state:e.snapshot()});e.on('event',listener);
        timer=setInterval(()=>{if(!stopped)try{controller.enqueue(encoder.encode(': heartbeat\n\n'));}catch{close();}},15000);timer.unref?.();
        request.signal.addEventListener('abort',close,{once:true});if(request.signal.aborted)close();
      },cancel(){close?.();}});
      return new Response(stream,{headers:{'Content-Type':'text/event-stream','X-Accel-Buffering':'no'}});
    }
    if(request.method!=='POST')throw failure('Endereço não encontrado.',404);
    if(path==='/api/web/audio'){
      sessions.limit(s,'audio',180);
      if(request.headers.get('content-type')!=='application/octet-stream')throw failure('Formato de áudio inválido.',415);
      const seq=request.headers.get('x-audio-sequence');if(!/^\d{1,9}$/.test(seq||''))throw failure('Sequência de áudio inválida.');
      const pcm=await boundedBody(request,128000);e.pushAudio(pcm,request.headers.get('x-stream-id'),Number(seq));return json({ok:true});
    }
    if(!request.headers.get('content-type')?.startsWith('application/json'))throw failure('Envie JSON.',415);
    const d=JSON.parse((await boundedBody(request)).toString()||'{}');
    if(path==='/api/web/stop'){e.stop();return json({state:e.snapshot()});}
    if(path==='/api/web/end-audio'){e.endAudio(d.streamId);return json({state:e.snapshot()});}
    if(path==='/api/web/session/delete'){
      e.stop();if(s.oauth){await s.oauth.ready;const profiles=[...s.oauth.data.profiles];await Promise.allSettled(profiles.filter(p=>p.refreshToken).map(p=>s.oauth.disconnect(p.id)));}
      sessions.remove(s);const r=json({ok:true});r.headers.set('Set-Cookie',cookie('',0));return r;
    }
    sessions.limit(s,'operations',40);
    if(s.starting||s.mutating)throw failure('Aguarde a operação em andamento.',409);
    if(path==='/api/web/start'){
      if(d.input!=='youtube'&&d.input!=='capture')throw failure('Escolha uma fonte de áudio.');
      sessions.reserve(s);
      try{await e.start({url:d.url,input:d.input,title:d.title,offset:d.offset,referenceDate:d.referenceDate,contextHint:d.contextHint,transcribeOnly:d.transcribeOnly===true,continuous:true});return json({state:e.snapshot()});}
      finally{s.starting=false;}
    }
    e.ensureIdle();s.mutating=true;
    try{
      if(path==='/api/web/connect')return json({source:await e.connect(d.url)});
      if(path==='/api/web/gateway'){e.configure(d.key);return json({state:e.snapshot()});}
      if(path==='/api/web/gateway/disconnect'){e.key='';e.sessionAuth=null;e.update();return json({state:e.snapshot()});}
      const a=s.oauth;
      if(!a)throw failure('O uso do plano ChatGPT está disponível apenas na versão local. Nesta versão, configure uma API explicitamente.',409);
      await a.ready;
      if(path==='/api/web/auth/begin'){e.useChatGPT();return json(await a.begin({profileId:a.data.activeId,reauthorize:!!a.snapshot().connected&&!a.snapshot().planEnabled}));}
      if(path==='/api/web/auth/cancel'){a.cancel();return json({ok:true});}
      if(path==='/api/web/auth/models'){const models=await a.models({force:d.force===true});return json({models,auth:a.snapshot()});}
      if(path==='/api/web/auth/model'){await a.selectModel(d.model);e.useChatGPT();return json({auth:a.snapshot()});}
      if(path==='/api/web/auth/effort'){await a.selectEffort(d.effort);return json({auth:a.snapshot()});}
      if(path==='/api/web/auth/test')return json(await testChatGPT(a));
      if(path==='/api/web/auth/disconnect')return json(await a.disconnect());
      throw failure('Endereço não encontrado.',404);
    }finally{s.mutating=false;}
  }
  return {sessions,origin,async fetch(request,meta){try{return headers(await handle(request,meta));}catch(error){const status=error instanceof SyntaxError?400:(error.status>=400&&error.status<=599?error.status:400);return headers(json({error:error instanceof SyntaxError?'JSON inválido.':error.message||'Falha na operação.'},status));}},close(){sessions.close();}};
}
