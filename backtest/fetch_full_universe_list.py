"""Fetch full HOSE + HNX stock list từ VND API, write to universe_full.txt.

Skip UPCOM (quá nhiều penny). Mỗi symbol = 1 dòng.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import requests

VALID_TICKER = re.compile(r"^[A-Z]{3,4}$")

BASE_DIR = Path(__file__).parent


def fetch_floor(floor: str) -> list[dict]:
    url = f"https://api-finfo.vndirect.com.vn/v4/stocks?q=floor:{floor}~status:LISTED~type:STOCK&size=2000"
    r = requests.get(url, headers={
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "application/json",
    })
    r.raise_for_status()
    data = r.json()
    return data.get("data", [])


def main():
    print("Fetching HOSE list...")
    hose = fetch_floor("HOSE")
    print(f"  {len(hose)} HOSE symbols")

    print("Fetching HNX list...")
    hnx = fetch_floor("HNX")
    print(f"  {len(hnx)} HNX symbols")

    all_stocks = hose + hnx
    valid = []
    for s in all_stocks:
        code = (s.get("code") or "").strip().upper()
        if VALID_TICKER.match(code):
            valid.append((code, s.get("floor", ""), s.get("companyName", "")[:60]))

    valid = sorted(set(valid))
    print(f"\nTotal valid: {len(valid)} symbols")

    out = BASE_DIR / "universe_full.txt"
    with open(out, "w") as f:
        f.write("# Full HOSE + HNX universe — fetched từ VND API\n")
        f.write(f"# Total: {len(valid)} symbols\n\n")
        for code, floor, name in valid:
            f.write(f"{code}\n")

    print(f"Saved → {out}")


if __name__ == "__main__":
    main()
