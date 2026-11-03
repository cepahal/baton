import { type Handoff, handoffFilePath, handoffPrompt } from "@baton/core";
import type { InboxOffer } from "./inbox.js";

/** Pages get no external resources and may only talk back to this daemon. */
export const PAGE_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

const agentName = (agent: string) => (agent === "codex" ? "Codex" : "Claude Code");

// The viewer's clay look (apps/web/src/styles.css), inlined: the page loads nothing external.
const STYLE = `
:root{--ink:#26324a;--ink-soft:#5d6a82;--ink-faint:#8a95aa;--clay:#fffaf4;--clay-2:#fbf2e8;--aqua:#ff8a2b;--aqua-deep:#d9620a;--leaf-deep:#2a9d55;--prompt:#ffe9d4;--prompt-edge:#ffc08a;
--clay-shadow:8px 8px 18px rgba(196,160,128,.35),-6px -6px 14px rgba(255,255,255,.9),inset 2px 2px 3px rgba(255,255,255,.85),inset -2px -3px 5px rgba(196,160,128,.18);
--clay-shadow-sm:4px 4px 10px rgba(196,160,128,.28),-3px -3px 8px rgba(255,255,255,.85),inset 1px 1px 2px rgba(255,255,255,.8),inset -1px -2px 3px rgba(196,160,128,.15);
--clay-pressed:inset 3px 3px 7px rgba(196,160,128,.35),inset -3px -3px 7px rgba(255,255,255,.9);
--gloss:linear-gradient(180deg,rgba(255,255,255,.75) 0%,rgba(255,255,255,0) 55%);
--orange:linear-gradient(180deg,#ffab5e,#d9620a);
--mono:"Cascadia Code","JetBrains Mono",ui-monospace,Consolas,monospace}
*{box-sizing:border-box}
body{margin:0;padding:40px 24px;min-height:100vh;color:var(--ink);font:15px/1.5 "Segoe UI Variable","Segoe UI",system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased;
background:radial-gradient(1200px 500px at 85% -10%,rgba(255,138,43,.22),transparent 60%),radial-gradient(900px 400px at -10% 110%,rgba(76,199,122,.14),transparent 60%),linear-gradient(180deg,#fff4e8,#f7efe6)}
main{max-width:860px;margin:0 auto}
h1{display:flex;align-items:center;gap:12px;font-size:22px;font-weight:700;letter-spacing:-.01em;margin:0 0 10px}
h1::before{content:"";width:16px;height:16px;border-radius:50%;flex:none;background:radial-gradient(circle at 30% 30%,#ffd09e 0%,var(--aqua) 45%,var(--aqua-deep) 100%);box-shadow:0 2px 6px rgba(217,98,10,.4)}
.meta{display:inline-block;margin:0 0 20px;padding:6px 14px;border-radius:16px;background:var(--clay-2);box-shadow:var(--clay-pressed);color:var(--ink-soft);font-size:13px}
.meta b{color:var(--ink);font-weight:700}
.box{margin:0 0 18px;padding:18px 20px;border-radius:22px;background:var(--gloss),var(--clay);box-shadow:var(--clay-shadow)}
.box p{margin:0 0 12px;color:var(--ink-soft)}
.preview{background:var(--gloss),var(--prompt);box-shadow:var(--clay-shadow),inset 4px 0 0 var(--prompt-edge)}
pre{white-space:pre-wrap;word-break:break-word;font:13px/1.55 var(--mono);margin:0;max-height:55vh;overflow:auto;color:var(--ink)}
button{font:inherit;font-weight:600;border:0;border-radius:999px;padding:9px 20px;margin:4px 10px 0 0;cursor:pointer;color:var(--ink-soft);background:var(--gloss),var(--clay);box-shadow:var(--clay-shadow-sm);transition:transform .12s ease,box-shadow .12s ease}
button:hover:not(:disabled){transform:translateY(-1px)}
button:active:not(:disabled){transform:none;box-shadow:var(--clay-pressed)}
button.primary{color:#fff;background:var(--gloss),var(--orange);box-shadow:0 6px 16px rgba(217,98,10,.35),inset 0 -2px 4px rgba(120,50,0,.25);text-shadow:0 1px 1px rgba(120,50,0,.35)}
button.primary:active:not(:disabled){box-shadow:inset 0 2px 6px rgba(120,50,0,.4)}
button.danger{color:#b2364b}
button:disabled{opacity:.5;cursor:default}
:focus-visible{outline:2px solid var(--aqua);outline-offset:2px}
label{display:block;color:var(--ink-soft);font-size:13px;font-weight:600}
input{font:inherit;font-weight:400;width:100%;margin:6px 0 14px;padding:9px 14px;border:0;border-radius:999px;background:var(--clay-2);box-shadow:var(--clay-pressed);color:var(--ink)}
input:focus{outline:none;box-shadow:var(--clay-pressed),0 0 0 2px rgba(255,138,43,.45)}
.status{display:inline-block;padding:1px 10px;border-radius:999px;font-size:12px;font-weight:600;box-shadow:var(--clay-pressed)}
.pending{background:#fff3d6;color:#9a6500}.accepted{background:#e3f7ea;color:var(--leaf-deep)}.declined{background:#fdecee;color:#b2364b}
#msg{min-height:1.5em;color:var(--aqua-deep);font-weight:600}
code{font-family:var(--mono);font-size:12.5px;padding:1px 6px;border-radius:6px;background:var(--clay-2)}
`;

function shell(title: string, body: string, script: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}<p id="msg" role="status"></p></main><script>${script}</script></body></html>`;
}

const SCRIPT_HELPERS = (base: string, token: string) => `
const TOKEN=${JSON.stringify(token)},BASE=${JSON.stringify(base)};
const msg=document.getElementById("msg");
async function post(action,body){
  msg.textContent="Working…";
  document.querySelectorAll("button").forEach(b=>b.disabled=true);
  try{
    const r=await fetch(BASE+"/"+action,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:TOKEN,...body})});
    const j=await r.json().catch(()=>({}));
    if(!r.ok){msg.textContent=j.error||("Failed ("+r.status+")");document.querySelectorAll("button").forEach(b=>b.disabled=false);if(j.needFolder){const f=document.getElementById("folderBox");if(f)f.hidden=false;}return null;}
    return j;
  }catch(e){msg.textContent=String(e);document.querySelectorAll("button").forEach(b=>b.disabled=false);return null;}
}
`;

/** The receiving user's confirm page: the preview, then Accept / Decline and the actions after. */
export function inboxPage(offer: InboxOffer, checkout: string | undefined): string {
  const h = offer.handoff;
  const id = h.id;
  const prompt = handoffPrompt(id);
  const meta = `<p class="meta"><b>${esc(h.sender)}</b> → your ${esc(agentName(h.to.agent))} session <code>${esc(h.to.sessionId.slice(0, 8))}</code> · from ${esc(h.from.user ?? "someone")}'s ${esc(agentName(h.from.agent))} session · ${esc(h.from.repoId ?? "not in git")}${h.from.branch ? ` @ <code>${esc(h.from.branch)}</code>` : ""} · <span class="status ${offer.local}">${offer.local}</span></p>`;
  let actions: string;
  if (offer.local === "pending") {
    actions = `<div class="box">
<p>Accepting writes <code>${esc(handoffFilePath(id))}</code> into ${checkout ? `<code>${esc(checkout)}</code>` : "your checkout"}. Nothing else happens until you click it.</p>
<div id="folderBox" ${checkout ? "hidden" : ""}><label>Folder of your checkout${h.from.repoId ? ` of <code>${esc(h.from.repoId)}</code>` : ""}<input id="folder" placeholder="C:\\code\\repo or /home/me/repo"></label></div>
<button class="primary" id="accept">Accept</button>
<button class="danger" id="decline">Decline</button>
</div>`;
  } else if (offer.local === "accepted") {
    actions = `<div class="box">
<p>Written to <code>${esc(offer.written ?? "")}</code></p>
<p>Prompt: <code id="prompt">${esc(prompt)}</code></p>
<button id="copy">Copy prompt</button>
<button class="primary" id="start">Start new ${esc(agentName(h.to.agent))} session</button>
${offer.started ? "<p>A terminal was opened.</p>" : ""}
</div>`;
  } else {
    actions = `<div class="box">You declined this handoff.</div>`;
  }
  const script = `${SCRIPT_HELPERS(`/inbox/${id}`, offer.token)}
const $=id=>document.getElementById(id);
$("accept")?.addEventListener("click",async()=>{const f=$("folder");const r=await post("accept",f&&f.value.trim()?{folder:f.value.trim()}:{});if(r)location.reload();});
$("decline")?.addEventListener("click",async()=>{const r=await post("decline",{});if(r)location.reload();});
$("copy")?.addEventListener("click",async()=>{await navigator.clipboard.writeText($("prompt").textContent);msg.textContent="Prompt copied.";});
$("start")?.addEventListener("click",async()=>{const r=await post("start",{});if(r){msg.textContent="Opened a terminal.";document.querySelectorAll("button").forEach(b=>b.disabled=false);}});
`;
  return shell(
    `Handoff from ${h.sender}`,
    `<h1>${kindTitle(h.kind)} from ${esc(h.sender)}</h1>${meta}<div class="box preview"><pre>${esc(h.markdown)}</pre></div>${actions}`,
    script,
  );
}

function kindTitle(kind: Handoff["kind"]): string {
  return kind === "full" ? "Session handoff" : kind === "chat" ? "Whole chat" : "Snippet";
}
