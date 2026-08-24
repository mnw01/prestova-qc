/* 在 print 媒体下量各块的高度，看超了多少 */
const { spawn } = require('child_process'); const path=require('path'); const fs=require('fs');
const CHROME='C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT=9339, PROF=path.join(__dirname,'chromeprof-m');
fs.rmSync(PROF,{recursive:true,force:true});
const chrome=spawn(CHROME,['--headless=new','--disable-gpu','--hide-scrollbars',
  '--remote-debugging-port='+PORT,'--user-data-dir='+PROF,'--window-size=794,1123','about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  let t; for(let i=0;i<60;i++){ try{const l=await(await fetch('http://127.0.0.1:'+PORT+'/json/list')).json();
    t=l.find(x=>x.type==='page'); if(t)break;}catch(e){} await sleep(250);}
  const ws=new WebSocket(t.webSocketDebuggerUrl); let id=0; const p=new Map();
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data); if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}});
  await new Promise(r=>ws.addEventListener('open',r));
  const send=(m,q)=>new Promise(res=>{const n=++id;p.set(n,res);ws.send(JSON.stringify({id:n,method:m,params:q||{}}));});
  const ev=async x=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true});
    return r.result&&r.result.result?r.result.result.value:undefined;};
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate',{url:process.argv[2]});
  for(let i=0;i<120;i++){ await sleep(500); if((await ev('document.title')||'').startsWith('DEMO:')) break; }
  await send('Emulation.setEmulatedMedia',{media:'print'});
  await sleep(800);
  console.log(await ev(`(()=>{
    const mm = px => (px/96*25.4).toFixed(1);
    const s = document.getElementById('lsheet');
    const out = ['可打印高度(9mm页边距) 279.0mm ；模板要求正文高 246.2mm',
                 'sheet 总高 '+mm(s.getBoundingClientRect().height)+'mm'];
    const label = {'lbhead':'页眉','ttl':'标题'};
    [...s.querySelectorAll('.lbhead,h2.ttl,table.lb,p.lbnote,table.lbsig,.lbfoot')].forEach((n,i)=>{
      const r=n.getBoundingClientRect();
      out.push('  '+String(i).padStart(2)+' '+n.tagName.toLowerCase()+'.'+
        (n.className||'')+'  高 '+mm(r.height)+'mm');
    });
    return out.join(String.fromCharCode(10));
  })()`));
  ws.close(); chrome.kill(); process.exit(0);
})().catch(e=>{console.error(e);chrome.kill();process.exit(1);});
