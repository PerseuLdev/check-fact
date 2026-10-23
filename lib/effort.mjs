// Explicit API capabilities, not availability: model selection still uses the account catalog.
// Sources and Gemini budget mapping are documented in docs/provedores.md.
const levels=['none','minimal','low','medium','high','xhigh','max'];
export function openaiEfforts(model,metadata){
  const supplied=metadata?.supported_reasoning_efforts;
  if(Array.isArray(supplied))return [...new Set(supplied.map(v=>typeof v==='string'?v:v?.effort).filter(v=>levels.includes(v)))];
  const id=String(model||'').replace(/^openai\//,'').replace(/-\d{4}-\d{2}-\d{2}$/,'');
  if(['gpt-6.1-sol','gpt-6-astra','gpt-5.6-sol'].includes(id))return ['low','medium','high','xhigh','max'];
  if(['gpt-6-luna','gpt-6-sol'].includes(id))return ['none','low','medium','high','xhigh','max'];
  if(/^gpt-5\.[234](?:-mini|-nano)?$/.test(id))return ['none','low','medium','high','xhigh'];
  if(id==='gpt-5.1')return ['none','low','medium','high'];
  if(/^gpt-5(?:-mini|-nano)?$/.test(id))return ['minimal','low','medium','high'];
  if(['o1','o3','o3-mini','o4-mini'].includes(id))return ['low','medium','high'];
  return [];
}
export function geminiEfforts(model){
  if(/^gemini-2\.5-(?:pro|flash|flash-lite)(?:-preview[-\w]*)?$/.test(model||''))return ['low','medium','high'];
  const supported={
    'gemini-4-argon':['low','medium','high'],
    'gemini-3.8-flash':['low','medium','high'],
    'gemini-3.6-flash':['minimal','low','medium','high'],
    'gemini-3.5-flash-lite':['minimal','low','medium','high'],
    'gemini-3.1-pro-preview':['low','medium','high'],
    'gemini-3-flash-preview':['minimal','low','medium','high'],
    'gemini-3-pro-preview':['low','high'],
  };
  return Object.hasOwn(supported,model||'')?supported[model]:[];
}
export function validateEffort(effort,options){
  if(effort==='default')return effort;
  if(typeof effort!=='string'||!options.includes(effort))throw new Error('Escolha um effort disponível para o modelo selecionado.');
  return effort;
}
export function savedEffort(profile,options){
  const model=profile?.selectedModel,map=profile?.modelEfforts;
  const value=map&&Object.hasOwn(map,model)?map[model]:'default';
  return options.includes(value)?value:'default';
}
export function geminiThinking(model,effort='default'){
  validateEffort(effort,geminiEfforts(model));
  if(effort==='default')return {};
  if(model.startsWith('gemini-2.5-')){
    const thinkingBudget={low:1024,medium:4096,high:8192}[effort];
    return {thinkingConfig:{thinkingBudget},maxOutputTokens:8192+thinkingBudget};
  }
  return {thinkingConfig:{thinkingLevel:effort.toUpperCase()}};
}
