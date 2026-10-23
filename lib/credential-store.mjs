import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export const storageDir=join(process.env.LOCALAPPDATA || join(homedir(),'.local','share'),'Verifica','ChatGPT');
export function pythonPath(){const p=join(process.cwd(),'.venv','Scripts','python.exe');return process.env.CHECK_FACT_PYTHON||(existsSync(p)?p:'python');}
export function dpapi(bytes,operation){
  return new Promise((resolve,reject)=>{
    const child=spawn(pythonPath(),[join(process.cwd(),'scripts','protect_credentials.py'),operation],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    const chunks=[];child.stdout.on('data',c=>chunks.push(c));child.stderr.resume();
    const timer=setTimeout(()=>{child.kill();reject(new Error('O armazenamento protegido não respondeu.'));},10000);
    child.on('error',()=>{clearTimeout(timer);reject(new Error('Não foi possível iniciar o armazenamento protegido.'));});
    child.on('close',code=>{clearTimeout(timer);code===0?resolve(Buffer.concat(chunks)):reject(new Error('Não foi possível abrir a conexão protegida pelo Windows.'));});
    child.stdin.on('error',()=>{});child.stdin.end(bytes);
  });
}
export class CredentialStore {
  constructor({dir=storageDir,platform=process.platform,cipher=dpapi}={}){this.dir=dir;this.platform=platform;this.cipher=cipher;this.tail=Promise.resolve();}
  async load(){
    try{
      const bytes=await readFile(join(this.dir,'connections.dat'));
      const raw=this.platform==='win32'?await this.cipher(bytes,'unprotect'):bytes;
      const d=JSON.parse(raw.toString('utf8'));if(d.version!==1||!Array.isArray(d.profiles))throw new Error('invalid');return d;
    }catch(e){if(e.code==='ENOENT')return{version:1,hostId:null,activeId:null,profiles:[]};throw new Error('A conexão local salva não pôde ser aberta. Nenhum token foi utilizado.');}
  }
  async save(data){
    await mkdir(this.dir,{recursive:true,mode:0o700});
    const raw=Buffer.from(JSON.stringify(data));const bytes=this.platform==='win32'?await this.cipher(raw,'protect'):raw;
    const temp=join(this.dir,`connections-${randomUUID()}.tmp`);
    await writeFile(temp,bytes,{mode:0o600,flag:'wx'});await rename(temp,join(this.dir,'connections.dat'));
  }
  transaction(fn){
    const task=this.tail.catch(()=>{}).then(async()=>{const d=await this.load();const result=await fn(d);await this.save(d);return{data:d,result};});
    this.tail=task;return task;
  }
}
