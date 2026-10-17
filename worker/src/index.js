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

function page(title, body, status = 200, headers = new Headers()) {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  const html = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif}
body{max-width:34rem;margin:3rem auto;padding:0 1rem;line-height:1.5}
button{font:inherit;padding:.5rem 1rem;margin-right:.5rem;cursor:pointer}
pre,code{background:rgba(127,127,127,.15);border-radius:4px}
pre{padding:.75rem;overflow:auto}code{padding:.1rem .3rem}
</style>
<h1>${esc(title)}</h1>
${body}</html>`;
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
      "No store data yet. This account's PC has not pushed a snapshot. " +
      `Sign in at ${origin}/account to get the PC setup key, then run push_store.py with the Riot Client open.`
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
      const raw = await env.STORE.get("snap:" + userId);
      return ok({ content: [{ type: "text", text: render(raw ? JSON.parse(raw) : null, origin) }] });
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

// ---------- /account: GitHub sign-in to mint the PC push key ----------

const ACCT_COOKIE = "__Host-vs-acct";
const cookieOf = (request, name) =>
  (request.headers.get("Cookie") || "")
    .split(/;\s*/)
    .map((c) => c.split("="))
    .find(([k]) => k === name)?.[1];

async function startAccount(request, env) {
  const origin = new URL(request.url).origin;
  const id = randHex(16);
  const verifier = randHex(32);
  await env.STORE.put("acct:" + id, verifier, { expirationTtl: 600 });
  const headers = new Headers({
    Location: githubAuthorizeUrl(env, origin, "acct_" + id, await s256(verifier)),
    "Set-Cookie": `${ACCT_COOKIE}=${id}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
  });
  return new Response(null, { status: 302, headers });
}

async function finishAccount(request, env, url, state) {
  const origin = url.origin;
  const id = state.slice(5);
  const clear = new Headers({ "Set-Cookie": `${ACCT_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0` });
  const verifier = await env.STORE.get("acct:" + id);
  await env.STORE.delete("acct:" + id);
  if (!verifier || cookieOf(request, ACCT_COOKIE) !== id) {
    return page("Sign-in expired", `<p>Start again at <a href="/account">/account</a>.</p>`, 400, clear);
  }
  if (url.searchParams.get("error") || !url.searchParams.get("code")) {
    return page("Sign-in cancelled", `<p>Start again at <a href="/account">/account</a>.</p>`, 400, clear);
  }
  const user = await githubUser(env, origin, url.searchParams.get("code"), verifier);
  if (!isAllowed(env, user.login)) return notAllowed(user.login, clear);

  // A new key replaces the old one.
  const key = "vs_" + randHex(24);
  const hash = await sha256(key);
  const prev = await env.STORE.get("user:" + user.id, "json");
  if (prev?.pk_hash) await env.STORE.delete("pk:" + prev.pk_hash);
  await env.STORE.put("pk:" + hash, user.id);
  await env.STORE.put("user:" + user.id, JSON.stringify({ login: user.login, pk_hash: hash, updated: Date.now() }));

  const cfg = JSON.stringify({ worker_url: origin, key }, null, 2);
  return page(
    "PC setup key",
    `<p>Signed in as <strong>${esc(user.login)}</strong>.</p>
<p>Save this as <code>config.json</code> next to <code>push_store.py</code> on your PC. It is shown once, and signing in here again replaces it.</p>
<pre>${esc(cfg)}</pre>
<p>Then run <code>python push_store.py</code> with the Riot Client open, and <code>setup_task.ps1</code> to keep it updated.</p>`,
    200,
    clear
  );
}

// ---------- OAuth for Claude: consent, then GitHub ----------

function consentPage(d, handle, headers) {
  const origin = d.clientDomain
    ? `Published by <strong>${esc(d.clientDomain)}</strong>.`
    : "This app registered itself, so its name is not verified.";
  return page(
    `Allow ${d.clientName} to read your Valorant store?`,
    `<p>${origin} Access will be sent to <strong>${esc(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>" : ""}
<p>You will sign in with GitHub next. Only your GitHub username and id are used.</p>
<form method="post">
<input type="hidden" name="handle" value="${esc(handle)}">
<button name="decision" value="approve">Allow</button><button name="decision" value="deny">Deny</button>
</form>`,
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
    `<p>Ask Claude what is in your Valorant store, from any device.</p>
<ol>
<li>In Claude, add a custom connector with the URL <code>${esc(origin)}/mcp</code> and sign in with GitHub.</li>
<li>Get your PC setup key at <a href="/account">/account</a>.</li>
</ol>`
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
      if (url.pathname === "/account" && request.method === "GET") return await startAccount(request, env);
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
