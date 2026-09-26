// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

export const DISPLAY_SOCKET_PATH = "/__bivy/display";
export const DISPLAY_STATS_PATH = "/__bivy/display-stats";
export const NOVNC_PATH = "/__bivy/novnc/";
/** The modifier apps paste with, as a keysym and noVNC key code: ⌘ on a Mac. */
const PASTE_MODIFIER: Partial<Record<NodeJS.Platform, [number, string]>> = { darwin: [0xffeb, "MetaLeft"] };

/** The page a display view serves on its own origin: noVNC's client streaming
 * the app's display. It asks the display to match its size in device pixels
 * (`scale` is what the display was started at), scales down when the display
 * is larger, reconnects while the app starts, carries the clipboard both ways
 * on a tap, gives phones a keyboard, and reports stream latency to Bivy. */
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
#typing{position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;border:0;padding:0}</style>
<div id="screen"></div><p id="status" role="status">Starting the app…</p>
<div id="tools"><button id="copy" type="button" hidden>Copy from app</button>
<form id="paste" hidden><input id="paste-text" aria-label="Text to paste into the app" placeholder="Paste here"><button type="submit">Send</button></form>
<button id="paste-open" type="button">Paste</button><button id="keys" type="button" aria-label="Show keyboard">⌨</button></div>
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
  rfb.addEventListener("connect",()=>{wait=500;say("");});
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

// Phones: a soft keyboard needs a text field; forward what's typed as keys.
const SPECIAL={Backspace:0xff08,Enter:0xff0d,Tab:0xff09,Escape:0xff1b,ArrowLeft:0xff51,ArrowUp:0xff52,ArrowRight:0xff53,ArrowDown:0xff54};
$("keys").onclick=()=>typing.focus();
typing.addEventListener("keydown",e=>{const key=SPECIAL[e.key];if(key){e.preventDefault();rfb.sendKey(key,null);}});
typing.addEventListener("input",()=>{for(const ch of typing.value){const cp=ch.codePointAt(0);rfb.sendKey(cp<256?cp:0x01000000+cp,null);}typing.value="";});
</script></html>`;
}
