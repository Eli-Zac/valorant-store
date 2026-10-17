#!/usr/bin/env python3
"""Read this PC's Valorant store and push it to the Worker.

Usage:
  python push_store.py            push using config.json
  python push_store.py --print    just print the snapshot, do not push
  python push_store.py --shard eu override shard auto-detection
"""
import argparse
import json
import os
import sys
import urllib.request

from store_lib import StoreError, fetch_store

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shard", default=None, help="ap, na, eu, kr")
    ap.add_argument("--print", dest="dry", action="store_true")
    args = ap.parse_args()

    snap = fetch_store(args.shard)
    if args.dry:
        print(json.dumps(snap, indent=2))
        return

    cfg_path = os.path.join(HERE, "config.json")
    if not os.path.exists(cfg_path):
        sys.exit("config.json missing. Copy config.example.json to config.json and fill it in.")
    cfg = json.load(open(cfg_path))
    req = urllib.request.Request(
        cfg["worker_url"].rstrip("/") + "/push",
        data=json.dumps(snap).encode(),
        headers={"Authorization": f"Bearer {cfg['key']}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        print(f"Pushed {len(snap['daily'])} skins: {r.read().decode()}")


if __name__ == "__main__":
    try:
        main()
    except StoreError as e:
        sys.exit(str(e))
    except Exception as e:
        sys.exit(f"Push failed: {e}")
