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
#dock > #drawing, #dock > #hint { pointer-events:none; }
nav, #draw-bar { display:flex; flex-wrap:wrap; justify-content:center; align-items:center; gap:var(--space-1); max-width:100%; padding:var(--space-1); background:var(--surface); border:thin solid var(--line); border-radius:var(--radius-xl); box-shadow:var(--shadow-lg); }
nav .btn, #draw-bar .btn { flex-shrink:0; border-radius:var(--radius-full); }
/* One row, however narrow: a bar that wraps doubles what it covers. Past the
   edge it scrolls sideways instead. */
nav { flex-wrap:nowrap; overflow-x:auto; scrollbar-width:none; }
nav::-webkit-scrollbar { display:none; }
#dock[data-edge="top"] { top:calc(var(--space-2) + env(safe-area-inset-top)); bottom:auto; flex-direction:column-reverse; }
#show[data-edge="top"] { top:calc(var(--space-3) + env(safe-area-inset-top)); bottom:auto; }
#name { display:flex; flex-direction:column; min-width:0; padding:0 var(--space-2); }
#title { font-size:var(--text-sm); font-weight:var(--weight-semibold); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:14em; }
#stamp { font-size:var(--text-xs); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:14em; }
#stamp:empty { display:none; }
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
#mic { flex:none; inline-size:var(--space-7); block-size:var(--space-7); padding:0; border-radius:var(--radius-full); touch-action:none; user-select:none; -webkit-user-select:none; -webkit-touch-callout:none; }
#mic[aria-pressed="true"] { background:var(--accent); border-color:var(--accent); color:var(--accent-contrast); }
#voice-status, #note-status { font-size:var(--text-xs); margin:var(--space-2) 0 0; }
#voice-status:empty, #note-status:empty { display:none; }
/* The note owns the dock while editing. Only its body scrolls; actions never
   cover the text field, even when the keyboard leaves little vertical room. */
#dock { max-height:calc(100% - var(--space-4)); }
#dock:has(#draft:not([hidden])) nav, #dock:has(#draft:not([hidden])) #drawing, #dock:has(#draft:not([hidden])) #menu { display:none; }
#draft { display:flex; flex-direction:column; max-height:70dvh; overflow:hidden; padding:0; }
#draft-body { min-height:0; overflow:auto; padding:var(--space-3); }
#draft .panel-actions { flex-shrink:0; margin:0; padding:var(--space-2) var(--space-3); border-top:thin solid var(--line); }
#draft details { margin-top:var(--space-2); }
#draft summary { color:var(--muted); font-size:var(--text-sm); cursor:pointer; }
#draft-hint { font-size:var(--text-xs); margin:var(--space-2) 0 var(--space-1); }
#draft-context { margin:0; padding:var(--space-2); background:var(--surface-2); border-radius:var(--radius-md); font-family:var(--font-mono); font-size:var(--text-xs); white-space:pre-wrap; overflow-wrap:anywhere; color:var(--muted); }
#show { position:fixed; right:var(--space-3); bottom:calc(var(--space-3) + env(safe-area-inset-bottom)); z-index:var(--z-sticky); border-radius:var(--radius-full); box-shadow:var(--shadow-lg); }
/* Draw: marks over the frozen app (or Compare's "after" shot). The layer takes
   every touch, so nothing reaches the app; two fingers scroll the page. */
#ink { position:fixed; z-index:var(--z-sticky); touch-action:none; cursor:crosshair; user-select:none; -webkit-user-select:none; -webkit-touch-callout:none; }
/* An HTML hit surface owns gestures even where the SVG has no painted marks. */
#ink svg { display:block; width:100%; height:100%; pointer-events:none; }
#ink.frozen { pointer-events:none; cursor:default; }
#ink .halo { fill:none; stroke:var(--annotate-halo); stroke-width:7; stroke-linecap:round; stroke-linejoin:round; }
#ink .mark { fill:none; stroke:var(--annotate); stroke-width:4; stroke-linecap:round; stroke-linejoin:round; }
/* A saved mark keeps its place while the next one is made, and wears its
   number, so a note and the thing it is about stay paired. */
#ink .saved { opacity:0.75; }
#ink .pip { fill:var(--annotate); stroke:var(--annotate-halo); stroke-width:2; }
#ink .pip-text { fill:var(--annotate-halo); font:var(--weight-semibold) 13px/1 var(--font-sans); text-anchor:middle; dominant-baseline:central; }
#mark-count { flex-shrink:0; }
/* Hints float over the app, whose page may be any colour: back them solidly. */
#dock > .banner.inline[data-tone="accent"] { background:color-mix(in srgb, var(--accent) 14%, var(--surface)); box-shadow:var(--shadow-sm); }
#dock .btn, #show, #down .btn, #dock .menu-item { min-block-size:var(--space-7); font-size:var(--text-sm); }
#dock .btn, #show { min-inline-size:var(--space-7); }
/* The menu belongs to the pill, so it sits over it. */
#menu { align-self:center; max-width:min(320px, 100%); }
#menu kbd { flex:none; padding:0 var(--space-1); border:thin solid var(--line); border-radius:var(--radius-sm); color:var(--muted); font-family:var(--font-mono); font-size:var(--text-xs); }
/* The name is a label, not a target: one pill, three buttons at most. */
#name { pointer-events:none; }
/* With scenarios, the name becomes their switcher: the title says which one
   you're in, the line under it whether Bivy is simulating anything. */
#scn { display:flex; align-items:center; gap:var(--space-1); min-width:0; padding-inline:var(--space-2); text-align:start; }
#scn[data-active] { background:color-mix(in srgb, var(--accent) 14%, var(--surface)); }
.scn-text { display:flex; flex-direction:column; min-width:0; }
#scn-title { font-weight:var(--weight-semibold); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:14em; }
#scn-sub { font-size:var(--text-xs); font-weight:var(--weight-normal); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:18em; }
#scn svg { flex:none; }
#dock:not([data-edge="top"]) #scn svg { transform:rotate(180deg); }
.scn-group { margin:var(--space-3) 0 var(--space-1); font-size:var(--text-xs); font-weight:var(--weight-semibold); color:var(--muted); }
.scn-group:first-of-type { margin-top:0; }
.scn-list { list-style:none; margin:0; padding:0; display:grid; grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); gap:var(--space-2); }
.scn-row { display:flex; align-items:flex-start; gap:var(--space-2); width:100%; height:100%; min-block-size:var(--space-7); box-sizing:border-box; padding:var(--space-2) var(--space-3); border:thin solid var(--line); border-radius:var(--radius-md); background:var(--surface); color:var(--ink); font:inherit; text-align:start; cursor:pointer; }
.scn-row:hover { background:var(--surface-2); }
.scn-row:focus-visible { outline:2px solid var(--focus-ring); outline-offset:1px; }
.scn-row[aria-current="true"] { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent); }
.scn-row-text { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
.scn-row-name { font-size:var(--text-sm); font-weight:var(--weight-semibold); overflow-wrap:anywhere; }
.scn-row-sub { font-size:var(--text-xs); color:var(--muted); overflow-wrap:anywhere; }
.scn-row .badge { flex:none; }
#scn-fail-text { font-size:var(--text-sm); margin:0; overflow-wrap:anywhere; }
#more { position:relative; gap:var(--space-1); }
#dock:not([data-edge="top"]) #more svg { transform:rotate(180deg); }
#compare-draw { margin-top:var(--space-2); }
/* Marking a Compare shot: make it big enough to draw on with a thumb. */
#compare[data-drawing] #compare-stage img { max-height:min(60vh, 560px); }
#compare[data-drawing] #compare-slider, #compare[data-drawing] #compare-hint, #compare[data-drawing] #compare-draw { display:none; }
.label-narrow { display:none; }
@media (max-width: 699px) { .wide-only { display:none; } .label-wide { display:none; } .label-narrow { display:inline; } #title, #scn-title { max-width:9em; } #scn-sub { max-width:12em; } }
/* "Made with Bivy": a quiet strip under a shared app, never over it. */
#made-with { flex-shrink:0; display:flex; align-items:center; justify-content:center; gap:var(--space-1); min-height:var(--space-6); padding:0 var(--space-3) env(safe-area-inset-bottom); box-sizing:border-box; background:var(--surface); border-top:thin solid var(--line); color:var(--muted); font-size:var(--text-xs); text-decoration:none; }
#made-with:hover, #made-with:focus-visible { color:var(--ink); }
body.badged #dock:not([data-edge="top"]) { bottom:calc(var(--space-2) + var(--space-6) + env(safe-area-inset-bottom)); }
[hidden] { display:none !important; }
</style></head><body>
<div class="banner" data-tone="warn" id="down" hidden><span class="banner-text" id="down-text" role="status"></span><span class="banner-actions"><button class="btn sm" id="ask" hidden>Ask agent to fix</button></span></div>
<p id="status" role="status">Opening app…</p>
<div id="stage" data-lens="full"><iframe id="app" title="App preview" hidden sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups" referrerpolicy="no-referrer"></iframe></div>
<a id="made-with" href="https://bivy.sh/?ref=preview" target="_blank" rel="noopener" hidden>Made with <strong>Bivy</strong><span aria-hidden="true">↗</span><span class="sr-only"> (opens in a new tab)</span></a>
<div id="ink" hidden aria-hidden="true"><svg id="ink-marks"></svg></div>
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
  <section class="panel" id="scenarios" hidden aria-labelledby="scenarios-title">
    <h2><span id="scenarios-title">Scenarios</span><button class="btn sm ghost" id="scenarios-close" type="button" aria-label="Close scenarios">✕</button></h2>
    <div id="scenarios-body"></div>
  </section>
  <section class="panel" id="scn-fail" hidden aria-labelledby="scn-fail-title" role="alertdialog">
    <h2 id="scn-fail-title">Couldn’t finish the scenario</h2>
    <p id="scn-fail-text"></p>
    <div class="panel-actions"><button class="btn sm ghost" id="scn-stay" type="button">Stay here</button><button class="btn sm primary" id="scn-fix" type="button">Ask agent to fix</button></div>
  </section>
  <section class="panel" id="draft" hidden aria-labelledby="draft-title">
    <div id="draft-body">
    <h2 id="draft-title">Note for the agent</h2>
    <div id="draft-row"><textarea class="field" id="draft-text" aria-label="What should change?" placeholder="What should change?"></textarea>
    <button class="btn" id="mic" type="button" hidden aria-pressed="false" aria-label="Speak" title="Hold to speak, or tap to start and stop"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15.5a3 3 0 003-3V6a3 3 0 10-6 0v6.5a3 3 0 003 3z"/><path d="M6 11.5v1a6 6 0 0012 0v-1M12 18.5V21M9 21h6"/></svg></button></div>
    <p class="muted" id="voice-status" role="status"></p>
    <p class="muted" id="draft-hint">Review in chat before sending.</p>
    <p class="muted" id="note-status" role="status"></p>
    <details id="draft-details"><summary>Preview context</summary><pre id="draft-context"></pre></details>
    </div>
    <div class="panel-actions"><button class="btn sm ghost" id="draft-cancel">Cancel</button><button class="btn sm" id="draft-more" type="button">Mark another</button><button class="btn sm primary" id="draft-add">Add to chat</button></div>
  </section>
  <p class="banner inline" data-tone="accent" id="hint" role="status" hidden>Press and hold anything in the app to mark what’s wrong.</p>
  <p class="banner inline" data-tone="accent" id="drawing" role="status" hidden>Tap what’s wrong, or circle it. Then Done. Two fingers scroll the page.</p>
  <div id="draw-bar" role="toolbar" aria-label="Marking tools" tabindex="-1" hidden>
    <span id="mark-count" class="badge" data-tone="accent" hidden></span>
    <button class="btn sm ghost" id="draw-undo" type="button" disabled>Undo</button>
    <button class="btn sm ghost" id="draw-clear" type="button" disabled>Clear</button>
    <button class="btn sm ghost" id="draw-cancel" type="button" aria-label="Stop marking">✕</button>
    <button class="btn sm primary" id="draw-done" type="button" disabled>Done</button>
  </div>
  <div class="menu" id="menu" role="menu" aria-label="Preview options" hidden>
    <button class="menu-item" role="menuitem" id="mark" type="button" aria-keyshortcuts="c" disabled><span class="menu-item-label">Mark something</span><kbd>C</kbd></button>
    <button class="menu-item" role="menuitemcheckbox" id="errors" type="button" aria-checked="false" disabled><span class="menu-item-label">Console</span></button>
    <button class="menu-item" role="menuitemcheckbox" id="compare-btn" type="button" aria-checked="false" hidden><span class="menu-item-label">Compare with before</span></button>
    <div class="menu-heading wide-only">Width</div>
    <button class="menu-item wide-only" role="menuitemradio" data-lens="full" type="button" aria-checked="true"><span class="menu-item-label">Full</span></button>
    <button class="menu-item wide-only" role="menuitemradio" data-lens="tablet" type="button" aria-checked="false"><span class="menu-item-label">Tablet</span></button>
    <button class="menu-item wide-only" role="menuitemradio" data-lens="phone" type="button" aria-checked="false"><span class="menu-item-label">Phone</span></button>
    <button class="menu-item separated" role="menuitem" id="reload" type="button" disabled><span class="menu-item-label">Reload</span></button>
    <button class="menu-item" role="menuitem" id="edge" type="button"><span class="menu-item-label">Move to top</span></button>
    <button class="menu-item" role="menuitem" id="hide" type="button"><span class="menu-item-label">Hide controls</span></button>
  </div>
  <nav aria-label="Bivy preview controls">
    <button class="btn sm ghost" id="back" aria-label="Back to chat">‹ <span class="label-wide">Chat</span></button>
    <span id="name"><span id="title">App preview</span><span id="stamp" class="muted" role="status"></span></span>
    <button class="btn sm ghost" id="scn" type="button" hidden aria-haspopup="dialog" aria-expanded="false" aria-controls="scenarios"><span class="scn-text"><span id="scn-title"></span><span id="scn-sub" class="muted" aria-live="polite"></span></span><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>
    <button class="btn sm ghost" id="scn-reset" type="button" hidden aria-label="Reset scenario" title="Start this scenario over"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg></button>
    <button class="btn sm primary" id="update" type="button" hidden><span class="label-wide">Show new version</span><span class="label-narrow">New</span></button>
    <button class="btn sm ghost" id="more" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="Preview options"><span class="badge" data-variant="solid" data-tone="danger" id="error-count" hidden></span><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>
  </nav>
</div>
<button class="btn sm" id="show" hidden aria-label="Show Bivy controls">Bivy</button>
<script nonce="${nonce}">
const $=id=>document.getElementById(id);
const frame=$('app'),status=$('status'),back=$('back'),reload=$('reload'),stage=$('stage');
// "#ticket~page": a review card opens the preview on the page it shows.
// "#ticket~page~scenario": a review card's "Try it" opens the preview in a scenario.
const [ticket,startPage='',startAt='']=location.hash.slice(1).split('~');history.replaceState(null,'',location.pathname);
let pendingScenario=/^[a-z0-9][a-z0-9-]{0,63}$/.test(startAt)?startAt:'';
let metadata,currentPath='/';
// Peek: framed by a Bivy client, which owns closing and the composer.
const embedded=parent!==window;
// The framing client's own origin: a packaged app's differs from returnTo's.
// (frame-ancestors already limits who that can be.)
const toBivy=m=>parent.postMessage(Object.assign({source:'bivy-preview'},m),location.ancestorOrigins?.[0]||new URL(metadata.returnTo).origin);
const storageKey='bivy-preview';
const safePath=p=>typeof p==='string'&&p.startsWith('/')&&!p.startsWith('//')&&p.length<=2048?p:'/';
const reviewerTools=ready=>{if(metadata?.reviewer)for(const id of ['mark','errors'])$(id).disabled=!ready;};
const open=(path,message)=>{status.hidden=false;status.textContent=message;resetConsole();reviewerTools(false);frame.src=metadata.origin+safePath(path);};
function show(data,launch){
  metadata=data;
  if(data.reviewer){
    drawOk=data.inspect!==false;back.hidden=true;
    $('draft-title').textContent='Note for the app’s owner';
    $('draft-text').maxLength=1000;
    $('send-errors').textContent='Leave a note…';
  }
  // A view-only share link shows the app without Bivy's tools.
  $('dock').hidden=data.controls===false;
  $('made-with').hidden=!data.badge;
  document.body.classList.toggle('badged',Boolean(data.badge));
  $('title').textContent=data.name;
  $('title').title=data.name;
  document.title='Bivy · '+data.name;
  back.title=data.returnTo?'Return to '+new URL(data.returnTo).host:'Close preview';
  frame.title=data.name;
  frame.hidden=false;
  // Desktop apps have no page to inspect, so no Console. Their viewer
  // (Bivy's own code) may use the clipboard; generated web apps may not.
  // (Set before navigating: the policy is fixed when the frame loads.)
  $('errors').hidden=data.inspect===false;
  if(data.inspect===false)frame.allow='clipboard-read; clipboard-write';
  frame.src=data.origin+(launch?'/__bivy/open#'+(embedded?'e:':'')+launch+(startPage?'~'+startPage:''):'/');
  back.hidden=Boolean(data.reviewer)||(embedded&&Boolean(data.returnTo));
  for(const b of [reload,$('errors'),markBtn])b.disabled=false;
  reviewerTools(false);
  status.textContent='Loading app…';
  frame.onload=()=>{
    loads++;
    if(runner)sendSteps();else status.hidden=true;
    void loadCompare();
    // Put them back where they were before an update they asked for.
    if(restore){const at=restore;restore=null;frame.contentWindow?.postMessage(Object.assign({type:'bivy:restore'},at),metadata.origin);}
    if(!watching){watching=true;latest=-1;shown=null;watch();firstHint();}else if(wake)wake();
  };
  // A Bivy client framing the shell says whether it can take dictation.
  if(embedded&&data.returnTo)toBivy({type:'hello'});
  // Store navigation metadata only, never tickets or cookies.
  try{sessionStorage.setItem(storageKey,JSON.stringify(data));}catch{}
}
// The marking gesture is the whole point of a preview, and a gesture nobody is
// told about is a gesture nobody uses. Say it once per device, then never again.
const hintKey='bivy-preview-hint';
function firstHint(){
  // A desktop app has no page to press on: its marking is the menu's, so the
  // hint would promise a gesture that isn't there.
  if(metadata.controls===false||metadata.inspect===false)return;
  try{if(localStorage.getItem(hintKey))return;localStorage.setItem(hintKey,'1');}catch{return;}
  $('hint').hidden=false;
  setTimeout(()=>{$('hint').hidden=true;},8000);
}
// An agent turn changes files: never reload the app under the person looking
// at it — a scroll position, a filled-in form or an open menu would go with it.
// "shown" is the revision the frame is displaying, "latest" the newest the node
// reports; while they differ the controls offer the new version, and taking it
// is the user's tap.
// Until the frame has redeemed its access cookie, polls fail; back off, and
// let the next frame load retry at once.
let shown=null,latest=null,watching=false,retry=0,wake=null,restore=null,newPath='/';
async function watch(){
  wake=null;
  try{
    const r=await fetch(metadata.origin+'/__bivy/revision?after='+latest,{credentials:'include',cache:'no-store'});
    if(!r.ok)throw Error();
    const d=await r.json();
    // A turn may have written or changed scenario files.
    if(latest!==null&&latest!==-1&&d.revision!==latest)void loadScenarios();
    latest=d.revision;newPath=safePath(d.path);
    // The first poll after a load describes what the frame already has.
    if(shown===null)shown=latest;
    waiting(latest!==shown);
    retry=0;setTimeout(watch,0);
  }catch{retry=Math.min(30000,(retry||1000)*2);const t=setTimeout(watch,retry);wake=()=>{clearTimeout(t);watch();};}
}
/** Offers the newer version, or takes the offer away once it is on screen.
 *  Only a change writes the stamp, which other statuses also use. */
function waiting(on){
  if($('update').hidden===!on)return;
  $('update').hidden=!on;
  $('stamp').textContent=on?'New version ready':'';
  renderScenarioPill();
}
/** Asks the page where it is, so the update can put it back. Without an
 *  inspector (a desktop app) there is nothing to ask. */
function pageState(){
  if(metadata.inspect===false)return Promise.resolve(null);
  return new Promise(resolve=>{
    const done=d=>{clearTimeout(timer);if(stateWaiter===done)stateWaiter=null;resolve(d||null);};
    const timer=setTimeout(()=>done(null),500);
    stateWaiter=done;
    frame.contentWindow?.postMessage({type:'bivy:draw'},metadata.origin);
  });
}
let stateWaiter=null;
/** Take the version the agent just built, on the page in view. */
async function takeUpdate(){
  const at=await pageState();
  restore=at&&{scroll:at.scroll,elementScrolls:at.elementScrolls};
  shown=latest;waiting(false);
  open(currentPath!=='/'?currentPath:newPath,'Updating…');
  // Screenshots for Compare land a few seconds after the change.
  for(const ms of [5000,15000])setTimeout(()=>void loadCompare(),ms);
}
// Owner drafts go to the session's composer. Reviewer drafts use only the
// bounded notes endpoint, never the owner's command channel.
function toChat(text){
  if(embedded)return toBivy({type:'draft',text});
  const to=new URL(metadata.returnTo),session=to.pathname.split('/').pop();
  location.assign(to.origin+'/share?session='+encodeURIComponent(session)+'&text='+encodeURIComponent(text));
}
let pendingNote=null,noteSequence=0,pending=null;
function draft(context,listen){
  panels(null);
  $('draft-add').disabled=false;
  $('note-status').textContent='';
  $('draft-hint').textContent=metadata.reviewer?'Feedback only — no agent runs. Pictures are approximate; if screenshots are off, we save text and mark details.':'Review in chat before sending.';
  $('draft').hidden=false;
  // Several marks, several notes: each keeps its own words and its own number.
  // A reviewer sends one note at a time, as the notes endpoint takes them.
  $('draft-more').hidden=!pending||Boolean(metadata.reviewer);
  $('draft-title').textContent=metadata.reviewer?'Note for the app’s owner':pending?'Note '+pending.n:'Note for the agent';
  const waiting=notes.length+(pending?1:0);
  $('draft-add').textContent=metadata.reviewer?'Send note':metadata.returnTo?(waiting>1?'Add '+waiting+' notes to chat':'Add to chat'):'Copy';
  $('draft-context').textContent=context;
  $('draft-details').open=false;
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
  if(d.type==='draw'){drawOk=d.available===true;$('compare-draw').hidden=!drawOk;}
  else if(d.type==='voice'){voice=d.available===true;mic.hidden=!voice;if(!voice)cancelListening();}
  else if(d.type==='transcript'){setListening(false);if(typeof d.error==='string')sayVoice(d.error.slice(0,200));else addSpoken(d.text);}
  else if(d.type==='listening'&&d.on===false&&listening){setListening(false);if(voiceStatus.textContent.startsWith('Listening'))sayVoice('');}
}
/** Saves the words for the mark in hand, and hands back the mark layer. */
function keepNote(){
  if(!pending)return false;
  notes.push({...pending,words:$('draft-text').value.trim().slice(0,2000)});
  pending=null;
  return true;
}
/** Back to marking with the notes so far still on the page. */
function resumeMarking(){
  const target=draw?.target??'frame',seed=draw?.state&&{scroll:draw.scroll,viewport:draw.state.viewport,dpr:draw.state.dpr,theme:draw.state.theme,path:draw.state.path,elementScrolls:draw.state.elementScrolls,signals:draw.state.signals};
  const keep=notes;
  cancelListening();
  $('draft').hidden=true;
  draw=null;notes=[];
  startDraw(target,seed);
  notes=keep;
  updateDrawBar();renderInk();
}
$('draft-more').onclick=()=>{if(keepNote())resumeMarking();};
// Cancelling drops the mark in hand; the notes before it are still yours.
$('draft-cancel').onclick=()=>{
  cancelListening();pending=null;
  $('draft').hidden=true;
  if(notes.length)resumeMarking();else{endDraw();$('more').focus();}
};
/** What goes to the machine: the page's state, every stroke, and which note
 *  each stroke belongs to, so the picture can be numbered and each note can
 *  become a pin of its own. */
function markPayload(d,list){
  const st=d.state,first=list[0]?.els?.[0];
  return Object.assign({path:st.path,viewport:st.viewport,dpr:st.dpr,signals:st.signals,
    strokes:list.flatMap(note=>note.strokes),
    notes:list.map(note=>({n:note.n,words:note.words||'',selectors:note.selectors,strokes:note.strokes})),
    selector:first?.selector||'',text:first?.text||''},
    d.target==='frame'?{scroll:d.scroll,elementScrolls:st.elementScrolls,theme:st.theme}:{compare:compareAfter});
}
/** The notes as words: where they are, once, then one numbered entry each. */
function composeText(d,list){
  return placeContext(d)+':\\n\\n'+list.map(note=>note.n+'. '+(note.words?'“'+note.words+'”\\n   ':'')+note.context.replace(/\\n/g,'\\n   ')).join('\\n\\n');
}
$('draft-add').onclick=async()=>{
  cancelListening();
  const words=$('draft-text').value.trim();
  const d=draw;
  if(metadata.reviewer){
    if(!words){$('note-status').textContent='Write a note before sending.';$('draft-text').focus();return;}
    const mark=pending&&d?markPayload(d,[{...pending,words}]):null,id=++noteSequence;
    $('draft-add').disabled=true;$('draft-cancel').disabled=true;$('draft-text').disabled=true;
    $('note-status').textContent='Sending note…';$('draft-add').textContent='Sending…';
    const timer=setTimeout(()=>finishNote({id,error:'No reply yet. Your note may have arrived; check the connection before retrying.'}),60000);
    pendingNote={id,timer};
    frame.contentWindow?.postMessage({type:'bivy:note',id,note:{note:words,context:$('draft-context').textContent,selector:mark?.selector||'',text:mark?.text||'',path:mark?.path||currentPath,viewport:mark?.viewport||{width:frame.clientWidth,height:frame.clientHeight},...(mark?{mark}:{})}},metadata.origin);
    return;
  }
  keepNote();
  const list=notes;
  const text=list.length&&d?composeText(d,list):(words?words+'\\n\\n':'')+$('draft-context').textContent;
  // Marks go to the Bivy client, which adds a numbered picture from the machine.
  if(list.length&&d&&embedded){const mark=markPayload(d,list);$('draft').hidden=true;endDraw();return toBivy({type:'annotation',text,mark});}
  if(metadata.returnTo){$('draft').hidden=true;endDraw();return toChat(text);}
  try{await navigator.clipboard.writeText(text);$('draft-add').textContent='Copied';}catch{$('draft-text').select();}
};
$('draft-text').addEventListener('input',()=>{if(!pendingNote)$('note-status').textContent='';});
function finishNote(d){
  if(!pendingNote||d.id!==pendingNote.id)return;
  clearTimeout(pendingNote.timer);pendingNote=null;
  $('draft-cancel').disabled=false;$('draft-add').disabled=false;$('draft-text').disabled=false;$('draft-add').textContent='Send note';
  if(d.error){$('note-status').textContent=String(d.error).slice(0,200);return;}
  $('draft').hidden=true;endDraw();
  $('stamp').textContent=d.screenshot?'Note and approximate picture sent':'Note sent without a picture';
  status.hidden=false;status.textContent=$('stamp').textContent+'. The app’s owner will see it.';
  $('more').focus();
}
// Scenarios: named starting points for the live app, from the project's
// .bivy/scenarios. Opening one tells the gateway (so its simulated responses
// apply to this browser only), opens its page and walks its steps through the
// page's inspector, one at a time; a step that loads a new page is picked up
// after on the next one. Reset does it all again; "Your data" leaves it.
let scenarios=[],activeScenario=null,runner=null,runSeq=0,loads=0,scenariosLoaded=false;
const scnBtn=$('scn'),scnReset=$('scn-reset');
async function loadScenarios(){
  if(!metadata||metadata.inspect===false||metadata.controls===false)return;
  try{
    const r=await fetch(metadata.origin+'/__bivy/scenarios',{credentials:'include',cache:'no-store'});if(!r.ok)return;
    const d=await r.json();
    scenarios=(Array.isArray(d.scenarios)?d.scenarios:[]).slice(0,100);
    if(!runner)activeScenario=d.active&&typeof d.active.id==='string'?d.active:null;
    renderScenarioPill();
    if(!$('scenarios').hidden)renderScenarioList();
  }catch{}
}
function renderScenarioPill(){
  if(!metadata)return;
  const on=scenarios.length>0||Boolean(activeScenario);
  scnBtn.hidden=!on;$('name').hidden=on;scnReset.hidden=!activeScenario||Boolean(runner);
  if(!on)return;
  const sim=activeScenario?.simulated;
  $('scn-title').textContent=activeScenario?activeScenario.name:metadata.name;
  $('scn-sub').textContent=runner?'Opening…':activeScenario?(sim?'Simulated: '+sim:metadata.name):$('stamp').textContent||(scenarios.length===1?'1 scenario':scenarios.length+' scenarios');
  scnBtn.toggleAttribute('data-active',Boolean(activeScenario));
  scnBtn.setAttribute('aria-label',(activeScenario?'Scenario: '+activeScenario.name+(sim?', simulated':'')+'. ':'')+'Choose a scenario');
  scnReset.setAttribute('aria-label','Reset '+(activeScenario?.name||'scenario'));
}
function scenarioRow(s){
  const b=document.createElement('button');b.type='button';b.className='scn-row';
  const current=(activeScenario?.id||'')===s.id;
  if(current)b.setAttribute('aria-current','true');
  const text=document.createElement('span');text.className='scn-row-text';
  const name=document.createElement('span');name.className='scn-row-name';name.textContent=s.name;
  text.append(name);
  const lines=s.error?[s.error]:[s.description,s.details??[s.open,s.simulated?'simulates '+s.simulated:'',s.steps?s.steps+' step'+(s.steps===1?'':'s'):'',s.fresh?'as a new visitor':''].filter(Boolean).join(' · ')];
  for(const line of lines.filter(Boolean)){const sub=document.createElement('span');sub.className='scn-row-sub';sub.textContent=String(line).slice(0,300);text.append(sub);}
  b.append(text);
  if(s.error||s.isNew){const tag=document.createElement('span');tag.className='badge';tag.dataset.tone=s.error?'warn':'accent';tag.textContent=s.error?'Needs a fix':'New';b.append(tag);}
  if(s.error&&(!metadata.returnTo||metadata.reviewer))b.disabled=true;
  b.onclick=()=>{if(s.error)return toChat(fixRequest(s.name,s.id,s.error));void enterScenario(s.id);};
  return b;
}
function renderScenarioList(){
  const body=$('scenarios-body'),fresh=scenarios.filter(s=>s.isNew&&!s.error);
  const group=(label,rows)=>{
    const h=document.createElement('h3');h.className='scn-group';h.textContent=label;
    const ul=document.createElement('ul');ul.className='scn-list';
    for(const row of rows){const li=document.createElement('li');li.append(scenarioRow(row));ul.append(li);}
    return [h,ul];
  };
  const mine={id:'',name:'Your data',details:'The app as it is, no scenario'};
  body.replaceChildren(...(fresh.length?group('New in this session',fresh):[]),...group(fresh.length?'All':'Start from',[mine,...scenarios.filter(s=>!fresh.includes(s))]));
}
scnBtn.onclick=()=>{
  if(!$('scenarios').hidden)return panels(null);
  panels('scenarios');renderScenarioList();void loadScenarios();
  ($('scenarios-body').querySelector('[aria-current="true"]')||$('scenarios-body').querySelector('.scn-row:not(:disabled)'))?.focus();
};
$('scenarios-close').onclick=()=>{panels(null);scnBtn.focus();};
scnReset.onclick=()=>{if(activeScenario)void enterScenario(activeScenario.id);};
const fixRequest=(name,id,problem)=>'The scenario “'+name+'” (.bivy/scenarios/'+id+'.json) for the app preview "'+metadata.name+'" doesn’t work: '+problem+'\\n\\nPlease fix the scenario, or the app if that’s what broke, and tell me when it opens cleanly.';
async function enterScenario(id){
  panels(null);
  const run=++runSeq;
  if(runner)clearTimeout(runner.timer);
  runner=null;
  let d={};
  try{
    const r=await fetch(metadata.origin+'/__bivy/scenario',{method:'POST',credentials:'include',cache:'no-store',headers:{'content-type':'text/plain'},body:id});
    d=await r.json().catch(()=>({}));
    if(!r.ok)throw Error(typeof d.error==='string'?d.error.slice(0,300):'The preview didn’t answer.');
  }catch(error){if(run===runSeq)failScenario({id,name:scenarios.find(s=>s.id===id)?.name||id},error.message||'The preview didn’t answer.');return;}
  if(run!==runSeq)return;
  const plan=d.plan;
  if(!plan){activeScenario=null;renderScenarioPill();open(currentPath,'Reloading app…');return;}
  activeScenario={id:plan.id,name:plan.name,...(plan.simulated?{simulated:plan.simulated}:{})};
  runner={run,plan,stage:0,step:0,timer:0};
  // As a new visitor: the page forgets what it kept before the first page opens.
  if(plan.fresh)frame.contentWindow?.postMessage({type:'bivy:forget'},metadata.origin);
  renderScenarioPill();
  setTimeout(()=>{if(runner?.run===run)goStage();},plan.fresh?200:0);
}
/** Opens the stage's page (its steps follow when it has loaded), or walks its steps where we are. */
function goStage(){
  const st=runner.plan.stages[runner.stage];
  if(!st)return finishScenario();
  runner.step=0;
  if(st.open){shown=latest;waiting(false);open(st.open,'Opening '+runner.plan.name+'…');watchdog();}
  else sendSteps();
}
function sendSteps(){
  const st=runner.plan.stages[runner.stage];
  if(!st)return finishScenario();
  if(runner.step>=st.steps.length){runner.stage++;return goStage();}
  frame.contentWindow?.postMessage({type:'bivy:steps',run:runner.run,load:loads,steps:st.steps,from:runner.step},metadata.origin);
  watchdog();
}
/** A page that stops answering (no inspector, a hung script) fails the scenario rather than leaving it opening forever. */
function watchdog(){
  const at=runner;clearTimeout(at.timer);
  at.timer=setTimeout(()=>{if(runner===at)failScenario(at.plan,'The page stopped answering at step '+(at.step+1)+' of “'+at.plan.name+'”.');},12000);
}
const stepWords=s=>s?('click' in s?'click '+s.click:'fill' in s?'fill '+s.fill:'press' in s?'press '+s.press:'wait' in s?'wait for '+s.wait:'step'):'step';
function stepReport(d){
  if(d.type==='steps-done'){runner.stage++;return goStage();}
  const i=Number(d.i)||0;
  if(d.ok){runner.step=i+1;return watchdog();}
  const st=runner.plan.stages[runner.stage],before=runner.plan.stages.slice(0,runner.stage).reduce((n,x)=>n+x.steps.length,0);
  failScenario(runner.plan,'Step '+(before+i+1)+' ('+stepWords(st.steps[i])+'): '+String(d.error||'it failed').slice(0,300)+'.');
}
function finishScenario(){
  if(runner)clearTimeout(runner.timer);
  runner=null;status.hidden=true;renderScenarioPill();
}
function failScenario(s,message){
  if(runner)clearTimeout(runner.timer);
  runner=null;status.hidden=true;renderScenarioPill();
  panels(null);
  $('scn-fail-title').textContent='Couldn’t finish “'+s.name+'”';
  $('scn-fail-text').textContent=message+' You’re on '+currentPath+' with what ran so far.';
  $('scn-fix').hidden=!metadata.returnTo||Boolean(metadata.reviewer);
  $('scn-fix').onclick=()=>{$('scn-fail').hidden=true;toChat(fixRequest(s.name,s.id,message));};
  $('scn-fail').hidden=false;
  ($('scn-fix').hidden?$('scn-stay'):$('scn-fix')).focus();
}
$('scn-stay').onclick=()=>{$('scn-fail').hidden=true;scnBtn.hidden?more.focus():scnBtn.focus();};
// Console
let entries=[];
function resetConsole(){entries=[];renderConsole();}
function renderConsole(){
  const errors=entries.filter(e=>e.level==='error').length,count=$('error-count');
  count.hidden=!errors;count.textContent=String(errors);
  // The number is shown once, on the pill, so it is visible without opening it.
  $('more').setAttribute('aria-label',errors?'Preview options, '+errors+' error'+(errors===1?'':'s'):'Preview options');
  $('console-empty').hidden=entries.length>0;$('send-errors').disabled=!entries.length;
  $('entries').replaceChildren(...entries.map(e=>{const li=document.createElement('li');const tag=document.createElement('span');tag.className='badge';tag.dataset.tone=e.level==='error'?'danger':'warn';tag.textContent=e.level;const text=document.createElement('span');text.textContent=e.text;li.append(tag,text);return li;}));
}
$('errors').onclick=()=>panels($('console').hidden?'console':null);
$('clear').onclick=resetConsole;
$('send-errors').onclick=()=>draft('Console output in the app preview "'+metadata.name+'" (page '+currentPath+'):\\n'+entries.slice(-20).map(e=>'- '+e.level+': '+e.text).join('\\n'));
// Marking: one gesture, two results. Pointing at an element and circling an
// area were two modes with a button each; they are one mode now, because they
// are one intention — "this, here".
//
//   Tap the app                     reaches the app, unchanged
//   Long press, lift without moving marks that element and opens the note
//                                   (listening, when voice is available)
//   Long press, then drag           draws a lasso and stays in marking
//   Mark (or the C key)             enters marking with nothing marked yet
//
// Marks are kept in page coordinates (so they stay on the content while two
// fingers scroll), and the app reports what is under each one. On Done they go
// into the draft box with that context; Add to chat hands them to the Bivy
// client, which gets a picture from the machine. Reviewers instead submit marks
// with their note; pictures stay on the machine for the owner. Compare's "after"
// shot can be marked the same way by the owner.
const markBtn=$('mark');
markBtn.onclick=()=>{if(draw&&!draw.done)endDraw();else startDraw('frame');};
const ink=$('ink'),inkMarks=$('ink-marks'),SVG='http://www.w3.org/2000/svg';
// One mark, one note, one number. Several marks used to collapse into a single
// note, so "the button is too small" and "the total is misaligned" arrived as
// one lump that could only be answered as a lump. Each mark now carries its own
// words and becomes its own pin, and the picture wears the numbers so a note and
// the thing it is about stay paired.
let draw=null,notes=[],drawOk=false,nextStroke=0,speakNext=false;
const pos=v=>({x:Number(v?.x)||0,y:Number(v?.y)||0});
/** Applies a page's report of where it is and what state it holds. */
function applyState(current,d){
  current.scroll=pos(d.scroll);
  current.state={viewport:{width:Math.round(Number(d.viewport?.width))||current.state.viewport.width,height:Math.round(Number(d.viewport?.height))||current.state.viewport.height},dpr:Number(d.dpr)||devicePixelRatio,theme:d.theme==='dark'?'dark':'light',path:safePath(d.path),elementScrolls:d.elementScrolls,signals:Object.fromEntries(Object.entries(d.signals||{}).map(([k,v])=>[k,v===true]))};
}
/** "seed": the page's state, when a long press in the app brought it along. */
function startDraw(target,seed){
  endDraw();
  if(target==='frame')panels(null);
  $('hint').hidden=true;
  if(target==='compare'){$('compare-slider').value='0';split();$('compare').dataset.drawing='';}
  // Tools first: they change the layout the marks are measured against.
  $('drawing').hidden=false;$('draw-bar').hidden=false;document.querySelector('nav').hidden=true;
  const r=placeInk(target);
  draw={target,rect:r,scroll:{x:0,y:0},strokes:[],elements:{},current:null,pointers:new Map(),pan:null,done:false,
    state:{viewport:{width:Math.round(r.width),height:Math.round(r.height)},dpr:devicePixelRatio,path:currentPath,signals:{}}};
  ink.style.zIndex=target==='compare'?'calc(var(--z-sticky) + 1)':'';
  ink.classList.remove('frozen');ink.toggleAttribute('hidden',false);
  // Where the page is and what state it holds. Without an inspector (a
  // desktop app, or a page whose policy kept it out) state is unknown.
  if(target==='frame'&&metadata.inspect!==false){
    const current=draw;
    current.state.signals={unknown:true};
    if(seed)applyState(current,seed);
    else{
      current.waiting=d=>{current.waiting=null;applyState(current,d);renderInk();};
      frame.contentWindow?.postMessage({type:'bivy:draw'},metadata.origin);
    }
  }
  space=draw;
  $('draw-bar').focus();
  updateDrawBar();renderInk();
}
/** A long press inside the app opens marking with that element already marked;
 *  dragging on from it draws instead, and the app streams the points here
 *  because the gesture belongs to its document, not this one. */
function markFromPress(d){
  startDraw('frame',d);
  const el=d.element||{},r=el.rect||{};
  const s={id:nextStroke++,tool:'pen',points:[[Math.round(Number(d.point?.[0])||0),Math.round(Number(d.point?.[1])||0)]],live:true};
  draw.strokes.push(s);draw.live=s;
  if(el.selector)draw.elements[s.id]=[{selector:String(el.selector).slice(0,300),tag:el.tag,text:String(el.text||'').slice(0,120),rect:r}];
  renderInk();updateDrawBar();
}
/** The pressing finger moved: the mark becomes the path it draws. */
function markMoved(d){
  const s=draw?.live;if(!s)return;
  const p=[Math.round(Number(d.point?.[0])||0),Math.round(Number(d.point?.[1])||0)];
  const last=s.points[s.points.length-1];
  if(Math.hypot(p[0]-last[0],p[1]-last[1])<2||s.points.length>=2000)return;
  s.points.push(p);renderInk();
}
/** The finger lifted. Lifted where it landed: the element is what they meant,
 *  so the mark becomes its box and the note opens, listening when it can. */
function markEnded(){
  const s=draw?.live;if(!s)return;
  draw.live=null;delete s.live;
  const xs=s.points.map(p=>p[0]),ys=s.points.map(p=>p[1]);
  const moved=Math.max(...xs)-Math.min(...xs)>=4||Math.max(...ys)-Math.min(...ys)>=4;
  if(moved){askMarked(s);renderInk();updateDrawBar();return;}
  const r=draw.elements[s.id]?.[0]?.rect;
  if(r&&r.width&&r.height){s.tool='box';s.points=[[r.x,r.y],[r.x+r.width,r.y+r.height]];}
  else{s.tool='box';s.points=[[xs[0]-12,ys[0]-12],[xs[0]+12,ys[0]+12]];}
  renderInk();updateDrawBar();
  speakNext=voice;
  $('draw-done').click();
}
/** Asks the page what a mark covers, while it is still on screen. */
function askMarked(s){
  if(draw.target!=='frame'||metadata.inspect===false)return;
  const xs=s.points.map(p=>p[0]),ys=s.points.map(p=>p[1]);
  const [x,y]=onScreen([Math.min(...xs),Math.min(...ys)]);
  frame.contentWindow?.postMessage({type:'bivy:marks',id:s.id,rect:{x,y,width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)}},metadata.origin);
}
/** Lays the marking layer over what's marked; returns where that is. A Compare
 *  shot scrolls inside its panel, and its box keeps the size it would have
 *  unclipped: left as is, the layer would reach past the panel and swallow the
 *  taps meant for the tools under it. Clipping the bottom keeps the top-left
 *  origin the marks are measured from. */
function placeInk(target){
  const r=(target==='compare'?$('compare-after'):frame).getBoundingClientRect();
  const limit=target==='compare'?$('compare').getBoundingClientRect().bottom:Infinity;
  const height=Math.max(0,Math.min(r.height,limit-r.top));
  Object.assign(ink.style,{left:r.left+'px',top:r.top+'px',width:r.width+'px',height:height+'px'});
  inkMarks.setAttribute('viewBox','0 0 '+r.width+' '+r.height);
  return {left:r.left,top:r.top,width:r.width,height:r.height};
}
// A rotation or a keyboard moves things: keep the layer on them. (Marks on
// the frame are in page pixels, so they follow; the size in use is kept.)
addEventListener('resize',()=>{if(draw&&!draw.done)draw.rect=Object.assign(placeInk(draw.target),{});});
function endDraw(){
  if(!draw&&!notes.length)return;
  delete $('compare').dataset.drawing;
  draw=null;space=null;notes=[];pending=null;ink.toggleAttribute('hidden',true);inkMarks.replaceChildren();
  $('drawing').hidden=true;$('draw-bar').hidden=true;$('mark-count').hidden=true;document.querySelector('nav').hidden=false;
}
function updateDrawBar(){
  const has=Boolean(draw?.strokes.length);
  $('draw-done').disabled=!has;
  $('draw-clear').disabled=!has;
  // Undo walks back through this mark's strokes, then through the marks before it.
  $('draw-undo').disabled=!has&&!notes.length;
  $('draw-undo').setAttribute('aria-label',has||!notes.length?'Undo':'Remove note '+notes.length);
  $('mark-count').hidden=!notes.length;
  $('mark-count').textContent=notes.length===1?'1 note':notes.length+' notes';
}
// Page pixels to screen pixels. Saved marks are drawn between marks, when
// there is no mark in hand, so the page's position is kept beside them.
let space=null;
const onScreen=([x,y])=>{const d=draw||space;return d&&d.target==='frame'?[x-d.scroll.x,y-d.scroll.y]:[x,y];};
function shape(stroke){
  const pts=stroke.points.map(onScreen);
  if(stroke.tool==='box'){const [a,b]=[pts[0],pts[pts.length-1]];const el=document.createElementNS(SVG,'rect');el.setAttribute('x',Math.min(a[0],b[0]));el.setAttribute('y',Math.min(a[1],b[1]));el.setAttribute('width',Math.abs(b[0]-a[0]));el.setAttribute('height',Math.abs(b[1]-a[1]));el.setAttribute('rx','3');return el;}
  const el=document.createElementNS(SVG,'polyline');el.setAttribute('points',pts.map(p=>p.join(',')).join(' '));return el;
}
/** The number a saved mark wears, at the top-left of what it covers. */
function pip(note){
  const xs=note.strokes.flatMap(s=>s.points.map(p=>p[0])),ys=note.strokes.flatMap(s=>s.points.map(p=>p[1]));
  const [x,y]=onScreen([Math.min(...xs),Math.min(...ys)]);
  const g=document.createElementNS(SVG,'g');
  const disc=document.createElementNS(SVG,'circle');
  disc.setAttribute('cx',x);disc.setAttribute('cy',y);disc.setAttribute('r','11');disc.setAttribute('class','pip');
  const text=document.createElementNS(SVG,'text');
  text.setAttribute('x',x);text.setAttribute('y',y);text.setAttribute('class','pip-text');text.textContent=String(note.n);
  g.append(disc,text);
  return g;
}
function renderInk(){
  if(!draw&&!notes.length)return;
  const paint=(s,saved)=>['halo','mark'].map(c=>{const el=shape(s);el.setAttribute('class',saved?c+' saved':c);return el;});
  const done=notes.flatMap(note=>[...note.strokes.flatMap(s=>paint(s,true)),pip(note)]);
  const live=draw?[...draw.strokes,...(draw.current?[draw.current]:[])].flatMap(s=>paint(s,false)):[];
  // The mark being written about wears its number too, so the note on screen
  // and the thing it is about are paired while the words are still being typed.
  inkMarks.replaceChildren(...done,...live,...(pending&&notes.length?[pip(pending)]:[]));
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
  draw.current={id:nextStroke++,tool:'pen',points:[local(e)]};renderInk();
};
ink.onpointermove=e=>{
  if(!draw||!draw.pointers.has(e.pointerId))return;
  draw.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if(draw.pan&&draw.pointers.size>=2){const m=middle();scrollPage(draw.pan.x-m.x,draw.pan.y-m.y);draw.pan=m;return;}
  const s=draw.current;if(!s)return;const p=local(e);
  const last=s.points[s.points.length-1];
  if(Math.hypot(p[0]-last[0],p[1]-last[1])<2||s.points.length>=2000)return;
  s.points.push(p);
  renderInk();
};
ink.onpointerup=ink.onpointercancel=e=>{
  if(!draw)return;draw.pointers.delete(e.pointerId);if(draw.pointers.size<2)draw.pan=null;
  const s=draw.current;draw.current=null;
  if(s&&e.type==='pointerup'){
    const xs=s.points.map(p=>p[0]),ys=s.points.map(p=>p[1]),w=Math.max(...xs)-Math.min(...xs),h=Math.max(...ys)-Math.min(...ys);
    draw.strokes.push(s);
    // A drag is the path it drew; a tap means the element under it, whose box
    // the page reports back (see "marked").
    if(w>=4||h>=4)askMarked(s);
    else if(draw.target==='frame'&&metadata.inspect!==false){s.fit=true;frame.contentWindow?.postMessage({type:'bivy:marks',id:s.id,rect:{x:onScreen(s.points[0])[0]-2,y:onScreen(s.points[0])[1]-2,width:4,height:4}},metadata.origin);}
    else draw.strokes.pop();
  }
  updateDrawBar();renderInk();
};
ink.onwheel=e=>{if(!draw||draw.done)return;e.preventDefault();scrollPage(e.deltaX,e.deltaY);};
$('draw-undo').onclick=()=>{
  if(!draw)return;
  // Back through this mark's strokes first, then through the notes before it.
  const s=draw.strokes.pop();
  if(s)delete draw.elements[s.id];else notes.pop();
  updateDrawBar();renderInk();
};
$('draw-clear').onclick=()=>{if(!draw)return;draw.strokes=[];draw.elements={};updateDrawBar();renderInk();};
$('draw-cancel').onclick=()=>endDraw();
$('compare-draw').onclick=()=>startDraw('compare');
/** What one mark names, and where it is, in words. */
function markContext(d,els){
  const bounds=s=>{const xs=s.points.map(p=>p[0]),ys=s.points.map(p=>p[1]);return s.tool+' '+Math.min(...xs)+','+Math.min(...ys)+'–'+Math.max(...xs)+','+Math.max(...ys);};
  return (els.length?els.map(el=>'- '+String(el.selector).slice(0,300)+(el.text?' ("'+String(el.text).slice(0,120)+'")':'')).join('\\n')+'\\n':'')
    +'Marks ('+(d.target==='compare'?'screenshot':'page')+' px): '+d.strokes.map(bounds).join('; ');
}
/** Where all the notes are, said once, above them. */
function placeContext(d){
  const st=d.state;
  const where=d.target==='compare'?'On the Compare screenshot after the agent’s last change in "'+metadata.name+'"':metadata.inspect===false?'On the desktop app "'+metadata.name+'"':'In the app preview "'+metadata.name+'"';
  const scrolled=d.target==='frame'&&(d.scroll.x||d.scroll.y)?', scrolled to '+d.scroll.x+','+d.scroll.y:'';
  return where+' (page '+st.path+', viewport '+st.viewport.width+'×'+st.viewport.height+scrolled+')';
}
$('draw-done').onclick=()=>{
  if(!draw||!draw.strokes.length)return;
  const d=draw,seen=new Set(),els=[];
  for(const s of d.strokes)for(const el of d.elements[s.id]||[]){const key=String(el.selector);if(!seen.has(key)){seen.add(key);els.push(el);}}
  pending={n:notes.length+1,strokes:d.strokes.map(s=>({tool:s.tool,points:s.points})),els,context:markContext(d,els),
    selectors:els.map(el=>String(el.selector).slice(0,300)).slice(0,8)};
  // The marks stay on screen, frozen, while the words for this one are added.
  d.done=true;draw=null;
  const speak=speakNext;speakNext=false;
  draft(placeContext(d)+', note '+pending.n+':\\n'+pending.context,speak);
  draw=d;ink.classList.add('frozen');renderInk();
  // Compare closed for the note box: its marks go with it (they're in the context).
  if(d.target==='compare')ink.toggleAttribute('hidden',true);$('drawing').hidden=true;$('draw-bar').hidden=true;document.querySelector('nav').hidden=false;
};
// Compare: screenshots around the agent's last change (agent screenshots on).
const compareBtn=$('compare-btn');let shots=[],urls=[],compareAfter=-1;
async function loadCompare(){
  if(metadata.reviewer)return;
  try{const r=await fetch(metadata.origin+'/__bivy/compare',{credentials:'include',cache:'no-store'});if(!r.ok)return;shots=(await r.json()).shots||[];compareBtn.hidden=shots.length<2;}catch{}
}
function panels(open){if(listening)cancelListening();if(draw&&!(open==='compare'&&draw.target==='compare'))endDraw();for(const [id,btn] of [['console','errors'],['compare','compare-btn'],['scenarios','scn']]){$(id).hidden=id!==open;$(btn).setAttribute(btn==='scn'?'aria-expanded':'aria-checked',String(id===open));}$('draft').hidden=true;$('scn-fail').hidden=true;}
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
// One pill, and one menu behind it: everything that used to be a button in a
// row of seven. The row scrolled sideways on a phone and covered the app; the
// pill holds what must always be visible — where you are, whether a newer
// version is waiting, whether the app is logging errors — and the menu holds
// the rest.
const dock=$('dock'),menu=$('menu'),more=$('more'),edgeKey='bivy-preview-edge';
function edge(to,keep){
  dock.dataset.edge=to;$('show').dataset.edge=to;
  $('edge').querySelector('.menu-item-label').textContent=to==='top'?'Move to bottom':'Move to top';
  if(keep)try{localStorage.setItem(edgeKey,to);}catch{}
}
try{edge(localStorage.getItem(edgeKey)==='top'?'top':'bottom');}catch{edge('bottom');}
function openMenu(on){
  menu.hidden=!on;more.setAttribute('aria-expanded',String(on));
  if(on)menu.querySelector('.menu-item:not([hidden]):not(:disabled)')?.focus();
}
more.onclick=()=>openMenu(menu.hidden);
// Choosing anything closes the menu; the pill takes focus back.
menu.addEventListener('click',e=>{if(e.target.closest('.menu-item')){openMenu(false);more.focus();}});
// A tap outside, or Escape, closes it. (The app is in a frame, so a tap there
// never reaches this document: the menu also closes when the frame takes over.)
addEventListener('pointerdown',e=>{if(!menu.hidden&&!menu.contains(e.target)&&!more.contains(e.target))openMenu(false);},true);
// Focus moving into the app's frame (or away from the preview) closes it too:
// a tap inside the frame never reaches this document.
addEventListener('blur',()=>openMenu(false));
$('edge').onclick=()=>edge(dock.dataset.edge==='top'?'bottom':'top',true);
more.onkeydown=e=>{if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();edge(e.key==='ArrowUp'?'top':'bottom',true);}};
/** Out of the way means out of the way: with the controls hidden, a long press
 *  belongs to the app again (a canvas, a map, anything with its own). */
const arm=on=>frame.contentWindow?.postMessage({type:'bivy:arm',on},metadata.origin);
$('hide').onclick=()=>{dock.hidden=true;$('show').hidden=false;$('show').focus();arm(false);};
$('show').onclick=()=>{dock.hidden=false;$('show').hidden=true;more.focus();arm(true);};
// Width (desktop only: a phone is already the width it is)
for(const b of menu.querySelectorAll('[data-lens]'))b.onclick=()=>{
  stage.dataset.lens=b.dataset.lens;
  for(const o of menu.querySelectorAll('[data-lens]'))o.setAttribute('aria-checked',String(o===b));
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
    if(d.type==='note-sent'&&metadata.reviewer)finishNote(d);
    else if(d.type==='route'){
      currentPath=safePath(d.path);reviewerTools(true);
      if(!scenariosLoaded){scenariosLoaded=true;void loadScenarios();}
      if(pendingScenario){const id=pendingScenario;pendingScenario='';void enterScenario(id);}
    }
    else if((d.type==='step'||d.type==='steps-done')&&runner&&d.run===runner.run&&d.load===loads)stepReport(d);
    else if(d.type==='console'&&(d.level==='error'||d.level==='warn')){entries.push({level:d.level,text:String(d.text).slice(0,500)});if(entries.length>50)entries.shift();renderConsole();}
    else if(d.type==='release'&&heldAt){heldAt=0;stopListening();}
    else if(d.type==='draw-state'){if(draw&&draw.waiting)draw.waiting(d);else if(stateWaiter)stateWaiter(d);}
    else if(d.type==='scrolled'&&draw&&draw.target==='frame'){draw.scroll=pos(d.scroll);renderInk();}
    else if(d.type==='marked'&&draw){
      const els=Array.isArray(d.elements)?d.elements.slice(0,8):[];
      draw.elements[Number(d.id)]=els;
      // A tap: make the mark the box of what it landed on.
      const s=draw.strokes.find(item=>item.id===Number(d.id));
      if(s&&s.fit){
        delete s.fit;const r=els[0]?.rect;
        if(r&&r.width&&r.height)s.points=[[r.x,r.y],[r.x+r.width,r.y+r.height]];
        else s.points=[[s.points[0][0]-12,s.points[0][1]-12],[s.points[0][0]+12,s.points[0][1]+12]];
        s.tool='box';renderInk();updateDrawBar();
      }
    }
    else if(d.type==='mark-start')markFromPress(d);
    else if(d.type==='mark-move')markMoved(d);
    else if(d.type==='mark-end')markEnded();
  }
});
ask.onclick=()=>toChat('The app preview "'+metadata.name+'" isn’t loading: nothing is answering on port '+downPort+'. Please find out why the server stopped, restart it, and tell me when it’s back.');
addEventListener('keydown',e=>{
  // C marks something, for anyone not holding a finger on a phone.
  if((e.key==='c'||e.key==='C')&&!e.metaKey&&!e.ctrlKey&&!e.altKey&&!/^(input|textarea|select)$/i.test(e.target?.localName||'')&&!markBtn.disabled&&!draw){e.preventDefault();startDraw('frame');return;}
  if(e.key==='Escape'){if(!menu.hidden){openMenu(false);more.focus();}else if(listening)cancelListening();else if(!$('draft').hidden)$('draft-cancel').click();else if(draw&&!draw.done)endDraw();else panels(null);}});
back.onclick=()=>{if(metadata?.returnTo){window.close();setTimeout(()=>location.replace(metadata.returnTo),100);}else{window.close();status.hidden=false;status.textContent='You can close this tab to return to Bivy.';}};
// A reload fetches the newest bytes, so it settles any waiting version too.
reload.onclick=()=>{if(!metadata)return;shown=latest;waiting(false);open(currentPath,'Reloading app…');};
$('update').onclick=()=>{void takeUpdate();};
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
