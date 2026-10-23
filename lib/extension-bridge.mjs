import { randomBytes, timingSafeEqual } from 'node:crypto';

// Deliberately expires when the local server restarts.
export const extensionToken = process.env.CHECK_FACT_EXTENSION_TOKEN || randomBytes(32).toString('hex');
export function extensionAccess(request, token = extensionToken) {
  const origin = request.headers.get('origin') || '';
  if (new URL(request.url).hostname !== '127.0.0.1' || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return false;
  const supplied = request.headers.get('authorization') || '';
  const expected = `Bearer ${token}`;
  return Buffer.byteLength(supplied) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}
export async function extensionRequest(request, getEngine) {
  const origin = request.headers.get('origin') || '';
  const validOrigin = /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
  const headers = { 'Cache-Control': 'no-store', 'Vary': 'Origin', ...(validOrigin ? { 'Access-Control-Allow-Origin': origin } : {}) };
  if (request.method === 'OPTIONS') return new Response(null, { status: validOrigin ? 204 : 403, headers: { ...headers, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'authorization, content-type' } });
  if (!extensionAccess(request)) return Response.json({error:'Pareie novamente com o servidor local.'}, {status:403,headers});
  try {
    if (!request.headers.get('content-type')?.includes('application/json')) throw new Error('Envie JSON.');
    const text = await request.text();
    if (text.length > 16000) throw new Error('Requisição muito grande.');
    const { action, data } = JSON.parse(text);
    const e = getEngine();
    if (action === 'start') await e.start(data || {});
    else if (action === 'stop') e.stop();
    else if (action === 'effort') {e.ensureIdle();if(e.provider!=='chatgpt')throw new Error('Selecione o ChatGPT nas configurações.');await e.oauth.selectEffort(data?.effort);}
    else if (action !== 'state') throw new Error('Operação não permitida.');
    return Response.json(e.snapshot(), {headers});
  } catch (error) { return Response.json({error:error.message}, {status:400,headers}); }
}
