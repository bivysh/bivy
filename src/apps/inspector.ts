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
// Taps and keys since this page (or route) loaded: state a retaken picture may lack.
let interacted=false;
const route=()=>{interacted=false;post({type:'route',path:location.pathname+location.search+location.hash});};
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
const report=(el,hold)=>{
  const r=el.getBoundingClientRect();
  onPicked({type:'picked',selector:selector(el),tag:el.localName,text:(el.innerText||el.getAttribute('aria-label')||el.getAttribute('alt')||'').trim().replace(/\\s+/g,' ').slice(0,200),
    rect:{x:Math.round(r.left),y:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)},
    viewport:{width:innerWidth,height:innerHeight},path:location.pathname+location.search+location.hash,hold});
};
// A long press picks at once and says so (the shell starts listening); the
// layer stays until the finger lifts, so the release never reaches the app.
let press=null,held=false;
const pick=e=>{
  e.preventDefault();
  if(held){held=false;stop();return;}
  const el=under(e);if(!el)return;stop();report(el,false);
};
const down=e=>{
  hover(e);clearTimeout(press?.timer);held=false;
  const x=e.clientX,y=e.clientY;
  press={x,y,timer:setTimeout(()=>{const el=under({clientX:x,clientY:y});if(!el)return;held=true;box?.remove();report(el,true);},450)};
};
const move=e=>{hover(e);if(press&&Math.hypot(e.clientX-press.x,e.clientY-press.y)>10)clearTimeout(press.timer);};
const up=()=>{clearTimeout(press?.timer);press=null;if(held){post({type:'release'});setTimeout(()=>{if(held){held=false;stop();}},0);}};
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
  layer.addEventListener('pointermove',move);layer.addEventListener('pointerdown',down);layer.addEventListener('pointerup',up);layer.addEventListener('pointercancel',up);layer.addEventListener('click',pick);
  layer.addEventListener('contextmenu',e=>e.preventDefault());
  document.documentElement.append(layer,box);
  addEventListener('keydown',key,true);
}
for(const type of ['pointerdown','keydown'])addEventListener(type,e=>{if(!layer&&!(host&&e.composedPath?.().includes(host)))interacted=true;},true);
// Draw (in the shell, over this page): where the page is, what state it holds
// that a fresh browser on the machine wouldn't, and what's under each mark.
const signals=()=>{
  let storage=false;try{storage=localStorage.length+sessionStorage.length>0;}catch{}
  const edited=[...document.querySelectorAll('input,textarea,select')].some(el=>el.type==='checkbox'||el.type==='radio'?el.checked!==el.defaultChecked:el.localName==='select'?[...el.options].some(o=>o.selected!==o.defaultSelected):el.type!=='hidden'&&el.value!==el.defaultValue);
  const open=Boolean(document.querySelector('dialog[open],details[open],[aria-expanded="true"],[aria-modal="true"]'));
  return {storage,cookies:Boolean(document.cookie),interacted,open,edited};
};
const drawState=()=>({type:'draw-state',scroll:{x:Math.round(scrollX),y:Math.round(scrollY)},viewport:{width:innerWidth,height:innerHeight},dpr:devicePixelRatio,
  theme:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light',path:location.pathname+location.search+location.hash,signals:signals()});
/** Elements inside a mark (viewport rect): a grid sample, then the largest
 * element under each hit that sits mostly inside the mark — circling a
 * button names the button, not the bar it's in. A line through something
 * falls back to what it crossed. Outermost first, at most eight. */
const marked=r=>{
  const hits=new Set();
  for(let i=0;i<8;i++)for(let j=0;j<8;j++){
    const x=Math.min(innerWidth-1,Math.max(0,r.x+r.width*(i+0.5)/8)),y=Math.min(innerHeight-1,Math.max(0,r.y+r.height*(j+0.5)/8));
    const el=document.elementsFromPoint(x,y).find(n=>n!==layer&&n!==box&&n!==host);if(el)hits.add(el);
  }
  const big=innerWidth*innerHeight*0.6,page=n=>n===document.body||n===document.documentElement;
  // Where an element's content is: a full-width block around "Total $102"
  // is judged by its text, which is what a circle goes around.
  const range=document.createRange();
  const rectOf=n=>{const b=n.getBoundingClientRect();if(!n.firstChild||/^(img|svg|video|canvas|input|select|textarea|button)$/.test(n.localName))return b;range.selectNodeContents(n);const c=range.getBoundingClientRect();return c.width&&c.height?c:b;};
  const inside=n=>{const b=rectOf(n),a=b.width*b.height;if(!a)return 0;const w=Math.max(0,Math.min(b.right,r.x+r.width)-Math.max(b.left,r.x)),h=Math.max(0,Math.min(b.bottom,r.y+r.height)-Math.max(b.top,r.y));return w*h/a;};
  const area=n=>{const b=rectOf(n);return b.width*b.height;};
  const picked=new Set();
  for(const hit of hits){let best=null;for(let n=hit;n&&n.nodeType===1&&!page(n);n=n.parentElement){if(inside(n)>=0.6&&area(n)<big)best=n;else if(best)break;}if(best)picked.add(best);}
  if(!picked.size)for(const hit of hits)if(!page(hit)&&area(hit)<big&&(hit.innerText||'').trim())picked.add(hit);
  const list=[...picked].filter(n=>![...picked].some(o=>o!==n&&o.contains(n)))
    .sort((a,b)=>{const p=a.getBoundingClientRect(),q=b.getBoundingClientRect();return p.top-q.top||p.left-q.left;});
  return list.slice(0,8).map(el=>{const b=el.getBoundingClientRect();return {selector:selector(el).slice(0,300),tag:el.localName,
    text:(el.innerText||el.getAttribute('aria-label')||el.getAttribute('alt')||'').trim().replace(/\\s+/g,' ').slice(0,120),
    rect:{x:Math.round(b.left+scrollX),y:Math.round(b.top+scrollY),width:Math.round(b.width),height:Math.round(b.height)}};});
};
addEventListener('message',e=>{
  if(!framed||e.origin!==SHELL||e.source!==parent)return;
  const d=e.data||{},n=v=>Number.isFinite(+v)?+v:0;
  if(d.type==='bivy:draw')post(drawState());
  else if(d.type==='bivy:scroll'){scrollBy({left:n(d.dx),top:n(d.dy),behavior:'instant'});post({type:'scrolled',scroll:{x:Math.round(scrollX),y:Math.round(scrollY)}});}
  else if(d.type==='bivy:marks'&&d.rect)post({type:'marked',id:n(d.id),elements:marked({x:n(d.rect.x),y:n(d.rect.y),width:n(d.rect.width),height:n(d.rect.height)})});
});
addEventListener('message',e=>{
  if(!framed||e.origin!==SHELL||e.source!==parent||e.data?.type!=='bivy:point')return;
  // Held: the layer goes when the finger lifts (see up).
  if(e.data.on)startPointing();else if(!held)stop();
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
