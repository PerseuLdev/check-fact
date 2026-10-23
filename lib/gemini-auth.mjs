import {EventEmitter} from 'node:events';
import {randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {dirname,join} from 'node:path';
import {CredentialStore,storageDir} from './credential-store.mjs';
import {GeminiLocal} from './gemini-local.mjs';
import {geminiEfforts,savedEffort,validateEffort} from './effort.mjs';

export const googleScopes=['https://www.googleapis.com/auth/cloud-platform','https://www.googleapis.com/auth/generative-language.retriever'];
const base='https://generativelanguage.googleapis.com/v1beta';
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
function failure(status,payload={}){
  const code=typeof payload.error==='string'?payload.error:payload.error?.status||`http_${status}`;
  const messages={invalid_grant:'A autorização do Google expirou ou foi revogada. Conecte novamente.',invalid_client:'O cliente OAuth do Google não foi aceito. Confira o JSON importado.',PERMISSION_DENIED:'O projeto ou a conta não tem acesso à Gemini API. Confira a API habilitada, permissões e consentimento.',RESOURCE_EXHAUSTED:'A cota da Gemini API foi atingida. Consulte os limites do projeto Google.',UNAUTHENTICATED:'A Gemini API não aceitou a autorização. Conecte novamente.'};
  const error=new Error(messages[code]||`O Google não concluiu a operação (HTTP ${status}).`);error.code=code;error.status=status;return error;
}
function enabled(p){return !!p?.accessToken&&googleScopes.some(s=>p.scopes?.includes(s));}
function loginNeeded(message){const error=new Error(message);error.code='UNAUTHENTICATED';error.status=401;return error;}
export class GeminiAuth extends EventEmitter{
  constructor({store=new CredentialStore({dir:join(dirname(storageDir),'Gemini')}),fetcher=fetch,origin='http://127.0.0.1:4310'}={}){
    super();this.store=store;this.fetcher=fetcher;this.origin=origin;this.data={version:1,profiles:[],activeId:null};this.pending=null;this.generation=0;this.refreshing=null;this.cache=null;this.error=null;this.ready=this.initialize();
  }
  async initialize(){try{this.data=await this.store.load();}catch(e){this.error=e.message;}this.emit('change');}
  profile(id=this.data.activeId){return this.data.profiles.find(p=>p.id===id);}
  snapshot(){const p=this.profile(),effortOptions=geminiEfforts(p?.selectedModel);return{configured:!!this.data.config,projectId:this.data.config?.projectId||null,connected:enabled(p),activeId:this.data.activeId,selectedModel:p?.selectedModel||null,selectedEffort:savedEffort(p,effortOptions),effortOptions,verifiedEffort:p?.verifiedEffort||'default',verifiedModel:p?.verifiedModel||null,pending:!!this.exchanging||!!this.pending&&this.pending.expiresAt>Date.now(),error:this.error,message:this.message||null};}
  async mutate(fn){const{data,result}=await this.store.transaction(fn);this.data=data;this.emit('change');return result;}
  async configure(json){
    await this.ready;if(this.error)throw new Error(this.error);if(this.snapshot().pending||this.snapshot().connected||this.refreshing)throw new Error('Conclua ou cancele o login e desconecte o Gemini antes de trocar o cliente.');
    const c=json?.installed;
    if(!c||typeof c.client_id!=='string'||!/^[-\w.]+\.apps\.googleusercontent\.com$/.test(c.client_id)||c.client_id.length>256||typeof c.client_secret!=='string'||c.client_secret.length<5||c.client_secret.length>1000||!/^[-a-z0-9]{6,63}$/.test(c.project_id||''))throw new Error('Importe o JSON original de um cliente OAuth do Google do tipo Desktop app, com projeto, client ID e client secret.');
    this.generation++;this.cache=null;await this.mutate(d=>{d.config={clientId:c.client_id,clientSecret:c.client_secret,projectId:c.project_id};d.profiles=[];d.activeId=null;});
    this.message='Cliente importado. Agora autorize sua conta Google.';return this.snapshot();
  }
  async begin(){
    await this.ready;if(this.error)throw new Error(this.error);if(!this.data.config)throw new Error('Importe primeiro o JSON do cliente OAuth criado no Google Cloud.');if(this.exchanging||this.refreshing)throw new Error('Aguarde a operação Google em andamento.');
    const state='gemini.'+randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url');this.generation++;
    // A root loopback callback also works for desktop clients without adding a web redirect URI.
    this.pending={state,verifier,redirectUri:this.origin+'/',generation:this.generation,expiresAt:Date.now()+10*60000,config:{...this.data.config}};
    const u=new URL('https://accounts.google.com/o/oauth2/v2/auth');for(const[k,v]of Object.entries({client_id:this.data.config.clientId,redirect_uri:this.pending.redirectUri,response_type:'code',scope:googleScopes.join(' '),access_type:'offline',prompt:'consent select_account',state,code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url')}))u.searchParams.set(k,v);
    this.message='Conclua a autorização na janela do Google.';this.emit('change');return{authorizeUrl:u.href};
  }
  cancel(){this.generation++;this.pending=null;this.message='Login Google cancelado.';this.emit('change');}
  async token(form,config){
    const r=await this.fetcher('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...form,client_id:config.clientId,client_secret:config.clientSecret}),signal:AbortSignal.timeout(20000)});
    let d;try{d=await r.json();}catch{throw failure(r.status);}if(!r.ok)throw failure(r.status,d);
    if(typeof d.access_token!=='string'||!Number.isFinite(d.expires_in)||d.expires_in<=0||d.token_type?.toLowerCase()!=='bearer')throw new Error('A autorização Google retornou dados incompletos.');return d;
  }
  async callback(params){
    const p=this.pending;if(!p||p.expiresAt<Date.now()||!same(params.get('state'),p.state))throw new Error('Login Google inválido ou expirado. Inicie novamente pelo painel.');
    this.pending=null;this.exchanging=true;this.emit('change');
    try{
      if(params.has('error'))throw new Error('A autorização Google foi cancelada ou recusada.');const code=params.get('code');if(!code||code.length>8192)throw new Error('O Google não retornou um código válido.');
      const t=await this.token({grant_type:'authorization_code',code,redirect_uri:p.redirectUri,code_verifier:p.verifier},p.config);
      if(p.generation!==this.generation)throw new Error('A tentativa de login Google foi cancelada.');
      // RFC 6749: omitted scope means the grant matches the requested scopes.
      const scopes=(t.scope??googleScopes.join(' ')).split(/\s+/);if(!googleScopes.some(s=>scopes.includes(s)))throw new Error('A conta foi autenticada, mas o acesso à Gemini API não foi autorizado.');
      const id=randomUUID();await this.mutate(d=>{if(p.generation!==this.generation)throw new Error('Login Google cancelado.');d.profiles=[{id,accessToken:t.access_token,refreshToken:t.refresh_token||null,expiresAt:Date.now()+t.expires_in*1000,scopes,selectedModel:null,verifiedModel:null}];d.activeId=id;});this.cache=null;this.message='Google conectado. Escolha o modelo, teste e selecione “Usar Gemini”.';
    }catch(e){this.message=e.message;throw e;}finally{this.exchanging=false;this.emit('change');}
  }
  async accessToken(id=this.data.activeId){
    await this.ready;let p=this.profile(id);if(!enabled(p))throw loginNeeded('Autorize a conta Google para usar a Gemini API.');if(p.expiresAt>Date.now()+60000)return p.accessToken;
    if(this.refreshing){await this.refreshing;p=this.profile(id);if(!enabled(p))throw new Error('A conexão Google mudou. Atualize o painel.');return p.accessToken;}
    const generation=this.generation,config={...this.data.config};
    this.refreshing=(async()=>{
      if(!p.refreshToken)throw loginNeeded('Conecte novamente ao Google para renovar a autorização.');let t;
      try{t=await this.token({grant_type:'refresh_token',refresh_token:p.refreshToken},config);}catch(e){if(e.code==='invalid_grant')await this.mutate(d=>{const row=d.profiles.find(x=>x.id===id);if(row){delete row.accessToken;delete row.refreshToken;row.verifiedModel=null;}});throw e;}
      if(generation!==this.generation)throw new Error('A conexão Google mudou durante a renovação.');
      await this.mutate(d=>{const row=d.profiles.find(x=>x.id===id);if(!row||generation!==this.generation)throw new Error('Conexão Google alterada.');Object.assign(row,{accessToken:t.access_token,refreshToken:t.refresh_token||row.refreshToken,expiresAt:Date.now()+t.expires_in*1000,scopes:t.scope?t.scope.split(/\s+/):row.scopes});});
      if(!enabled(this.profile(id)))throw loginNeeded('O acesso à Gemini API deixou de estar autorizado. Conecte novamente.');return t.access_token;
    })();try{return await this.refreshing;}finally{this.refreshing=null;}
  }
  async fetchAuthed(path,options={},id=this.data.activeId){
    if(!/^\/models(?:\?pageSize=100(?:&pageToken=[\w%.-]+)?|\/[-\w.]+:generateContent)?$/.test(path))throw new Error('Endpoint não permitido na conexão Gemini.');
    const token=await this.accessToken(id),r=await this.fetcher(base+path,{...options,headers:{...options.headers,Authorization:`Bearer ${token}`,'x-goog-user-project':this.data.config.projectId},signal:options.signal||AbortSignal.timeout(45000),redirect:'error'});
    if(!r.ok){let d={};try{d=await r.json();}catch{}throw failure(r.status,d);}return r;
  }
  async models({force=false}={}){
    await this.ready;const id=this.data.activeId;if(!force&&this.cache?.id===id&&this.cache.at>Date.now()-300000)return this.cache.models;
    let page='',models=[];for(let i=0;i<5;i++){const r=await this.fetchAuthed('/models?pageSize=100'+(page?'&pageToken='+encodeURIComponent(page):''),{},id),d=await r.json();if(!Array.isArray(d.models))throw new Error('O catálogo Gemini retornou um formato inesperado.');models.push(...d.models.filter(m=>m.supportedGenerationMethods?.includes('generateContent')&&/^models\/gemini-[-\w.]+$/.test(m.name)&&!/image|tts|audio|robotics|computer-use/.test(m.name)).map(m=>({id:m.name.slice(7),name:m.displayName||m.name})));page=d.nextPageToken;if(!page)break;if(i===4)throw new Error('O catálogo Gemini excedeu o limite de páginas da consulta.');}
    if(this.data.activeId!==id)throw new Error('A conexão Gemini mudou durante a consulta.');
    models=[...new Map(models.map(m=>[m.id,m])).values()];this.cache={id,at:Date.now(),models};
    if(this.profile(id)?.selectedModel&&!models.some(m=>m.id===this.profile(id).selectedModel))await this.mutate(d=>{const p=d.profiles.find(x=>x.id===id);if(p){p.selectedModel=null;p.verifiedModel=null;}});
    if(!this.profile(id)?.selectedModel&&models.some(m=>m.id==='gemini-2.5-flash'))await this.mutate(d=>{const p=d.profiles.find(x=>x.id===id);if(p)p.selectedModel='gemini-2.5-flash';});return models;
  }
  async selectModel(model){const id=this.data.activeId,models=await this.models();if(!models.some(m=>m.id===model)||this.data.activeId!==id)throw new Error('Escolha um modelo retornado pelo catálogo desta conexão.');await this.mutate(d=>{const p=d.profiles.find(x=>x.id===id);p.selectedModel=model;p.verifiedModel=null;});}
  async selectEffort(effort){await this.ready;const id=this.data.activeId,model=this.profile()?.selectedModel;if(!model)throw new Error('Selecione um modelo antes de escolher o effort.');validateEffort(effort,geminiEfforts(model));await this.mutate(d=>{const p=d.profiles.find(x=>x.id===id);p.modelEfforts={...p.modelEfforts,[model]:effort};p.verifiedModel=null;});}
  async markInference(id,model,effort='default'){await this.mutate(d=>{const p=d.profiles.find(x=>x.id===id);if(p){p.verifiedModel=model;p.verifiedEffort=effort;p.lastInferenceAt=Date.now();}});}
  async disconnect(){
    await this.ready;this.cancel();if(this.refreshing)await this.refreshing.catch(()=>{});const p=this.profile(),token=p?.refreshToken||p?.accessToken;let revoked=false;
    try{if(token){const r=await this.fetcher('https://oauth2.googleapis.com/revoke',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token}),signal:AbortSignal.timeout(10000)});revoked=r.ok;}}catch{}
    await this.mutate(d=>{d.profiles=[];d.activeId=null;});this.cache=null;this.message=revoked?'Google desconectado e autorização revogada.':'Google desconectado localmente. A revogação remota não foi confirmada; confira as conexões da sua conta Google.';this.emit('change');return{revoked,message:this.message};
  }
}
export class GeminiConnection extends EventEmitter{
  constructor({local=new GeminiLocal(),api=new GeminiAuth()}={}){super();this.local=local;this.api=api;this.mode='local';this.ready=Promise.all([local.ready,api.ready]);for(const service of [local,api])service.on('change',()=>this.emit('change'));}
  get current(){return this.mode==='local'?this.local:this.api;}
  snapshot(){return{...this.current.snapshot(),connectionMode:this.mode,...(this.mode==='local'?{configured:false,connected:false,pending:false,unavailable:true,message:'Login Google simplificado indisponível nesta versão. A integração precisa ser atualizada; você não precisa fornecer arquivos.'}:{})};}
  async configure(json){if(this.snapshot().pending)throw new Error('Conclua ou cancele o login atual.');await this.api.configure(json);this.local.cancel();this.mode='api';this.emit('change');return this.snapshot();}
  useLocal(){if(this.snapshot().pending)throw new Error('Aguarde ou cancele o login atual.');this.mode='local';this.emit('change');}
  begin(){if(this.mode==='local')throw new Error('O login Google simplificado ainda não está disponível. Use uma conexão já disponível no painel.');return this.current.begin();}cancel(){return this.current.cancel();}
  models(options){return this.current.models(options);}selectModel(model){return this.current.selectModel(model);}
  selectEffort(effort){if(this.mode==='local')throw new Error('O login Google simplificado ainda não está disponível.');return this.api.selectEffort(effort);}
  fetchAuthed(...args){return this.current.fetchAuthed(...args);}markInference(...args){return this.current.markInference(...args);}
  disconnect(){return this.current.disconnect();}
}
let instance;export function geminiAuth(){return instance ||= new GeminiConnection();}
