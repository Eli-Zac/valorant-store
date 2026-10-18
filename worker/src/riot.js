// Riot helpers: parse a Riot login redirect, optionally re-authenticate with saved cookies,
// and read the store. Uses Riot's unofficial endpoints, the same ones the game client uses.

const AUTH = "https://auth.riotgames.com";
const ENT = "https://entitlements.auth.riotgames.com";
const GEO = "https://riot-geo.pas.si.riotgames.com";
const VAPI = "https://valorant-api.com";
const pdHost = (shard) => `https://pd.${shard}.a.pvp.net`;

export const RIOT_LOGIN_URL =
  AUTH +
  "/authorize?client_id=play-valorant-web-prod&redirect_uri=https%3A%2F%2Fplayvalorant.com%2Fopt_in" +
  "&response_type=token%20id_token&nonce=1&scope=account%20openid";

const VP = "85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741";
const KC = "85ca954a-41f2-ce94-9b45-8ca3dd39a00d";
const RAD = "e59aa87c-4cbf-517a-5983-6e81511be9b7";
const SKIN_LEVEL = "e7c63390-eda7-46e0-bb7a-a6abdacd2433";
// Accessory item types -> where valorant-api.com describes them.
const ACCESSORY = {
  "d5f120f8-ff8c-4aac-92ea-f2b5acbe9475": { type: "Spray", path: "sprays", icon: ["fullTransparentIcon", "displayIcon"] },
  "dd3bf334-87f3-40bd-b043-682a57a8dc3a": { type: "Gun buddy", path: "buddies/levels", icon: ["displayIcon"] },
  "3f296c07-64c3-494c-923b-fe692a4fa1bd": { type: "Player card", path: "playercards", icon: ["displayIcon", "largeArt"] },
  "de7caa6b-adf7-4588-bbd1-143831e786c6": { type: "Title", path: "playertitles", icon: [] },
};
const UA = "RiotClient/87.0.0.1234.5678 rso-auth (Windows;10;;Professional, x64)";
const SHARD = { latam: "na", br: "na", na: "na", eu: "eu", ap: "ap", kr: "kr" };
const COOKIE_NAMES = ["ssid", "clid", "csid", "tdid", "sub"];

export class RiotError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- parsing ----------

const JWT = /^[\w-]+\.[\w-]+\.[\w-]*$/;

// Accepts the full address from the browser after login (…#access_token=…&id_token=…).
export function parseTokens(text) {
  const get = (k) => {
    const m = String(text).match(new RegExp(`[#&?]${k}=([^&\\s]+)`));
    return m ? decodeURIComponent(m[1]) : null;
  };
  const access_token = get("access_token");
  const id_token = get("id_token");
  if (!access_token || !id_token || !JWT.test(access_token) || !JWT.test(id_token)) return null;
  return { access_token, id_token };
}

// Accepts "ssid=abc; clid=def" or one name=value per line. Keeps only the cookies Riot needs.
export function parseCookies(text) {
  const out = {};
  for (const part of String(text).split(/[;\n\r]+/)) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (COOKIE_NAMES.includes(name) && /^[\w\-.~+/=%]+$/.test(value)) out[name] = value;
  }
  return out.ssid ? out : null;
}

const cookieHeader = (c) => Object.entries(c).map(([k, v]) => `${k}=${v}`).join("; ");

// ---------- sealing (AES-GCM) for saved cookies ----------

const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function aesKey(secret) {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(secret));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(secret, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), enc.encode(JSON.stringify(obj)));
  return `${b64(iv)}.${b64(new Uint8Array(ct))}`;
}

export async function unseal(secret, sealed) {
  const [iv, ct] = sealed.split(".");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await aesKey(secret), unb64(ct));
  return JSON.parse(dec.decode(pt));
}

// ---------- Riot calls ----------

// Re-authenticate with saved cookies. Returns fresh tokens and the updated cookies.
export async function reauth(cookies) {
  const r = await fetch(AUTH + "/authorize?" + RIOT_LOGIN_URL.split("?")[1], {
    redirect: "manual",
    headers: { Cookie: cookieHeader(cookies), "User-Agent": UA },
  });
  const loc = r.headers.get("location") || "";
  const tokens = parseTokens(loc);
  if (!tokens) throw new RiotError("session_expired", "The saved Riot login has expired.");
  const updated = { ...cookies };
  for (const c of r.headers.getSetCookie?.() || []) {
    const [kv] = c.split(";");
    const i = kv.indexOf("=");
    const name = kv.slice(0, i).trim();
    const value = kv.slice(i + 1).trim();
    if (COOKIE_NAMES.includes(name) && value) updated[name] = value;
  }
  return { tokens, cookies: updated };
}

async function riotJson(url, opts, what) {
  let r;
  try {
    r = await fetch(url, opts);
  } catch {
    throw new RiotError("network", `Could not reach Riot (${what}).`);
  }
  if (r.status === 401 || r.status === 403) {
    throw new RiotError("token_rejected", `Riot rejected the login (${what}). Log in again and paste the new address.`);
  }
  if (!r.ok) throw new RiotError("riot_http", `Riot returned ${r.status} (${what}).`);
  return r.json();
}

// Skin catalogue and content tiers (rarity), fetched at most once per isolate while warm.
let catalogue = null;
function loadCatalogue() {
  catalogue ||= Promise.all([
    fetch(`${VAPI}/v1/weapons/skins`).then((r) => r.json()),
    fetch(`${VAPI}/v1/contenttiers`).then((r) => r.json()),
  ])
    .then(([skins, tiers]) => {
      const byLevel = new Map();
      for (const sk of skins?.data || []) for (const l of sk.levels || []) byLevel.set(l.uuid, sk);
      const tierMap = new Map((tiers?.data || []).map((t) => [t.uuid, t]));
      return { byLevel, tierMap };
    })
    .catch((e) => {
      catalogue = null;
      throw e;
    });
  return catalogue;
}

// Name, icon, rarity and variants for a skin level, cached for 30 days.
async function skinInfo(env, uuid) {
  const cached = await env.STORE.get("skin4:" + uuid, "json");
  if (cached) return cached;
  try {
    const d = (await (await fetch(`${VAPI}/v1/weapons/skinlevels/${uuid}`)).json())?.data;
    if (d?.displayName) {
      const info = { name: d.displayName, icon: d.displayIcon || null };
      try {
        const { byLevel, tierMap } = await loadCatalogue();
        const sk = byLevel.get(uuid);
        if (sk) {
          const t = tierMap.get(sk.contentTierUuid);
          if (t) {
            info.tier = {
              name: t.displayName.replace(/ Edition$/, ""),
              color: /^[0-9a-f]{6}/i.test(t.highlightColor || "") ? t.highlightColor.slice(0, 6) : null,
              icon: t.displayIcon || null,
            };
          }
          info.levels = (sk.levels || []).length;
          // The base skin previews with its top level; each variant has its own clip.
          info.video = [...(sk.levels || [])].reverse().find((l) => l.streamedVideo)?.streamedVideo || null;
          // The first chroma is the base skin; the rest are the variants shown in game.
          info.chromas = (sk.chromas || []).slice(1).map((c) => ({
            name: String(c.displayName || "").replace(/^.*\(([^)]*)\)\s*$/s, "$1").replace(/^Variant \d+\s*/, "").trim() || "Variant",
            swatch: c.swatch || null,
            icon: c.fullRender || c.displayIcon || null,
            video: c.streamedVideo || null,
          }));
        }
      } catch {}
      if (info.tier) await env.STORE.put("skin4:" + uuid, JSON.stringify(info), { expirationTtl: 30 * 86400 });
      return info;
    }
  } catch {}
  return { name: uuid, icon: null };
}

// Name, icon and type of an accessory (spray, buddy, card or title), cached for 30 days.
async function accessoryInfo(env, typeId, uuid) {
  const kind = ACCESSORY[typeId];
  if (!kind) return { name: uuid, type: "Item", icon: null };
  const cached = await env.STORE.get("acc1:" + uuid, "json");
  if (cached) return cached;
  try {
    const d = (await (await fetch(`${VAPI}/v1/${kind.path}/${uuid}`)).json())?.data;
    const name = d?.displayName || d?.titleText;
    if (name) {
      const info = { name, type: kind.type, icon: kind.icon.map((k) => d[k]).find(Boolean) || null };
      await env.STORE.put("acc1:" + uuid, JSON.stringify(info), { expirationTtl: 30 * 86400 });
      return info;
    }
  } catch {}
  return { name: uuid, type: kind.type, icon: null };
}

// Bundle name and art, cached for 30 days.
async function bundleInfo(env, uuid) {
  const cached = await env.STORE.get("bun1:" + uuid, "json");
  if (cached) return cached;
  try {
    const d = (await (await fetch(`${VAPI}/v1/bundles/${uuid}`)).json())?.data;
    if (d?.displayName) {
      const info = { name: d.displayName, icon: d.displayIcon2 || d.displayIcon || null };
      await env.STORE.put("bun1:" + uuid, JSON.stringify(info), { expirationTtl: 30 * 86400 });
      return info;
    }
  } catch {}
  return { name: "Bundle", icon: null };
}

// Item ids the account owns, per item type. Failures are ignored: ownership is a nice-to-have.
async function ownedItems(shard, puuid, headers) {
  const types = [SKIN_LEVEL, ...Object.keys(ACCESSORY)];
  const lists = await Promise.all(
    types.map((t) =>
      riotJson(`${pdHost(shard)}/store/v1/entitlements/${puuid}/${t}`, { headers }, "owned items")
        .then((r) => (r.Entitlements || []).map((e) => e.ItemID))
        .catch(() => [])
    )
  );
  return new Set(lists.flat().map((x) => String(x).toLowerCase()));
}

// Bump when the snapshot gains fields, so older saved snapshots get refreshed.
export const SNAPSHOT_VERSION = 5;

// Reads the store with fresh tokens. Returns { snapshot, puuid, shard, name }. Tokens are not kept.
export async function fetchSnapshot(env, tokens) {
  const bearer = { Authorization: `Bearer ${tokens.access_token}`, "User-Agent": UA };
  const json = { ...bearer, "Content-Type": "application/json" };

  const [ent, info, geo, ver] = await Promise.all([
    riotJson(ENT + "/api/token/v1", { method: "POST", headers: json, body: "{}" }, "entitlements"),
    riotJson(AUTH + "/userinfo", { headers: bearer }, "userinfo"),
    riotJson(
      GEO + "/pas/v1/product/valorant",
      { method: "PUT", headers: json, body: JSON.stringify({ id_token: tokens.id_token }) },
      "region"
    ),
    riotJson(VAPI + "/v1/version", {}, "client version"),
  ]);

  const puuid = info.sub;
  const live = geo?.affinities?.live;
  const shard = SHARD[live] || live;
  if (!puuid || !shard) throw new RiotError("riot_http", "Riot did not return an account or region.");

  const platform = btoa(
    JSON.stringify({
      platformType: "PC",
      platformOS: "Windows",
      platformOSVersion: "10.0.19042.1.256.64bit",
      platformChipset: "Unknown",
    })
  );
  const headers = {
    ...json,
    "X-Riot-Entitlements-JWT": ent.entitlements_token,
    "X-Riot-ClientPlatform": platform,
    "X-Riot-ClientVersion": ver?.data?.riotClientVersion || "",
  };

  let store;
  try {
    store = await riotJson(`${pdHost(shard)}/store/v3/storefront/${puuid}`, { method: "POST", headers, body: "{}" }, "store");
  } catch (e) {
    if (e.code !== "riot_http") throw e;
    store = await riotJson(`${pdHost(shard)}/store/v2/storefront/${puuid}`, { headers }, "store");
  }

  const now = Math.floor(Date.now() / 1000);
  const panel = store.SkinsPanelLayout;
  if (!panel) throw new RiotError("riot_http", "Riot returned no store data.");

  const [wallet, owned] = await Promise.all([
    riotJson(`${pdHost(shard)}/store/v1/wallet/${puuid}`, { headers }, "wallet")
      .then((r) => ({ vp: r.Balances?.[VP] ?? 0, rad: r.Balances?.[RAD] ?? 0, kc: r.Balances?.[KC] ?? 0 }))
      .catch(() => null),
    ownedItems(shard, puuid, headers),
  ]);
  const has = (id) => owned.has(String(id).toLowerCase());

  const offers = panel.SingleItemStoreOffers || (panel.SingleItemOffers || []).map((id) => ({ Rewards: [{ ItemID: id }], Cost: {} }));
  const daily = await Promise.all(
    offers.map(async (o) => ({ ...(await skinInfo(env, o.Rewards[0].ItemID)), vp: o.Cost?.[VP] ?? 0, owned: has(o.Rewards[0].ItemID) }))
  );

  let night_market = null;
  const bonus = store.BonusStore;
  if (bonus?.BonusStoreOffers?.length) {
    night_market = {
      ends_at: now + Number(bonus.BonusStoreRemainingDurationInSeconds),
      items: await Promise.all(
        bonus.BonusStoreOffers.map(async (o) => ({
          ...(await skinInfo(env, o.Offer.Rewards[0].ItemID)),
          vp: o.DiscountCosts?.[VP] ?? 0,
          discount: o.DiscountPercent,
          owned: has(o.Offer.Rewards[0].ItemID),
        }))
      ),
    };
  }

  let accessories = null;
  const acc = store.AccessoryStore;
  if (acc?.AccessoryStoreOffers?.length) {
    accessories = {
      ends_at: now + Number(acc.AccessoryStoreRemainingDurationInSeconds),
      items: await Promise.all(
        acc.AccessoryStoreOffers.map(async (o) => {
          const reward = o.Offer?.Rewards?.[0] || {};
          return {
            ...(await accessoryInfo(env, reward.ItemTypeID, reward.ItemID)),
            kc: o.Offer?.Cost?.[KC] ?? 0,
            quantity: Number(reward.Quantity) || 1,
            owned: has(reward.ItemID),
          };
        })
      ),
    };
  }

  let bundles = [];
  try {
    bundles = await Promise.all(
      (store.FeaturedBundle?.Bundles || []).map(async (b) => {
        const meta = await bundleInfo(env, b.DataAssetID);
        const items = await Promise.all(
          (b.Items || []).map(async (it) => {
            const id = it.Item?.ItemID;
            const type = it.Item?.ItemTypeID;
            const base = type === SKIN_LEVEL ? await skinInfo(env, id) : await accessoryInfo(env, type, id);
            return {
              name: base.name,
              type: base.type || "Skin",
              icon: base.icon,
              vp: it.DiscountedPrice ?? it.BasePrice ?? 0,
              owned: has(id),
            };
          })
        );
        return {
          name: meta.name,
          icon: meta.icon,
          ends_at: now + Number(b.DurationRemainingInSeconds),
          vp: b.TotalDiscountedCost?.[VP] ?? b.TotalBaseCost?.[VP] ?? 0,
          base_vp: b.TotalBaseCost?.[VP] ?? 0,
          discount: Math.round(Number(b.TotalDiscountPercent) || 0),
          items,
        };
      })
    );
  } catch {
    bundles = [];
  }

  return {
    puuid,
    shard,
    name: info.acct?.game_name ? info.acct.game_name + (info.acct.tag_line ? "#" + info.acct.tag_line : "") : "",
    snapshot: {
      v: SNAPSHOT_VERSION,
      fetched_at: now,
      daily_ends_at: now + Number(panel.SingleItemOffersRemainingDurationInSeconds),
      daily,
      night_market,
      accessories,
      bundles,
      wallet,
    },
  };
}
