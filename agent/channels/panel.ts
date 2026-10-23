import { defineChannel, GET, POST, OPTIONS } from 'eve/channels';
import { extensionRequest, extensionToken } from '../../lib/extension-bridge.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { engine } from '../../lib/engine.mjs';
import { chatgptAuth } from '../../lib/chatgpt-auth.mjs';
import { localAsr } from '../../lib/local-asr.mjs';
import { testChatGPT, testGemini } from '../../lib/ai.mjs';
import { geminiAuth } from '../../lib/gemini-auth.mjs';

async function asset(name:string,type:string){return new Response(await readFile(join(process.cwd(),'public',name)),{headers:{'Content-Type':type,'Cache-Control':'no-store'}});}
function localRead(request:Request){
  if(!['127.0.0.1','localhost'].includes(new URL(request.url).hostname)||request.headers.get('sec-fetch-site')==='cross-site')return Response.json({error:'Use o endereço local do painel.'},{status:403});return null;
}
async function mutation(request:Request,action:(data:any)=>Promise<any>|any){
  if(!['127.0.0.1','localhost'].includes(new URL(request.url).hostname))return Response.json({error:'Use o endereço local do painel.'},{status:403});
  const origin=request.headers.get('origin');if(origin&&origin!==new URL(request.url).origin)return Response.json({error:'Origem não permitida.'},{status:403});
  if(!(request.headers.get('content-type')||'').includes('application/json'))return Response.json({error:'Envie JSON.'},{status:415});
  try{const text=await request.text();if(text.length>16000)return Response.json({error:'Requisição muito grande.'},{status:413});return Response.json(await action(JSON.parse(text)));}
  catch(e){return Response.json({error:e instanceof Error?e.message:'Falha na operação.'},{status:400});}
}
function callbackPage(message:string,ok:boolean,provider='ChatGPT'){
  const escaped=message.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
  return new Response(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Verifica — ${provider}</title><style>body{background:#0b1012;color:#e9f0ed;font:16px/1.6 system-ui;max-width:560px;margin:15vh auto;padding:24px}a{color:#b6f38b}h1{font-size:26px}</style><h1>${ok?'Conexão com '+provider+' recebida':'Não foi possível concluir o login'}</h1><p>${escaped}</p><p><a href="/">Voltar ao painel</a></p><script>history.replaceState({},'', '/');if(window.opener)window.opener.postMessage({type:'verifica-auth-finished'},location.origin);${ok?'window.close();':''}</script></html>`,{status:ok?200:400,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
}
export default defineChannel({routes:[
  GET('/extension',()=>asset('extension.html','text/html; charset=utf-8')),
  GET('/extension.js',()=>asset('extension.js','text/javascript; charset=utf-8')),
  GET('/api/extension/pairing',(request)=>localRead(request)||Response.json({token:extensionToken},{headers:{'Cache-Control':'no-store'}})),
  POST('/api/extension',(request)=>extensionRequest(request,engine)),
  OPTIONS('/api/extension',(request)=>extensionRequest(request,engine)),
  GET('/',async(request)=>{
    const params=new URL(request.url).searchParams;
    if(params.get('state')?.startsWith('gemini.')){
      if(new URL(request.url).hostname!=='127.0.0.1')return callbackPage('Use o endereço local do aplicativo.',false,'Google');
      try{await geminiAuth().callback(params);return callbackPage('Google conectado. Volte ao painel para escolher o modelo Gemini.',true,'Google');}catch(e){return callbackPage(e instanceof Error?e.message:'O login Google falhou.',false,'Google');}
    }
    return asset('index.html','text/html; charset=utf-8');
  }),
  GET('/overlay',()=>asset('overlay.html','text/html; charset=utf-8')),
  GET('/assistir',()=>asset('watch.html','text/html; charset=utf-8')),
  GET('/watch.js',()=>asset('watch.js','text/javascript; charset=utf-8')),
  GET('/overlay-client.js',()=>asset('overlay-client.js','text/javascript; charset=utf-8')),
  GET('/overlay-style',()=>asset('overlay.css','text/css; charset=utf-8')),
  GET('/app.js',()=>asset('app.js','text/javascript; charset=utf-8')),
  GET('/stylesheet',()=>asset('style.css','text/css; charset=utf-8')),
  GET('/api/state',(request)=>localRead(request)||Response.json(engine().snapshot(),{headers:{'Cache-Control':'no-store'}})),
  GET('/api/auth/state',async(request)=>{const denied=localRead(request);if(denied)return denied;await chatgptAuth().ready;return Response.json(chatgptAuth().snapshot(),{headers:{'Cache-Control':'no-store'}});}),
  GET('/api/gemini/state',async(request)=>{const denied=localRead(request);if(denied)return denied;await geminiAuth().ready;return Response.json(geminiAuth().snapshot(),{headers:{'Cache-Control':'no-store'}});}),
  GET('/api/gemini/models',async(request)=>{const denied=localRead(request);if(denied)return denied;try{const g=geminiAuth();return Response.json({models:await g.models({force:new URL(request.url).searchParams.get('refresh')==='1'}),auth:g.snapshot()},{headers:{'Cache-Control':'no-store'}});}catch(e){return Response.json({error:e instanceof Error?e.message:'Falha no catálogo Gemini.'},{status:400});}}),
  GET('/api/auth/models',async(request)=>{
    const denied=localRead(request);if(denied)return denied;
    try{const a=chatgptAuth();return Response.json({models:await a.models({force:new URL(request.url).searchParams.get('refresh')==='1'}),auth:a.snapshot()},{headers:{'Cache-Control':'no-store'}});}
    catch(e){return Response.json({error:e instanceof Error?e.message:'Não foi possível consultar os modelos.'},{status:400});}
  }),
  GET('/auth/callback',async(request)=>{
    if(new URL(request.url).hostname!=='127.0.0.1')return callbackPage('Retorne ao endereço local do aplicativo.',false);
    const a=chatgptAuth();
    try{await a.callback(new URL(request.url).searchParams);a.loginError=false;a.loginMessage=a.snapshot().planEnabled?'Conta conectada. Selecione um modelo e teste o acesso.':'A conta foi identificada, mas o uso do plano não foi autorizado.';a.emit('change');return callbackPage(a.loginMessage,true);}
    catch(e){const message=e instanceof Error?e.message:'O login não foi concluído.';if(!a.snapshot().pending){a.loginError=true;a.loginMessage=message;a.emit('change');}return callbackPage(message,false);}
  }),
  GET('/api/events',(request)=>{
    const denied=localRead(request);if(denied)return denied;
    const e=engine(),encoder=new TextEncoder();let listener:any,timer:any;
    const body=new ReadableStream({start(controller){
      const send=(event:any)=>controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));send({type:'snapshot',state:e.snapshot()});listener=send;e.on('event',listener);
      timer=setInterval(()=>controller.enqueue(encoder.encode(': heartbeat\n\n')),15000);
      request.signal.addEventListener('abort',()=>{e.off('event',listener);clearInterval(timer);try{controller.close();}catch{}},{once:true});
    },cancel(){e.off('event',listener);clearInterval(timer);}});
    return new Response(body,{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'}});
  }),
  POST('/api/connect',(r)=>mutation(r,async d=>({source:await engine().connect(d.url)}))),
  POST('/api/config',(r)=>mutation(r,d=>{engine().configure(d.key);return{ok:true};})),
  POST('/api/config/effort',(r)=>mutation(r,d=>{engine().configureEfforts(d);return{ok:true};})),
  POST('/api/auth/begin',(r)=>mutation(r,async d=>{engine().ensureIdle();engine().useChatGPT();return chatgptAuth().begin({profileId:d.profileId||null,reauthorize:d.reauthorize===true});})),
  POST('/api/auth/cancel',(r)=>mutation(r,()=>{chatgptAuth().cancel();return{ok:true};})),
  POST('/api/auth/use',(r)=>mutation(r,()=>{engine().useChatGPT();return{ok:true};})),
  POST('/api/auth/profile',(r)=>mutation(r,async d=>{engine().ensureIdle();await chatgptAuth().selectProfile(d.id);engine().useChatGPT();return{auth:chatgptAuth().snapshot()};})),
  POST('/api/auth/model',(r)=>mutation(r,async d=>{engine().ensureIdle();await chatgptAuth().selectModel(d.model);engine().useChatGPT();return{auth:chatgptAuth().snapshot()};})),
  POST('/api/auth/effort',(r)=>mutation(r,async d=>{engine().ensureIdle();await chatgptAuth().selectEffort(d.effort);return{auth:chatgptAuth().snapshot()};})),
  POST('/api/auth/test',(r)=>mutation(r,async()=>{engine().ensureIdle();return testChatGPT(chatgptAuth());})),
  POST('/api/auth/disconnect',(r)=>mutation(r,async d=>{engine().ensureIdle();return chatgptAuth().disconnect(d.profileId||undefined);})),
  POST('/api/gemini/config',(r)=>mutation(r,async d=>{engine().ensureIdle();return geminiAuth().configure(d.credentials);})),
  POST('/api/gemini/begin',(r)=>mutation(r,async()=>{engine().ensureIdle();return geminiAuth().begin();})),
  POST('/api/gemini/local',(r)=>mutation(r,()=>{engine().ensureIdle();geminiAuth().useLocal();return geminiAuth().snapshot();})),
  POST('/api/gemini/cancel',(r)=>mutation(r,()=>{geminiAuth().cancel();return{ok:true};})),
  POST('/api/gemini/model',(r)=>mutation(r,async d=>{engine().ensureIdle();await geminiAuth().selectModel(d.model);return geminiAuth().snapshot();})),
  POST('/api/gemini/effort',(r)=>mutation(r,async d=>{engine().ensureIdle();await geminiAuth().selectEffort(d.effort);return geminiAuth().snapshot();})),
  POST('/api/gemini/use',(r)=>mutation(r,()=>{engine().useGemini();return{ok:true};})),
  POST('/api/gemini/test',(r)=>mutation(r,async()=>{engine().ensureIdle();return testGemini(geminiAuth());})),
  POST('/api/gemini/disconnect',(r)=>mutation(r,async()=>{engine().ensureIdle();return geminiAuth().disconnect();})),
  POST('/api/asr/prepare',(r)=>mutation(r,async()=>{engine().ensureIdle();return localAsr().prepare();})),
  POST('/api/start',(r)=>mutation(r,async d=>{await engine().start(d);return{ok:true};})),
  POST('/api/stop',(r)=>mutation(r,()=>{engine().stop();return{ok:true};})),
]});
