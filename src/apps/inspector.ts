// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/** Served on the app's own origin and injected into its HTML. It reports only
 * to the trusted shell that frames it, and everything it reports is untrusted
 * app data: the shell shows it and turns it into drafts, never into actions.
 * Agent-neutral: it observes the browser, not the framework or the agent. */
export function inspectorScript(shellOrigin: string): string {
  return `(()=>{
if(window.__bivyInspector||parent===window)return;window.__bivyInspector=1;
const SHELL=${JSON.stringify(shellOrigin)};
const post=m=>{try{parent.postMessage(Object.assign({source:'bivy-inspector'},m),SHELL);}catch{}};
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
  for(let node=el;node&&node.nodeType===1&&parts.length<4;node=node.parentElement){
    if(node.id){parts.unshift('#'+CSS.escape(node.id));break;}
    let part=node.localName;
    const classes=[...node.classList].filter(c=>!/\\d{3,}|^css-|^_/.test(c)).slice(0,2);
    if(classes.length)part+='.'+classes.map(c=>CSS.escape(c)).join('.');
    const same=node.parentElement?[...node.parentElement.children].filter(c=>c.localName===node.localName):[];
    if(same.length>1)part+=':nth-of-type('+(same.indexOf(node)+1)+')';
    parts.unshift(part);
  }
  return parts.join(' > ');
};
let box=null,target=null;
const stop=()=>{box?.remove();box=null;target=null;removeEventListener('pointermove',hover,true);removeEventListener('click',pick,true);removeEventListener('keydown',key,true);};
const hover=e=>{
  const el=document.elementFromPoint(e.clientX,e.clientY);
  if(!el||el===box)return;target=el;const r=el.getBoundingClientRect();
  Object.assign(box.style,{left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px'});
};
const pick=e=>{
  e.preventDefault();e.stopPropagation();
  const el=document.elementFromPoint(e.clientX,e.clientY)||target;stop();
  if(!el)return;const r=el.getBoundingClientRect();
  post({type:'picked',selector:selector(el),tag:el.localName,text:(el.innerText||el.getAttribute('aria-label')||el.getAttribute('alt')||'').trim().replace(/\\s+/g,' ').slice(0,200),
    rect:{x:Math.round(r.left),y:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)},
    viewport:{width:innerWidth,height:innerHeight},path:location.pathname+location.search+location.hash});
};
const key=e=>{if(e.key==='Escape'){stop();post({type:'picked',cancelled:true});}};
addEventListener('message',e=>{
  if(e.origin!==SHELL||e.source!==parent||e.data?.type!=='bivy:point')return;
  stop();if(!e.data.on)return;
  box=document.createElement('div');
  box.setAttribute('aria-hidden','true');
  Object.assign(box.style,{position:'fixed',zIndex:2147483647,pointerEvents:'none',outline:'2px solid Highlight',outlineOffset:'2px',borderRadius:'4px',transition:'all 60ms ease-out'});
  document.documentElement.append(box);
  addEventListener('pointermove',hover,true);addEventListener('click',pick,true);addEventListener('keydown',key,true);
});
})();`;
}
