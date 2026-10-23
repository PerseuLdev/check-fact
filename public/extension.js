const input=document.getElementById('token'),message=document.getElementById('message');
try { const r=await fetch('/api/extension/pairing',{cache:'no-store'});if(!r.ok)throw new Error('Use o endereço local para parear.');input.value=(await r.json()).token; }
catch(e){message.textContent=e.message;}
document.getElementById('copy').onclick=async()=>{try{await navigator.clipboard.writeText(input.value);message.textContent='Código copiado. Cole no painel da extensão.';}catch{input.select();message.textContent='Selecione e copie o código com Ctrl+C.';}};
