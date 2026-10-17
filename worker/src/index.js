// Valorant store remote MCP. Multi-user: each person gets their own key.
// Their PC pushes snapshots to /push with that key; Claude reads them via /mcp/<key>.
// Admin manages users via /admin/users (Bearer ADMIN_TOKEN).

const enc = new TextEncoder();

const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const randHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));

// Compare via hashes so timing does not leak the secret.
async function safeEqual(a, b) {
  return (await sha256(a || "")) === (await sha256(b || ""));
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

const bearer = (req) => (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");

async function userFromKey(env, key) {
  if (!key) return null;
  const raw = await env.STORE.get("key:" + (await sha256(key)));
  return raw ? JSON.parse(raw) : null;
}

async function isAdmin(req, env) {
  return Boolean(env.ADMIN_TOKEN) && (await safeEqual(bearer(req), env.ADMIN_TOKEN));
}

// ---------- store rendering ----------

function fmtDur(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function render(snap) {
  if (!snap) {
    return "No store data yet. The PC push script has not run for this user. Open the Riot Client on the PC and run it once.";
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

// ---------- MCP (JSON-RPC over HTTP) ----------

const TOOL = {
  name: "get_valorant_store",
  description:
    "Get the user's current Valorant daily skin store (4 skins with VP prices, time until rotation) and the Night Market if active.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
};

async function rpc(msg, user, env) {
  const { id, method, params } = msg;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const err = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  if (id === undefined) return null; // notification, no response
  switch (method) {
    case "initialize":
      return ok({
        protocolVersion: params?.protocolVersion || "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "valorant-store", version: "1.0.0" },
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: [TOOL] });
    case "tools/call": {
      if (params?.name !== TOOL.name) return err(-32602, "Unknown tool");
      const raw = await env.STORE.get("snap:" + user.id);
      return ok({ content: [{ type: "text", text: render(raw ? JSON.parse(raw) : null) }] });
    }
    default:
      return err(-32601, "Method not found");
  }
}

async function handleMcp(req, user, env) {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => rpc(m, user, env)))).filter(Boolean);
    return out.length ? json(out) : new Response(null, { status: 202 });
  }
  const res = await rpc(body, user, env);
  return res ? json(res) : new Response(null, { status: 202 });
}

// ---------- push ----------

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

async function handlePush(req, env) {
  const user = await userFromKey(env, bearer(req));
  if (!user) return new Response("unauthorized", { status: 401 });
  let snap;
  try {
    snap = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }
  if (!validSnapshot(snap)) return new Response("bad snapshot", { status: 400 });
  // Store only the fields we use.
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
  await env.STORE.put("snap:" + user.id, JSON.stringify(clean));
  return new Response("ok");
}

// ---------- admin ----------

async function handleAdmin(req, env, url) {
  if (!(await isAdmin(req, env))) return new Response("unauthorized", { status: 401 });
  const parts = url.pathname.split("/").filter(Boolean); // admin, users, [id]

  if (parts[1] !== "users") return new Response("not found", { status: 404 });

  if (req.method === "POST" && parts.length === 2) {
    let body = {};
    try {
      body = await req.json();
    } catch {}
    const name = String(body.name || "").trim().slice(0, 40);
    if (!name) return json({ error: "name required" }, 400);
    const id = randHex(6);
    const key = randHex(24);
    await env.STORE.put(
      "key:" + (await sha256(key)),
      JSON.stringify({ id, name, created: Date.now() })
    );
    const base = url.origin;
    return json({
      id,
      name,
      key,
      push_url: `${base}/push`,
      mcp_url: `${base}/mcp/${key}`,
      note: "The key is shown once. Give mcp_url to the Claude connector and key + worker_url to the PC script.",
    });
  }

  if (req.method === "GET" && parts.length === 2) {
    const list = await env.STORE.list({ prefix: "key:" });
    const users = [];
    for (const k of list.keys) {
      const u = JSON.parse(await env.STORE.get(k.name));
      users.push({ id: u.id, name: u.name, created: u.created });
    }
    return json(users);
  }

  if (req.method === "DELETE" && parts.length === 3) {
    const id = parts[2];
    const list = await env.STORE.list({ prefix: "key:" });
    for (const k of list.keys) {
      const u = JSON.parse(await env.STORE.get(k.name));
      if (u.id === id) {
        await env.STORE.delete(k.name);
        await env.STORE.delete("snap:" + id);
        return json({ removed: id });
      }
    }
    return json({ error: "no such user" }, 404);
  }

  return new Response("not found", { status: 404 });
}

// ---------- router ----------

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/push" && req.method === "POST") return handlePush(req, env);

    if (p.startsWith("/mcp/")) {
      const user = await userFromKey(env, p.slice(5));
      if (!user) return new Response("not found", { status: 404 });
      return handleMcp(req, user, env);
    }

    if (p.startsWith("/admin/")) return handleAdmin(req, env, url);

    return new Response("valorant-store mcp", { status: 200 });
  },
};
