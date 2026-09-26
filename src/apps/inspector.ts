// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/** Served on the app's own origin and injected into its HTML. It reports only
 * to the trusted shell that frames it, and everything it reports is untrusted
 * app data: the shell shows it and turns it into drafts, never into actions.
 * Agent-neutral: it observes the browser, not the framework or the agent. */
export function inspectorScript(shellOrigin: string, reviewer = false): string {
  return `(()=>{
// Framed by the shell: report to it. Opened from a shared link: offer notes.
const framed=parent!==window,REVIEWER=${reviewer};
if(window.__bivyInspector||(!framed&&!REVIEWER))return;window.__bivyInspector=1;
const SHELL=${JSON.stringify(shellOrigin)};
const post=m=>{if(!framed)return;try{parent.postMessage(Object.assign({source:'bivy-inspector'},m),SHELL);}catch{}};
const fmt=v=>{if(v instanceof Error)return v.name+': '+v.message;if(typeof v==='string')return v;try{return JSON.stringify(v);}catch{return String(v);}};
const log=(level,text)=>post({type:'console',level,text:String(text).slice(0,500),at:Date.now()});
for(const level of ['error','warn']){const original=console[level];console[level]=function(...args){log(level,args.map(fmt).join(' '));return original.apply(this,args);};}
addEventListener('error',e=>{if(e.message)log('error',e.message+(e.filename?' ('+e.filename.split('/').pop()+':'+e.lineno+')':''));},true);
addEventListener('unhandledrejection',e=>log('error','Unhandled rejection: '+fmt(e.reason)));
const route=()=>post({type:'route',path:location.pathname+location.search+location.hash});
for(const name of ['pushState','replaceState']){const original=history[name];history[name]=function(...args){const result=original.apply(this,args);route();return result;};}
addEventListener('popstate',route);addEventListener('hashchange',route);route();
const selector=el=>{
  const parts=[];
  for(let node=el;node&&node.nodeType===1&&node!==document.body&&node!==document.documentElement&&parts.length<4;node=node.parentElement){
    if(node.id){parts.unshift('#'+CSS.escape(node.id));break;}
    let part=node.localName;
    const classes=[...node.classList].filter(c=>!/\\d{3,}|^css-|^_/.test(c)).slice(0,2);
    if(classes.length)part+='.'+classes.map(c=>CSS.escape(c)).join('.');
    const same=node.parentElement?[...node.parentElement.children].filter(c=>c.localName===node.localName):[];
    if(same.length>1)part+=':nth-of-type('+(same.indexOf(node)+1)+')';
    parts.unshift(part);
  }
  return parts.join(' > ')||el.localName;
};
let box=null,target=null,onPicked=post,host=null;
// Picks on pointerup: iOS never fires click for a tap on a non-clickable
// element when only window listens, so click would miss most of the page.
// While pointing, the app sees none of the gesture, including the click after.
const SWALLOW=['pointerdown','mousedown','mouseup','touchend','click','dblclick','contextmenu'];
const swallow=e=>{e.preventDefault();e.stopPropagation();};
// A second listener, so stopping (which the shell does right after a pick)
// doesn't also drop the guard on the rest of the tap. The tap's click ends it.
const aftermath=e=>{swallow(e);if(e.type==='click')listen(false,aftermath);};
const listen=(on,handler=swallow)=>{
  const method=on?addEventListener:removeEventListener;
  if(handler===swallow){method('pointermove',hover,true);method('pointerup',pick,true);method('keydown',key,true);}
  for(const type of SWALLOW)method(type,handler,true);
};
const stop=()=>{box?.remove();box=null;target=null;listen(false);};
const hover=e=>{
  const el=document.elementFromPoint(e.clientX,e.clientY);
  if(!el||el===box||el===host)return;target=el;const r=el.getBoundingClientRect();
  Object.assign(box.style,{left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px'});
};
const pick=e=>{
  swallow(e);
  const el=document.elementFromPoint(e.clientX,e.clientY)||target;stop();
  // Keep eating the click (and iOS's delayed mouse events) this tap still fires.
  listen(true,aftermath);setTimeout(()=>listen(false,aftermath),500);
  if(!el||el===host){onPicked({type:'picked',cancelled:true});return;}const r=el.getBoundingClientRect();
  onPicked({type:'picked',selector:selector(el),tag:el.localName,text:(el.innerText||el.getAttribute('aria-label')||el.getAttribute('alt')||'').trim().replace(/\\s+/g,' ').slice(0,200),
    rect:{x:Math.round(r.left),y:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)},
    viewport:{width:innerWidth,height:innerHeight},path:location.pathname+location.search+location.hash});
};
const key=e=>{if(e.key==='Escape'){stop();onPicked({type:'picked',cancelled:true});}};
function startPointing(){
  stop();
  box=document.createElement('div');
  box.setAttribute('aria-hidden','true');
  Object.assign(box.style,{position:'fixed',zIndex:2147483647,pointerEvents:'none',outline:'2px solid Highlight',outlineOffset:'2px',borderRadius:'4px',transition:'all 60ms ease-out'});
  document.documentElement.append(box);
  listen(true);
}
addEventListener('message',e=>{
  if(!framed||e.origin!==SHELL||e.source!==parent||e.data?.type!=='bivy:point')return;
  if(e.data.on)startPointing();else stop();
});
if(REVIEWER&&!framed){
  // A shadow root keeps the app's CSS off these controls (and ours off the app).
  host=document.createElement('bivy-review');
  const root=host.attachShadow({mode:'open'});
  root.innerHTML='<style>:host{all:initial}*{box-sizing:border-box;font:14px/1.4 system-ui,sans-serif}'
    +'.dock{position:fixed;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:2147483647;display:flex;flex-direction:column;align-items:flex-end;gap:8px;max-width:calc(100vw - 24px)}'
    +'button{border:1px solid ButtonBorder;background:ButtonFace;color:ButtonText;border-radius:999px;padding:10px 14px;font-weight:600;cursor:pointer;min-height:44px}'
    +'.primary{background:CanvasText;color:Canvas;border-color:CanvasText}'
    +'form{width:min(340px,calc(100vw - 24px));background:Canvas;color:CanvasText;border:1px solid GrayText;border-radius:14px;padding:12px;box-shadow:0 8px 30px rgb(0 0 0/.25)}'
    +'textarea{width:100%;min-height:5em;margin:8px 0;border:1px solid GrayText;border-radius:8px;padding:8px;background:Canvas;color:CanvasText;resize:vertical}'
    +'.row{display:flex;justify-content:flex-end;gap:8px}.muted{color:GrayText;font-size:12px;overflow-wrap:anywhere}[hidden]{display:none!important}</style>'
    +'<div class="dock"><p class="muted" role="status" id="status" hidden></p>'
    +'<form id="form" hidden><label for="note">Your note</label><div class="muted" id="about"></div><textarea id="note" required maxlength="1000"></textarea>'
    +'<div class="row"><button type="button" id="cancel">Cancel</button><button class="primary" id="send">Send note</button></div></form>'
    +'<button id="leave">Leave a note</button></div>';
  const $=id=>root.getElementById(id);let picked=null;
  const say=text=>{$('status').hidden=!text;$('status').textContent=text;};
  $('leave').onclick=()=>{say('Tap the part of the page your note is about. Escape cancels.');$('leave').hidden=true;startPointing();};
  onPicked=d=>{
    $('leave').hidden=false;say('');
    if(d.cancelled)return;picked=d;
    $('about').textContent='About: '+(d.text?'“'+d.text.slice(0,80)+'” ':'')+'('+d.selector+')';
    $('form').hidden=false;$('leave').hidden=true;$('note').focus();
  };
  $('cancel').onclick=()=>{$('form').hidden=true;$('leave').hidden=false;};
  $('form').onsubmit=async e=>{
    e.preventDefault();
    const r=await fetch('/__bivy/notes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.assign({},picked,{note:$('note').value}))}).catch(()=>null);
    if(r&&r.ok){$('note').value='';$('form').hidden=true;$('leave').hidden=false;say('Sent. Thanks — the app’s owner will see it.');setTimeout(()=>say(''),4000);}
    else say('Couldn’t send the note. Your link may have expired.');
  };
  (document.body||document.documentElement).append(host);
}
})();`;
}
