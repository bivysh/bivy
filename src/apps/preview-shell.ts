// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/** This document lives on a different origin from app code. Never put a
 * generated document on the shell host or let the frame navigate its parent.
 * Everything the app's inspector reports is untrusted: it is displayed and
 * turned into drafts the user reviews, never sent or acted on by itself. */
export function previewShell(nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>Bivy · App preview</title>
<link rel="stylesheet" href="/__bivy/tokens.css"><link rel="stylesheet" href="/__bivy/styles.css">
<style nonce="${nonce}">
html,body { margin:0; width:100%; height:100%; }
body { display:flex; flex-direction:column; background:var(--surface-2); color:var(--ink); font-family:var(--font-sans); }
#stage { flex:1; min-height:0; display:flex; justify-content:center; }
iframe { width:100%; height:100%; border:0; background:var(--bg); }
#stage[data-lens="tablet"] iframe { max-width:768px; }
#stage[data-lens="phone"] iframe { max-width:390px; }
#stage:not([data-lens="full"]) iframe { border-inline:thin solid var(--line); box-shadow:var(--shadow-sm); }
#status { padding:var(--space-4); margin:0; font-size:var(--text-sm); }
#down { flex-shrink:0; }
/* The pill floats above the app instead of taking a header row from it. */
#dock { position:fixed; left:var(--space-2); right:var(--space-2); bottom:calc(var(--space-2) + env(safe-area-inset-bottom)); z-index:var(--z-sticky); display:flex; flex-direction:column; align-items:center; gap:var(--space-2); pointer-events:none; }
#dock > * { pointer-events:auto; }
/* The hint sits over the app; a tap on it is meant for the app underneath. */
#dock > #pointing { pointer-events:none; }
nav { display:flex; align-items:center; gap:var(--space-1); max-width:100%; padding:var(--space-1); background:var(--surface); border:thin solid var(--line); border-radius:var(--radius-full); box-shadow:var(--shadow-lg); }
nav .btn { flex-shrink:0; border-radius:var(--radius-full); }
nav .btn[aria-pressed="true"] { background:var(--accent-soft); color:var(--accent); }
#name { display:flex; flex-direction:column; min-width:0; padding:0 var(--space-2); }
#title { font-size:var(--text-sm); font-weight:var(--weight-semibold); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:14em; }
#stamp { font-size:var(--text-xs); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
#stamp:empty { display:none; }
#lens { flex-shrink:0; }
.panel { width:min(560px, 100%); max-height:50vh; overflow:auto; background:var(--surface); border:thin solid var(--line); border-radius:var(--radius-lg); box-shadow:var(--shadow-lg); padding:var(--space-3); box-sizing:border-box; }
.panel h2 { font-size:var(--text-sm); margin:0 0 var(--space-2); display:flex; align-items:center; justify-content:space-between; gap:var(--space-2); }
.panel-actions { display:flex; justify-content:flex-end; gap:var(--space-2); margin-top:var(--space-2); flex-wrap:wrap; }
#compare-stage { display:grid; justify-content:center; background:var(--surface-2); border-radius:var(--radius-md); overflow:hidden; }
/* Both shots share one grid cell, so they overlay exactly at any size. */
#compare-stage img { grid-area:1 / 1; display:block; max-height:32vh; max-width:100%; }
/* Same column as the shots, so the handle sits on the split. */
#compare-slider { grid-area:2 / 1; width:100%; margin:var(--space-2) 0; accent-color:var(--accent); }
#compare-hint { font-size:var(--text-xs); margin:var(--space-1) 0 0; }
#entries { list-style:none; margin:0; padding:0; font-family:var(--font-mono); font-size:var(--text-xs); }
#entries li { display:flex; gap:var(--space-2); align-items:baseline; padding:var(--space-1) 0; border-top:thin solid var(--line); overflow-wrap:anywhere; }
/* Keeps .field's 16px: smaller, and iOS zooms the shell on focus and stays zoomed. */
#draft-text { width:100%; min-height:5em; box-sizing:border-box; resize:vertical; }
#draft-hint { font-size:var(--text-xs); margin:var(--space-2) 0 var(--space-1); }
#draft-context { margin:0; padding:var(--space-2); background:var(--surface-2); border-radius:var(--radius-md); font-family:var(--font-mono); font-size:var(--text-xs); white-space:pre-wrap; overflow-wrap:anywhere; color:var(--muted); }
#show { position:fixed; right:var(--space-3); bottom:calc(var(--space-3) + env(safe-area-inset-bottom)); z-index:var(--z-sticky); border-radius:var(--radius-full); box-shadow:var(--shadow-lg); }
.label-narrow { display:none; }
@media (max-width: 699px) { #lens { display:none; } #name { display:none; } .label-wide { display:none; } .label-narrow { display:inline; } }
[hidden] { display:none !important; }
</style></head><body>
<div class="banner" data-tone="warn" id="down" hidden><span class="banner-text" id="down-text" role="status"></span><span class="banner-actions"><button class="btn sm" id="ask" hidden>Ask agent to fix</button></span></div>
<p id="status" role="status">Opening app…</p>
<div id="stage" data-lens="full"><iframe id="app" title="App preview" hidden sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups" referrerpolicy="no-referrer"></iframe></div>
<div id="dock">
  <section class="panel" id="console" hidden aria-labelledby="console-title">
    <h2><span id="console-title">Console</span><button class="btn sm ghost" id="clear">Clear</button></h2>
    <p class="muted" id="console-empty">No errors or warnings since this page loaded.</p>
    <ul id="entries"></ul>
    <div class="panel-actions"><button class="btn sm" id="send-errors" disabled>Send to agent…</button></div>
  </section>
  <section class="panel" id="compare" hidden aria-labelledby="compare-title">
    <h2 id="compare-title">Before and after the agent’s last change</h2>
    <div id="compare-stage"><img id="compare-after" alt="After the agent’s last change"><img id="compare-before" alt="Before the agent’s last change"><input type="range" id="compare-slider" min="0" max="100" value="50" aria-label="Show more of before or after"></div>
    <p class="muted" id="compare-hint">Left of the handle: before. Right: now. Screenshots at phone width.</p>
  </section>
  <section class="panel" id="draft" hidden aria-labelledby="draft-title">
    <h2 id="draft-title">Draft for the agent</h2>
    <textarea class="field" id="draft-text" aria-label="What should change?" placeholder="What should change?"></textarea>
    <p class="muted" id="draft-hint">Sent with this context from the preview. Nothing is sent until you send it in the chat.</p>
    <pre id="draft-context"></pre>
    <div class="panel-actions"><button class="btn sm ghost" id="draft-cancel">Cancel</button><button class="btn sm primary" id="draft-add">Add to chat</button></div>
  </section>
  <p class="banner inline" data-tone="accent" id="pointing" role="status" hidden>Tap anything in the app to point at it. Press Escape or Point again to stop.</p>
  <nav aria-label="Bivy preview controls">
    <button class="btn sm ghost" id="back" aria-label="Back to chat">‹ <span class="label-wide">Back to chat</span><span class="label-narrow">Chat</span></button>
    <span id="name"><span id="title">App preview</span><span id="stamp" class="muted" role="status"></span></span>
    <button class="btn sm ghost" id="hide" aria-label="Hide Bivy controls" title="Hide controls">⌄</button>
    <button class="btn sm ghost" id="point" aria-pressed="false" disabled>Point</button>
    <button class="btn sm ghost" id="compare-btn" aria-pressed="false" hidden>Compare</button>
    <button class="btn sm ghost" id="errors" aria-pressed="false" aria-label="Console" disabled>Console <span class="badge" data-variant="solid" data-tone="danger" id="error-count" hidden></span></button>
    <div class="segmented" id="lens" role="radiogroup" aria-label="Preview width"><button class="seg-btn" role="radio" aria-selected="true" data-lens="full">Full</button><button class="seg-btn" role="radio" aria-selected="false" data-lens="tablet">Tablet</button><button class="seg-btn" role="radio" aria-selected="false" data-lens="phone">Phone</button></div>
    <button class="btn sm ghost" id="reload" disabled>Reload</button>
  </nav>
</div>
<button class="btn sm" id="show" hidden aria-label="Show Bivy controls">Bivy</button>
<script nonce="${nonce}">
const $=id=>document.getElementById(id);
const frame=$('app'),status=$('status'),back=$('back'),reload=$('reload'),stage=$('stage');
// "#ticket~page": a review card opens the preview on the page it shows.
const [ticket,startPage='']=location.hash.slice(1).split('~');history.replaceState(null,'',location.pathname);
let metadata,currentPath='/';
// Peek: framed by a Bivy client, which owns closing and the composer.
const embedded=parent!==window;
const toBivy=m=>parent.postMessage(Object.assign({source:'bivy-preview'},m),new URL(metadata.returnTo).origin);
const storageKey='bivy-preview';
const safePath=p=>typeof p==='string'&&p.startsWith('/')&&!p.startsWith('//')&&p.length<=2048?p:'/';
const open=(path,message)=>{status.hidden=false;status.textContent=message;resetConsole();frame.src=metadata.origin+safePath(path);};
function show(data,launch){
  metadata=data;
  $('title').textContent=data.name;
  $('title').title=data.name;
  document.title='Bivy · '+data.name;
  back.title=data.returnTo?'Return to '+new URL(data.returnTo).host:'Close preview';
  frame.title=data.name;
  frame.hidden=false;
  // Desktop apps have no page to inspect: no Point or Console. Their viewer
  // (Bivy's own code) may use the clipboard; generated web apps may not.
  // (Set before navigating: the policy is fixed when the frame loads.)
  for(const b of [$('point'),$('errors')])b.hidden=data.inspect===false;
  if(data.inspect===false)frame.allow='clipboard-read; clipboard-write';
  frame.src=data.origin+(launch?'/__bivy/open#'+(embedded?'e:':'')+launch+(startPage?'~'+startPage:''):'/');
  back.hidden=embedded&&Boolean(data.returnTo);
  for(const b of [reload,$('point'),$('errors')])b.disabled=false;
  status.textContent='Loading app…';
  frame.onload=()=>{status.hidden=true;void loadCompare();if(revision===null){revision=-1;watch();}else if(wake)wake();};
  // Store navigation metadata only, never tickets or cookies.
  try{sessionStorage.setItem(storageKey,JSON.stringify(data));}catch{}
}
// Reload when an agent turn changes files, returning to the page in view.
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
      open(currentPath!=='/'?currentPath:d.path,'Updating…');
      $('stamp').textContent='Updated after the agent’s turn';
      // Screenshots for Compare land a few seconds after the change.
      for(const ms of [5000,15000])setTimeout(()=>void loadCompare(),ms);
    }
    revision=d.revision;retry=0;setTimeout(watch,0);
  }catch{retry=Math.min(30000,(retry||1000)*2);const t=setTimeout(watch,retry);wake=()=>{clearTimeout(t);watch();};}
}
// Drafts go to the session's composer; nothing is ever sent from here.
function toChat(text){
  if(embedded)return toBivy({type:'draft',text});
  const to=new URL(metadata.returnTo),session=to.pathname.split('/').pop();
  location.assign(to.origin+'/share?session='+encodeURIComponent(session)+'&text='+encodeURIComponent(text));
}
function draft(context){
  panels(null);
  $('draft').hidden=false;
  $('draft-add').textContent=metadata.returnTo?'Add to chat':'Copy';
  $('draft-context').textContent=context;
  const box=$('draft-text');box.value='';box.focus();
}
$('draft-cancel').onclick=()=>{$('draft').hidden=true;};
$('draft-add').onclick=async()=>{
  const note=$('draft-text').value.trim(),text=(note?note+'\\n\\n':'')+$('draft-context').textContent;
  if(metadata.returnTo)return toChat(text);
  try{await navigator.clipboard.writeText(text);$('draft-add').textContent='Copied';}catch{$('draft-text').select();}
};
// Console
let entries=[];
function resetConsole(){entries=[];renderConsole();}
function renderConsole(){
  const errors=entries.filter(e=>e.level==='error').length,count=$('error-count');
  count.hidden=!errors;count.textContent=String(errors);
  $('errors').setAttribute('aria-label',errors?'Console, '+errors+' error'+(errors===1?'':'s'):'Console');
  $('console-empty').hidden=entries.length>0;$('send-errors').disabled=!entries.length;
  $('entries').replaceChildren(...entries.map(e=>{const li=document.createElement('li');const tag=document.createElement('span');tag.className='badge';tag.dataset.tone=e.level==='error'?'danger':'warn';tag.textContent=e.level;const text=document.createElement('span');text.textContent=e.text;li.append(tag,text);return li;}));
}
$('errors').onclick=()=>panels($('console').hidden?'console':null);
$('clear').onclick=resetConsole;
$('send-errors').onclick=()=>draft('Console output in the app preview "'+metadata.name+'" (page '+currentPath+'):\\n'+entries.slice(-20).map(e=>'- '+e.level+': '+e.text).join('\\n'));
// Point and tell
const point=$('point');
function pointing(on){point.setAttribute('aria-pressed',String(on));$('pointing').hidden=!on;frame.contentWindow?.postMessage({type:'bivy:point',on},metadata.origin);}
point.onclick=()=>pointing(point.getAttribute('aria-pressed')!=='true');
function picked(d){
  pointing(false);
  if(d.cancelled)return;
  const r=d.rect||{},v=d.viewport||{};
  const errors=entries.filter(e=>e.level==='error').slice(-5);
  draft('In the app preview "'+metadata.name+'" (page '+safePath(d.path)+', viewport '+v.width+'×'+v.height+'):\\n'
    +'Element: '+String(d.selector).slice(0,300)+(d.text?' ("'+String(d.text).slice(0,200)+'")':'')+', '+r.width+'×'+r.height+' at '+r.x+','+r.y
    +(errors.length?'\\nRecent errors:\\n'+errors.map(e=>'- '+e.text).join('\\n'):''));
}
// Compare: screenshots around the agent's last change (agent screenshots on).
const compareBtn=$('compare-btn');let shots=[],urls=[];
async function loadCompare(){
  try{const r=await fetch(metadata.origin+'/__bivy/compare',{credentials:'include',cache:'no-store'});if(!r.ok)return;shots=(await r.json()).shots||[];compareBtn.hidden=shots.length<2;}catch{}
}
function panels(open){for(const [id,btn] of [['console','errors'],['compare','compare-btn']]){$(id).hidden=id!==open;$(btn).setAttribute('aria-pressed',String(id===open));}$('draft').hidden=true;}
compareBtn.onclick=async()=>{
  if(!$('compare').hidden)return panels(null);
  panels('compare');
  for(const u of urls)URL.revokeObjectURL(u);
  const pick=[shots[shots.length-2],shots[shots.length-1]];
  urls=await Promise.all(pick.map(async s=>URL.createObjectURL(await (await fetch(metadata.origin+'/__bivy/compare/'+s.index,{credentials:'include'})).blob())));
  const before=$('compare-before'),after=$('compare-after');
  before.src=urls[0];after.src=urls[1];
  split();
};
const split=()=>{$('compare-before').style.clipPath='inset(0 '+(100-Number($('compare-slider').value))+'% 0 0)';};
$('compare-slider').oninput=split;
// The pill can cover an app's own bottom bar; collapse it to a corner button.
$('hide').onclick=()=>{if(point.getAttribute('aria-pressed')==='true')pointing(false);$('dock').hidden=true;$('show').hidden=false;$('show').focus();};
$('show').onclick=()=>{$('dock').hidden=false;$('show').hidden=true;$('hide').focus();};
// Device lens (desktop widths)
for(const b of $('lens').querySelectorAll('button'))b.onclick=()=>{
  stage.dataset.lens=b.dataset.lens;
  for(const o of $('lens').querySelectorAll('button'))o.setAttribute('aria-selected',String(o===b));
};
// Messages from the app origin: server state and inspector reports.
const down=$('down'),downText=$('down-text'),ask=$('ask');
let downPort=0;
addEventListener('message',e=>{
  if(!metadata||e.origin!==metadata.origin||e.source!==frame.contentWindow)return;
  const d=e.data||{};
  if(d.type==='bivy:access'&&d.state==='blocked'&&embedded&&metadata.returnTo)toBivy({type:'blocked'});
  else if(d.type==='bivy:upstream'){
    downPort=Number(d.port)||0;
    down.hidden=d.state!=='down';
    downText.textContent='Nothing is answering on port '+downPort+'.';
    ask.hidden=!metadata.returnTo;
  }else if(d.source==='bivy-inspector'){
    if(d.type==='route')currentPath=safePath(d.path);
    else if(d.type==='console'&&(d.level==='error'||d.level==='warn')){entries.push({level:d.level,text:String(d.text).slice(0,500)});if(entries.length>50)entries.shift();renderConsole();}
    else if(d.type==='picked')picked(d);
  }
});
ask.onclick=()=>toChat('The app preview "'+metadata.name+'" isn’t loading: nothing is answering on port '+downPort+'. Please find out why the server stopped, restart it, and tell me when it’s back.');
addEventListener('keydown',e=>{if(e.key==='Escape'){if(point.getAttribute('aria-pressed')==='true')pointing(false);else panels(null);}});
back.onclick=()=>{if(metadata?.returnTo){window.close();setTimeout(()=>location.replace(metadata.returnTo),100);}else{window.close();status.hidden=false;status.textContent='You can close this tab to return to Bivy.';}};
reload.onclick=()=>{if(metadata)open(currentPath,'Reloading app…');};
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
