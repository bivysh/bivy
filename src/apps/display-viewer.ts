// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

export const DISPLAY_SOCKET_PATH = "/__bivy/display";
export const NOVNC_PATH = "/__bivy/novnc/";

/** The page a display view serves on its own origin: noVNC's client streaming
 * the app's display. It asks the display to match its size, scales down when
 * the display is larger, reconnects while the app starts, and gives phones a
 * way to open the on-screen keyboard. */
export function displayViewer(nonce: string, name: string): string {
  const title = name.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, interactive-widget=resizes-content"><title>${title}</title>
<style nonce="${nonce}">:root{color-scheme:light dark;font-family:system-ui,sans-serif}html,body{margin:0;height:100%;overflow:hidden;background:Canvas;color:CanvasText}
#screen{position:fixed;inset:0}#status{position:fixed;inset:0;display:grid;place-items:center;margin:0;padding:24px;text-align:center;line-height:1.5}#status[hidden]{display:none}
#keys{position:fixed;left:12px;bottom:12px;min-width:44px;min-height:44px;border-radius:22px;border:1px solid GrayText;background:Canvas;color:CanvasText;font:inherit;display:none}
@media (pointer:coarse){#keys{display:block}}#typing{position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;border:0;padding:0}</style>
<div id="screen"></div><p id="status" role="status">Starting the app…</p>
<button id="keys" type="button" aria-label="Show keyboard">⌨</button><input id="typing" aria-label="Type into the app" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false">
<script type="module" nonce="${nonce}">import RFB from "${NOVNC_PATH}core/rfb.js";
const screen=document.getElementById("screen"),status=document.getElementById("status"),typing=document.getElementById("typing");
let rfb,wait=500;
const say=text=>{status.textContent=text;status.hidden=!text;};
function connect(){
  rfb=new RFB(screen,(location.protocol==="https:"?"wss://":"ws://")+location.host+"${DISPLAY_SOCKET_PATH}",{shared:true});
  rfb.resizeSession=true;rfb.scaleViewport=true;rfb.focusOnClick=true;
  rfb.addEventListener("connect",()=>{wait=500;say("");});
  rfb.addEventListener("disconnect",()=>{say("Starting the app…");setTimeout(connect,wait);wait=Math.min(wait*2,5000);});
}
connect();
// Phones: a soft keyboard needs a text field; forward what's typed as keys.
const SPECIAL={Backspace:0xff08,Enter:0xff0d,Tab:0xff09,Escape:0xff1b,ArrowLeft:0xff51,ArrowUp:0xff52,ArrowRight:0xff53,ArrowDown:0xff54};
document.getElementById("keys").onclick=()=>typing.focus();
typing.addEventListener("keydown",e=>{const key=SPECIAL[e.key];if(key){e.preventDefault();rfb.sendKey(key,null);}});
typing.addEventListener("input",()=>{for(const ch of typing.value){const cp=ch.codePointAt(0);rfb.sendKey(cp<256?cp:0x01000000+cp,null);}typing.value="";});
</script></html>`;
}
