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
nav, #draw-bar { display:flex; align-items:center; gap:var(--space-1); max-width:100%; padding:var(--space-1); background:var(--surface); border:thin solid var(--line); border-radius:var(--radius-full); box-shadow:var(--shadow-lg); }
nav .btn, #draw-bar .btn { flex-shrink:0; border-radius:var(--radius-full); }
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
#draft-row { display:flex; align-items:flex-start; gap:var(--space-2); }
#draft-row #draft-text { flex:1; min-width:0; }
/* Hold to talk: a phone-sized target that never selects text or opens a callout. */
#mic { flex:none; inline-size:44px; block-size:44px; padding:0; border-radius:var(--radius-full); touch-action:none; user-select:none; -webkit-user-select:none; -webkit-touch-callout:none; }
#mic[aria-pressed="true"] { background:var(--accent); border-color:var(--accent); color:var(--accent-contrast); }
#voice-status { font-size:var(--text-xs); margin:var(--space-2) 0 0; }
#voice-status:empty { display:none; }
/* The panel scrolls on a phone; its actions stay in reach at the bottom. */
#draft .panel-actions { position:sticky; bottom:calc(-1 * var(--space-3)); margin:var(--space-2) calc(-1 * var(--space-3)) calc(-1 * var(--space-3)); padding:var(--space-2) var(--space-3) var(--space-3); background:var(--surface); border-top:thin solid var(--line); }
#draft-hint { font-size:var(--text-xs); margin:var(--space-2) 0 var(--space-1); }
#draft-context { margin:0; padding:var(--space-2); background:var(--surface-2); border-radius:var(--radius-md); font-family:var(--font-mono); font-size:var(--text-xs); white-space:pre-wrap; overflow-wrap:anywhere; color:var(--muted); }
#show { position:fixed; right:var(--space-3); bottom:calc(var(--space-3) + env(safe-area-inset-bottom)); z-index:var(--z-sticky); border-radius:var(--radius-full); box-shadow:var(--shadow-lg); }
/* Draw: marks over the frozen app (or Compare's "after" shot). The layer takes
   every touch, so nothing reaches the app; two fingers scroll the page. */
#ink { position:fixed; z-index:var(--z-sticky); touch-action:none; cursor:crosshair; user-select:none; -webkit-user-select:none; -webkit-touch-callout:none; }
#ink.frozen { pointer-events:none; cursor:default; }
#ink .halo { fill:none; stroke:var(--annotate-halo); stroke-width:7; stroke-linecap:round; stroke-linejoin:round; }
#ink .mark { fill:none; stroke:var(--annotate); stroke-width:4; stroke-linecap:round; stroke-linejoin:round; }
#dock > #drawing { pointer-events:none; }
/* Hints float over the app, whose page may be any colour: back them solidly. */
#dock > .banner.inline[data-tone="accent"] { background:color-mix(in srgb, var(--accent) 14%, var(--surface)); box-shadow:var(--shadow-sm); }
#draw-bar .btn { min-block-size:44px; }
#draw-bar .seg-btn { min-block-size:36px; min-inline-size:48px; }
#draw-bar .segmented { flex-shrink:0; }
#compare-draw { margin-top:var(--space-2); }
/* Marking a Compare shot: make it big enough to draw on with a thumb. */
#compare[data-drawing] #compare-stage img { max-height:min(60vh, 560px); }
#compare[data-drawing] #compare-slider, #compare[data-drawing] #compare-hint, #compare[data-drawing] #compare-draw { display:none; }
.label-narrow { display:none; }
@media (max-width: 699px) { #lens { display:none; } #name { display:none; } .label-wide { display:none; } .label-narrow { display:inline; } }
[hidden] { display:none !important; }
</style></head><body>
<div class="banner" data-tone="warn" id="down" hidden><span class="banner-text" id="down-text" role="status"></span><span class="banner-actions"><button class="btn sm" id="ask" hidden>Ask agent to fix</button></span></div>
<p id="status" role="status">Opening app…</p>
<div id="stage" data-lens="full"><iframe id="app" title="App preview" hidden sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups" referrerpolicy="no-referrer"></iframe></div>
<svg id="ink" hidden aria-hidden="true"></svg>
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
    <button class="btn sm" id="compare-draw" type="button" hidden>Draw on “now”</button>
  </section>
  <section class="panel" id="draft" hidden aria-labelledby="draft-title">
    <h2 id="draft-title">Draft for the agent</h2>
    <div id="draft-row"><textarea class="field" id="draft-text" aria-label="What should change?" placeholder="What should change?"></textarea>
    <button class="btn" id="mic" type="button" hidden aria-pressed="false" aria-label="Speak" title="Hold to speak, or tap to start and stop"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15.5a3 3 0 003-3V6a3 3 0 10-6 0v6.5a3 3 0 003 3z"/><path d="M6 11.5v1a6 6 0 0012 0v-1M12 18.5V21M9 21h6"/></svg></button></div>
    <p class="muted" id="voice-status" role="status"></p>
    <p class="muted" id="draft-hint">Sent with this context from the preview. Nothing is sent until you send it in the chat.</p>
    <pre id="draft-context"></pre>
    <div class="panel-actions"><button class="btn sm ghost" id="draft-cancel">Cancel</button><button class="btn sm primary" id="draft-add">Add to chat</button></div>
  </section>
  <p class="banner inline" data-tone="accent" id="pointing" role="status" hidden>Tap anything in the app to point at it. <span id="pointing-voice" hidden>Hold to point and speak. </span>Press Escape or Point again to stop.</p>
  <p class="banner inline" data-tone="accent" id="drawing" role="status" hidden>Circle or box what’s wrong, then Done. Two fingers scroll the page.</p>
  <div id="draw-bar" role="toolbar" aria-label="Drawing tools" hidden>
    <div class="segmented" role="radiogroup" aria-label="Mark with"><button class="seg-btn" type="button" role="radio" aria-checked="true" data-tool="pen">Pen</button><button class="seg-btn" type="button" role="radio" aria-checked="false" data-tool="box">Box</button></div>
    <button class="btn sm ghost" id="draw-undo" type="button" disabled>Undo</button>
    <button class="btn sm ghost" id="draw-clear" type="button" disabled>Clear</button>
    <button class="btn sm ghost" id="draw-cancel" type="button" aria-label="Stop drawing">✕</button>
    <button class="btn sm primary" id="draw-done" type="button" disabled>Done</button>
  </div>
  <nav aria-label="Bivy preview controls">
    <button class="btn sm ghost" id="back" aria-label="Back to chat">‹ <span class="label-wide">Back to chat</span><span class="label-narrow">Chat</span></button>
    <span id="name"><span id="title">App preview</span><span id="stamp" class="muted" role="status"></span></span>
    <button class="btn sm ghost" id="hide" aria-label="Hide Bivy controls" title="Hide controls">⌄</button>
    <button class="btn sm ghost" id="point" aria-pressed="false" disabled>Point</button>
    <button class="btn sm ghost" id="draw" type="button" hidden>Draw</button>
    <button class="btn sm ghost" id="compare-btn" aria-pressed="false" hidden>Compare</button>
    <button class="btn sm ghost" id="errors" aria-pressed="false" aria-label="Console" disabled>Console <span class="badge" data-variant="solid" data-tone="danger" id="error-count" hidden></span></button>
    <div class="segmented" id="lens" role="radiogroup" aria-label="Preview width"><button class="seg-btn" role="radio" aria-selected="true" data-lens="full">Full</button><button class="seg-btn" role="radio" aria-selected="false" data-lens="tablet">Tablet</button><button class="seg-btn" role="radio" aria-selected="false" data-lens="phone">Phone</button></div>
    <button class="btn sm ghost" id="reload" aria-label="Reload" disabled><span class="label-wide">Reload</span><span class="label-narrow" aria-hidden="true">↻</span></button>
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
  // A Bivy client framing the shell says whether it can take dictation.
  if(embedded&&data.returnTo)toBivy({type:'hello'});
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
function draft(context,listen){
  panels(null);
  $('draft').hidden=false;
  $('draft-add').textContent=metadata.returnTo?'Add to chat':'Copy';
  $('draft-context').textContent=context;
  const box=$('draft-text');box.value='';
  // Speaking right away: don't raise the keyboard over the draft.
  if(listen)startListening();else box.focus();
}
// Point and speak. The Bivy client framing this shell does the listening:
// audio never reaches this origin, and only the transcript comes back, into
// the draft box, where it stays editable. Hold to talk, or tap to start and
// tap again to stop.
const mic=$('mic'),voiceStatus=$('voice-status');
let voice=false,listening=false,heldAt=0;
const sayVoice=text=>{voiceStatus.textContent=text;};
function setListening(on){listening=on;mic.setAttribute('aria-pressed',String(on));mic.setAttribute('aria-label',on?'Stop and add what you said':'Speak');}
function startListening(){if(!voice||listening)return;setListening(true);sayVoice('Listening… let go, or tap the mic again, to add what you said.');toBivy({type:'listen',state:'start'});}
function stopListening(){if(!listening)return;sayVoice('Turning speech into text…');toBivy({type:'listen',state:'stop'});}
function cancelListening(){if(listening)toBivy({type:'listen',state:'cancel'});setListening(false);sayVoice('');}
function addSpoken(text){
  const box=$('draft-text'),said=String(text||'').trim().slice(0,4000);
  if(!said)return;
  box.value=box.value.trim()?box.value.trimEnd()+' '+said:said;
  sayVoice('Added what you said. Edit it, or Add to chat.');
}
mic.onpointerdown=e=>{
  e.preventDefault();
  if(listening){stopListening();heldAt=0;return;}
  heldAt=Date.now();try{mic.setPointerCapture(e.pointerId);}catch{}
  startListening();
};
// A short tap keeps listening until the next tap; a hold stops on release.
mic.onpointerup=mic.onpointercancel=()=>{if(heldAt&&Date.now()-heldAt>400)stopListening();heldAt=0;};
mic.onclick=e=>{if(e.detail===0){if(listening)stopListening();else startListening();}};
function fromBivy(d){
  if(d.type==='draw'){drawOk=d.available===true;$('draw').hidden=!drawOk;$('compare-draw').hidden=!drawOk;}
  else if(d.type==='voice'){voice=d.available===true;mic.hidden=!voice;$('pointing-voice').hidden=!voice;if(!voice)cancelListening();}
  else if(d.type==='transcript'){setListening(false);if(typeof d.error==='string')sayVoice(d.error.slice(0,200));else addSpoken(d.text);}
  else if(d.type==='listening'&&d.on===false&&listening){setListening(false);if(voiceStatus.textContent.startsWith('Listening'))sayVoice('');}
}
$('draft-cancel').onclick=()=>{cancelListening();$('draft').hidden=true;endDraw();};
$('draft-add').onclick=async()=>{
  cancelListening();
  const note=$('draft-text').value.trim(),text=(note?note+'\\n\\n':'')+$('draft-context').textContent;
  // Marks go to the Bivy client, which adds a picture made on the machine.
  if(marks){const mark=marks;endDraw();return toBivy({type:'annotation',text,mark});}
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
// Pointing again starts a new draft: panels over the app step aside.
function pointing(on){if(on)panels(null);point.setAttribute('aria-pressed',String(on));$('pointing').hidden=!on;frame.contentWindow?.postMessage({type:'bivy:point',on},metadata.origin);}
point.onclick=()=>pointing(point.getAttribute('aria-pressed')!=='true');
function picked(d){
  pointing(false);
  if(d.cancelled)return;
  // A long press: the draft opens listening, and letting go stops.
  if(d.hold&&voice)heldAt=Date.now();
  const r=d.rect||{},v=d.viewport||{};
  const errors=entries.filter(e=>e.level==='error').slice(-5);
  draft('In the app preview "'+metadata.name+'" (page '+safePath(d.path)+', viewport '+v.width+'×'+v.height+'):\\n'
    +'Element: '+String(d.selector).slice(0,300)+(d.text?' ("'+String(d.text).slice(0,200)+'")':'')+', '+r.width+'×'+r.height+' at '+r.x+','+r.y
    +(errors.length?'\\nRecent errors:\\n'+errors.map(e=>'- '+e.text).join('\\n'):''),d.hold===true&&voice);
}
// Draw: freeze the app and mark what's wrong. Marks are kept in page
// coordinates (so they stay on the content while two fingers scroll), and
// the app reports what's under each one. On Done they go into the draft box
// with that context; Add to chat hands them to the Bivy client, which gets a
// picture from the machine. Nothing about them goes through this origin's
// network. Compare's "after" shot can be marked the same way.
const ink=$('ink'),SVG='http://www.w3.org/2000/svg';
let draw=null,marks=null,drawOk=false,nextStroke=0;
const pos=v=>({x:Number(v?.x)||0,y:Number(v?.y)||0});
function startDraw(target){
  endDraw();if(point.getAttribute('aria-pressed')==='true')pointing(false);
  if(target==='frame')panels(null);
  if(target==='compare'){$('compare-slider').value='0';split();$('compare').dataset.drawing='';}
  // Tools first: they change the layout the marks are measured against.
  $('drawing').hidden=false;$('draw-bar').hidden=false;document.querySelector('nav').hidden=true;
  const r=placeInk(target);
  draw={target,rect:r,scroll:{x:0,y:0},strokes:[],elements:{},tool:'pen',current:null,pointers:new Map(),pan:null,done:false,
    state:{viewport:{width:Math.round(r.width),height:Math.round(r.height)},dpr:devicePixelRatio,path:currentPath,signals:{}}};
  ink.style.zIndex=target==='compare'?'calc(var(--z-sticky) + 1)':'';
  ink.classList.remove('frozen');ink.toggleAttribute('hidden',false);
  // Where the page is and what state it holds. Without an inspector (a
  // desktop app, or a page whose policy kept it out) state is unknown.
  if(target==='frame'&&metadata.inspect!==false){
    const current=draw;
    current.state.signals={unknown:true};
    current.waiting=d=>{current.waiting=null;current.scroll=pos(d.scroll);current.state={viewport:{width:Math.round(Number(d.viewport?.width))||current.state.viewport.width,height:Math.round(Number(d.viewport?.height))||current.state.viewport.height},dpr:Number(d.dpr)||devicePixelRatio,theme:d.theme==='dark'?'dark':'light',path:safePath(d.path),signals:Object.fromEntries(Object.entries(d.signals||{}).map(([k,v])=>[k,v===true]))};renderInk();};
    frame.contentWindow?.postMessage({type:'bivy:draw'},metadata.origin);
  }
  $('draw-bar').querySelector('[aria-checked="true"]').focus();
  updateDrawBar();renderInk();
}
/** Lays the marking layer over what's marked; returns where that is. */
function placeInk(target){
  const r=(target==='compare'?$('compare-after'):frame).getBoundingClientRect();
  Object.assign(ink.style,{left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px'});
  ink.setAttribute('viewBox','0 0 '+r.width+' '+r.height);
  return {left:r.left,top:r.top,width:r.width,height:r.height};
}
// A rotation or a keyboard moves things: keep the layer on them. (Marks on
// the frame are in page pixels, so they follow; the size in use is kept.)
addEventListener('resize',()=>{if(draw&&!draw.done)draw.rect=Object.assign(placeInk(draw.target),{});});
function endDraw(){
  if(!draw)return;
  delete $('compare').dataset.drawing;
  draw=null;marks=null;ink.toggleAttribute('hidden',true);ink.replaceChildren();
  $('drawing').hidden=true;$('draw-bar').hidden=true;document.querySelector('nav').hidden=false;
}
function updateDrawBar(){const has=Boolean(draw?.strokes.length);for(const id of ['draw-undo','draw-clear','draw-done'])$(id).disabled=!has;}
const onScreen=([x,y])=>draw.target==='frame'?[x-draw.scroll.x,y-draw.scroll.y]:[x,y];
function shape(stroke){
  const pts=stroke.points.map(onScreen);
  if(stroke.tool==='box'){const [a,b]=[pts[0],pts[pts.length-1]];const el=document.createElementNS(SVG,'rect');el.setAttribute('x',Math.min(a[0],b[0]));el.setAttribute('y',Math.min(a[1],b[1]));el.setAttribute('width',Math.abs(b[0]-a[0]));el.setAttribute('height',Math.abs(b[1]-a[1]));el.setAttribute('rx','3');return el;}
  const el=document.createElementNS(SVG,'polyline');el.setAttribute('points',pts.map(p=>p.join(',')).join(' '));return el;
}
function renderInk(){
  if(!draw)return;
  const all=[...draw.strokes,...(draw.current?[draw.current]:[])];
  ink.replaceChildren(...all.flatMap(s=>['halo','mark'].map(c=>{const el=shape(s);el.setAttribute('class',c);return el;})));
}
function local(e){const x=e.clientX-draw.rect.left,y=e.clientY-draw.rect.top;return draw.target==='frame'?[Math.round(x+draw.scroll.x),Math.round(y+draw.scroll.y)]:[Math.round(x),Math.round(y)];}
let scrollAsk=null;
function scrollPage(dx,dy){
  if(draw?.target!=='frame'||metadata.inspect===false)return;
  scrollAsk=scrollAsk?{dx:scrollAsk.dx+dx,dy:scrollAsk.dy+dy}:{dx,dy};
  requestAnimationFrame(()=>{if(!scrollAsk)return;frame.contentWindow?.postMessage(Object.assign({type:'bivy:scroll'},scrollAsk),metadata.origin);scrollAsk=null;});
}
const middle=()=>{const p=[...draw.pointers.values()];return {x:(p[0].x+p[1].x)/2,y:(p[0].y+p[1].y)/2};};
ink.onpointerdown=e=>{
  if(!draw||draw.done)return;e.preventDefault();try{ink.setPointerCapture(e.pointerId);}catch{}
  draw.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
  // A second finger scrolls instead: the stroke it interrupted is dropped.
  if(draw.pointers.size>=2){draw.current=null;draw.pan=middle();renderInk();return;}
  draw.current={id:nextStroke++,tool:draw.tool,points:[local(e)]};renderInk();
};
ink.onpointermove=e=>{
  if(!draw||!draw.pointers.has(e.pointerId))return;
  draw.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if(draw.pan&&draw.pointers.size>=2){const m=middle();scrollPage(draw.pan.x-m.x,draw.pan.y-m.y);draw.pan=m;return;}
  const s=draw.current;if(!s)return;const p=local(e);
  if(s.tool==='box')s.points=[s.points[0],p];
  else{const last=s.points[s.points.length-1];if(Math.hypot(p[0]-last[0],p[1]-last[1])<2||s.points.length>=2000)return;s.points.push(p);}
  renderInk();
};
ink.onpointerup=ink.onpointercancel=e=>{
  if(!draw)return;draw.pointers.delete(e.pointerId);if(draw.pointers.size<2)draw.pan=null;
  const s=draw.current;draw.current=null;
  if(s&&e.type==='pointerup'){
    const xs=s.points.map(p=>p[0]),ys=s.points.map(p=>p[1]),w=Math.max(...xs)-Math.min(...xs),h=Math.max(...ys)-Math.min(...ys);
    if(w>=4||h>=4){
      draw.strokes.push(s);
      // Ask what's under it while it's on screen (viewport coordinates).
      if(draw.target==='frame'&&metadata.inspect!==false){const [x,y]=onScreen([Math.min(...xs),Math.min(...ys)]);frame.contentWindow?.postMessage({type:'bivy:marks',id:s.id,rect:{x,y,width:w,height:h}},metadata.origin);}
    }
  }
  updateDrawBar();renderInk();
};
ink.onwheel=e=>{if(!draw||draw.done)return;e.preventDefault();scrollPage(e.deltaX,e.deltaY);};
for(const b of $('draw-bar').querySelectorAll('[data-tool]'))b.onclick=()=>{if(!draw)return;draw.tool=b.dataset.tool;for(const o of $('draw-bar').querySelectorAll('[data-tool]'))o.setAttribute('aria-checked',String(o===b));};
$('draw-undo').onclick=()=>{if(!draw)return;const s=draw.strokes.pop();if(s)delete draw.elements[s.id];updateDrawBar();renderInk();};
$('draw-clear').onclick=()=>{if(!draw)return;draw.strokes=[];draw.elements={};updateDrawBar();renderInk();};
$('draw-cancel').onclick=()=>endDraw();
$('draw').onclick=()=>startDraw('frame');
$('compare-draw').onclick=()=>startDraw('compare');
$('draw-done').onclick=()=>{
  if(!draw||!draw.strokes.length)return;
  const d=draw,st=d.state,seen=new Set(),els=[];
  for(const s of d.strokes)for(const el of d.elements[s.id]||[]){const key=String(el.selector);if(!seen.has(key)){seen.add(key);els.push(el);}}
  const bounds=s=>{const xs=s.points.map(p=>p[0]),ys=s.points.map(p=>p[1]);return s.tool+' '+Math.min(...xs)+','+Math.min(...ys)+'–'+Math.max(...xs)+','+Math.max(...ys);};
  const where=d.target==='compare'?'On the Compare screenshot after the agent’s last change in "'+metadata.name+'"':metadata.inspect===false?'On the desktop app "'+metadata.name+'"':'In the app preview "'+metadata.name+'"';
  const scrolled=d.target==='frame'&&(d.scroll.x||d.scroll.y)?', scrolled to '+d.scroll.x+','+d.scroll.y:'';
  const context=where+' (page '+st.path+', viewport '+st.viewport.width+'×'+st.viewport.height+scrolled+'), marked:\\n'
    +(els.length?els.map(el=>'- '+String(el.selector).slice(0,300)+(el.text?' ("'+String(el.text).slice(0,120)+'")':'')).join('\\n')+'\\n':'')
    +'Marks ('+(d.target==='compare'?'screenshot':'page')+' px): '+d.strokes.map(bounds).join('; ');
  const mark=Object.assign({path:st.path,viewport:st.viewport,dpr:st.dpr,strokes:d.strokes.map(s=>({tool:s.tool,points:s.points})),signals:st.signals},
    d.target==='frame'?{scroll:d.scroll,theme:st.theme}:{compare:compareAfter});
  // The marks stay on screen, frozen, while you add your words.
  d.done=true;draw=null;
  draft(context,false);
  draw=d;marks=mark;ink.classList.add('frozen');
  // Compare closed for the draft box: its marks go with it (they're in the context).
  if(d.target==='compare')ink.toggleAttribute('hidden',true);$('drawing').hidden=true;$('draw-bar').hidden=true;document.querySelector('nav').hidden=false;
};
// Compare: screenshots around the agent's last change (agent screenshots on).
const compareBtn=$('compare-btn');let shots=[],urls=[],compareAfter=-1;
async function loadCompare(){
  try{const r=await fetch(metadata.origin+'/__bivy/compare',{credentials:'include',cache:'no-store'});if(!r.ok)return;shots=(await r.json()).shots||[];compareBtn.hidden=shots.length<2;}catch{}
}
function panels(open){if(listening)cancelListening();if(draw&&!(open==='compare'&&draw.target==='compare'))endDraw();for(const [id,btn] of [['console','errors'],['compare','compare-btn']]){$(id).hidden=id!==open;$(btn).setAttribute('aria-pressed',String(id===open));}$('draft').hidden=true;}
compareBtn.onclick=async()=>{
  if(!$('compare').hidden)return panels(null);
  panels('compare');
  for(const u of urls)URL.revokeObjectURL(u);
  const pick=[shots[shots.length-2],shots[shots.length-1]];
  compareAfter=pick[1].index;
  urls=await Promise.all(pick.map(async s=>URL.createObjectURL(await (await fetch(metadata.origin+'/__bivy/compare/'+s.index,{credentials:'include'})).blob())));
  const before=$('compare-before'),after=$('compare-after');
  before.src=urls[0];after.src=urls[1];
  // Drawing on "now" measures the picture, so wait until it's there.
  $('compare-draw').disabled=true;
  void Promise.all([before.decode(),after.decode()]).catch(()=>{}).then(()=>{$('compare-draw').disabled=false;});
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
  // The Bivy client framing this shell (Peek): voice only.
  if(embedded&&metadata?.returnTo&&e.source===parent&&e.origin===new URL(metadata.returnTo).origin){if(e.data?.source==='bivy')fromBivy(e.data);return;}
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
    else if(d.type==='release'&&heldAt){heldAt=0;stopListening();}
    else if(d.type==='draw-state'&&draw&&draw.waiting){draw.waiting(d);}
    else if(d.type==='scrolled'&&draw&&draw.target==='frame'){draw.scroll=pos(d.scroll);renderInk();}
    else if(d.type==='marked'&&draw){draw.elements[Number(d.id)]=Array.isArray(d.elements)?d.elements.slice(0,8):[];}
  }
});
ask.onclick=()=>toChat('The app preview "'+metadata.name+'" isn’t loading: nothing is answering on port '+downPort+'. Please find out why the server stopped, restart it, and tell me when it’s back.');
addEventListener('keydown',e=>{if(e.key==='Escape'){if(listening)cancelListening();else if(draw&&!draw.done)endDraw();else if(point.getAttribute('aria-pressed')==='true')pointing(false);else panels(null);}});
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
