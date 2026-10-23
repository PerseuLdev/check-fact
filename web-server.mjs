// Separate entry point: do not use eve's reserved server.mjs filename.
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { createWebApp } from './lib/web-app.mjs';

const port=Number(process.env.PORT||4311),origin=process.env.APP_PUBLIC_ORIGIN||`http://127.0.0.1:${port}`;
const app=createWebApp({origin,accessCode:process.env.WEB_ACCESS_CODE||''});
const host=process.env.HOST||(new URL(origin).protocol==='https:'?'0.0.0.0':'127.0.0.1');
const server=createServer(async(req,res)=>{
  const controller=new AbortController();res.on('close',()=>controller.abort());
  try{
    if(req.headers.host!==new URL(origin).host){res.writeHead(421,{'Content-Type':'text/plain; charset=utf-8'});res.end('Endereço não autorizado.');return;}
    const request=new Request(new URL(req.url,origin),{method:req.method,headers:req.headers,signal:controller.signal,...(!['GET','HEAD'].includes(req.method)?{body:Readable.toWeb(req),duplex:'half'}:{})});
    const response=await app.fetch(request,{ip:req.socket.remoteAddress});
    res.writeHead(response.status,Object.fromEntries(response.headers));
    if(response.body)Readable.fromWeb(response.body).on('error',()=>res.destroy()).pipe(res);else res.end();
  }catch{if(!res.headersSent)res.writeHead(500);res.end('Falha ao atender a solicitação.');}
});
server.requestTimeout=180000;server.headersTimeout=15000;
const sweep=setInterval(()=>app.sessions.sweep(),15000);sweep.unref();
server.listen(port,host,()=>process.stdout.write(`Verifica web: ${origin}\n`));
function close(){clearInterval(sweep);app.close();server.close();server.closeAllConnections();}
process.on('SIGINT',close);process.on('SIGTERM',close);
