// Valorant store: a web app plus a remote MCP server, multi-user, with "Sign in with Discord".
//
//   Claude  --OAuth (Discord identity)-->  this Worker  <--  you (web app, Riot login)
//
// - /mcp        the MCP endpoint (needs an OAuth access token, issued by this Worker)
// - /authorize  consent page, then Discord sign-in (handled via @cloudflare/workers-oauth-provider)
// - /account    the web app: sign in with Discord, link Riot accounts, see your store

import OAuthProvider, {
  AuthorizationError,
  CimdFetchError,
  authorizationErrorRedirect,
} from "@cloudflare/workers-oauth-provider";

import { RIOT_LOGIN_URL, RiotError, fetchSnapshot, parseCookies, parseTokens, reauth, seal, unseal } from "./riot.js";

const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
const randHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));

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
nav>div{max-width:120rem;margin:0 auto;padding:0 var(--pad);min-height:3.5rem;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:0 1.5rem}
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
.btn,button{--cta-bg:#ff4655;--cta-text:#ece8e1;--cta-hover-bg:#ece8e1;--cta-hover-text:#0f1923;
position:relative;display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:18px 32px;border:0;border-radius:0;
background-color:var(--cta-bg);color:var(--cta-text);font:500 18px/28px var(--font);letter-spacing:.02em;text-transform:uppercase;text-align:center;text-decoration:none;cursor:pointer;
transition:color .25s ease-in-out,background-color .3s ease-in-out;touch-action:manipulation;-webkit-user-select:none;user-select:none}
.btn:hover,button:hover{color:var(--cta-hover-text);background-color:var(--cta-hover-bg);text-decoration:none}
.btn:active,button:active{transform:translateY(1px)}
.sec,button[value=deny]{--cta-bg:#ece8e1;--cta-text:#0f1923;--cta-hover-bg:#ff4655;--cta-hover-text:#ece8e1}
button.danger{--cta-bg:rgba(255,70,85,.14);--cta-text:#ff4655;--cta-hover-bg:#ff4655;--cta-hover-text:#ece8e1}
button:disabled{--cta-bg:#262f38;--cta-text:#3f474f;--cta-hover-bg:#262f38;--cta-hover-text:#3f474f;cursor:not-allowed}
.orn{outline:1px solid #ece8e1;outline-offset:3px}
.orn:focus-visible{outline:2px solid #ff4655;outline-offset:5px}
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
.copy button{padding:6px 14px;font:500 13px/20px var(--font)}
em{font-style:normal;font-weight:600}
nav a.tab{color:var(--sub);position:relative;padding:.4rem 0;transition:color .2s}
nav a.tab::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;background:var(--red);transform:scaleX(0);transform-origin:left;transition:transform .3s var(--ease)}
nav a.tab:hover,nav a.tab.on{color:var(--text)}nav a.tab:hover::after,nav a.tab.on::after{transform:scaleX(1)}
.tabs{display:flex;gap:2rem;margin:0 auto 0 2.5rem}
.who{display:flex;align-items:center;gap:.9rem;font:700 13px/1 var(--display);letter-spacing:.16em;text-transform:uppercase;color:var(--sub)}.who form{margin:0}
nav .btn,nav button{padding:8px 16px;font:500 13px/20px var(--font)}
nav .btn:hover{text-decoration:none}
.strip{--cut:20px;position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:1.5rem 3.5rem;background:var(--card);padding:1.4rem 1.75rem;margin:0 0 2.5rem;clip-path:polygon(0 0,calc(100% - var(--cut)) 0,100% var(--cut),100% 100%,var(--cut) 100%,0 calc(100% - var(--cut)));animation:rise .6s var(--ease) both}
.strip::before{content:"";position:absolute;left:0;top:0;bottom:var(--cut);width:3px;background:var(--red)}
.stat{display:flex;flex-direction:column;gap:.45rem}
.stat .k{font:700 12px/1 var(--display);letter-spacing:.2em;text-transform:uppercase;color:var(--sub)}
.stat .v{font:800 2.1rem/1 var(--display);letter-spacing:.04em;display:inline-flex;align-items:center;gap:.5rem;font-variant-numeric:tabular-nums}
.stat .v.clock{font-size:clamp(2.4rem,6vw,3.6rem)}
.stat .v.bad{color:var(--amber)}
.stat .vpi{width:1.4rem;height:1.4rem}
.strip .tools{margin-left:auto}
.empty{max-width:40rem}
.cta{margin:-1.25rem 0 1.5rem}
.trust{list-style:none;margin:0 0 3rem;padding:0;display:flex;flex-wrap:wrap;gap:.7rem 2.2rem;color:var(--sub);font-size:15px;line-height:1.45}
.trust li{position:relative;padding-left:1.45rem;max-width:23rem}
.trust li::before{content:"";position:absolute;left:0;top:.5rem;width:.55rem;height:.55rem;background:var(--green);transform:rotate(45deg)}
.trust strong{color:var(--text);font-weight:600}
.trust.stack{flex-direction:column;flex-wrap:nowrap;margin:0 0 1rem}.trust.stack li{max-width:none}
.star{grid-column:1/-1;background:linear-gradient(135deg,rgba(255,70,85,.16),transparent 55%),var(--card)}
.star .copy{max-width:36rem;margin-bottom:0}
.ghost .art{animation:pulse 1.8s ease-in-out infinite}.ghost:hover{transform:none}
.ghost .bar{height:.7rem;width:55%;background:var(--fill)}.ghost .bar.s{width:18%}
@keyframes pulse{50%{opacity:.55}}
.asks{list-style:none;margin:0 0 1rem;padding:0}
.asks li{padding:.8rem 1rem;margin:0 0 .6rem;background:rgba(0,0,0,.3);border-left:2px solid var(--red);font-weight:500}
.stepno{display:block;font:800 3rem/1 var(--display);color:var(--red);margin-bottom:.5rem}
.accts{display:flex;flex-wrap:wrap;gap:.6rem;margin:0 0 1.8rem}
.chip{--c:9px;font:700 14px/1 var(--display);letter-spacing:.14em;text-transform:uppercase;padding:.8rem 1.15rem;background:var(--card2);color:var(--sub);text-decoration:none;clip-path:polygon(0 0,calc(100% - var(--c)) 0,100% var(--c),100% 100%,var(--c) 100%,0 calc(100% - var(--c)));transition:color .2s,background .2s}
.chip:hover{color:var(--text);text-decoration:none}
.chip.on{background:var(--red);color:#fff}
.chip.add{background:var(--fill)}
.wide{grid-column:1/-1}
.acc{display:flex;align-items:center;flex-wrap:wrap;gap:.8rem 1.2rem;padding:1rem 0;border-top:1px solid var(--line)}
.head+.acc{border-top:0}
.acc .who2{flex:1 1 16rem;min-width:0;display:flex;flex-direction:column;gap:.2rem}
.aname{font:700 1.25rem/1.1 var(--display);letter-spacing:.06em;text-transform:uppercase}
.acts{display:flex;gap:.6rem;flex-wrap:wrap}.acts form{margin:0}
.connect{display:grid;gap:2.5rem;grid-template-columns:minmax(0,1fr)}
@media(min-width:62rem){.connect{grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:start}}
.steps.big li{padding-bottom:1.6rem}.steps.big li:last-child{padding-bottom:0}
.steps.big li strong{display:block;font:700 1.2rem/1.2 var(--display);letter-spacing:.06em;text-transform:uppercase;margin-bottom:.2rem}
.steps.big li .sub{display:block;margin:0 0 .9rem}
.paste textarea{min-height:9rem}
footer{border-top:1px solid var(--line);margin-top:2rem}
footer>div{max-width:120rem;margin:0 auto;padding:2rem var(--pad) 3rem;color:var(--sub);font-size:14px;display:flex;flex-wrap:wrap;gap:.8rem 2rem;align-items:center;justify-content:space-between}
footer a{color:var(--sub)}footer a:hover{color:var(--text)}
footer .links{display:flex;gap:1.6rem;flex-wrap:wrap}
footer p{margin:0;max-width:34rem}
.legal{max-width:46rem}
.legal h2{font-size:1.5rem;margin:2.6rem 0 .8rem}
.legal h2:first-child{margin-top:0}
.legal p,.legal li{color:#cfcbc4}
.legal ul{margin:0 0 1rem;padding-left:1.3rem}.legal li{margin:0 0 .55rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,26rem),1fr));gap:1.4rem;align-items:start}.grid>.card{margin:0}
.narrow{max-width:40rem}
.sect{margin:0 0 2.75rem}
.tools{display:flex;align-items:center;gap:.8rem;flex-wrap:wrap}.tools form{margin:0}
.sm{padding:9px 18px;font:500 14px/20px var(--font);letter-spacing:.02em}
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
@media(max-width:40rem){.tabs{order:3;width:100%;margin:0;gap:0;justify-content:space-between;border-top:1px solid var(--line)}nav a.tab{flex:1;text-align:center;padding:.85rem 0}nav a.tab::after{bottom:0}.who span{display:none}nav>div{min-height:3.25rem}.strip{padding:1.1rem 1.2rem;gap:1.1rem 1.8rem}.strip .tools{margin-left:0;width:100%}.cta .btn{flex:1 1 100%}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:opacity .2s!important}.btn:active,button:active{transform:none}}
@media(prefers-reduced-transparency:reduce){nav{-webkit-backdrop-filter:none;backdrop-filter:none;background:var(--bg)}}
@media(prefers-contrast:more){.sub,.lead{color:var(--text)}.card{box-shadow:inset 0 0 0 1px var(--text)}}
`;

const COPY_JS = `document.addEventListener("click",function(e){var b=e.target.closest("[data-copy]");if(!b)return;
var t=b.getAttribute("data-copy"),o=b.textContent;
(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(function(){b.textContent="Copied"},function(){b.textContent="Press Ctrl+C"});
setTimeout(function(){b.textContent=o},1600)});`;

const TICK_JS = `(function(){function p(n){return(n<10?"0":"")+n}
function f(ms){var m=Math.max(0,Math.floor(ms/6e4)),d=Math.floor(m/1440),h=Math.floor(m%1440/60);m%=60;return(d?d+"d ":"")+((d||h)?h+"h ":"")+m+"m"}
function t(){var n=Date.now();
document.querySelectorAll("[data-clock]").forEach(function(e){var s=Math.max(0,Math.floor((e.getAttribute("data-clock")*1000-n)/1e3));e.textContent=p(Math.floor(s/3600))+":"+p(Math.floor(s%3600/60))+":"+p(s%60)});
document.querySelectorAll("[data-end]").forEach(function(e){var l=e.getAttribute("data-end")*1000-n;e.textContent=l>0?e.getAttribute("data-pre")+" "+f(l):"Ended"})}
t();setInterval(t,1e3)})();`;

const TABS = [
  ["store", "Store", "/account"],
  ["connect", "Connect", "/account/connect"],
  ["claude", "Claude", "/account/claude"],
];

function navHtml(n) {
  const brand = `<a class="brand" href="${n ? "/account" : "/"}"><span class="mark"></span>Valorant Store</a>`;
  if (!n) return `<nav><div>${brand}<a class="btn sm" href="/account">Sign in</a></div></nav>`;
  const tabs = TABS.map(
    ([k, label, href]) => `<a class="tab${n.tab === k ? " on" : ""}" href="${href}"${n.tab === k ? ' aria-current="page"' : ""}>${label}</a>`
  ).join("");
  return `<nav><div>${brand}<div class="tabs">${tabs}</div><div class="who"><span>${esc(n.login)}</span><form method="post" action="/account/signout"><input type="hidden" name="csrf" value="${esc(n.csrf)}"><button class="sec sm">Sign out</button></form></div></div></nav>`;
}

// opts: { lead } is the subtitle under the heading (trusted HTML), { heading } overrides the h1 text,
// { docTitle } overrides the <title>, { nav } shows the signed-in tabs.
function page(title, body, status = 200, headers = new Headers(), opts = {}) {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  const html = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0f1923">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700;800&family=Barlow:wght@400;500;600&display=swap">
<title>${esc(opts.docTitle ?? title + " \u00b7 Valorant Store")}</title>
<style>${STYLE}</style>
${navHtml(opts.nav)}
<main>
<h1>${esc(opts.heading ?? title)}</h1>
${opts.lead ? `<p class="lead">${opts.lead}</p>` : ""}
${body}
</main>
<footer><div><p>Valorant Store is a fan project. It is not affiliated with or endorsed by Riot Games.</p><div class="links"><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="https://github.com/Eli-Zac/valorant-store" target="_blank" rel="noopener noreferrer">GitHub</a></div></div></footer>
<script>${COPY_JS}${TICK_JS}</script></html>`;
  return new Response(html, { status, headers });
}

// ---------- Discord ----------

// Discord asks API clients to identify themselves as DiscordBot (url, version).
const DISCORD_UA = "DiscordBot (https://github.com/Eli-Zac/valorant-store, 1.0)";

// Discord's docs do not list PKCE, so it is not used. The random state (checked by the OAuth provider
// for Claude, and by a cookie plus a short-lived KV entry for the web app) protects the redirect.
function discordAuthorizeUrl(env, origin, state) {
  const u = new URL("https://discord.com/oauth2/authorize");
  u.search = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    redirect_uri: `${origin}/callback`,
    response_type: "code",
    scope: "identify",
    state,
  }).toString();
  return u.toString();
}

// Exchanges the code and reads the public profile. Only the "identify" scope is requested and the
// Discord token is discarded straight away, only the id and name are kept.
async function discordUser(env, origin, code) {
  const r = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": DISCORD_UA },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: `${origin}/callback`,
    }),
  });
  const t = await r.json();
  if (!t.access_token) throw new Error(t.error_description || "Discord sign-in failed");
  const u = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${t.access_token}`, Accept: "application/json", "User-Agent": DISCORD_UA },
  });
  const user = await u.json();
  if (!user.id || !user.username) throw new Error("Could not read Discord profile");
  return { id: String(user.id), username: String(user.username), login: String(user.global_name || user.username) };
}

// ALLOWED_USERS (optional, comma-separated Discord usernames or ids). Empty means anyone can sign in.
function isAllowed(env, user) {
  const list = (env.ALLOWED_USERS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.length === 0 || list.includes(user.username.toLowerCase()) || list.includes(user.id);
}

const notAllowed = (login, headers) =>
  page("Not allowed", `<p>The Discord account <strong>${esc(login)}</strong> is not on this server's allow list.</p>`, 403, headers);

// ---------- store rendering ----------

function fmtDur(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function render(snap, origin) {
  if (!snap) {
    return (
      "No store data yet. Connect your Riot account at " +
      `${origin}/account and then ask again.`
    );
  }
  const now = Date.now();
  const ageMs = now - snap.fetched_at * 1000;
  const lines = [];
  if (now > snap.daily_ends_at * 1000) {
    lines.push(
      `Warning: this snapshot is stale (taken ${fmtDur(ageMs)} ago and the store has rotated since). Open ${origin}/account to refresh it.`
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

// ---------- linked Riot accounts ----------
// Per Discord user: accs:<uid> is a light list [{ puuid, name }]. Each account has
// riot:<uid>:<puuid> (connection details) and snap:<uid>:<puuid> (store snapshot).

const MAX_ACCOUNTS = 5;
const PUUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validAcct = (p) => PUUID_RE.test(String(p));
const acctName = (a, i) => a.name || `Account ${i + 1}`;

async function getAccounts(env, uid) {
  const list = await env.STORE.get("accs:" + uid, "json");
  if (list) return list;
  // One-time move from the old single-account layout (riot:<uid>, snap:<uid>). Data without a Riot
  // connection (it was never linked through a Riot login) is left alone and not migrated.
  const [rec, snap] = await Promise.all([env.STORE.get("riot:" + uid, "json"), env.STORE.get("snap:" + uid, "json")]);
  if (!rec || !validAcct(rec.puuid)) return [];
  const puuid = rec.puuid;
  await env.STORE.put(`riot:${uid}:${puuid}`, JSON.stringify(rec));
  if (snap) await env.STORE.put(`snap:${uid}:${puuid}`, JSON.stringify(snap));
  const migrated = [{ puuid, name: "" }];
  await env.STORE.put("accs:" + uid, JSON.stringify(migrated));
  await env.STORE.delete("riot:" + uid);
  await env.STORE.delete("snap:" + uid);
  return migrated;
}

// Adds an account or updates its name. Returns { list } or { error } when the limit is reached.
async function upsertAccount(env, uid, { puuid, name = "" }) {
  const list = await getAccounts(env, uid);
  const i = list.findIndex((a) => a.puuid === puuid);
  if (i < 0 && list.length >= MAX_ACCOUNTS) return { error: `You can link up to ${MAX_ACCOUNTS} Riot accounts. Remove one first.` };
  if (i < 0) list.push({ puuid, name });
  else list[i] = { ...list[i], name: name || list[i].name };
  await env.STORE.put("accs:" + uid, JSON.stringify(list));
  return { list };
}

async function removeAccount(env, uid, puuid) {
  const list = (await getAccounts(env, uid)).filter((a) => a.puuid !== puuid);
  await env.STORE.put("accs:" + uid, JSON.stringify(list));
  await env.STORE.delete(`riot:${uid}:${puuid}`);
  await env.STORE.delete(`snap:${uid}:${puuid}`);
}

// Reads one account's snapshot. If it is missing or the store has rotated (or force is set) and the
// user chose "stay logged in", refreshes it from Riot using their saved (encrypted) cookies.
async function loadSnapshot(env, userId, puuid, { force = false } = {}) {
  const snapKey = `snap:${userId}:${puuid}`;
  const riotKey = `riot:${userId}:${puuid}`;
  const out = { snap: await env.STORE.get(snapKey, "json"), attempted: false, expired: false, failed: false, error: "" };
  if (!force && out.snap && Date.now() <= out.snap.daily_ends_at * 1000) return out;
  const rec = await env.STORE.get(riotKey, "json");
  if (!rec?.sealed || !env.RIOT_ENCRYPTION_KEY) return out;
  out.attempted = true;
  try {
    const r = await reauth(await unseal(env.RIOT_ENCRYPTION_KEY, rec.sealed));
    out.snap = (await fetchSnapshot(env, r.tokens)).snapshot;
    await env.STORE.put(snapKey, JSON.stringify(out.snap));
    await env.STORE.put(
      riotKey,
      JSON.stringify({ ...rec, sealed: await seal(env.RIOT_ENCRYPTION_KEY, r.cookies), refreshed: Date.now() })
    );
  } catch (e) {
    if (e instanceof RiotError && e.code === "session_expired") {
      out.expired = true;
      await env.STORE.put(riotKey, JSON.stringify({ ...rec, sealed: undefined, expired: Date.now() }));
    } else {
      out.failed = true;
      out.error = e instanceof RiotError ? e.message : "";
    }
  }
  return out;
}

// Every linked account as { a, name }, or only the one whose id equals `filter` or whose name contains it.
function matchAccounts(accs, filter = "") {
  const picked = accs.map((a, i) => ({ a, name: acctName(a, i) }));
  const f = String(filter || "").trim().toLowerCase();
  if (!f) return picked;
  return picked.filter((p) => p.a.puuid.toLowerCase() === f || p.name.toLowerCase().includes(f));
}

// Returns the store text for Claude: every linked account, or the one matching `filter`.
async function getStoreText(env, userId, origin, filter = "") {
  const accs = await getAccounts(env, userId);
  if (!accs.length) return render(null, origin);
  const names = accs.map(acctName);
  const picked = matchAccounts(accs, filter);
  if (!picked.length) return `No linked Riot account matches "${filter}". Linked accounts: ${names.join(", ")}.`;
  const parts = await Promise.all(
    picked.map(async ({ a }) => {
      const r = await loadSnapshot(env, userId, a.puuid);
      let note = "";
      if (r.expired) note = `\n\nThis account's saved Riot login has expired. Reconnect at ${origin}/account/connect.`;
      else if (r.failed) note = `\n\nCould not refresh from Riot${r.error ? ": " + r.error : "."}`;
      return render(r.snap, origin) + note;
    })
  );
  if (accs.length === 1) return parts[0];
  return picked.map((p, i) => `## ${p.name}\n${parts[i]}`).join("\n\n");
}

// ---------- MCP (JSON-RPC over HTTP), behind OAuth ----------

const TOOL = {
  name: "get_valorant_store",
  description:
    "Get the user's current Valorant daily skin store (4 skins with VP prices, time until rotation) and the Night Market if active. If the user linked several Riot accounts, every account is returned unless one is named.",
  inputSchema: {
    type: "object",
    properties: {
      account: {
        type: "string",
        description: "Optional. Part of a linked Riot account's name, to get just that account. Leave empty for all accounts.",
      },
    },
    additionalProperties: false,
  },
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
      return ok({ content: [{ type: "text", text: await getStoreText(env, userId, origin, params?.arguments?.account) }] });
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

// ---------- /account: Discord sign-in, then the web app ----------

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
  await env.STORE.put("acct:" + id, "1", { expirationTtl: 600 });
  const headers = new Headers({
    Location: discordAuthorizeUrl(env, origin, "acct_" + id),
    "Set-Cookie": setCookie(ACCT_COOKIE, id, 600),
  });
  return new Response(null, { status: 302, headers });
}

async function finishAccount(request, env, url, state) {
  const id = state.slice(5);
  const clear = new Headers({ "Set-Cookie": setCookie(ACCT_COOKIE, "", 0) });
  const pending = await env.STORE.get("acct:" + id);
  await env.STORE.delete("acct:" + id);
  if (!pending || cookieOf(request, ACCT_COOKIE) !== id) {
    return page("Sign-in expired", `<p>Start again at <a href="/account">/account</a>.</p>`, 400, clear);
  }
  if (url.searchParams.get("error") || !url.searchParams.get("code")) {
    return page("Sign-in cancelled", `<p>Start again at <a href="/account">/account</a>.</p>`, 400, clear);
  }
  const user = await discordUser(env, url.origin, url.searchParams.get("code"));
  if (!isAllowed(env, user)) return notAllowed(user.login, clear);

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

const fmtClock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};

function skinCard(s, i) {
  const icon = safeIcon(s.icon);
  const off = Number(s.discount) || 0;
  return `<article class="skin" style="--i:${i}">
<div class="art${icon ? "" : " none"}">${off ? `<span class="off">-${off}%</span>` : ""}${icon ? `<img src="${esc(icon)}" alt="" loading="lazy" decoding="async">` : ""}</div>
<div class="meta"><span class="nm">${esc(s.name)}</span><span class="vp"><img src="${VP_ICON}" alt="VP" width="16" height="16">${(Number(s.vp) || 0).toLocaleString("en-US")}</span></div>
</article>`;
}

// A signed-in page: same shell plus the Store / Connect / Claude tabs and a sign-out button.
const acct = (sess, tab, title, body, opts = {}) =>
  page(title, body, 200, new Headers(), { ...opts, nav: { tab, login: sess.login, csrf: sess.csrf } });

const flashBox = (flash) =>
  flash ? `<div class="notice${/^(Done|Disconnected)/.test(flash) ? "" : " warn"}" role="status">${esc(flash)}</div>` : "";

// ---------- Store tab: the main screen ----------

async function storeView(env, sess, origin, flash = "", preloaded = null, sel = "") {
  const uid = sess.userId;
  const accs = await getAccounts(env, uid);
  const idx = Math.max(0, accs.findIndex((a) => a.puuid === sel));
  const cur = accs[idx];
  const lead = `Signed in as <strong>${esc(sess.login)}</strong>.`;

  if (!cur) {
    return acct(
      sess,
      "store",
      "Today's store",
      `${flashBox(flash)}<section class="card empty">
<div class="head"><h2>No store yet</h2></div>
<p class="sub">Link your Riot account once and your daily skins and Night Market show up here. You can link up to ${MAX_ACCOUNTS} accounts.</p>
<div class="actions"><a class="btn orn" href="/account/connect">Connect Riot account</a></div>
</section>`,
      { lead }
    );
  }

  const loaded = preloaded ?? (await loadSnapshot(env, uid, cur.puuid));
  const snap = loaded.snap;
  const riot = await env.STORE.get(`riot:${uid}:${cur.puuid}`, "json");
  const now = Date.now();
  const ago = (ms) => `${fmtDur(now - ms)} ago`;
  const csrf = `<input type="hidden" name="csrf" value="${esc(sess.csrf)}"><input type="hidden" name="puuid" value="${esc(cur.puuid)}">`;
  const warn = (t) => `<div class="notice warn" role="status">${esc(t)}</div>`;

  let note = "";
  if (!preloaded) {
    if (loaded.expired) note = warn("This account's saved Riot login has expired. Reconnect on the Connect tab.");
    else if (loaded.failed) note = warn("Could not refresh from Riot" + (loaded.error ? ": " + loaded.error : "."));
  }

  const chips = `<div class="accts">${accs
    .map(
      (a, i) =>
        `<a class="chip${i === idx ? " on" : ""}" href="/account?acc=${esc(a.puuid)}"${i === idx ? ' aria-current="true"' : ""}>${esc(acctName(a, i))}</a>`
    )
    .join("")}${accs.length < MAX_ACCOUNTS ? '<a class="chip add" href="/account/connect">+ Add account</a>' : ""}</div>`;

  let body;
  if (!snap) {
    body = `${note}<section class="card empty">
<div class="head"><h2>No store yet</h2></div>
<p class="sub">This account has no store snapshot yet. Add it again on the Connect tab.</p>
<div class="actions"><a class="btn" href="/account/connect">Open Connect</a></div>
</section>`;
  } else {
    const stale = now > snap.daily_ends_at * 1000;
    const nm = snap.night_market;
    const nmLive = nm && now < nm.ends_at * 1000 && (nm.items || []).length;
    const total = (snap.daily || []).reduce((n, s) => n + (Number(s.vp) || 0), 0);
    const tool = riot?.sealed
      ? `<form method="post" action="/account/refresh">${csrf}<button class="sec sm">Refresh</button></form>`
      : `<a class="btn sec sm" href="/account/connect">Update store</a>`;
    body = `${note}<div class="strip">
<div class="stat"><span class="k">Resets in</span>${
      stale
        ? '<span class="v bad">Out of date</span>'
        : `<span class="v clock" data-clock="${Number(snap.daily_ends_at)}">${fmtClock(snap.daily_ends_at * 1000 - now)}</span>`
    }</div>
<div class="stat"><span class="k">Daily total</span><span class="v"><img class="vpi" src="${VP_ICON}" alt="VP" width="22" height="22">${total.toLocaleString("en-US")}</span></div>
<div class="stat"><span class="k">Updated</span><span class="v">${esc(ago(snap.fetched_at * 1000))}</span></div>
<div class="tools">${tool}</div>
</div>
${stale ? `<p class="sub" style="margin:0 0 1rem">This snapshot is from ${esc(ago(snap.fetched_at * 1000))}, before the store rotated. ${riot?.sealed ? "Hit Refresh." : "Update it from the Connect tab."}</p>` : ""}
<section class="sect${stale ? " stale" : ""}">
<div class="head"><h2>Daily store</h2></div>
<div class="skins">${(snap.daily || []).map((s, i) => skinCard(s, i)).join("")}</div>
</section>
${
  nmLive
    ? `<section class="sect">
<div class="head"><h2>Night Market</h2><div class="tools"><span class="badge warn" data-end="${Number(nm.ends_at)}" data-pre="Ends in">Ends in ${fmtLeft(nm.ends_at * 1000 - now)}</span></div></div>
<div class="skins nm">${nm.items.map((s, i) => skinCard(s, i)).join("")}</div>
</section>`
    : ""
}`;
  }
  return acct(sess, "store", "Today's store", flashBox(flash) + chips + body, {
    lead: accs.length > 1 ? `${lead} Showing <strong>${esc(acctName(cur, idx))}</strong>.` : lead,
  });
}

// ---------- Connect tab: linked accounts and the Riot login flow ----------

async function connectView(env, sess, origin, flash = "") {
  const uid = sess.userId;
  const accs = await getAccounts(env, uid);
  const [recs, snaps] = await Promise.all([
    Promise.all(accs.map((a) => env.STORE.get(`riot:${uid}:${a.puuid}`, "json"))),
    Promise.all(accs.map((a) => env.STORE.get(`snap:${uid}:${a.puuid}`, "json"))),
  ]);
  const ago = (ms) => `${fmtDur(Date.now() - ms)} ago`;
  const csrf = `<input type="hidden" name="csrf" value="${esc(sess.csrf)}">`;

  const row = (a, i) => {
    const rec = recs[i];
    const snap = snaps[i];
    const [label, tone, text] = rec?.sealed
      ? ["Staying logged in", "ok", "Refreshes itself when the store rotates."]
      : rec?.expired
        ? ["Expired", "bad", "The saved login expired. Add this account again below."]
        : ["Connected", "warn", "Linked once. Add it again to update."];
    const meta = snap ? `Store updated ${ago(snap.fetched_at * 1000)}. ${text}` : `No store yet. ${text}`;
    const hid = `${csrf}<input type="hidden" name="puuid" value="${esc(a.puuid)}">`;
    return `<div class="acc">
<div class="who2"><strong class="aname">${esc(acctName(a, i))}</strong><span class="sub">${esc(meta)}</span></div>
<span class="badge ${tone}">${esc(label)}</span>
<div class="acts">
<a class="btn sec sm" href="/account?acc=${esc(a.puuid)}">View</a>
${rec?.sealed ? `<form method="post" action="/account/refresh">${hid}<button class="sec sm">Refresh</button></form>` : ""}
<form method="post" action="/account/remove" onsubmit="return confirm('Remove this account and its saved store?')">${hid}<button class="danger sm">Remove</button></form>
</div>
</div>`;
  };

  const stay = env.RIOT_ENCRYPTION_KEY
    ? `<details>
<summary>Stay logged in (optional)</summary>
<div class="body">
<p class="sub">Paste the <em>value</em> of each Riot login cookie from auth.riotgames.com. <code>ssid</code> is required, the others make it last longer.
Find them in your browser's developer tools under Application or Storage, then Cookies.
They are saved encrypted and only used when you open your store (or ask Claude for it) and today's snapshot is out of date.
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

  const full = accs.length >= MAX_ACCOUNTS;
  const add = full
    ? `<section class="card wide">
<div class="head"><h2>Add a Riot account</h2><span class="badge warn">${accs.length} of ${MAX_ACCOUNTS}</span></div>
<p class="sub">You have linked the maximum of ${MAX_ACCOUNTS} accounts. Remove one to add another.</p>
</section>`
    : `<section class="card wide">
<div class="head"><h2>${accs.length ? "Add a Riot account" : "Link your Riot account"}</h2>${accs.length ? `<span class="badge">${accs.length} of ${MAX_ACCOUNTS}</span>` : ""}</div>
<div class="connect">
<ol class="steps big">
<li><strong>Log in on Riot</strong><span class="sub">Opens Riot's own page in a new tab. This site never sees your password.${accs.length ? " Adding a different account? Sign out of Riot there first, or use a private window." : ""}</span><a class="btn orn" href="${esc(RIOT_LOGIN_URL)}" target="_blank" rel="noopener noreferrer">Open Riot login</a></li>
<li><strong>Copy the address</strong><span class="sub">You land on a page that looks empty or broken. That is expected. Copy the full address from the address bar.</span></li>
<li><strong>Paste it here</strong><span class="sub">It is used once to read your store, then discarded. Nothing from it is saved unless you turn on Stay logged in.</span></li>
</ol>
<form class="paste" method="post" action="/account/riot">${csrf}
<label class="f" for="paste">Address from Riot</label>
<textarea id="paste" name="paste" rows="5" placeholder="https://playvalorant.com/opt_in#access_token=..."></textarea>
${stay}
<div class="actions"><button class="orn">${accs.length ? "Add account" : "Get my store"}</button></div>
</form>
</div>
</section>`;

  return acct(
    sess,
    "connect",
    "Connect",
    `${flashBox(flash)}<div class="grid">
${
  accs.length
    ? `<section class="card wide">
<div class="head"><h2>Linked accounts</h2><span class="badge">${accs.length} of ${MAX_ACCOUNTS}</span></div>
${accs.map(row).join("\n")}
</section>`
    : ""
}
${add}
</div>`,
    { lead: `Link up to ${MAX_ACCOUNTS} Riot accounts to your Discord login. You log in on Riot's own page.` }
  );
}

// ---------- Claude tab: the MCP connector ----------

function claudeView(env, sess, origin) {
  const url = `${origin}/mcp`;
  const install = `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(env.DISCORD_CLIENT_ID)}&integration_type=1&scope=applications.commands`;
  return acct(
    sess,
    "claude",
    "Ask Claude",
    `<div class="grid">
<section class="card star">
<div class="head"><h2>Use it in Discord</h2><span class="badge bad">/store</span></div>
<p>Add the app to your Discord profile and type <em>/store</em> in any server, DM or group chat. Pick which linked Riot account to show. The reply is posted in the chat.</p>
<div class="actions"><a class="btn orn" href="${esc(install)}" target="_blank" rel="noopener noreferrer">Add to Discord</a></div>
</section>
<section class="card">
<div class="head"><h2>Add the connector</h2><span class="badge bad">MCP</span></div>
<ol class="steps">
<li>Copy the connector URL.
<div class="copy"><code>${esc(url)}</code><button type="button" data-copy="${esc(url)}">Copy</button></div></li>
<li>In Claude, add a custom connector with that URL.</li>
<li>Click Connect, sign in with Discord, and approve.</li>
</ol>
</section>
<section class="card">
<div class="head"><h2>Then just ask</h2></div>
<ul class="asks">
<li>What's in my Valorant store?</li>
<li>Is the Night Market live?</li>
<li>How long until my store resets?</li>
</ul>
<p class="sub">Works in Claude on web, desktop and mobile with the same account. You need to link your Riot account first, on the Connect tab.</p>
</section>
</div>`,
    { lead: "This site is also a Claude connector (MCP). Add it once and ask for your store in plain language, from any device." }
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
    return connectView(env, sess, origin, "Nothing usable was pasted. Copy the whole address after logging in, it contains access_token=." + warn);
  }

  let result;
  try {
    result = await fetchSnapshot(env, tokens);
  } catch (e) {
    return connectView(env, sess, origin, (e instanceof RiotError ? e.message : "Could not read the store.") + warn);
  }
  if (!validAcct(result.puuid)) return connectView(env, sess, origin, "Riot returned an unexpected account id." + warn);

  const up = await upsertAccount(env, uid, { puuid: result.puuid, name: result.name || "" });
  if (up.error) return connectView(env, sess, origin, up.error + warn);
  await env.STORE.put(`snap:${uid}:${result.puuid}`, JSON.stringify(result.snapshot));
  const rec = { puuid: result.puuid, shard: result.shard, connected: Date.now() };
  if (sealed) rec.sealed = sealed;
  await env.STORE.put(`riot:${uid}:${result.puuid}`, JSON.stringify(rec));
  return storeView(env, sess, origin, "Done. Your store is loaded. You can also ask Claude for it." + warn, null, result.puuid);
}

async function accountPost(request, env, url) {
  const sess = await getSession(request, env);
  if (!sess) return page("Signed out", `<p><a href="/account">Sign in again</a>.</p>`, 401);
  const form = await request.formData();
  if (form.get("csrf") !== sess.csrf) {
    return page("Bad request", `<p>The session check failed. Reload <a href="/account">/account</a>.</p>`, 400);
  }
  // Account-specific actions name the account in a hidden "puuid" field; it must be one of this user's.
  const accs = await getAccounts(env, sess.userId);
  const puuid = String(form.get("puuid") || "");
  const target = accs.find((a) => a.puuid === puuid);
  switch (url.pathname) {
    case "/account/riot":
      return connectRiot(env, sess, form, url.origin);
    case "/account/refresh": {
      if (!target) return connectView(env, sess, url.origin, "That account is not linked.");
      const r = await loadSnapshot(env, sess.userId, target.puuid, { force: true });
      const flash = r.expired
        ? "This account's saved Riot login has expired. Reconnect on the Connect tab."
        : r.failed
          ? "Could not refresh from Riot" + (r.error ? ": " + r.error : ".")
          : r.attempted
            ? "Done. Store refreshed."
            : "Nothing to refresh. Add this account again on the Connect tab.";
      return storeView(env, sess, url.origin, flash, r, target.puuid);
    }
    case "/account/remove": {
      if (!target) return connectView(env, sess, url.origin, "That account is not linked.");
      await removeAccount(env, sess.userId, target.puuid);
      return connectView(env, sess, url.origin, `Disconnected ${acctName(target, accs.indexOf(target))}. Its Riot connection and saved store were deleted.`);
    }
    case "/account/signout":
      await env.STORE.delete("sess:" + sess.id);
      return new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": setCookie(SESS_COOKIE, "", 0) } });
    default:
      return new Response("not found", { status: 404 });
  }
}

// ---------- Discord app: the /store slash command ----------
// Discord POSTs every interaction to /interactions, signed with the app's Ed25519 key. The command is
// installed to a user's profile (user install), so it works in servers, DMs and group chats. The
// person who runs it is identified by their Discord id, the same id used for the web login, so the
// "account" choices are exactly the Riot accounts they linked. Replies are posted in the chat.

const unhex = (s) => Uint8Array.from(s.match(/../g) || [], (h) => parseInt(h, 16));

async function verifyDiscord(env, request, body) {
  const sig = request.headers.get("X-Signature-Ed25519") || "";
  const ts = request.headers.get("X-Signature-Timestamp") || "";
  if (!env.DISCORD_PUBLIC_KEY || !ts || !/^[0-9a-f]{128}$/i.test(sig)) return false;
  try {
    const key = await crypto.subtle.importKey("raw", unhex(env.DISCORD_PUBLIC_KEY), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, unhex(sig), new TextEncoder().encode(ts + body));
  } catch {
    return false;
  }
}

const EPHEMERAL = 64;
const reply = (content) => json({ type: 4, data: { content, flags: EPHEMERAL } });
const vpText = (n) => `${(Number(n) || 0).toLocaleString("en-US")} VP`;

function storeEmbed(name, r, origin) {
  const embed = { title: name, color: 0xff4655, fields: [] };
  const snap = r.snap;
  if (!snap) {
    embed.description = `No store data yet. Reconnect this account at ${origin}/account/connect.`;
    return embed;
  }
  const now = Date.now();
  const unix = (s) => Math.floor(Number(s));
  const lines = (items, extra = () => "") => items.map((s) => `**${s.name}**: ${vpText(s.vp)}${extra(s)}`).join("\n");
  if (now > snap.daily_ends_at * 1000) {
    embed.description = `This snapshot is out of date (taken <t:${unix(snap.fetched_at)}:R>). Open ${origin}/account to refresh it.`;
  } else {
    embed.description = `Resets <t:${unix(snap.daily_ends_at)}:R>`;
  }
  embed.fields.push({ name: "Daily store", value: lines(snap.daily || []).slice(0, 1024) || "Empty" });
  const nm = snap.night_market;
  if (nm && now < nm.ends_at * 1000 && (nm.items || []).length) {
    embed.fields.push({
      name: `Night Market (ends <t:${unix(nm.ends_at)}:R>)`,
      value: lines(nm.items, (s) => ` (${Number(s.discount) || 0}% off)`).slice(0, 1024),
    });
  }
  if (r.expired) embed.footer = { text: "The saved Riot login has expired. Reconnect on the website." };
  else if (r.failed) embed.footer = { text: "Could not refresh from Riot" + (r.error ? ": " + r.error : ".") };
  return embed;
}

async function storeCommand(env, interaction, userId, origin) {
  const opt = (interaction.data.options || []).find((o) => o.name === "account");
  const accs = await getAccounts(env, userId);
  if (!accs.length) return { content: `You have not linked a Riot account yet. Do it at ${origin}/account/connect, then run /store again.` };
  const picked = matchAccounts(accs, opt?.value);
  if (!picked.length) {
    return { content: `No linked Riot account matches "${opt.value}". Linked accounts: ${accs.map(acctName).join(", ")}.` };
  }
  const embeds = await Promise.all(
    picked.map(async ({ a, name }) => storeEmbed(name, await loadSnapshot(env, userId, a.puuid), origin))
  );
  return { embeds };
}

// loadSnapshot can call Riot, which may take longer than the 3 seconds Discord allows for a first
// answer. So the reply is deferred right away and filled in afterwards.
async function followUp(interaction, data) {
  const r = await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "User-Agent": DISCORD_UA },
    body: JSON.stringify({ allowed_mentions: { parse: [] }, ...data }),
  });
  if (!r.ok) throw new Error(`Discord follow-up failed ${r.status}: ${(await r.text()).slice(0, 500)}`);
}

async function interactions(request, env, ctx) {
  const body = await request.text();
  if (!(await verifyDiscord(env, request, body))) return new Response("invalid request signature", { status: 401 });
  const interaction = JSON.parse(body);
  if (interaction.type === 1) return json({ type: 1 }); // PING

  const origin = new URL(request.url).origin;
  const du = interaction.member?.user || interaction.user;
  if (!du?.id) return reply("Could not tell who you are.");
  const user = { id: String(du.id), username: String(du.username || ""), login: String(du.global_name || du.username || "") };
  const allowed = isAllowed(env, user);

  if (interaction.type === 4) {
    // Autocomplete for the "account" option: this user's linked accounts, filtered by what they typed.
    const typed = String(interaction.data?.options?.find((o) => o.focused)?.value || "");
    const accs = allowed ? await getAccounts(env, user.id) : [];
    const choices = matchAccounts(accs, typed)
      .slice(0, 25)
      .map((p) => ({ name: p.name.slice(0, 100), value: p.a.puuid }));
    return json({ type: 8, data: { choices } });
  }

  if (interaction.type === 2 && interaction.data?.name === "store") {
    if (!allowed) return reply("Your Discord account is not on this server's allow list.");
    const work = storeCommand(env, interaction, user.id, origin).catch((e) => {
      console.error(e);
      return { content: "Something went wrong reading your store. Try again in a moment." };
    });
    // Usually the snapshot is fresh and this finishes at once, so answer directly. Only if Riot has to
    // be called (slow) do we defer and edit the reply in afterwards.
    const slow = Symbol();
    const first = await Promise.race([work, new Promise((r) => setTimeout(r, 2500, slow))]);
    if (first !== slow) return json({ type: 4, data: first });
    ctx.waitUntil(
      work.then((data) =>
        followUp(interaction, data).catch(async (e) => {
          console.error("Discord follow-up error", e);
          await followUp(interaction, { content: "Could not post your store. Try /store again." }).catch(() => {});
        })
      )
    );
    return json({ type: 5 });
  }
  return reply("Unknown command.");
}

// ---------- OAuth for Claude: consent, then Discord ----------

function consentPage(d, handle, headers) {
  const origin = d.clientDomain
    ? `Published by <strong>${esc(d.clientDomain)}</strong>.`
    : "This app registered itself, so its name is not verified.";
  return page(
    `Allow ${d.clientName} to read your Valorant store?`,
    `<section class="card narrow">
<p>${origin} Access will be sent to <strong>${esc(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? `<p class="notice" style="background:var(--amber-bg)"><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>` : ""}
<ul class="trust stack">
<li><strong>Claude can only read your store</strong> (skin names and prices). It never gets your Riot password or a way to log in as you.</li>
<li><strong>You sign in with Discord next.</strong> We only get your username and ID, not your email, servers or messages.</li>
<li>You can delete your Riot connection and saved store at any time from the Connect tab.</li>
</ul>
<p class="sub">By continuing you agree to the <a href="/terms" target="_blank" rel="noopener noreferrer">Terms</a> and <a href="/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a>.</p>
<form method="post">
<input type="hidden" name="handle" value="${esc(handle)}">
<div class="actions split"><button class="orn" name="decision" value="approve">Allow</button><button name="decision" value="deny">Deny</button></div>
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
  const { state, headers } = await oauth.beginUpstream(approved.request, {
    data: {},
    headers: approved.headers,
  });
  headers.set("Location", discordAuthorizeUrl(env, origin, state));
  return new Response(null, { status: 302, headers });
}

async function callback(request, env) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") || "";
  if (state.startsWith("acct_")) return finishAccount(request, env, url, state);

  const oauth = env.OAUTH_PROVIDER;
  const { request: original, headers } = await oauth.finishUpstream(request);
  if (url.searchParams.get("error") || !url.searchParams.get("code")) {
    headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
    return new Response(null, { status: 302, headers });
  }
  const user = await discordUser(env, url.origin, url.searchParams.get("code"));
  if (!isAllowed(env, user)) return notAllowed(user.login, headers);

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

// ---------- Privacy policy and Terms ----------

// PRIVACY.md and TERMS.md at the repo root carry the same text (Discord accepts GitHub links for its
// policy URL fields). Keep them and the date below in sync when editing these pages.
const LEGAL_UPDATED = "18 October 2026";
const CONTACT = `<a href="https://github.com/Eli-Zac/valorant-store/issues" target="_blank" rel="noopener noreferrer">open an issue on GitHub</a>`;

const privacyPage = () =>
  page(
    "Privacy Policy",
    `<article class="legal">
<h2>Who we are</h2>
<p>Valorant Store is a small, independent web app and Claude connector (MCP) that shows you your own Valorant item store. It is run by Eli-Zac (the operator). It is not affiliated with or endorsed by Riot Games, Discord or Anthropic. The source code is public on <a href="https://github.com/Eli-Zac/valorant-store" target="_blank" rel="noopener noreferrer">GitHub</a>.</p>

<h2>What we collect and why</h2>
<ul>
<li><strong>Discord sign-in.</strong> When you sign in we ask Discord for the <code>identify</code> scope only. We keep your Discord user ID, username and display name so we can tell users apart and show your name. We do not ask for your email address, servers, friends or messages, and we discard the Discord access token straight after reading your profile.</li>
<li><strong>Riot account details.</strong> When you link a Riot account we keep its Riot account ID (PUUID), its region, its Riot ID (name and tag) if Riot provides it, and when you linked it.</li>
<li><strong>Your store.</strong> We save the latest snapshot of your store so we can show it again: skin names, images and VP prices, the Night Market if there is one, and when they rotate. This is the whole point of the service.</li>
<li><strong>Your Riot login.</strong> You log in on Riot's own page, so we never see your password. The address you paste back contains short-lived Riot tokens. We use them once to read your store and then discard them. They are not saved.</li>
<li><strong>"Stay logged in" (optional, off by default).</strong> If you turn it on, we also save your Riot login cookies, encrypted, and use them only to refresh your store when it has rotated. The encryption key is a secret held by the operator, so the operator could technically decrypt them. Only turn this on if you trust the operator. You can remove it at any time by removing the account.</li>
<li><strong>Sign-in session.</strong> We set one strictly necessary cookie to keep you signed in and keep a matching server-side session record (your Discord ID and name, plus a token that protects forms). It expires after one hour.</li>
<li><strong>Claude connector.</strong> If you add the connector, we keep a record of the app you approved and its access. When you ask Claude for your store, we send it your store details as text. What Claude does with that text is covered by Anthropic's own policies.</li>
<li><strong>Discord app.</strong> If you add the Discord app to your profile and run <code>/store</code>, Discord sends us your Discord user ID and name with the command so we can find your linked accounts. We reply with your store details, posted in the chat where you ran the command, so anyone there can see it. We do not read or store messages, servers or channels.</li>
</ul>
<p>We do not collect payment details, we do not sell or share your data for advertising, and we do not run analytics or advertising trackers.</p>

<h2>Where your data goes</h2>
<ul>
<li><strong>Cloudflare</strong> hosts the service and stores your data in its Workers KV database. Cloudflare also processes technical request data such as your IP address.</li>
<li><strong>Discord</strong> handles sign-in. <strong>Riot Games</strong> receives the requests we make to read your store.</li>
<li><strong>Google Fonts</strong> and <strong>valorant-api.com</strong> are loaded by your browser for fonts and skin images, so they can see your IP address and browser details when you visit.</li>
</ul>

<h2>How long we keep it</h2>
<ul>
<li>Removing a Riot account on the Connect tab deletes its saved connection and store snapshot straight away.</li>
<li>Sign-in sessions expire after one hour.</li>
<li>Your Discord ID and name, and any remaining connector records, are kept until you ask us to delete them. To have everything removed, ${CONTACT}, or revoke the connector from your Claude settings.</li>
</ul>

<h2>Security</h2>
<p>Everything is sent over HTTPS. Saved Riot cookies, if you choose to save them, are encrypted. The operator can access the service's database, so please only use it if you are comfortable with that. No system is perfectly secure, and Riot's login and store endpoints that we rely on are unofficial.</p>

<h2>Your choices</h2>
<p>You can ask what we hold about you, ask us to correct or delete it, or stop using the service at any time. To do any of that, ${CONTACT}.</p>

<h2>Children</h2>
<p>This service is not for anyone under 13, or under the minimum age Discord allows in your country.</p>

<h2>Changes</h2>
<p>If we change this policy we will update the date at the top. Material changes will be announced on the GitHub page.</p>

<h2>Contact</h2>
<p>Questions or requests: ${CONTACT}.</p>
</article>`,
    200,
    new Headers(),
    { lead: `Last updated ${LEGAL_UPDATED}.` }
  );

const termsPage = () =>
  page(
    "Terms of Service",
    `<article class="legal">
<h2>Agreement</h2>
<p>By signing in to or using Valorant Store (the service), you agree to these terms and to our <a href="/privacy">Privacy Policy</a>. If you do not agree, please do not use it.</p>

<h2>What the service is</h2>
<p>The service shows you the Valorant item store for Riot accounts that you link, on the web and through an optional Claude connector (MCP). It is a free, independent fan project run by Eli-Zac (the operator). It is <strong>not affiliated with or endorsed by Riot Games</strong>. VALORANT and Riot Games are trademarks of Riot Games, Inc.</p>

<h2>Who can use it</h2>
<ul>
<li>You must be old enough to use Discord in your country, and at least 13.</li>
<li>You may only link Riot accounts that belong to you.</li>
<li>You are responsible for your Discord and Riot accounts and for what happens through your sign-in.</li>
</ul>

<h2>Acceptable use</h2>
<ul>
<li>Do not try to access anyone else's data, break or probe the service, or get around its limits.</li>
<li>Do not overload the service, for example with automated or repeated requests.</li>
<li>Do not use the service to break the law or the rules of Riot Games, Discord or any other service.</li>
</ul>

<h2>Riot Games and unofficial access</h2>
<p>To read your store, the service uses Riot login and store endpoints that are not officially documented for third parties. Riot can change or block them at any time, which may stop the service working. You are responsible for making sure your use complies with Riot's terms and rules. Optional features such as "stay logged in" save your Riot login cookies on the service; you use them at your own risk.</p>

<h2>No guarantees</h2>
<p>The service is provided "as is" and "as available", without warranties of any kind. We do not promise that it will be accurate, always available, or free of errors. Prices and items shown come from Riot at the time of the last update and may be out of date.</p>

<h2>Limit of liability</h2>
<p>To the fullest extent the law allows, the operator is not liable for any indirect or consequential loss, or for loss of accounts, items, data or profits, arising from your use of the service. Nothing in these terms limits any right you have by law that cannot be excluded.</p>

<h2>Ending your use</h2>
<p>You can stop at any time by removing your linked accounts on the Connect tab and asking us to delete your remaining records. We may suspend or remove access for anyone who breaks these terms or puts the service at risk, and we may change or end the service at any time.</p>

<h2>Changes to these terms</h2>
<p>We may update these terms. The date at the top will change when we do, and continuing to use the service means you accept the updated terms.</p>

<h2>Contact</h2>
<p>Questions: ${CONTACT}.</p>
</article>`,
    200,
    new Headers(),
    { lead: `Last updated ${LEGAL_UPDATED}.` }
  );

// ---------- default (non-API) handler ----------

const ghostCard = (i) => `<article class="skin ghost" style="--i:${i}">
<div class="art none"></div>
<div class="meta"><span class="bar"></span><span class="bar s"></span></div>
</article>`;

const landing = (origin) =>
  page(
    "Valorant Store",
    `<div class="actions cta"><a class="btn orn" href="/account">Sign in with Discord</a><a class="btn sec" href="#features">See what you get</a></div>
<p class="sub" style="margin:0 0 1.4rem">By signing in you agree to the <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>.</p>
<ul class="trust">
<li><strong>We never see your Riot password.</strong> You log in on Riot's own page.</li>
<li><strong>Discord shares your name and ID only.</strong> Not your email, servers or messages.</li>
<li><strong>Delete it any time.</strong> Remove your Riot connection and saved store from the Connect tab.</li>
</ul>

<section class="sect" aria-label="Preview">
<div class="skins">${[0, 1, 2, 3].map(ghostCard).join("")}</div>
</section>

<section class="sect" id="features">
<div class="head"><h2>What you get</h2></div>
<div class="grid feat">
<section class="card">
<div class="head"><h2>Daily store</h2></div>
<p class="sub">Your four daily skins with their art and VP prices, as soon as you open the page.</p>
</section>
<section class="card">
<div class="head"><h2>Night Market</h2></div>
<p class="sub">When it is live, every item with its discount, plus how long it has left.</p>
</section>
<section class="card">
<div class="head"><h2>Live reset timer</h2></div>
<p class="sub">A countdown to the next store rotation, and a one-tap refresh if you stay logged in.</p>
</section>
<section class="card star">
<div class="head"><h2>Ask Claude (MCP)</h2><span class="badge bad">Key feature</span></div>
<p>This site is also a Claude connector, built on the Model Context Protocol (MCP). Add it once and ask Claude <em>"What's in my Valorant store?"</em> from the web, desktop or your phone.</p>
<div class="copy"><code>${esc(origin)}/mcp</code><button type="button" data-copy="${esc(origin)}/mcp">Copy</button></div>
<div class="actions"><a class="btn sec sm" href="/account/claude">Setup guide</a></div>
</section>
</div>
</section>

<section class="sect">
<div class="head"><h2>How it works</h2></div>
<div class="grid">
<section class="card"><span class="stepno">01</span><h2>Sign in</h2><p class="sub">Use your Discord account. Only your username and id are kept.</p></section>
<section class="card"><span class="stepno">02</span><h2>Link Riot</h2><p class="sub">Log in on Riot's own page and link up to five accounts. This site never sees your password.</p></section>
<section class="card"><span class="stepno">03</span><h2>Check your store</h2><p class="sub">Open it here on the web, or ask Claude through the MCP connector.</p></section>
</div>
</section>

<section class="sect" id="privacy">
<div class="head"><h2>Your data and safety</h2></div>
<section class="card">
<ul class="trust stack">
<li><strong>Your Riot password stays with Riot.</strong> You log in on Riot's own page and paste back the address you land on. This site never sees the password.</li>
<li><strong>Nothing from that login is kept.</strong> It is used once to read your store, then thrown away. All we save is your Discord ID and name, your Riot account ID and region, and your skin names, icons and prices.</li>
<li><strong>"Stay logged in" is optional and off by default.</strong> If you turn it on, your Riot login cookies are saved encrypted and used only to refresh your store. The encryption key is a secret held by whoever runs this server, so only enable it if you trust them, or run your own copy.</li>
<li><strong>Discord sign-in is minimal.</strong> We ask for your identity only: no email, no servers, no messages. Claude can only read your store, never your login.</li>
<li><strong>It is open source.</strong> Read exactly what it does on <a href="https://github.com/Eli-Zac/valorant-store" target="_blank" rel="noopener noreferrer">GitHub</a>.</li>
</ul>
</section>
</section>`,
    200,
    new Headers(),
    {
      docTitle: "Valorant Store",
      heading: "Check your Valorant store.",
      lead: "Today's skins, the Night Market and a live reset timer, on any device. Prefer to ask in plain language? It works as a Claude connector (MCP) too.",
    }
  );

const defaultHandler = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/interactions" && request.method === "POST") return await interactions(request, env, ctx);
      if (url.pathname === "/authorize") {
        if (request.method === "GET") return await authorizeGet(request, env);
        if (request.method === "POST") return await authorizePost(request, env);
      }
      if (url.pathname === "/callback" && request.method === "GET") return await callback(request, env);
      if (["/account", "/account/connect", "/account/claude"].includes(url.pathname) && request.method === "GET") {
        const sess = await getSession(request, env);
        if (!sess) return await startAccount(request, env);
        if (url.pathname === "/account/connect") return await connectView(env, sess, url.origin);
        if (url.pathname === "/account/claude") return claudeView(env, sess, url.origin);
        return await storeView(env, sess, url.origin, "", null, url.searchParams.get("acc") || "");
      }
      if (url.pathname.startsWith("/account/") && request.method === "POST") return await accountPost(request, env, url);
      if (url.pathname === "/privacy" && request.method === "GET") return privacyPage();
      if (url.pathname === "/terms" && request.method === "GET") return termsPage();
      if (url.pathname === "/") {
        return (await getSession(request, env)) ? Response.redirect(url.origin + "/account", 302) : landing(url.origin);
      }
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
