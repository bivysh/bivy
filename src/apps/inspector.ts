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
let box=null,layer=null,onPicked=post,host=null;
// While pointing, a clear layer over the page takes every tap itself, so the
// app never sees one and no browser's event order matters (iOS sends no click
// to a window listener for most taps). The element is looked up beneath it.
const stop=()=>{box?.remove();layer?.remove();box=layer=null;removeEventListener('keydown',key,true);};
const under=e=>document.elementsFromPoint(e.clientX,e.clientY).find(el=>el!==layer&&el!==box&&el!==host);
const hover=e=>{
  const el=under(e);if(!el)return;const r=el.getBoundingClientRect();
  Object.assign(box.style,{left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px'});
};
const pick=e=>{
  e.preventDefault();
  const el=under(e);if(!el)return;stop();
  const r=el.getBoundingClientRect();
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
  // One below the reviewer dock, so its controls stay usable while pointing.
  layer=document.createElement('div');
  layer.setAttribute('aria-hidden','true');
  Object.assign(layer.style,{position:'fixed',inset:0,zIndex:2147483646,cursor:'crosshair',background:'transparent',touchAction:'manipulation',userSelect:'none',webkitUserSelect:'none',webkitTouchCallout:'none'});
  layer.addEventListener('pointermove',hover);layer.addEventListener('pointerdown',hover);layer.addEventListener('click',pick);
  document.documentElement.append(layer,box);
  addEventListener('keydown',key,true);
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
    // 16px: smaller, and iOS zooms the page in when the note box is focused.
    +'textarea{width:100%;min-height:5em;margin:8px 0;border:1px solid GrayText;border-radius:8px;padding:8px;background:Canvas;color:CanvasText;resize:vertical;font-size:16px}'
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
