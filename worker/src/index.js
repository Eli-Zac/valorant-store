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

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

const STYLE = `
:root{color-scheme:light dark;
--bg:#f5f5f7;--card:#fff;--text:#1d1d1f;--sub:#6e6e73;--line:rgba(0,0,0,.08);--fill:rgba(120,120,128,.12);
--blue:#0071e3;--blue-h:#0077ed;--red:#d70015;--green:#1d7f37;--green-bg:rgba(52,199,89,.16);--red-bg:rgba(255,59,48,.12);--amber:#9a5b00;--amber-bg:rgba(255,159,10,.16);
--nav:rgba(245,245,247,.72);--shadow:0 1px 2px rgba(0,0,0,.04),0 8px 24px rgba(0,0,0,.05);
--font:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display","Segoe UI Variable Text","Segoe UI",system-ui,Roboto,sans-serif;
--spring:cubic-bezier(.32,.72,0,1)}
@media(prefers-color-scheme:dark){:root{--bg:#000;--card:#1c1c1e;--text:#f5f5f7;--sub:#98989d;--line:rgba(255,255,255,.12);--fill:rgba(120,120,128,.24);
--blue:#0a84ff;--blue-h:#409cff;--red:#ff453a;--green:#30d158;--green-bg:rgba(48,209,88,.18);--red-bg:rgba(255,69,58,.18);--amber:#ffb340;--amber-bg:rgba(255,159,10,.2);
--nav:rgba(0,0,0,.66);--shadow:none}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;-webkit-tap-highlight-color:transparent}
body{margin:0;background:var(--bg);color:var(--text);font:400 17px/1.47 var(--font);letter-spacing:-.022em;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
nav{position:sticky;top:0;z-index:10;background:var(--nav);-webkit-backdrop-filter:saturate(180%) blur(20px);backdrop-filter:saturate(180%) blur(20px);border-bottom:.5px solid var(--line)}
nav div{max-width:44rem;margin:0 auto;padding:0 1.25rem;height:3rem;display:flex;align-items:center;justify-content:space-between}
nav a{color:var(--text);text-decoration:none;font-size:14px;letter-spacing:-.01em}
nav a.brand{font-weight:600;display:flex;align-items:center;gap:.5rem}
nav a.link{color:var(--sub);transition:color .2s}nav a.link:hover{color:var(--text)}
.mark{width:1.25rem;height:1.25rem;border-radius:.4rem;background:linear-gradient(145deg,#ff5a5f,#d6213a);display:inline-block}
main{max-width:44rem;margin:0 auto;padding:3.5rem 1.25rem 5rem}
h1{font-size:clamp(2rem,6.5vw,3rem);line-height:1.08;letter-spacing:-.035em;font-weight:700;margin:0 0 .75rem;text-wrap:balance}
.lead{font-size:clamp(1.05rem,2.6vw,1.3rem);line-height:1.4;color:var(--sub);letter-spacing:-.018em;margin:0 0 2.5rem;max-width:34rem;text-wrap:pretty}
h2{font-size:1.4rem;line-height:1.2;letter-spacing:-.025em;font-weight:600;margin:0}
p{margin:0 0 1rem}p:last-child{margin-bottom:0}
a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}
strong{font-weight:600}
.sub{color:var(--sub);font-size:15px;letter-spacing:-.016em}
.card{background:var(--card);border-radius:1.25rem;padding:1.5rem;margin:0 0 1.25rem;box-shadow:var(--shadow);animation:rise .5s var(--spring) both}
.card:nth-of-type(2){animation-delay:.05s}.card:nth-of-type(3){animation-delay:.1s}.card:nth-of-type(4){animation-delay:.15s}
@keyframes rise{from{opacity:0;transform:translateY(10px)}}
.head{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:1rem}
.badge{display:inline-flex;align-items:center;gap:.4rem;font-size:13px;font-weight:500;letter-spacing:-.01em;padding:.2rem .65rem;border-radius:99px;background:var(--fill);color:var(--sub);white-space:nowrap}
.badge::before{content:"";width:.45rem;height:.45rem;border-radius:50%;background:currentColor}
.badge.ok{background:var(--green-bg);color:var(--green)}.badge.warn{background:var(--amber-bg);color:var(--amber)}.badge.bad{background:var(--red-bg);color:var(--red)}
.steps{list-style:none;margin:0 0 1.25rem;padding:0;counter-reset:s}
.steps li{counter-increment:s;position:relative;padding:0 0 .9rem 2.4rem}.steps li:last-child{padding-bottom:0}
.steps li::before{content:counter(s);position:absolute;left:0;top:.1rem;width:1.55rem;height:1.55rem;border-radius:50%;background:var(--fill);color:var(--sub);font-size:13px;font-weight:600;display:grid;place-items:center;letter-spacing:0}
.notice{background:var(--green-bg);color:var(--text);border-radius:1rem;padding:.9rem 1.1rem;margin:0 0 1.25rem;font-size:15px;animation:rise .4s var(--spring) both}
.btn,button{font:inherit;font-size:16px;font-weight:500;letter-spacing:-.016em;line-height:1;display:inline-flex;align-items:center;justify-content:center;min-height:2.75rem;padding:0 1.35rem;border:0;border-radius:99px;background:var(--blue);color:#fff;cursor:pointer;text-decoration:none;transition:background .2s,transform .12s var(--spring),opacity .2s;touch-action:manipulation;-webkit-user-select:none;user-select:none}
.btn:hover,button:hover{background:var(--blue-h);text-decoration:none}
.btn:active,button:active{transform:scale(.97);transition-duration:.06s}
.sec,button[value=deny]{background:var(--fill);color:var(--blue)}.sec:hover,button[value=deny]:hover{background:rgba(120,120,128,.2)}
button.danger{background:var(--red-bg);color:var(--red)}button.danger:hover{background:rgba(255,59,48,.2)}
.actions{display:flex;gap:.75rem;flex-wrap:wrap;margin-top:1.25rem}
.actions.split{flex-direction:row-reverse;justify-content:flex-end}.actions.split button{flex:1 1 9rem}
:focus-visible{outline:3px solid color-mix(in srgb,var(--blue) 55%,transparent);outline-offset:2px;border-radius:.5rem}
button:focus-visible,.btn:focus-visible{border-radius:99px}
textarea,input[type=password],input[type=text]{width:100%;font:inherit;font-size:16px;letter-spacing:-.016em;color:var(--text);background:var(--fill);border:1.5px solid transparent;border-radius:.85rem;padding:.75rem .95rem;transition:border-color .2s,background .2s;resize:vertical}
textarea::placeholder,input::placeholder{color:var(--sub);opacity:.7}
textarea:focus,input:focus{outline:0;border-color:var(--blue);background:var(--card)}
label.f{display:block;font-size:14px;font-weight:500;color:var(--sub);margin:0 0 .85rem}label.f input{margin-top:.35rem}
label.f em{font-style:normal;font-weight:400;opacity:.8}
details{margin-top:1rem;border-top:.5px solid var(--line);padding-top:.25rem}
summary{list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;padding:.7rem 0;font-weight:500;-webkit-user-select:none;user-select:none}
summary::-webkit-details-marker{display:none}
summary::after{content:"";width:.55rem;height:.55rem;border-right:2px solid var(--sub);border-bottom:2px solid var(--sub);transform:rotate(45deg) translate(-2px,-2px);transition:transform .3s var(--spring)}
details[open] summary::after{transform:rotate(225deg)}
details .body{padding:.25rem 0 .5rem}
.switch{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin:1rem 0;font-weight:500;cursor:pointer}
.switch input{appearance:none;-webkit-appearance:none;flex:none;width:3.1rem;height:1.9rem;border-radius:99px;background:var(--fill);position:relative;cursor:pointer;transition:background .25s;margin:0}
.switch input::after{content:"";position:absolute;top:2px;left:2px;width:calc(1.9rem - 4px);height:calc(1.9rem - 4px);border-radius:50%;background:#fff;box-shadow:0 2px 4px rgba(0,0,0,.25);transition:transform .35s var(--spring)}
.switch input:checked{background:#34c759}.switch input:checked::after{transform:translateX(1.2rem)}
code{font:500 .86em ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;letter-spacing:0;background:var(--fill);padding:.15rem .4rem;border-radius:.4rem;word-break:break-all}
pre{font:500 14px/1.55 ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;letter-spacing:0;background:var(--fill);border-radius:.9rem;padding:1rem 1.1rem;margin:0 0 1rem;overflow:auto}
pre code{background:none;padding:0}
.copy{display:flex;align-items:center;gap:.5rem;background:var(--fill);border-radius:.85rem;padding:.35rem .35rem .35rem 1rem;margin-top:.6rem}
.copy code{background:none;padding:0;flex:1;min-width:0;font-size:14px}
.copy button{min-height:2rem;padding:0 .9rem;font-size:14px;background:var(--card);color:var(--blue);box-shadow:0 1px 2px rgba(0,0,0,.12)}
em{font-style:normal;font-weight:500}
@media(max-width:34rem){main{padding-top:2.25rem}.card{padding:1.2rem;border-radius:1.1rem}.head{align-items:flex-start;flex-direction:column;gap:.5rem}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:opacity .2s!important}.btn:active,button:active{transform:none}}
@media(prefers-reduced-transparency:reduce){nav{-webkit-backdrop-filter:none;backdrop-filter:none;background:var(--bg)}}
@media(prefers-contrast:more){.card{box-shadow:0 0 0 1px var(--text)}.sub,.lead{color:var(--text)}}
`;

const COPY_JS = `document.addEventListener("click",function(e){var b=e.target.closest("[data-copy]");if(!b)return;
var t=b.getAttribute("data-copy"),o=b.textContent;
(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(function(){b.textContent="Copied"},function(){b.textContent="Press Ctrl+C"});
setTimeout(function(){b.textContent=o},1600)});`;

// opts: { lead } is the subtitle under the heading (trusted HTML), { heading } overrides the h1 text.
function page(title, body, status = 200, headers = new Headers(), opts = {}) {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  const html = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#f5f5f7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
<title>${esc(title)}</title>
<style>${STYLE}</style>
<nav><div><a class="brand" href="/"><span class="mark"></span>Valorant Store</a><a class="link" href="/account">Account</a></div></nav>
<main>
<h1>${esc(opts.heading ?? title)}</h1>
${opts.lead ? `<p class="lead">${opts.lead}</p>` : ""}
${body}
</main>
<script>${COPY_JS}</script></html>`;
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

// Returns the store text. If the snapshot is missing or the store has rotated and the user chose
// "stay logged in", refresh it from Riot using their saved (encrypted) cookies.
async function getStoreText(env, userId, origin) {
  let snap = await env.STORE.get("snap:" + userId, "json");
  let note = "";
  if (!snap || Date.now() > snap.daily_ends_at * 1000) {
    const rec = await env.STORE.get("riot:" + userId, "json");
    if (rec?.sealed && env.RIOT_ENCRYPTION_KEY) {
      try {
        const r = await reauth(await unseal(env.RIOT_ENCRYPTION_KEY, rec.sealed));
        snap = (await fetchSnapshot(env, r.tokens)).snapshot;
        await env.STORE.put("snap:" + userId, JSON.stringify(snap));
        await env.STORE.put(
          "riot:" + userId,
          JSON.stringify({ ...rec, sealed: await seal(env.RIOT_ENCRYPTION_KEY, r.cookies), refreshed: Date.now() })
        );
      } catch (e) {
        if (e instanceof RiotError && e.code === "session_expired") {
          note = `\n\nYour saved Riot login has expired. Reconnect at ${origin}/account.`;
          await env.STORE.put("riot:" + userId, JSON.stringify({ ...rec, sealed: undefined, expired: Date.now() }));
        } else {
          note = `\n\nCould not refresh from Riot${e instanceof RiotError ? ": " + e.message : "."}`;
        }
      }
    }
  }
  return render(snap, origin) + note;
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
    daily: snap.daily.map((d) => ({ name: d.name.slice(0, 80), vp: d.vp })),
    night_market: snap.night_market
      ? {
          ends_at: snap.night_market.ends_at,
          items: (snap.night_market.items || []).slice(0, 8).map((d) => ({
            name: String(d.name).slice(0, 80),
            vp: d.vp,
            discount: d.discount,
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

async function dashboard(env, sess, origin, flash = "") {
  const [user, riot, snap] = await Promise.all([
    env.STORE.get("user:" + sess.userId, "json"),
    env.STORE.get("riot:" + sess.userId, "json"),
    env.STORE.get("snap:" + sess.userId, "json"),
  ]);
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
    `${flash ? `<div class="notice" role="status"${/^(Done|Disconnected)/.test(flash) ? "" : " style=\"background:var(--amber-bg)\""}>${esc(flash)}</div>` : ""}
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
</section>` : ""}`,
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
    `<section class="card">
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
    `<section class="card">
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
    `<section class="card">
<div class="head"><h2>Set up in two steps</h2></div>
<ol class="steps">
<li>In Claude, add a custom connector with this URL and sign in with GitHub.
<div class="copy"><code>${esc(origin)}/mcp</code><button type="button" data-copy="${esc(origin)}/mcp">Copy</button></div></li>
<li>Connect your Riot account, with a Riot login or the PC script.</li>
</ol>
<div class="actions"><a class="btn" href="/account">Connect Riot account</a></div>
</section>`,
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
