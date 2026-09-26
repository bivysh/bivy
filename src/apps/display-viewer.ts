// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

export const DISPLAY_SOCKET_PATH = "/__bivy/display";
export const DISPLAY_STATS_PATH = "/__bivy/display-stats";
export const DISPLAY_MENU_PATH = "/__bivy/display-menu";
export const NOVNC_PATH = "/__bivy/novnc/";
/** The modifier apps paste with, as a keysym and noVNC key code: ⌘ on a Mac. */
const PASTE_MODIFIER: Partial<Record<NodeJS.Platform, [number, string]>> = { darwin: [0xffeb, "MetaLeft"] };

/** The page a display view serves on its own origin: noVNC's client streaming
 * the app's display. It asks the display to match its size in device pixels
 * (`scale` is what the display was started at), scales down when the display
 * is larger, reconnects while the app starts, carries the clipboard both ways
 * on a tap, gives phones a keyboard, offers the app's menu bar where the
 * display can read it (macOS), and reports stream latency to Bivy. */
export function displayViewer(nonce: string, name: string, scale: number, platform: NodeJS.Platform = process.platform): string {
  const [modifier, modifierCode] = PASTE_MODIFIER[platform] ?? [0xffe3, "ControlLeft"];
  const title = name.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, interactive-widget=resizes-content"><title>${title}</title>
<style nonce="${nonce}">:root{color-scheme:light dark;font-family:system-ui,sans-serif}html,body{margin:0;height:100%;overflow:hidden;background:Canvas;color:CanvasText}
#screen{position:fixed;inset:0}#status{position:fixed;inset:0;display:grid;place-items:center;margin:0;padding:24px;text-align:center;line-height:1.5}[hidden]{display:none!important}
#tools{position:fixed;left:12px;bottom:72px;display:flex;flex-direction:column;align-items:flex-start;gap:8px}
button,#paste{font:inherit;font-size:14px;min-height:44px;padding:0 14px;border-radius:22px;border:1px solid GrayText;background:Canvas;color:CanvasText}
#keys{display:none;min-width:44px;padding:0}@media (pointer:coarse){#keys{display:block}}
#paste{display:flex;gap:8px;align-items:center;padding:4px 4px 4px 14px}#paste input{font:inherit;min-height:36px;border:0;background:transparent;color:inherit;width:12em}
#typing{position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;border:0;padding:0}
#menu{position:fixed;left:12px;bottom:72px;width:min(22rem,calc(100vw - 24px));max-height:min(70vh,36rem);display:flex;flex-direction:column;background:Canvas;color:CanvasText;border:1px solid GrayText;border-radius:16px;box-shadow:0 8px 24px color-mix(in srgb,CanvasText 25%,transparent);overflow:hidden}
#menu header{display:flex;align-items:center;gap:4px;padding:4px;border-bottom:1px solid GrayText}
#menu header button{border:0;min-width:44px;padding:0;font-size:18px}
#menu h2{flex:1;margin:0;padding:0 8px;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#menu-status{margin:0;padding:12px 16px;color:GrayText;font-size:14px}#menu-status:empty{display:none}
#menu ul{list-style:none;margin:0;padding:4px 0;overflow:auto;overscroll-behavior:contain}
#menu li[role=separator]{border-top:1px solid GrayText;margin:4px 16px;opacity:.5}
#menu li button{display:flex;align-items:center;gap:8px;width:100%;border:0;border-radius:0;padding:0 16px;text-align:start}
#menu li button:hover:not(:disabled),#menu li button:focus-visible{background:Highlight;color:HighlightText;outline:none}
#menu li button:disabled{color:GrayText}
#menu .mark{width:1em;flex:none}#menu .label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#menu .keys{flex:none;opacity:.7;font-variant-numeric:tabular-nums}</style>
<div id="screen"></div><p id="status" role="status">Starting the app…</p>
<div id="tools"><button id="menu-open" type="button" aria-haspopup="menu" aria-controls="menu" aria-expanded="false" hidden>Menu</button><button id="copy" type="button" hidden>Copy from app</button>
<form id="paste" hidden><input id="paste-text" aria-label="Text to paste into the app" placeholder="Paste here"><button type="submit">Send</button></form>
<button id="paste-open" type="button">Paste</button><button id="keys" type="button" aria-label="Show keyboard">⌨</button></div>
<div id="menu" role="dialog" aria-labelledby="menu-title" hidden><header><button id="menu-back" type="button" aria-label="Back">‹</button><h2 id="menu-title">Menu</h2><button id="menu-close" type="button" aria-label="Close menu">✕</button></header>
<p id="menu-status" role="status"></p><ul id="menu-items" role="menu" aria-labelledby="menu-title"></ul></div>
<input id="typing" aria-label="Type into the app" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false">
<script type="module" nonce="${nonce}">import RFB from "${NOVNC_PATH}core/rfb.js";
const $=id=>document.getElementById(id),screen=$("screen"),status=$("status"),typing=$("typing"),SCALE=${scale === 2 ? 2 : 1};
let rfb,wait=500,remote="";
const say=text=>{status.textContent=text;status.hidden=!text;};

// Latency: time from each input sent to the next frame back, in this browser.
const lat=[];let pending=0,bytes=0,since=performance.now();
// (Patched in place: noVNC rejects a WebSocket subclass.)
const send=WebSocket.prototype.send,probed=new WeakSet();
WebSocket.prototype.send=function(data){
  if(!probed.has(this)){probed.add(this);this.addEventListener("message",e=>{bytes+=e.data.byteLength??e.data.size??0;if(pending){lat.push(performance.now()-pending);pending=0;}});}
  const first=data instanceof ArrayBuffer?new Uint8Array(data)[0]:ArrayBuffer.isView(data)?new Uint8Array(data.buffer,data.byteOffset,1)[0]:-1;
  if((first===4||first===5)&&!pending)pending=performance.now();
  return send.call(this,data);
};
setInterval(()=>{
  if(lat.length<5)return;
  const sorted=lat.splice(0).sort((a,b)=>a-b),at=p=>sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))];
  const secs=(performance.now()-since)/1000;since=performance.now();
  fetch("${DISPLAY_STATS_PATH}",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({latencyMs:{p50:at(.5),p95:at(.95)},kBps:bytes/1024/secs,viewport:{width:innerWidth,height:innerHeight,scale:devicePixelRatio}})}).catch(()=>{});
  bytes=0;
},10000);

function connect(){
  rfb=new RFB(screen,(location.protocol==="https:"?"wss://":"ws://")+location.host+"${DISPLAY_SOCKET_PATH}",{shared:true});
  // Ask for device pixels, so a display started at 2× stays sharp once scaled
  // to fit. Only the resize request uses them; scaling still fits CSS pixels.
  let ask=1;const measure=rfb._screenSize.bind(rfb),request=rfb._requestRemoteResize.bind(rfb);
  rfb._screenSize=()=>{const s=measure();return{w:Math.round(s.w*ask),h:Math.round(s.h*ask)};};
  rfb._requestRemoteResize=()=>{ask=SCALE;try{request();}finally{ask=1;}};
  rfb.resizeSession=true;rfb.scaleViewport=true;rfb.focusOnClick=true;
  rfb.addEventListener("connect",()=>{wait=500;say("");hasMenu();});
  rfb.addEventListener("disconnect",()=>{say("Starting the app…");setTimeout(connect,wait);wait=Math.min(wait*2,5000);});
  // The app copied text: offer it; the browser only lets a tap write the clipboard.
  rfb.addEventListener("clipboard",e=>{remote=e.detail.text;$("copy").hidden=!remote;$("copy").textContent="Copy from app";});
}
connect();

$("copy").onclick=async()=>{try{await navigator.clipboard.writeText(remote);$("copy").textContent="Copied";setTimeout(()=>{$("copy").hidden=true;},1500);}catch{$("copy").textContent="Couldn’t copy";}};
// Paste: hand the text to the app's clipboard, then press Ctrl+V (⌘V on a Mac) in it.
const paste=text=>{if(!text)return;rfb.clipboardPasteFrom(text);rfb.sendKey(${modifier},"${modifierCode}",true);rfb.sendKey(0x76,"KeyV");rfb.sendKey(${modifier},"${modifierCode}",false);rfb.focus();};
$("paste-open").onclick=async()=>{
  try{const text=await navigator.clipboard.readText();if(text){paste(text);return;}}catch{}
  // No clipboard access here: paste into a field instead.
  $("paste").hidden=false;$("paste-text").focus();
};
$("paste").onsubmit=e=>{e.preventDefault();paste($("paste-text").value);$("paste-text").value="";$("paste").hidden=true;};
$("paste-text").addEventListener("keydown",e=>{if(e.key==="Escape"){$("paste").hidden=true;rfb.focus();}});

// The app's menu bar, read when opened so enabled and checked states are
// current. Drill down through submenus; choosing an item closes the menu.
// Titles come from the app: shown as text only.
const MENU="${DISPLAY_MENU_PATH}",menu=$("menu"),items=$("menu-items"),menuStatus=$("menu-status");
let stack=[];
const hasMenu=()=>fetch(MENU,{method:"HEAD"}).then(r=>{$("menu-open").hidden=!r.ok;}).catch(()=>{});
const setOpen=open=>{menu.hidden=!open;$("tools").hidden=open;$("menu-open").setAttribute("aria-expanded",String(open));};
const closeMenu=()=>{setOpen(false);stack=[];rfb.focus();};
const cell=(cls,text)=>{const span=document.createElement("span");span.className=cls;span.textContent=text;return span;};
function show(){
  const level=stack[stack.length-1];
  $("menu-title").textContent=level.title;$("menu-back").hidden=stack.length<2;
  items.replaceChildren(...level.items.map(item=>{
    const li=document.createElement("li");
    if(item.separator){li.setAttribute("role","separator");return li;}
    li.setAttribute("role","none");
    const button=document.createElement("button");
    button.type="button";button.setAttribute("role",item.checked?"menuitemcheckbox":"menuitem");
    if(item.checked)button.setAttribute("aria-checked","true");
    button.disabled=item.enabled===false;
    button.append(cell("mark",item.checked?"✓":""),cell("label",item.title));
    if(item.items){button.setAttribute("aria-haspopup","menu");button.append(cell("keys","›"));button.onclick=()=>{stack.push({title:item.title,items:item.items,path:[...level.path,item.title]});show();};}
    else{if(item.shortcut){button.append(cell("keys",item.shortcut));button.setAttribute("aria-keyshortcuts",item.shortcut);}button.onclick=()=>choose([...level.path,item.title]);}
    li.append(button);return li;
  }));
  items.querySelector("button:not(:disabled)")?.focus();
}
async function choose(path){
  menuStatus.textContent="Choosing "+path.join(" › ")+"…";
  try{
    const r=await fetch(MENU,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path})});
    if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||"The app didn’t take it.");
    menuStatus.textContent="";closeMenu();
  }catch(e){menuStatus.textContent=e.message;}
}
$("menu-open").onclick=async()=>{
  stack=[];items.replaceChildren();setOpen(true);$("menu-back").hidden=true;$("menu-title").textContent="Menu";
  menuStatus.textContent="Reading the app’s menus…";$("menu-close").focus();
  try{
    const r=await fetch(MENU);const body=await r.json();
    if(!r.ok)throw new Error(body.error||"Couldn’t read the app’s menus.");
    menuStatus.textContent=body.menus.length?"":"This app has no menus.";
    stack=[{title:"Menu",items:body.menus.map(m=>({title:m.title,enabled:true,items:m.items})),path:[]}];show();
  }catch(e){menuStatus.textContent=e.message;}
};
$("menu-close").onclick=closeMenu;
$("menu-back").onclick=()=>{stack.pop();show();};
menu.addEventListener("keydown",e=>{
  if(e.key==="Escape"){e.preventDefault();if(stack.length>1){stack.pop();show();}else closeMenu();return;}
  if(e.key!=="ArrowDown"&&e.key!=="ArrowUp")return;
  const all=[...items.querySelectorAll("button:not(:disabled)")];if(!all.length)return;
  e.preventDefault();const at=all.indexOf(document.activeElement);
  all[(at+(e.key==="ArrowDown"?1:-1)+all.length)%all.length].focus();
});

// Phones: a soft keyboard needs a text field; forward what's typed as keys.
const SPECIAL={Backspace:0xff08,Enter:0xff0d,Tab:0xff09,Escape:0xff1b,ArrowLeft:0xff51,ArrowUp:0xff52,ArrowRight:0xff53,ArrowDown:0xff54};
$("keys").onclick=()=>typing.focus();
typing.addEventListener("keydown",e=>{const key=SPECIAL[e.key];if(key){e.preventDefault();rfb.sendKey(key,null);}});
typing.addEventListener("input",()=>{for(const ch of typing.value){const cp=ch.codePointAt(0);rfb.sendKey(cp<256?cp:0x01000000+cp,null);}typing.value="";});
</script></html>`;
}
