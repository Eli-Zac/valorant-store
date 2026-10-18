"""Read the Valorant store from the local Riot Client session. Stdlib only."""
import base64
import json
import os
import re
import ssl
import time
import urllib.request

VP = "85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741"

_LOCAL_CTX = ssl.create_default_context()
_LOCAL_CTX.check_hostname = False
_LOCAL_CTX.verify_mode = ssl.CERT_NONE  # local Riot Client uses a self-signed cert


class StoreError(Exception):
    pass


def _get_json(url, headers=None, data=None, method=None, ctx=None):
    req = urllib.request.Request(url, headers=headers or {}, data=data, method=method)
    with urllib.request.urlopen(req, context=ctx, timeout=15) as r:
        return json.load(r)


def _local_session():
    base = os.environ.get("LOCALAPPDATA")
    if not base:
        raise StoreError("LOCALAPPDATA not set. This is for Windows.")
    path = os.path.join(base, "Riot Games", "Riot Client", "Config", "lockfile")
    if not os.path.exists(path):
        raise StoreError("Riot Client lockfile not found. Open the Riot Client and log in.")
    _, _, port, password, _ = open(path).read().strip().split(":")
    auth = base64.b64encode(f"riot:{password}".encode()).decode()
    return _get_json(
        f"https://127.0.0.1:{port}/entitlements/v1/token",
        headers={"Authorization": f"Basic {auth}"},
        ctx=_LOCAL_CTX,
    )


def _detect_shard(default="ap"):
    base = os.environ.get("LOCALAPPDATA", "")
    log = os.path.join(base, "VALORANT", "Saved", "Logs", "ShooterGame.log")
    try:
        text = open(log, errors="ignore").read()
        m = re.search(r"https://glz-[a-z0-9]+-1\.([a-z0-9]+)\.a\.pvp\.net", text)
        if m:
            return m.group(1)
    except OSError:
        pass
    return default


def _skin(uuid):
    try:
        d = _get_json(f"https://valorant-api.com/v1/weapons/skinlevels/{uuid}")["data"]
        return {"name": d["displayName"], "icon": d.get("displayIcon")}
    except Exception:
        return {"name": uuid, "icon": None}


def fetch_store(shard=None):
    """Return a snapshot dict: daily skins, rotation time, optional Night Market."""
    s = _local_session()
    shard = shard or _detect_shard()
    ver = _get_json("https://valorant-api.com/v1/version")["data"]["riotClientVersion"]
    platform = base64.b64encode(json.dumps({
        "platformType": "PC",
        "platformOS": "Windows",
        "platformOSVersion": "10.0.19042.1.256.64bit",
        "platformChipset": "Unknown",
    }).encode()).decode()
    headers = {
        "Authorization": f"Bearer {s['accessToken']}",
        "X-Riot-Entitlements-JWT": s["token"],
        "X-Riot-ClientPlatform": platform,
        "X-Riot-ClientVersion": ver,
        "Content-Type": "application/json",
    }
    store = _get_json(
        f"https://pd.{shard}.a.pvp.net/store/v3/storefront/{s['subject']}",
        headers=headers, data=b"{}", method="POST",
    )

    now = int(time.time())
    panel = store["SkinsPanelLayout"]
    snap = {
        "shard": shard,
        "fetched_at": now,
        "daily_ends_at": now + int(panel["SingleItemOffersRemainingDurationInSeconds"]),
        "daily": [
            {**_skin(o["Rewards"][0]["ItemID"]), "vp": o["Cost"].get(VP, 0)}
            for o in panel["SingleItemStoreOffers"]
        ],
        "night_market": None,
    }

    bonus = store.get("BonusStore")
    if bonus:
        snap["night_market"] = {
            "ends_at": now + int(bonus["BonusStoreRemainingDurationInSeconds"]),
            "items": [
                {
                    **_skin(o["Offer"]["Rewards"][0]["ItemID"]),
                    "vp": o["DiscountCosts"].get(VP, 0),
                    "discount": o["DiscountPercent"],
                }
                for o in bonus["BonusStoreOffers"]
            ],
        }
    return snap
