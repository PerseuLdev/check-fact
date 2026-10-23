import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { CredentialStore } from './credential-store.mjs';
import { openaiEfforts, savedEffort, validateEffort } from './effort.mjs';

const authOrigin='https://auth.openai.com',resource='https://api.openai.com/v1';
const scopes='openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const terminalRefresh=new Set(['invalid_grant','invalid_refresh_token','token_expired','refresh_token_expired','refresh_token_invalidated','refresh_token_reused']);
export function serviceError(status,payload={},requestId=null){
  const code=payload.error?.code || (typeof payload.error==='string'?payload.error:null) || `http_${status}`;
  const messages={subscription_sharing_user_not_eligible:'O plano ou workspace desta conta não permite este uso.',subscription_sharing_usage_limit_exceeded:'O limite de uso do plano para este aplicativo foi atingido. Consulte o uso no ChatGPT.',subscription_sharing_usage_unavailable:'O uso do plano está temporariamente indisponível.',subscription_sharing_unsupported_capability:'O modelo ou recurso solicitado não está autorizado neste fluxo.',chatpass_v2_scope_not_authorized:'O uso do plano não foi autorizado para esta operação.',invalid_grant:'A conexão expirou. Entre novamente com o ChatGPT.'};
  const error=new Error(messages[code]||`O ChatGPT não concluiu a solicitação (HTTP ${status}).`);
  error.code=code;error.status=status;error.requestId=requestId;return error;
}
function same(a,b){if(typeof a!=='string'||typeof b!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
function canUse(p){return !!p?.accessToken&&p.scopes?.includes('chatgpt.tokens.use.direct')&&p.scopes?.includes('resource.invoke');}
export class ChatGPTAuth extends EventEmitter {
  constructor({store=new CredentialStore(),fetcher=fetch,keySet=null,origin='http://127.0.0.1:4310'}={}){
    super();this.store=store;this.fetcher=fetcher;this.origin=origin;this.jwks=keySet;this.pending=null;this.refreshes=new Map();this.catalogs=new Map();this.data={profiles:[],activeId:null};this.error=null;this.ready=this.initialize();
  }
  async initialize(){try{this.data=await this.store.load();}catch(e){this.error=e.message;}this.emit('change');}
  profile(id=this.data.activeId){return this.data.profiles.find(p=>p.id===id);}
  snapshot(){
    const p=this.profile(),effortOptions=this.effortOptions();return{connected:!!(p?.idToken||p?.accessToken),planEnabled:canUse(p),activeId:this.data.activeId,selectedModel:p?.selectedModel||null,selectedEffort:savedEffort(p,effortOptions),effortOptions,verifiedEffort:p?.verifiedEffort||'default',verifiedModel:p?.verifiedModel||null,lastInferenceAt:p?.lastInferenceAt||null,
      profiles:this.data.profiles.map(p=>({id:p.id,label:p.label,email:p.email||null,connected:!!(p.idToken||p.accessToken),planEnabled:canUse(p)})),
      pending:!!this.exchanging||(!!this.pending&&Date.now()<this.pending.expiresAt),error:this.error,loginMessage:this.loginMessage||null,loginError:!!this.loginError};
  }
  async mutate(fn){const {data,result}=await this.store.transaction(fn);this.data=data;this.emit('change');return result;}
  async metadata(){
    if(!this.discovery){const r=await this.fetcher(authOrigin+'/.well-known/openid-configuration',{signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error('Não foi possível consultar a configuração de login.');
      const d=await r.json();if(d.issuer!==authOrigin)throw new Error('Emissor de autenticação inesperado.');
      for(const k of ['jwks_uri','revocation_endpoint'])if(new URL(d[k]).origin!==authOrigin)throw new Error('Endpoint de autenticação inesperado.');this.discovery=d;
    }return this.discovery;
  }
  async begin({profileId=null,reauthorize=false}={}){
    await this.ready;if(this.error)throw new Error(this.error);if(this.exchanging)throw new Error('Aguarde a conclusão do login em andamento.');this.loginMessage=null;this.loginError=false;this.authGeneration=(this.authGeneration||0)+1;
    const p=profileId?this.profile(profileId):null;if(profileId&&!p)throw new Error('Conexão não encontrada.');
    if(!this.data.hostId)await this.mutate(d=>{d.hostId ||= 'urn:uuid:'+randomUUID();});
    const state=randomBytes(32).toString('base64url'),nonce=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url');
    const redirectUri=this.origin+'/auth/callback';
    this.pending={state,nonce,verifier,redirectUri,profileId:p?.id||null,clientId:p?.clientId||null,subject:p?.subject||null,generation:this.authGeneration,expiresAt:Date.now()+10*60000};
    const u=new URL(authOrigin+'/api/accounts/authorize');
    const params={client_id:p?.clientId||'dynamic_agent_client',ext_agent_host_id:this.data.hostId,response_type:'code',redirect_uri:redirectUri,scope:scopes,resource,state,nonce,code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url')};
    if(!p)params.agent_name_hint='Verifica';if(reauthorize)params.prompt='consent';
    // ID-token hints are optional. Do not expose saved tokens in browser URLs.
    for(const [k,v]of Object.entries(params))u.searchParams.set(k,v);
    this.emit('change');return{authorizeUrl:u.href,expiresAt:this.pending.expiresAt};
  }
  cancel(){this.pending=null;this.authGeneration=(this.authGeneration||0)+1;this.emit('change');}
  async token(form){
    const r=await this.fetcher(authOrigin+'/api/accounts/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(form),signal:AbortSignal.timeout(20000)});
    let payload;try{payload=await r.json();}catch{throw serviceError(r.status);}
    if(!r.ok)throw serviceError(r.status,payload,r.headers.get('x-request-id'));
    return payload;
  }
  async verifyIdentity(token,clientId,nonce=null){
    const meta=await this.metadata();this.jwks ||= createRemoteJWKSet(new URL(meta.jwks_uri));
    const {payload}=await jwtVerify(token,this.jwks,{issuer:authOrigin,audience:clientId,algorithms:['RS256'],requiredClaims:nonce?['sub','exp','iat','nonce']:['sub','exp','iat'],clockTolerance:5});
    if(nonce&&!same(payload.nonce,nonce))throw new Error('A identidade retornada não corresponde à tentativa de login.');return payload;
  }
  async callback(params){
    const p=this.pending;
    if(!p||Date.now()>p.expiresAt||!same(params.get('state'),p.state))throw new Error('Tentativa de login inválida ou expirada. Abra o login novamente pelo painel.');
    this.pending=null;
    this.exchanging=true;
    try{
    if(params.has('error')){this.emit('change');throw new Error('Login cancelado ou não autorizado.');}
    const code=params.get('code');if(!code||code.length>8192)throw new Error('O login não retornou um código válido.');
    const supplied=params.get('client_id');
    if(p.clientId&&supplied&&supplied!==p.clientId)throw new Error('O registro retornado não corresponde à conta selecionada.');
    const clientId=p.clientId||supplied;
    if(!clientId||clientId==='dynamic_agent_client'||!/^[\w-]{4,200}$/.test(clientId))throw new Error('O registro da conexão não foi concluído.');
    // Retain an issued registration even if the single-use code exchange fails.
    let profileId=p.profileId;
    if(!profileId){profileId=randomUUID();await this.mutate(d=>{d.profiles.push({id:profileId,clientId,label:`Conexão ${d.profiles.length+1}`,subject:null,scopes:[]});});}
    const tokens=await this.token({grant_type:'authorization_code',client_id:clientId,code,code_verifier:p.verifier,redirect_uri:p.redirectUri,resource});
    let identity;try{identity=await this.verifyIdentity(tokens.id_token,clientId,p.nonce);}catch{throw new Error('Não foi possível validar com segurança a identidade retornada pelo ChatGPT.');}
    if(!identity.sub||(p.subject&&p.subject!==identity.sub))throw new Error('A conta autorizada difere da conexão selecionada. A conexão anterior foi preservada.');
    const granted=String(tokens.scope||'').split(/\s+/).filter(Boolean);
    if(granted.includes('chatgpt.tokens.use.direct')&&(typeof tokens.access_token!=='string'||!Number.isFinite(tokens.expires_in)||tokens.expires_in<=0))throw new Error('Resposta de autenticação incompleta.');
    if(p.generation!==this.authGeneration)throw new Error('Login cancelado. A conexão anterior foi preservada.');
    await this.mutate(d=>{
      const record=d.profiles.find(x=>x.id===profileId);if(!record)throw new Error('Registro não encontrado.');
      Object.assign(record,{subject:identity.sub,issuer:identity.iss,email:identity.email||null,accessToken:tokens.access_token||null,refreshToken:tokens.refresh_token||null,idToken:tokens.id_token,
        scopes:granted,expiresAt:Date.now()+(tokens.expires_in||0)*1000,earliestRefreshAt:tokens.earliest_refresh_at||null});d.activeId=profileId;
    });
    this.error=null;this.emit('change');return this.snapshot();
    }finally{this.exchanging=false;this.emit('change');}
  }
  async accessToken(profileId=this.data.activeId){
    await this.ready;let p=this.profile(profileId);if(!canUse(p))throw new Error('Entre com ChatGPT e autorize o uso do plano para continuar.');
    if(p.expiresAt>Date.now()+60000)return p.accessToken;
    if(this.refreshes.has(profileId))return this.refreshes.get(profileId);
    const promise=(async()=>{
      p=this.profile(profileId);if(!p?.refreshToken)throw new Error('Entre novamente com ChatGPT para renovar a conexão.');
      let tokens;
      try{tokens=await this.token({grant_type:'refresh_token',client_id:p.clientId,refresh_token:p.refreshToken,resource});}
      catch(e){if(terminalRefresh.has(e.code))await this.mutate(d=>{const r=d.profiles.find(x=>x.id===profileId);if(r){delete r.accessToken;delete r.refreshToken;delete r.idToken;}});throw e;}
      if(!tokens.access_token||!tokens.refresh_token||!Number.isFinite(tokens.expires_in))throw new Error('A renovação da conexão retornou dados incompletos.');
      if(tokens.id_token){
        try{const identity=await this.verifyIdentity(tokens.id_token,p.clientId);if(identity.sub!==p.subject)throw new Error('identity mismatch');}
        catch{throw serviceError(401,{error:{code:'subscription_sharing_invalid_user'}});}
      }
      await this.mutate(d=>{const r=d.profiles.find(x=>x.id===profileId);Object.assign(r,{accessToken:tokens.access_token,refreshToken:tokens.refresh_token,idToken:tokens.id_token||r.idToken,expiresAt:Date.now()+tokens.expires_in*1000,scopes:tokens.scope?tokens.scope.split(/\s+/):r.scopes});});
      if(!canUse(this.profile(profileId)))throw new Error('A conexão foi renovada, mas o uso do plano não está autorizado. Autorize novamente no painel.');return tokens.access_token;
    })();this.refreshes.set(profileId,promise);try{return await promise;}finally{this.refreshes.delete(profileId);}
  }
  async fetchAuthed(path,options={},profileId=this.data.activeId){
    if(!['/models','/responses'].includes(path))throw new Error('Endpoint não permitido no fluxo ChatGPT.');
    const token=await this.accessToken(profileId);
    const r=await this.fetcher(resource+path,{...options,headers:{...options.headers,Authorization:`Bearer ${token}`},signal:options.signal||AbortSignal.timeout(20000)});
    if(!r.ok){let d={};try{d=await r.json();}catch{}throw serviceError(r.status,d,r.headers.get('x-request-id'));}return r;
  }
  async models({force=false}={}){
    await this.ready;const id=this.data.activeId,cache=this.catalogs.get(id);
    if(!force&&cache&&cache.at>Date.now()-300000)return cache.models;
    const r=await this.fetchAuthed('/models',{},id),d=await r.json();if(!Array.isArray(d.models))throw new Error('O catálogo da conta retornou um formato inesperado.');
    const models=d.models.filter(m=>m.visibility==='list'&&typeof m.slug==='string').map(m=>({id:m.slug,name:m.display_name||m.slug,effortOptions:openaiEfforts(m.slug,m)}));
    this.catalogs.set(id,{at:Date.now(),models});
    const current=this.profile(id);
    if(current?.selectedModel&&!models.some(m=>m.id===current.selectedModel))await this.mutate(d=>{const p=d.profiles.find(p=>p.id===id);p.selectedModel=null;p.verifiedModel=null;});
    if(!this.profile(id)?.selectedModel&&models.some(m=>m.id==='gpt-6-luna'))await this.mutate(d=>{const p=d.profiles.find(p=>p.id===id);p.selectedModel='gpt-6-luna';p.verifiedModel=null;});
    return models;
  }
  async selectModel(model){
    const profileId=this.data.activeId;
    const available=await this.models();if(!available.some(m=>m.id===model))throw new Error('Escolha um modelo retornado para esta conta.');
    if(this.data.activeId!==profileId)throw new Error('A conta mudou durante a seleção. Atualize a lista de modelos.');
    await this.mutate(d=>{const p=d.profiles.find(p=>p.id===profileId);p.selectedModel=model;p.verifiedModel=null;});
  }
  effortOptions(){const p=this.profile();return this.catalogs.get(p?.id)?.models.find(m=>m.id===p.selectedModel)?.effortOptions||openaiEfforts(p?.selectedModel);}
  async selectEffort(effort){
    await this.ready;const profileId=this.data.activeId,model=this.profile()?.selectedModel;
    if(!model)throw new Error('Selecione um modelo antes de escolher o effort.');
    await this.models();
    if(this.data.activeId!==profileId||this.profile()?.selectedModel!==model)throw new Error('A conexão ou o modelo mudou. Atualize as configurações.');
    validateEffort(effort,this.effortOptions());
    await this.mutate(d=>{const p=d.profiles.find(p=>p.id===profileId);p.modelEfforts={...p.modelEfforts,[model]:effort};p.verifiedModel=null;});
  }
  async selectProfile(id){await this.ready;if(this.snapshot().pending)throw new Error('Conclua ou cancele o login antes de trocar de conta.');if(!this.profile(id))throw new Error('Conexão não encontrada.');await this.mutate(d=>{d.activeId=id;});}
  async markInference(profileId,model,effort='default'){await this.mutate(d=>{const p=d.profiles.find(p=>p.id===profileId);if(p){p.verifiedModel=model;p.verifiedEffort=effort;p.lastInferenceAt=Date.now();}});}
  async disconnect(profileId=this.data.activeId){
    await this.ready;let p=this.profile(profileId);if(!p)throw new Error('Conexão não encontrada.');
    if(this.refreshes.has(profileId))await this.refreshes.get(profileId).catch(()=>{});
    p=this.profile(profileId);
    let revoked=false;
    try{const meta=await this.metadata();if(p.refreshToken){const r=await this.fetcher(meta.revocation_endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:p.refreshToken,token_type_hint:'refresh_token',client_id:p.clientId}),signal:AbortSignal.timeout(10000)});revoked=r.status===200;}}catch{}
    await this.mutate(d=>{const r=d.profiles.find(x=>x.id===profileId);delete r.accessToken;delete r.refreshToken;delete r.idToken;r.verifiedModel=null;});this.catalogs.delete(profileId);
    return{revoked,message:revoked?'Conexão encerrada.':'Conexão encerrada neste computador. A revogação remota não foi confirmada; você também pode desconectar o aplicativo nas configurações do ChatGPT.'};
  }
}
let instance;
export function chatgptAuth(){return instance ||= new ChatGPTAuth();}
