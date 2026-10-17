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
  const riotStatus = !riot
    ? "Not connected."
    : riot.sealed
      ? `Staying logged in (connected ${ago(riot.connected)}).`
      : riot.expired
        ? "The saved login expired. Reconnect below."
        : `Connected once, ${ago(riot.connected)}. It will not refresh by itself.`;
  const snapStatus = snap ? `Last store snapshot: ${ago(snap.fetched_at * 1000)}.` : "No store snapshot yet.";
  const csrf = `<input type="hidden" name="csrf" value="${esc(sess.csrf)}">`;
  const stay = env.RIOT_ENCRYPTION_KEY
    ? `<details><summary>Stay logged in (optional)</summary>
<p>Paste the <em>value</em> of each Riot login cookie from auth.riotgames.com. <code>ssid</code> is required, the others make it last longer.
Find them in your browser's developer tools under Application or Storage, then Cookies.
They are saved encrypted and only used when you ask Claude for your store and today's snapshot is out of date.
They usually last 1 to 3 weeks before you need to reconnect. Anyone with these cookies can act as your Riot account,
so only turn this on if you trust whoever runs this server.</p>
<label><input type="checkbox" name="stay" value="1"> Keep me logged in</label>
${["ssid", "clid", "csid", "tdid"]
  .map(
    (n) =>
      `<p><label>${n}${n === "ssid" ? " (required)" : ""}<br><input type="password" name="cookie_${n}" autocomplete="off" spellcheck="false" style="width:100%"></label></p>`
  )
  .join("\n")}
</details>`
    : "";

  return page(
    "Valorant store",
    `<p>Signed in as <strong>${esc(sess.login)}</strong>. ${esc(snapStatus)}</p>
${flash ? `<p><strong>${esc(flash)}</strong></p>` : ""}
<h2>Option A: Riot login (no PC needed)</h2>
<p>${esc(riotStatus)}</p>
<ol>
<li><a href="${esc(RIOT_LOGIN_URL)}" target="_blank" rel="noopener noreferrer">Log in on Riot's own page</a>. This site never sees your password.</li>
<li>You land on a page that looks empty or broken. Copy the full address from the address bar.</li>
<li>Paste it here.</li>
</ol>
<form method="post" action="/account/riot">${csrf}
<textarea name="paste" rows="3" style="width:100%" placeholder="https://playvalorant.com/opt_in#access_token=..."></textarea>
${stay}
<p><button>Get my store</button></p>
</form>
<h2>Option B: PC script</h2>
<p>${user?.pk_hash ? "A PC key exists." : "No PC key yet."} Creating a new key replaces the old one.</p>
<form method="post" action="/account/pc-key">${csrf}<button>Create PC key</button></form>
${riot || snap ? `<h2>Disconnect</h2><form method="post" action="/account/disconnect">${csrf}<button>Delete my Riot connection and snapshot</button></form>` : ""}`
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
    `<p>Save this as <code>config.json</code> next to <code>push_store.py</code> on your PC. It is shown once.</p>
<pre>${esc(cfg)}</pre>
<p>Then run <code>python push_store.py</code> with the Riot Client open, and <code>setup_task.ps1</code> to keep it updated.</p>
<p><a href="/account">Back</a></p>`
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
<li>Connect your Riot account at <a href="/account">/account</a>, with a Riot login or the PC script.</li>
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
