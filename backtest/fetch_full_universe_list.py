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

    print("Fetching UPCOM list...")
    upcom = fetch_floor("UPCOM")
    print(f"  {len(upcom)} UPCOM symbols")

    all_stocks = hose + hnx + upcom
    valid = []
    for s in all_stocks:
        code = (s.get("code") or "").strip().upper()
        if VALID_TICKER.match(code):
            valid.append((code, s.get("floor", ""), s.get("companyName", "")[:60]))

    valid = sorted(set(valid))
    print(f"\nTotal valid: {len(valid)} symbols")

    # Write txt for reference
    out = BASE_DIR / "universe_full.txt"
    with open(out, "w") as f:
        f.write("# Full HOSE + HNX + UPCOM universe — fetched từ VND API\n")
        f.write(f"# Total: {len(valid)} symbols\n\n")
        for code, floor, name in valid:
            f.write(f"{code}  # {floor}\n")
    print(f"Saved → {out}")

    # Generate JS array for stock-pwa import
    pwa_out = BASE_DIR.parent / "stock-pwa" / "full_universe.js"
    by_floor = {"HOSE": [], "HNX": [], "UPCOM": []}
    for code, floor, _ in valid:
        if floor in by_floor:
            by_floor[floor].append(code)
    with open(pwa_out, "w") as f:
        f.write("// Auto-generated bởi backtest/fetch_full_universe_list.py\n")
        f.write(f"// Total: {len(valid)} symbols (HOSE+HNX+UPCOM, status:LISTED)\n")
        f.write(f"// HOSE: {len(by_floor['HOSE'])} · HNX: {len(by_floor['HNX'])} · UPCOM: {len(by_floor['UPCOM'])}\n\n")
        f.write("(function(){\n")
        all_codes = [c for c, _, _ in valid]
        f.write("  var FULL_UNIVERSE = [\n")
        for i in range(0, len(all_codes), 10):
            chunk = all_codes[i:i+10]
            f.write("    " + ", ".join(f'"{c}"' for c in chunk) + ",\n")
        f.write("  ];\n\n")
        f.write("  var UNIVERSE_BY_FLOOR = {\n")
        for floor, codes in by_floor.items():
            f.write(f'    {floor}: [\n')
            for i in range(0, len(codes), 10):
                chunk = codes[i:i+10]
                f.write("      " + ", ".join(f'"{c}"' for c in chunk) + ",\n")
            f.write("    ],\n")
        f.write("  };\n\n")
        f.write("  window.FULL_UNIVERSE = FULL_UNIVERSE;\n")
        f.write("  window.UNIVERSE_BY_FLOOR = UNIVERSE_BY_FLOOR;\n")
        f.write("})();\n")
    print(f"Saved → {pwa_out}")


if __name__ == "__main__":
    main()
