// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/** This document lives on a different origin from app code. Never put a
 * generated document on the shell host or let the frame navigate its parent. */
export function previewShell(nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Bivy · App preview</title>
<link rel="stylesheet" href="/__bivy/tokens.css"><link rel="stylesheet" href="/__bivy/styles.css">
<style nonce="${nonce}">
html,body { margin:0; width:100%; height:100%; }
body { display:flex; flex-direction:column; background:var(--bg); color:var(--ink); font-family:var(--font-sans); }
nav { display:flex; align-items:center; gap:var(--space-2); padding:var(--space-2) var(--space-3); border-bottom:thin solid var(--line); background:var(--surface); flex-shrink:0; }
nav .btn { min-height:var(--space-7); flex-shrink:0; }
#stamp { font-size:var(--text-xs); white-space:nowrap; }
#title { flex:1; min-width:0; font-size:var(--text-sm); font-weight:var(--weight-semibold); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#down { flex-shrink:0; }
#status { padding:var(--space-4); margin:0; font-size:var(--text-sm); }
iframe { flex:1; min-height:0; width:100%; border:0; background:var(--bg); }
[hidden] { display:none !important; }
</style></head><body>
<nav aria-label="Bivy preview controls"><button class="btn ghost" id="back">‹ Back to chat</button><span id="title">App preview</span><span id="stamp" class="muted" role="status"></span><button class="btn ghost" id="reload" disabled>Reload</button></nav>
<div class="banner" data-tone="warn" id="down" hidden><span class="banner-text" id="down-text" role="status"></span><span class="banner-actions"><button class="btn sm" id="ask" hidden>Ask agent to fix</button></span></div>
<p id="status" role="status">Opening app…</p>
<iframe id="app" title="App preview" hidden sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups" referrerpolicy="no-referrer"></iframe>
<script nonce="${nonce}">
const frame=document.getElementById('app'),status=document.getElementById('status'),back=document.getElementById('back'),reload=document.getElementById('reload');
const ticket=location.hash.slice(1);history.replaceState(null,'',location.pathname);
let metadata;
const storageKey='bivy-preview';
function show(data,launch){
  metadata=data;
  document.getElementById('title').textContent=data.name;
  document.getElementById('title').title=data.name;
  document.title='Bivy · '+data.name;
  back.title=data.returnTo?'Return to '+new URL(data.returnTo).host:'Close preview';
  frame.title=data.name;
  frame.hidden=false;
  frame.src=data.origin+(launch?'/__bivy/open#'+launch:'/');
  reload.disabled=false;
  status.textContent='Loading app…';
  frame.onload=()=>{status.hidden=true;if(revision===null){revision=-1;watch();}else if(wake)wake();};
  // Store navigation metadata only, never tickets or cookies.
  try{sessionStorage.setItem(storageKey,JSON.stringify(data));}catch{}
}
// Reload when an agent turn changes files, returning to the last framed page.
// Until the frame has redeemed its access cookie, polls fail; back off, and
// let the next frame load retry at once.
let revision=null,retry=0,wake=null;
async function watch(){
  wake=null;
  try{
    const r=await fetch(metadata.origin+'/__bivy/revision?after='+revision,{credentials:'include',cache:'no-store'});
    if(!r.ok)throw Error();
    const d=await r.json();
    if(revision>=0&&d.revision!==revision){
      const path=typeof d.path==='string'&&d.path.startsWith('/')&&!d.path.startsWith('//')?d.path:'/';
      frame.src=metadata.origin+path;
      document.getElementById('stamp').textContent='Updated after the agent’s turn';
    }
    revision=d.revision;retry=0;setTimeout(watch,0);
  }catch{retry=Math.min(30000,(retry||1000)*2);const t=setTimeout(watch,retry);wake=()=>{clearTimeout(t);watch();};}
}
// The app origin reports when its server stops answering. Its content is
// untrusted: the port is only ever placed in a draft the user reviews.
const down=document.getElementById('down'),downText=document.getElementById('down-text'),ask=document.getElementById('ask');
let downPort=0;
addEventListener('message',e=>{
  if(!metadata||e.origin!==metadata.origin||e.source!==frame.contentWindow||e.data?.type!=='bivy:upstream')return;
  downPort=Number(e.data.port)||0;
  down.hidden=e.data.state!=='down';
  downText.textContent='Nothing is answering on port '+downPort+'.';
  ask.hidden=!metadata.returnTo;
});
ask.onclick=()=>{
  const to=new URL(metadata.returnTo),session=to.pathname.split('/').pop();
  const text='The app preview "'+metadata.name+'" isn’t loading: nothing is answering on port '+downPort+'. Please find out why the server stopped, restart it, and tell me when it’s back.';
  location.assign(to.origin+'/share?session='+encodeURIComponent(session)+'&text='+encodeURIComponent(text));
};
back.onclick=()=>{if(metadata?.returnTo){window.close();setTimeout(()=>location.replace(metadata.returnTo),100);}else{window.close();status.hidden=false;status.textContent='You can close this tab to return to Bivy.';}};
reload.onclick=()=>{if(metadata){status.hidden=false;status.textContent='Reloading app…';frame.src=metadata.origin+'/';}};
(async()=>{
  if(ticket){
    const response=await fetch('/__bivy/launch',{method:'POST',headers:{'Content-Type':'text/plain'},body:ticket});
    if(!response.ok)throw Error();
    show(await response.json(),ticket);
  }else{
    const stored=JSON.parse(sessionStorage.getItem(storageKey)||'null');
    if(!stored)throw Error();
    show(stored);
  }
})().catch(()=>{status.hidden=false;status.textContent='This preview link expired or the app was removed. Open a fresh preview from your Bivy chat.';});
</script></body></html>`;
}
