// Valorant store remote MCP, multi-user, with "Sign in with GitHub".
//
//   Claude  --OAuth (GitHub identity)-->  this Worker  <--push (personal key)--  your PC
//
// - /mcp        the MCP endpoint (needs an OAuth access token, issued by this Worker)
// - /authorize  consent page, then GitHub sign-in (handled via @cloudflare/workers-oauth-provider)
// - /account    sign in with GitHub to get the personal key the PC script pushes with
// - /push       the PC script posts the store snapshot here (Bearer personal key)

import OAuthProvider, {
  AuthorizationError,
  CimdFetchError,
  authorizationErrorRedirect,
} from "@cloudflare/workers-oauth-provider";

import { RIOT_LOGIN_URL, RiotError, fetchSnapshot, parseCookies, parseTokens, reauth, seal, unseal } from "./riot.js";

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const randHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const s256 = async (v) => b64url(await crypto.subtle.digest("SHA-256", enc.encode(v)));

const ICON_RE = /^https:\/\/media\.valorant-api\.com\/[\w\/.-]{1,200}$/;
const safeIcon = (u) => (typeof u === "string" && ICON_RE.test(u) ? u : null);
const VP_ICON = "https://media.valorant-api.com/currencies/85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741/displayicon.png";

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

const STYLE = `
:root{color-scheme:dark;--pad:clamp(1.25rem,4vw,3.5rem);
--bg:#0f1923;--card:#16222d;--card2:#1b2a37;--text:#ece8e1;--sub:#8b978f;--line:rgba(236,232,225,.14);--fill:rgba(236,232,225,.07);
--blue:#ff4655;--blue-h:#ff6270;--red:#ff4655;--green:#3ddc97;--green-bg:rgba(61,220,151,.13);--red-bg:rgba(255,70,85,.14);--amber:#ffc24b;--amber-bg:rgba(255,194,75,.14);
--nav:rgba(15,25,35,.78);--shadow:none;
--display:"Barlow Condensed","Bebas Neue","Arial Narrow",Impact,sans-serif;
--font:"Barlow",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
--ease:cubic-bezier(.22,1,.36,1)}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;-webkit-tap-highlight-color:transparent}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font:400 17px/1.55 var(--font);-webkit-font-smoothing:antialiased;position:relative;overflow-x:hidden}
body::before{content:"";position:fixed;inset:0;z-index:-2;pointer-events:none;
background:radial-gradient(60rem 36rem at 88% -8%,rgba(255,70,85,.22),transparent 60%),radial-gradient(40rem 30rem at -10% 110%,rgba(255,70,85,.08),transparent 60%),
repeating-linear-gradient(115deg,transparent 0 46px,rgba(236,232,225,.022) 46px 47px)}
body::after{content:"";position:fixed;top:-10vh;right:8vw;width:2px;height:140vh;background:linear-gradient(transparent,rgba(255,70,85,.55),transparent);transform:rotate(18deg);z-index:-1;pointer-events:none}
nav{position:sticky;top:0;z-index:10;background:var(--nav);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);border-bottom:1px solid var(--line)}
nav div{max-width:120rem;margin:0 auto;padding:0 var(--pad);height:3.5rem;display:flex;align-items:center;justify-content:space-between}
nav a{color:var(--text);text-decoration:none;font:700 15px/1 var(--display);letter-spacing:.18em;text-transform:uppercase}
nav a.brand{display:flex;align-items:center;gap:.7rem}
nav a.link{color:var(--sub);position:relative;padding:.4rem 0;transition:color .2s}
nav a.link::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2px;background:var(--red);transform:scaleX(0);transform-origin:left;transition:transform .3s var(--ease)}
nav a.link:hover{color:var(--text)}nav a.link:hover::after{transform:scaleX(1)}
.mark{width:.9rem;height:1.35rem;background:var(--red);clip-path:polygon(35% 0,100% 0,65% 100%,0 100%);display:inline-block}
main{max-width:120rem;margin:0 auto;padding:4.5rem var(--pad) 6rem}
h1{font:800 clamp(2.9rem,10vw,7rem)/.92 var(--display);text-transform:uppercase;letter-spacing:.005em;margin:0 0 1.2rem;text-wrap:balance;position:relative}
h1::before{content:"";display:block;width:3.2rem;height:.4rem;background:var(--red);margin-bottom:1.2rem;transform-origin:left;animation:bar .7s var(--ease) both}
@keyframes bar{from{transform:scaleX(0)}}
.lead{font-size:clamp(1.05rem,2.6vw,1.25rem);line-height:1.5;color:var(--sub);margin:0 0 2.75rem;max-width:40rem;text-wrap:pretty}
.lead strong{color:var(--text)}
h2{font:700 1.65rem/1 var(--display);text-transform:uppercase;letter-spacing:.06em;margin:0}
p{margin:0 0 1rem}p:last-child{margin-bottom:0}
a{color:var(--red);text-decoration:none}a:hover{color:var(--blue-h);text-decoration:underline}
strong{font-weight:600}
.sub{color:var(--sub);font-size:15px}
.card{--cut:20px;position:relative;background:var(--card);padding:1.75rem;margin:0 0 1.4rem;
clip-path:polygon(0 0,calc(100% - var(--cut)) 0,100% var(--cut),100% 100%,var(--cut) 100%,0 calc(100% - var(--cut)));
animation:rise .6s var(--ease) both}
.card::before{content:"";position:absolute;left:0;top:0;bottom:var(--cut);width:3px;background:var(--red)}
.card:nth-of-type(2){animation-delay:.07s}.card:nth-of-type(3){animation-delay:.14s}.card:nth-of-type(4){animation-delay:.21s}
@keyframes rise{from{opacity:0;transform:translateY(16px)}}
.head{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:1rem}
.badge{display:inline-flex;align-items:center;gap:.45rem;font:700 12px/1 var(--display);letter-spacing:.16em;text-transform:uppercase;padding:.45rem .7rem;background:var(--fill);color:var(--sub);white-space:nowrap;clip-path:polygon(0 0,calc(100% - 6px) 0,100% 6px,100% 100%,6px 100%,0 calc(100% - 6px))}
.badge::before{content:"";width:.4rem;height:.4rem;background:currentColor;transform:rotate(45deg)}
.badge.ok{background:var(--green-bg);color:var(--green)}.badge.warn{background:var(--amber-bg);color:var(--amber)}.badge.bad{background:var(--red-bg);color:var(--red)}
.steps{list-style:none;margin:0 0 1.5rem;padding:0;counter-reset:s}
.steps li{counter-increment:s;position:relative;padding:0 0 1rem 3rem}.steps li:last-child{padding-bottom:0}
.steps li::before{content:counter(s);position:absolute;left:0;top:-.1rem;width:1.9rem;height:1.9rem;background:var(--red);color:var(--bg);font:800 1.1rem/1 var(--display);display:grid;place-items:center;clip-path:polygon(0 0,calc(100% - 7px) 0,100% 7px,100% 100%,7px 100%,0 calc(100% - 7px))}
.notice{background:var(--green-bg);color:var(--text);border-left:3px solid var(--green);padding:.95rem 1.2rem;margin:0 0 1.4rem;font-size:15px;animation:rise .45s var(--ease) both}
.btn,button{--c:12px;position:relative;overflow:hidden;isolation:isolate;font:700 16px/1 var(--display);letter-spacing:.14em;text-transform:uppercase;display:inline-flex;align-items:center;justify-content:center;min-height:3.1rem;padding:0 2rem;border:0;background:var(--red);color:#fff;cursor:pointer;text-decoration:none;
clip-path:polygon(0 0,calc(100% - var(--c)) 0,100% var(--c),100% 100%,var(--c) 100%,0 calc(100% - var(--c)));
transition:color .3s,transform .15s var(--ease);touch-action:manipulation;-webkit-user-select:none;user-select:none}
.btn::before,button::before{content:"";position:absolute;inset:0;z-index:-1;background:var(--text);transform:translateX(-101%);transition:transform .4s var(--ease)}
.btn:hover,button:hover{color:var(--bg);text-decoration:none}
.btn:hover::before,button:hover::before{transform:translateX(0)}
.btn:active,button:active{transform:translateY(1px) scale(.985);transition-duration:.05s}
.sec,button[value=deny]{background:var(--card2);color:var(--text);box-shadow:inset 0 0 0 1px var(--line)}
.sec::before,button[value=deny]::before{background:var(--red)}
.sec:hover,button[value=deny]:hover{color:#fff}
button.danger{background:var(--red-bg);color:var(--red)}button.danger::before{background:var(--red)}button.danger:hover{color:#fff}
.actions{display:flex;gap:.9rem;flex-wrap:wrap;margin-top:1.5rem}
.actions.split{flex-direction:row-reverse;justify-content:flex-end}.actions.split button{flex:1 1 9rem}
:focus-visible{outline:2px solid var(--text);outline-offset:3px}
textarea,input[type=password],input[type=text]{width:100%;font:inherit;font-size:16px;color:var(--text);background:rgba(0,0,0,.28);border:0;border-bottom:2px solid var(--line);border-radius:0;padding:.85rem 1rem;transition:border-color .25s,background .25s;resize:vertical}
textarea::placeholder,input::placeholder{color:var(--sub);opacity:.6}
textarea:focus,input:focus{outline:0;border-bottom-color:var(--red);background:rgba(0,0,0,.4)}
label.f{display:block;font:700 13px/1 var(--display);letter-spacing:.16em;text-transform:uppercase;color:var(--sub);margin:0 0 1rem}label.f input{margin-top:.55rem;letter-spacing:normal;font-family:var(--font)}
label.f em{font-style:normal;color:var(--red)}
details{margin-top:1.2rem;border-top:1px solid var(--line);padding-top:.25rem}
summary{list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;padding:.8rem 0;font:700 15px/1 var(--display);letter-spacing:.16em;text-transform:uppercase;-webkit-user-select:none;user-select:none}
summary::-webkit-details-marker{display:none}
summary::after{content:"";width:.6rem;height:.6rem;border-right:2px solid var(--red);border-bottom:2px solid var(--red);transform:rotate(45deg) translate(-2px,-2px);transition:transform .35s var(--ease)}
details[open] summary::after{transform:rotate(225deg)}
details .body{padding:.25rem 0 .5rem}
.switch{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin:1.1rem 0;font:700 14px/1 var(--display);letter-spacing:.16em;text-transform:uppercase;cursor:pointer}
.switch input{appearance:none;-webkit-appearance:none;flex:none;width:3.4rem;height:1.7rem;background:rgba(0,0,0,.4);box-shadow:inset 0 0 0 1px var(--line);position:relative;cursor:pointer;transition:background .25s;margin:0;clip-path:polygon(0 0,calc(100% - 7px) 0,100% 7px,100% 100%,7px 100%,0 calc(100% - 7px))}
.switch input::after{content:"";position:absolute;top:4px;left:4px;width:calc(1.7rem - 8px);height:calc(1.7rem - 8px);background:var(--sub);transition:transform .35s var(--ease),background .25s}
.switch input:checked{background:var(--red-bg)}.switch input:checked::after{background:var(--red);transform:translateX(1.7rem)}
code{font:500 .86em ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;background:var(--fill);color:var(--text);padding:.15rem .4rem;word-break:break-all}
pre{font:500 14px/1.6 ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;background:rgba(0,0,0,.35);border-left:2px solid var(--red);padding:1rem 1.1rem;margin:0 0 1.2rem;overflow:auto}
pre code{background:none;padding:0}
.copy{display:flex;align-items:center;gap:.6rem;background:rgba(0,0,0,.35);border-left:2px solid var(--red);padding:.4rem .4rem .4rem 1rem;margin-top:.7rem}
.copy code{background:none;padding:0;flex:1;min-width:0;font-size:14px}
.copy button{min-height:2.2rem;padding:0 1rem;font-size:13px;--c:7px}
em{font-style:normal;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,26rem),1fr));gap:1.4rem;align-items:start}.grid>.card{margin:0}
.narrow{max-width:40rem}
.sect{margin:0 0 2.75rem}
.tools{display:flex;align-items:center;gap:.8rem;flex-wrap:wrap}.tools form{margin:0}
.sm{min-height:2.3rem;padding:0 1.1rem;font-size:13px;--c:8px}
.notice.warn{background:var(--amber-bg);border-left-color:var(--amber)}
.skins{display:grid;gap:1rem;grid-template-columns:repeat(2,minmax(0,1fr))}
.skin{--cut:12px;position:relative;display:flex;flex-direction:column;background:#101820;clip-path:polygon(0 0,calc(100% - var(--cut)) 0,100% var(--cut),100% 100%,var(--cut) 100%,0 calc(100% - var(--cut)));transition:transform .35s var(--ease);animation:rise .6s var(--ease) both;animation-delay:calc(var(--i,0)*70ms)}
.skin:hover{transform:translateY(-4px)}
.art{position:relative;aspect-ratio:16/10;display:grid;place-items:center;padding:1rem;overflow:hidden;
background:radial-gradient(70% 60% at 50% 38%,rgba(255,255,255,.1),transparent 70%),linear-gradient(180deg,#39414a 0%,#3a3532 55%,#7a4a26 100%)}
.art img{max-width:100%;max-height:100%;object-fit:contain;filter:drop-shadow(0 8px 10px rgba(0,0,0,.5));transition:transform .5s var(--ease)}
.skin:hover .art img{transform:scale(1.07) rotate(-1.5deg)}
.art.none::after{content:"";width:2.6rem;height:2.6rem;border:2px solid rgba(236,232,225,.22);transform:rotate(45deg)}
.meta{display:flex;align-items:center;justify-content:space-between;gap:.6rem;padding:.8rem .95rem;border-top:1px solid rgba(236,232,225,.08)}
.meta .nm{min-width:0;font:700 .95rem/1.15 var(--display);letter-spacing:.08em;text-transform:uppercase}
.vp{flex:none;display:inline-flex;align-items:center;gap:.35rem;font:700 1.05rem/1 var(--display);letter-spacing:.04em}.vp img{width:1rem;height:1rem}
.off{position:absolute;top:.6rem;left:.6rem;z-index:1;background:var(--red);color:#fff;font:800 .9rem/1 var(--display);letter-spacing:.08em;padding:.3rem .5rem}
.stale .skin{opacity:.5;filter:saturate(.4)}
@media(min-width:46rem){.skins{grid-template-columns:repeat(4,minmax(0,1fr))}.skins.nm{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(min-width:84rem){.skins.nm{grid-template-columns:repeat(6,minmax(0,1fr))}}
@media(max-width:34rem){main{padding-top:2.75rem}.meta{flex-direction:column;align-items:flex-start;gap:.45rem}.card{--cut:14px;padding:1.3rem}.head{align-items:flex-start;flex-direction:column;gap:.7rem}body::after{display:none}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:opacity .2s!important}.btn:active,button:active{transform:none}}
@media(prefers-reduced-transparency:reduce){nav{-webkit-backdrop-filter:none;backdrop-filter:none;background:var(--bg)}}
@media(prefers-contrast:more){.sub,.lead{color:var(--text)}.card{box-shadow:inset 0 0 0 1px var(--text)}}
`;

const COPY_JS = `document.addEventListener("click",function(e){var b=e.target.closest("[data-copy]");if(!b)return;
var t=b.getAttribute("data-copy"),o=b.textContent;
(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(function(){b.textContent="Copied"},function(){b.textContent="Press Ctrl+C"});
setTimeout(function(){b.textContent=o},1600)});`;

const TICK_JS = `(function(){function f(ms){var m=Math.max(0,Math.floor(ms/6e4)),d=Math.floor(m/1440),h=Math.floor(m%1440/60);m%=60;return(d?d+"d ":"")+((d||h)?h+"h ":"")+m+"m"}
function t(){document.querySelectorAll("[data-end]").forEach(function(e){var l=e.getAttribute("data-end")*1000-Date.now();e.textContent=l>0?e.getAttribute("data-pre")+" "+f(l):"Rotated"})}t();setInterval(t,3e4)})();`;

// opts: { lead } is the subtitle under the heading (trusted HTML), { heading } overrides the h1 text.
function page(title, body, status = 200, headers = new Headers(), opts = {}) {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  const html = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0f1923">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700;800&family=Barlow:wght@400;500;600&display=swap">
<title>${esc(title)}</title>
<style>${STYLE}</style>
<nav><div><a class="brand" href="/"><span class="mark"></span>Store Connector</a><a class="link" href="/account">Account</a></div></nav>
<main>
<h1>${esc(opts.heading ?? title)}</h1>
${opts.lead ? `<p class="lead">${opts.lead}</p>` : ""}
${body}
</main>
<script>${COPY_JS}${TICK_JS}</script></html>`;
  return new Response(html, { status, headers });
}

// ---------- GitHub ----------

const UA = "valorant-store-mcp";

function githubAuthorizeUrl(env, origin, state, challenge) {
  const u = new URL("https://github.com/login/oauth/authorize");
  u.search = new URLSearchParams({
    client_id: env.GH_CLIENT_ID,
    redirect_uri: `${origin}/callback`,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return u.toString();
}

// Exchanges the code and reads the public profile. No GitHub scopes are requested and the
// GitHub token is discarded straight away, only the numeric id and login are kept.
async function githubUser(env, origin, code, verifier) {
  const r = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({
      client_id: env.GH_CLIENT_ID,
      client_secret: env.GH_CLIENT_SECRET,
      code,
      redirect_uri: `${origin}/callback`,
      code_verifier: verifier,
    }),
  });
  const t = await r.json();
  if (!t.access_token) throw new Error(t.error_description || "GitHub sign-in failed");
  const u = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${t.access_token}`, Accept: "application/vnd.github+json", "User-Agent": UA },
  });
  const user = await u.json();
  if (!user.id || !user.login) throw new Error("Could not read GitHub profile");
  return { id: String(user.id), login: String(user.login) };
}

// ALLOWED_USERS (optional, comma-separated GitHub logins). Empty means anyone can sign in.
function isAllowed(env, login) {
  const list = (env.ALLOWED_USERS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.length === 0 || list.includes(login.toLowerCase());
}

const notAllowed = (login, headers) =>
  page("Not allowed", `<p>The GitHub account <strong>${esc(login)}</strong> is not on this server's allow list.</p>`, 403, headers);

// ---------- store rendering ----------

function fmtDur(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function render(snap, origin) {
  if (!snap) {
    return (
      "No store data yet. Connect your Riot account at " +
      `${origin}/account (Riot login, or the PC script) and then ask again.`
    );
  }
  const now = Date.now();
  const ageMs = now - snap.fetched_at * 1000;
  const lines = [];
  if (now > snap.daily_ends_at * 1000) {
    lines.push(
      `Warning: this snapshot is stale (taken ${fmtDur(ageMs)} ago and the store has rotated since). Open the Riot Client on the PC so it refreshes.`
    );
  } else {
    lines.push(`Daily store, rotates in ${fmtDur(snap.daily_ends_at * 1000 - now)} (snapshot ${fmtDur(ageMs)} old):`);
  }
  for (const s of snap.daily || []) lines.push(`- ${s.name}: ${s.vp} VP`);
  const nm = snap.night_market;
  if (nm && now < nm.ends_at * 1000) {
    lines.push("", `Night Market, ends in ${fmtDur(nm.ends_at * 1000 - now)}:`);
    for (const s of nm.items || []) lines.push(`- ${s.name}: ${s.vp} VP (${s.discount}% off)`);
  }
  return lines.join("\n");
}

// Reads the user's snapshot. If it is missing or the store has rotated (or force is set) and the user
// chose "stay logged in", refreshes it from Riot using their saved (encrypted) cookies.
async function loadSnapshot(env, userId, { force = false } = {}) {
  const out = { snap: await env.STORE.get("snap:" + userId, "json"), attempted: false, expired: false, failed: false, error: "" };
  if (!force && out.snap && Date.now() <= out.snap.daily_ends_at * 1000) return out;
  const rec = await env.STORE.get("riot:" + userId, "json");
  if (!rec?.sealed || !env.RIOT_ENCRYPTION_KEY) return out;
  out.attempted = true;
  try {
    const r = await reauth(await unseal(env.RIOT_ENCRYPTION_KEY, rec.sealed));
    out.snap = (await fetchSnapshot(env, r.tokens)).snapshot;
    await env.STORE.put("snap:" + userId, JSON.stringify(out.snap));
    await env.STORE.put(
      "riot:" + userId,
      JSON.stringify({ ...rec, sealed: await seal(env.RIOT_ENCRYPTION_KEY, r.cookies), refreshed: Date.now() })
    );
  } catch (e) {
    if (e instanceof RiotError && e.code === "session_expired") {
      out.expired = true;
      await env.STORE.put("riot:" + userId, JSON.stringify({ ...rec, sealed: undefined, expired: Date.now() }));
    } else {
      out.failed = true;
      out.error = e instanceof RiotError ? e.message : "";
    }
  }
  return out;
}

// Returns the store text for Claude.
async function getStoreText(env, userId, origin) {
  const r = await loadSnapshot(env, userId);
  let note = "";
  if (r.expired) note = `\n\nYour saved Riot login has expired. Reconnect at ${origin}/account.`;
  else if (r.failed) note = `\n\nCould not refresh from Riot${r.error ? ": " + r.error : "."}`;
  return render(r.snap, origin) + note;
}

// ---------- MCP (JSON-RPC over HTTP), behind OAuth ----------

const TOOL = {
  name: "get_valorant_store",
  description:
    "Get the user's current Valorant daily skin store (4 skins with VP prices, time until rotation) and the Night Market if active.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
};

async function rpc(msg, userId, env, origin) {
  const { id, method, params } = msg;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const err = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  if (id === undefined) return null; // notification
  switch (method) {
    case "initialize":
      return ok({
        protocolVersion: params?.protocolVersion || "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "valorant-store", version: "2.0.0" },
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: [TOOL] });
    case "tools/call": {
      if (params?.name !== TOOL.name) return err(-32602, "Unknown tool");
      return ok({ content: [{ type: "text", text: await getStoreText(env, userId, origin) }] });
    }
    default:
      return err(-32601, "Method not found");
  }
}

const mcpHandler = {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    }
    const userId = ctx.props?.userId;
    if (!userId) return new Response("unauthorized", { status: 401 });
    const origin = new URL(request.url).origin;
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    }
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => rpc(m, userId, env, origin)))).filter(Boolean);
      return out.length ? json(out) : new Response(null, { status: 202 });
    }
    const res = await rpc(body, userId, env, origin);
    return res ? json(res) : new Response(null, { status: 202 });
  },
};

// ---------- push (from the PC) ----------

function validSnapshot(s) {
  return (
    s &&
    Number.isFinite(s.fetched_at) &&
    Number.isFinite(s.daily_ends_at) &&
    Array.isArray(s.daily) &&
    s.daily.length <= 8 &&
    s.daily.every((d) => typeof d.name === "string" && Number.isFinite(d.vp))
  );
}

async function handlePush(request, env) {
  const key = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const userId = key ? await env.STORE.get("pk:" + (await sha256(key))) : null;
  if (!userId) return new Response("unauthorized", { status: 401 });
  let snap;
  try {
    snap = await request.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }
  if (!validSnapshot(snap)) return new Response("bad snapshot", { status: 400 });
  // Keep only the fields we use.
  const clean = {
    fetched_at: snap.fetched_at,
    daily_ends_at: snap.daily_ends_at,
    daily: snap.daily.map((d) => ({ name: d.name.slice(0, 80), vp: d.vp, icon: safeIcon(d.icon) })),
    night_market: snap.night_market
      ? {
          ends_at: snap.night_market.ends_at,
          items: (snap.night_market.items || []).slice(0, 8).map((d) => ({
            name: String(d.name).slice(0, 80),
            vp: d.vp,
            discount: d.discount,
            icon: safeIcon(d.icon),
          })),
        }
      : null,
  };
  await env.STORE.put("snap:" + userId, JSON.stringify(clean));
  return new Response("ok");
}

// ---------- /account: GitHub sign-in, then a small dashboard ----------

const ACCT_COOKIE = "__Host-vs-acct";
const SESS_COOKIE = "__Host-vs-sess";
const cookieOf = (request, name) =>
  (request.headers.get("Cookie") || "")
    .split(/;\s*/)
    .map((c) => c.split("="))
    .find(([k]) => k === name)?.[1];
const setCookie = (name, value, maxAge) =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;

async function getSession(request, env) {
  const id = cookieOf(request, SESS_COOKIE);
  if (!id) return null;
  const s = await env.STORE.get("sess:" + id, "json");
  return s ? { id, ...s } : null;
}

async function startAccount(request, env) {
  const origin = new URL(request.url).origin;
  const id = randHex(16);
  const verifier = randHex(32);
  await env.STORE.put("acct:" + id, verifier, { expirationTtl: 600 });
  const headers = new Headers({
    Location: githubAuthorizeUrl(env, origin, "acct_" + id, await s256(verifier)),
    "Set-Cookie": setCookie(ACCT_COOKIE, id, 600),
  });
  return new Response(null, { status: 302, headers });
}

async function finishAccount(request, env, url, state) {
  const id = state.slice(5);
  const clear = new Headers({ "Set-Cookie": setCookie(ACCT_COOKIE, "", 0) });
  const verifier = await env.STORE.get("acct:" + id);
  await env.STORE.delete("acct:" + id);
  if (!verifier || cookieOf(request, ACCT_COOKIE) !== id) {
    return page("Sign-in expired", `<p>Start again at <a href="/account">/account</a>.</p>`, 400, clear);
  }
  if (url.searchParams.get("error") || !url.searchParams.get("code")) {
    return page("Sign-in cancelled", `<p>Start again at <a href="/account">/account</a>.</p>`, 400, clear);
  }
  const user = await githubUser(env, url.origin, url.searchParams.get("code"), verifier);
  if (!isAllowed(env, user.login)) return notAllowed(user.login, clear);

  const sid = randHex(24);
  await env.STORE.put(
    "sess:" + sid,
    JSON.stringify({ userId: user.id, login: user.login, csrf: randHex(16) }),
    { expirationTtl: 3600 }
  );
  const headers = new Headers({ Location: "/account" });
  headers.append("Set-Cookie", setCookie(ACCT_COOKIE, "", 0));
  headers.append("Set-Cookie", setCookie(SESS_COOKIE, sid, 3600));
  return new Response(null, { status: 302, headers });
}

const fmtLeft = (ms) => {
  let m = Math.max(0, Math.floor(ms / 60000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  m %= 60;
  return (d ? d + "d " : "") + (d || h ? h + "h " : "") + m + "m";
};

function skinCard(s, i) {
  const icon = safeIcon(s.icon);
  const off = Number(s.discount) || 0;
  return `<article class="skin" style="--i:${i}">
<div class="art${icon ? "" : " none"}">${off ? `<span class="off">-${off}%</span>` : ""}${icon ? `<img src="${esc(icon)}" alt="" loading="lazy" decoding="async">` : ""}</div>
<div class="meta"><span class="nm">${esc(s.name)}</span><span class="vp"><img src="${VP_ICON}" alt="VP" width="16" height="16">${(Number(s.vp) || 0).toLocaleString("en-US")}</span></div>
</article>`;
}

async function dashboard(env, sess, origin, flash = "", preloaded = null) {
  const loaded = preloaded ?? (await loadSnapshot(env, sess.userId));
  const snap = loaded.snap;
  const [user, riot] = await Promise.all([
    env.STORE.get("user:" + sess.userId, "json"),
    env.STORE.get("riot:" + sess.userId, "json"),
  ]);
  const now = Date.now();
  const ago = (ms) => `${fmtDur(Date.now() - ms)} ago`;
  const [riotLabel, riotTone, riotText] = !riot
    ? ["Not connected", "", "Log in with Riot to let Claude read your store."]
    : riot.sealed
      ? ["Staying logged in", "ok", `Connected ${ago(riot.connected)}. Your store refreshes itself when it rotates.`]
      : riot.expired
        ? ["Expired", "bad", "The saved login expired. Reconnect below."]
        : ["Connected", "warn", `Connected once, ${ago(riot.connected)}. It will not refresh by itself.`];
  const snapStatus = snap ? `Last store snapshot: ${ago(snap.fetched_at * 1000)}.` : "No store snapshot yet.";
  const csrf = `<input type="hidden" name="csrf" value="${esc(sess.csrf)}">`;

  // ----- the store itself -----
  const warn = (t) => `<div class="notice warn" role="status">${esc(t)}</div>`;
  let storeNote = "";
  if (!preloaded) {
    if (loaded.expired) storeNote = warn("Your saved Riot login has expired. Reconnect below.");
    else if (loaded.failed) storeNote = warn("Could not refresh from Riot" + (loaded.error ? ": " + loaded.error : "."));
  }
  const refresh = riot?.sealed
    ? `<form method="post" action="/account/refresh">${csrf}<button class="sec sm">Refresh</button></form>`
    : "";
  let store;
  if (!snap) {
    store = `<section class="sect"><div class="card"><div class="head"><h2>Daily store</h2></div>
<p class="sub">No store yet. Log in with Riot below, or run the PC script, and your skins show up here.</p></div></section>`;
  } else {
    const stale = now > snap.daily_ends_at * 1000;
    const nm = snap.night_market;
    const nmLive = nm && now < nm.ends_at * 1000 && (nm.items || []).length;
    store = `<section class="sect${stale ? " stale" : ""}">
<div class="head"><h2>Daily store</h2><div class="tools">${
      stale
        ? '<span class="badge warn">Out of date</span>'
        : `<span class="badge ok" data-end="${Number(snap.daily_ends_at)}" data-pre="Rotates in">Rotates in ${fmtLeft(snap.daily_ends_at * 1000 - now)}</span>`
    }${refresh}</div></div>
${storeNote}${stale ? `<p class="sub" style="margin:0 0 1rem">This snapshot is from ${ago(snap.fetched_at * 1000)}, before the store rotated. ${riot?.sealed ? "Hit Refresh." : "Log in with Riot below to update it."}</p>` : ""}
<div class="skins">${(snap.daily || []).map((s, i) => skinCard(s, i)).join("")}</div>
</section>
${nmLive ? `<section class="sect">
<div class="head"><h2>Night Market</h2><div class="tools"><span class="badge warn" data-end="${Number(nm.ends_at)}" data-pre="Ends in">Ends in ${fmtLeft(nm.ends_at * 1000 - now)}</span></div></div>
<div class="skins nm">${nm.items.map((s, i) => skinCard(s, i)).join("")}</div>
</section>` : ""}`;
  }
  if (!snap && storeNote) store = storeNote + store;

  const stay = env.RIOT_ENCRYPTION_KEY
    ? `<details>
<summary>Stay logged in</summary>
<div class="body">
<p class="sub">Paste the <em>value</em> of each Riot login cookie from auth.riotgames.com. <code>ssid</code> is required, the others make it last longer.
Find them in your browser's developer tools under Application or Storage, then Cookies.
They are saved encrypted and only used when you ask Claude for your store and today's snapshot is out of date.
They usually last 1 to 3 weeks before you need to reconnect. Anyone with these cookies can act as your Riot account,
so only turn this on if you trust whoever runs this server.</p>
<label class="switch">Keep me logged in<input type="checkbox" name="stay" value="1"></label>
${["ssid", "clid", "csid", "tdid"]
  .map(
    (n) =>
      `<label class="f">${n}${n === "ssid" ? " <em>(required)</em>" : ""}<input type="password" name="cookie_${n}" autocomplete="off" spellcheck="false"></label>`
  )
  .join("\n")}
</div>
</details>`
    : "";

  return page(
    "Your store",
    `${flash ? `<div class="notice${/^(Done|Disconnected)/.test(flash) ? "" : " warn"}" role="status">${esc(flash)}</div>` : ""}
${store}
<div class="grid">
<section class="card">
<div class="head"><h2>Riot login</h2><span class="badge ${riotTone}">${esc(riotLabel)}</span></div>
<p class="sub">${esc(riotText)}</p>
<ol class="steps">
<li><a href="${esc(RIOT_LOGIN_URL)}" target="_blank" rel="noopener noreferrer">Log in on Riot's own page</a>. This site never sees your password.</li>
<li>You land on a page that looks empty or broken. Copy the full address from the address bar.</li>
<li>Paste it here.</li>
</ol>
<form method="post" action="/account/riot">${csrf}
<textarea name="paste" rows="3" placeholder="https://playvalorant.com/opt_in#access_token=..." aria-label="Address after logging in"></textarea>
${stay}
<div class="actions"><button>Get my store</button></div>
</form>
</section>
<section class="card">
<div class="head"><h2>PC script</h2><span class="badge ${user?.pk_hash ? "ok" : ""}">${user?.pk_hash ? "Key created" : "No key"}</span></div>
<p class="sub">Run a small script on your PC to push your store here. Creating a new key replaces the old one.</p>
<form method="post" action="/account/pc-key">${csrf}<div class="actions"><button class="sec">Create PC key</button></div></form>
</section>
${riot || snap ? `<section class="card">
<div class="head"><h2>Disconnect</h2></div>
<p class="sub">Deletes your saved Riot connection and store snapshot from this server.</p>
<form method="post" action="/account/disconnect">${csrf}<div class="actions"><button class="danger">Delete my Riot connection and snapshot</button></div></form>
</section>` : ""}
</div>`,
    200,
    new Headers(),
    { lead: `Signed in as <strong>${esc(sess.login)}</strong>. ${esc(snapStatus)}` }
  );
}

async function mintPcKey(env, sess, origin) {
  const key = "vs_" + randHex(24);
  const hash = await sha256(key);
  const prev = await env.STORE.get("user:" + sess.userId, "json");
  if (prev?.pk_hash) await env.STORE.delete("pk:" + prev.pk_hash);
  await env.STORE.put("pk:" + hash, sess.userId);
  await env.STORE.put("user:" + sess.userId, JSON.stringify({ login: sess.login, pk_hash: hash, updated: Date.now() }));
  const cfg = JSON.stringify({ worker_url: origin, key }, null, 2);
  return page(
    "PC setup key",
    `<section class="card narrow">
<p>Save this as <code>config.json</code> next to <code>push_store.py</code> on your PC. It is shown once.</p>
<pre><code>${esc(cfg)}</code></pre>
<button type="button" class="sec" data-copy="${esc(cfg)}">Copy</button>
<p class="sub" style="margin-top:1rem">Then run <code>python push_store.py</code> with the Riot Client open, and <code>setup_task.ps1</code> to keep it updated.</p>
<div class="actions"><a class="btn" href="/account">Done</a></div>
</section>`
  );
}

async function connectRiot(env, sess, form, origin) {
  const uid = sess.userId;
  let tokens = parseTokens(String(form.get("paste") || ""));
  let sealed = null;
  let warn = "";

  if (form.get("stay") === "1") {
    if (!env.RIOT_ENCRYPTION_KEY) {
      warn = " Staying logged in is not enabled on this server.";
    } else {
      const cookies = parseCookies(
        ["ssid", "clid", "csid", "tdid"]
          .map((n) => [n, String(form.get("cookie_" + n) || "").trim()])
          .filter(([, v]) => v)
          .map(([n, v]) => `${n}=${v}`)
          .join("; ")
      );
      if (!cookies) {
        warn = " Staying logged in needs the ssid cookie, so it was not turned on.";
      } else {
        try {
          const r = await reauth(cookies);
          sealed = await seal(env.RIOT_ENCRYPTION_KEY, r.cookies);
          if (!tokens) tokens = r.tokens;
        } catch {
          warn = " Those cookies did not work (expired or incomplete), so staying logged in was not turned on.";
        }
      }
    }
  }

  if (!tokens) {
    return dashboard(env, sess, origin, "Nothing usable was pasted. Copy the whole address after logging in, it contains access_token=." + warn);
  }

  let result;
  try {
    result = await fetchSnapshot(env, tokens);
  } catch (e) {
    return dashboard(env, sess, origin, (e instanceof RiotError ? e.message : "Could not read the store.") + warn);
  }

  await env.STORE.put("snap:" + uid, JSON.stringify(result.snapshot));
  const rec = { puuid: result.puuid, shard: result.shard, connected: Date.now() };
  if (sealed) rec.sealed = sealed;
  await env.STORE.put("riot:" + uid, JSON.stringify(rec));
  return dashboard(env, sess, origin, "Done. Ask Claude for your Valorant store." + warn);
}

async function accountPost(request, env, url) {
  const sess = await getSession(request, env);
  if (!sess) return page("Signed out", `<p><a href="/account">Sign in again</a>.</p>`, 401);
  const form = await request.formData();
  if (form.get("csrf") !== sess.csrf) {
    return page("Bad request", `<p>The session check failed. Reload <a href="/account">/account</a>.</p>`, 400);
  }
  switch (url.pathname) {
    case "/account/pc-key":
      return mintPcKey(env, sess, url.origin);
    case "/account/riot":
      return connectRiot(env, sess, form, url.origin);
    case "/account/refresh": {
      const r = await loadSnapshot(env, sess.userId, { force: true });
      const flash = r.expired
        ? "Your saved Riot login has expired. Reconnect below."
        : r.failed
          ? "Could not refresh from Riot" + (r.error ? ": " + r.error : ".")
          : r.attempted
            ? "Done. Store refreshed."
            : "Nothing to refresh. Log in with Riot below.";
      return dashboard(env, sess, url.origin, flash, r);
    }
    case "/account/disconnect":
      await env.STORE.delete("riot:" + sess.userId);
      await env.STORE.delete("snap:" + sess.userId);
      return dashboard(env, sess, url.origin, "Disconnected. Your Riot connection and store snapshot were deleted.");
    default:
      return new Response("not found", { status: 404 });
  }
}

// ---------- OAuth for Claude: consent, then GitHub ----------

function consentPage(d, handle, headers) {
  const origin = d.clientDomain
    ? `Published by <strong>${esc(d.clientDomain)}</strong>.`
    : "This app registered itself, so its name is not verified.";
  return page(
    `Allow ${d.clientName} to read your Valorant store?`,
    `<section class="card narrow">
<p>${origin} Access will be sent to <strong>${esc(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? `<p class="notice" style="background:var(--amber-bg)"><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>` : ""}
<p class="sub">You will sign in with GitHub next. Only your GitHub username and id are used.</p>
<form method="post">
<input type="hidden" name="handle" value="${esc(handle)}">
<div class="actions split"><button name="decision" value="approve">Allow</button><button name="decision" value="deny">Deny</button></div>
</form>
</section>`,
    200,
    headers
  );
}

async function authorizeGet(request, env) {
  const oauth = env.OAUTH_PROVIDER;
  const req = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(req);
  const consent = await oauth.beginConsent(req);
  return consentPage(details, consent.handle, consent.headers);
}

async function authorizePost(request, env) {
  const oauth = env.OAUTH_PROVIDER;
  const origin = new URL(request.url).origin;
  const form = await request.formData();
  const handle = String(form.get("handle"));
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(request, handle);
  const verifier = randHex(32);
  const { state, headers } = await oauth.beginUpstream(approved.request, {
    data: { verifier },
    headers: approved.headers,
  });
  headers.set("Location", githubAuthorizeUrl(env, origin, state, await s256(verifier)));
  return new Response(null, { status: 302, headers });
}

async function callback(request, env) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") || "";
  if (state.startsWith("acct_")) return finishAccount(request, env, url, state);

  const oauth = env.OAUTH_PROVIDER;
  const { request: original, data, headers } = await oauth.finishUpstream(request);
  if (url.searchParams.get("error") || !url.searchParams.get("code")) {
    headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
    return new Response(null, { status: 302, headers });
  }
  const user = await githubUser(env, url.origin, url.searchParams.get("code"), data.verifier);
  if (!isAllowed(env, user.login)) return notAllowed(user.login, headers);

  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: user.id,
    metadata: { login: user.login },
    scope: original.scope,
    props: { userId: user.id, login: user.login },
  });
  headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers });
}

// ---------- default (non-API) handler ----------

const home = (origin) =>
  page(
    "Valorant store connector",
    `<div class="grid">
<section class="card">
<div class="head"><h2>1. Add the connector</h2></div>
<p class="sub">In Claude, add a custom connector with this URL and sign in with GitHub.</p>
<div class="copy"><code>${esc(origin)}/mcp</code><button type="button" data-copy="${esc(origin)}/mcp">Copy</button></div>
</section>
<section class="card">
<div class="head"><h2>2. Connect Riot</h2></div>
<p class="sub">Log in with Riot, or run the PC script, so Claude and this site can read your store.</p>
<div class="actions"><a class="btn" href="/account">Connect Riot account</a></div>
</section>
</div>`,
    200,
    new Headers(),
    { heading: "Your Valorant store, in Claude.", lead: "Ask Claude what is in your daily store or Night Market, from any device." }
  );

const defaultHandler = {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/authorize") {
        if (request.method === "GET") return await authorizeGet(request, env);
        if (request.method === "POST") return await authorizePost(request, env);
      }
      if (url.pathname === "/callback" && request.method === "GET") return await callback(request, env);
      if (url.pathname === "/account" && request.method === "GET") {
        const sess = await getSession(request, env);
        return sess ? await dashboard(env, sess, url.origin) : await startAccount(request, env);
      }
      if (url.pathname.startsWith("/account/") && request.method === "POST") return await accountPost(request, env, url);
      if (url.pathname === "/push" && request.method === "POST") return await handlePush(request, env);
      if (url.pathname === "/") return home(url.origin);
      return new Response("not found", { status: 404 });
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) {
        return Response.redirect(error.redirectTo, 302);
      }
      if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
        const message = error instanceof AuthorizationError ? error.description : "This app could not be verified.";
        return page("Could not authorize", `<p>${esc(message)}</p>`, 400);
      }
      console.error(error);
      return page("Something went wrong", `<p>${esc(error.message || "Unexpected error")}</p>`, 500);
    }
  },
};

// The provider is built per request because the canonical MCP resource is this Worker's own URL
// (https://<host>/mcp), which differs per deployment and custom domain.
export default {
  fetch(request, env, ctx) {
    const origin = new URL(request.url).origin;
    const provider = new OAuthProvider({
      apiRoute: "/mcp",
      apiHandler: mcpHandler,
      defaultHandler,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      resourceMetadata: { resource: `${origin}/mcp`, resource_name: "Valorant store" },
      refreshTokenTTL: 365 * 86400,
      refreshTokenIdleTTL: 90 * 86400,
    });
    return provider.fetch(request, env, ctx);
  },
};
