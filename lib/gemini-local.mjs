import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {existsSync} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';

export function nativePermission(params){
  const call=params?.toolCall,allow=/^(?:google_web_search|GoogleSearch)(?:\b|:)/.test(call?.title||'');
  const option=allow?params.options?.find(o=>o.kind==='allow_once'):null;
  return{outcome:option?{outcome:'selected',optionId:option.optionId}:{outcome:'cancelled'}};
}
export class GeminiLocal extends EventEmitter{
  constructor({entry=join(process.env.APPDATA||join(homedir(),'AppData','Roaming'),'npm','node_modules','@google','gemini-cli','bundle','gemini.js'),dir=join(process.env.LOCALAPPDATA||join(homedir(),'.local','share'),'Verifica','GeminiLocal'),spawnProcess=spawn}={}){
    super();this.entry=entry;this.dir=dir;this.spawnProcess=spawnProcess;this.requests=new Map();this.turns=new Map();this.nextId=0;this.generation=0;this.state={configured:existsSync(entry),connected:false,pending:false,selectedModel:null,verifiedModel:null,connectionMode:'local',message:'Conecte sua conta Google pelo navegador.',authorizeUrl:null};this.ready=Promise.resolve();
  }
  snapshot(){return{...this.state,activeId:'gemini-local',projectId:null};}
  update(values){Object.assign(this.state,values);this.emit('change');}
  send(value){this.child?.stdin.write(JSON.stringify(value)+'\n');}
  request(method,params={},timeout=60000){return new Promise((resolve,reject)=>{const id=++this.nextId,timer=setTimeout(()=>{this.requests.delete(id);reject(new Error('O Gemini não respondeu a tempo. Tente conectar novamente.'));},timeout);timer.unref?.();this.requests.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});this.send({jsonrpc:'2.0',id,method,params});});}
  receive(message){
    if(message.id!==undefined&&!message.method){const r=this.requests.get(message.id);if(!r)return;this.requests.delete(message.id);if(message.error)r.reject(new Error('O Gemini não concluiu a operação. Confira a autorização e a disponibilidade da conta.'));else r.resolve(message.result);return;}
    if(message.method==='session/request_permission'){this.send({jsonrpc:'2.0',id:message.id,result:nativePermission(message.params)});return;}
    if(message.id!==undefined){this.send({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Operação indisponível neste cliente.'}});return;}
    if(message.method!=='session/update')return;const update=message.params?.update,turn=this.turns.get(message.params?.sessionId);if(!turn||!update)return;
    if(update.sessionUpdate==='agent_message_chunk'&&update.content?.type==='text')turn.text+=update.content.text;
    if(update.sessionUpdate==='tool_call')turn.tools.set(update.toolCallId,update.title||'');
    if(update.sessionUpdate==='tool_call_update'&&update.status==='completed'&&/google_web_search|Google Search|Search/i.test(turn.tools.get(update.toolCallId)||'')){
      // Only actual completed search-tool output can supply provenance.
      const raw=JSON.stringify(update.rawOutput??update.content??'');for(const url of raw.match(/https:\/\/[^\s"<>\\]+/g)||[])turn.sources.add(url.replace(/[),.;\]]+$/,''));
    }
    if(turn.text.length>500000)void this.request('session/cancel',{sessionId:message.params.sessionId}).catch(()=>{});
  }
  async launch(){
    if(this.child)return;if(!existsSync(this.entry))throw new Error('O componente Gemini precisa ser instalado neste computador para conectar pelo navegador.');
    const home=join(this.dir,'home'),cwd=join(this.dir,'workspace');await mkdir(join(home,'.gemini'),{recursive:true});await mkdir(cwd,{recursive:true});
    await writeFile(join(home,'.gemini','settings.json'),JSON.stringify({security:{auth:{selectedType:'oauth-personal'},folderTrust:{enabled:false}},tools:{core:['google_web_search'],allowed:['google_web_search']},mcp:{allowed:[]},hooks:{enabled:false},context:{fileName:[]},telemetry:{enabled:false}}));
    const env={...process.env,GEMINI_CLI_HOME:home,GEMINI_CLI_NO_RELAUNCH:'1'};for(const k of ['GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_APPLICATION_CREDENTIALS','GOOGLE_CLOUD_PROJECT','GOOGLE_GENAI_USE_VERTEXAI','GOOGLE_GEMINI_BASE_URL','GEMINI_SYSTEM_MD','NO_BROWSER'])delete env[k];
    const child=this.spawnProcess(process.execPath,[this.entry,'--acp','--extensions','none'],{cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});this.child=child;
    child.stdin.on('error',()=>{});const lines=createInterface({input:child.stdout});lines.on('line',line=>{if(line.length>2000000)return;try{this.receive(JSON.parse(line));}catch{}});
    let tail='';child.stderr.on('data',data=>{tail=(tail+data.toString()).slice(-12000);const match=tail.match(/https:\/\/accounts\.google\.com\/[^\s\u001b]+/);if(match){try{const url=new URL(match[0]);if(!url.searchParams.has('code')&&!url.searchParams.has('access_token'))this.update({authorizeUrl:url.href});}catch{}}});
    child.on('error',()=>this.end('Não foi possível iniciar o Gemini.'));
    child.on('close',()=>{lines.close();if(this.child===child){this.child=null;this.end('A conexão local do Gemini foi encerrada.');}});
    const info=await this.request('initialize',{protocolVersion:1,clientInfo:{name:'verifica',version:'0.1.0'},clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false}},30000);
    if(!info.authMethods?.some(m=>m.id==='oauth-personal'))throw new Error('Esta versão do Gemini não oferece login Google pelo aplicativo.');
    this.info=info;this.cwd=cwd;
  }
  end(message){for(const r of this.requests.values())r.reject(new Error(message));this.requests.clear();this.update({pending:false,connected:false,message,authorizeUrl:null});}
  async begin(){
    if(this.state.pending)return{};this.update({pending:true,verifiedModel:null,message:'Abrindo o login Google no navegador…',authorizeUrl:null});const generation=++this.generation;
    void(async()=>{try{await this.launch();await this.request('authenticate',{methodId:'oauth-personal'},300000);if(generation!==this.generation)return;const session=await this.request('session/new',{cwd:this.cwd,mcpServers:[]});if(generation!==this.generation)return;
      this.catalog=(session.models?.availableModels||[]).filter(m=>/^gemini-[-\w.]+$/.test(m.modelId)).map(m=>({id:m.modelId,name:m.name||m.modelId}));
      const selected=this.catalog.find(m=>m.id===session.models?.currentModelId)?.id||this.catalog.find(m=>m.id.includes('flash'))?.id||this.catalog[0]?.id;
      if(!selected)throw new Error('O Gemini não retornou os modelos disponíveis.');
      this.update({pending:false,connected:true,selectedModel:selected,message:'Google conectado. Gemini pronto para usar.',authorizeUrl:null});
    }catch(e){if(generation===this.generation){this.child?.kill();this.child=null;this.end(e.message);}}})();return{};
  }
  cancel(){this.generation++;const child=this.child;this.child=null;child?.kill();this.end('Conexão Gemini cancelada neste painel.');}
  async models(){if(!this.state.connected)throw new Error('Conecte sua conta Google para listar os modelos.');return this.catalog||[];}
  async selectModel(model){if(!(await this.models()).some(m=>m.id===model))throw new Error('Selecione um modelo disponível nesta conta.');this.update({selectedModel:model,verifiedModel:null});}
  async markInference(_id,model){this.update({verifiedModel:model});}
  async fetchAuthed(path,options){
    const match=/^\/models\/(gemini-[-\w.]+):generateContent$/.exec(path);if(!match||!this.state.connected)throw new Error('Conecte o Gemini antes de usar este modelo.');
    const request=JSON.parse(options.body),session=await this.request('session/new',{cwd:this.cwd,mcpServers:[]});
    const sessionId=session.sessionId;await this.request('session/set_model',{sessionId,modelId:match[1]});
    const turn={text:'',tools:new Map(),sources:new Set()};this.turns.set(sessionId,turn);
    const abort=()=>{void this.request('session/cancel',{sessionId}).catch(()=>{});};options.signal?.addEventListener('abort',abort,{once:true});
    try{
      if(options.signal?.aborted)throw new Error('Operação cancelada.');
      const prompt=[request.systemInstruction?.parts?.map(p=>p.text).join('\n'),request.contents?.flatMap(c=>c.parts).map(p=>p.text).join('\n'),request.generationConfig?.responseJsonSchema?'Retorne somente JSON válido de acordo com este schema: '+JSON.stringify(request.generationConfig.responseJsonSchema):'',request.tools?'Use google_web_search para pesquisar e cite fontes.':'Não use ferramentas nesta etapa.'].join('\n\n');
      const result=await this.request('session/prompt',{sessionId,prompt:[{type:'text',text:prompt}]},90000);
      if(options.signal?.aborted||result.stopReason!=='end_turn'||!turn.text)throw new Error('O Gemini não concluiu a resposta.');
      const text=turn.text.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
      return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text}]},groundingMetadata:{groundingChunks:[...turn.sources].map(uri=>({web:{uri}}))}}]});
    }finally{this.turns.delete(sessionId);options.signal?.removeEventListener('abort',abort);}
  }
  async disconnect(){this.cancel();return{revoked:false,message:'Gemini desconectado deste painel. O login é gerenciado pelo componente oficial do Google.'};}
}
