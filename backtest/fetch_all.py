"""Fetch OHLCV + fundamentals + foreign flow for entire universe.

Usage:
    python fetch_all.py              # fetch all types
    python fetch_all.py ohlcv        # just OHLCV
    python fetch_all.py fundamentals # just fundamentals
    python fetch_all.py foreign      # just foreign flow
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pandas as pd

from src.data_fetch import fetch_ohlcv, fetch_fundamentals, fetch_foreign_flow

BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)

START_DATE = "2018-01-01"


def read_universe() -> list[str]:
    with open(BASE_DIR / "universe.txt") as f:
        return [
            line.strip()
            for line in f
            if line.strip() and not line.startswith("#")
        ]


def fetch_all_ohlcv(universe: list[str]) -> pd.DataFrame:
    print(f"\n=== OHLCV ({len(universe)} symbols) ===")
    dfs: list[pd.DataFrame] = []
    failed: list[str] = []

    for i, sym in enumerate(universe, 1):
        print(f"  [{i}/{len(universe)}] {sym}...", end=" ", flush=True)
        try:
            df = fetch_ohlcv(sym, start=START_DATE)
            dfs.append(df)
            print(f"{len(df)} bars")
            time.sleep(0.3)
        except Exception as e:
            print(f"FAILED: {e}")
            failed.append(sym)

    if not dfs:
        print("No OHLCV fetched — check network/API.")
        return pd.DataFrame()

    out = pd.concat(dfs, ignore_index=True).sort_values(["symbol", "date"])
    path = DATA_DIR / "ohlcv.parquet"
    out.to_parquet(path, index=False)
    print(f"Saved {len(out)} rows → {path}")
    if failed:
        print(f"  Failed: {failed}")
    return out


def fetch_all_fundamentals(universe: list[str]) -> pd.DataFrame:
    print(f"\n=== Fundamentals ({len(universe)} symbols) ===")
    rows: list[dict] = []
    failed: list[str] = []

    for i, sym in enumerate(universe, 1):
        print(f"  [{i}/{len(universe)}] {sym}...", end=" ", flush=True)
        try:
            r = fetch_fundamentals(sym)
            rows.append(r)
            extras = [k for k in r if k != "symbol"]
            print(f"{len(extras)} ratios")
            time.sleep(0.3)
        except Exception as e:
            print(f"FAILED: {e}")
            failed.append(sym)

    if not rows:
        print("No fundamentals fetched.")
        return pd.DataFrame()

    df = pd.DataFrame(rows)
    path = DATA_DIR / "fundamentals.parquet"
    df.to_parquet(path, index=False)
    print(f"Saved {len(df)} rows → {path}")
    if failed:
        print(f"  Failed: {failed}")
    return df


def fetch_all_foreign(universe: list[str]) -> pd.DataFrame:
    print(f"\n=== Foreign Flow ({len(universe)} symbols) ===")
    dfs: list[pd.DataFrame] = []
    failed: list[str] = []

    for i, sym in enumerate(universe, 1):
        print(f"  [{i}/{len(universe)}] {sym}...", end=" ", flush=True)
        try:
            df = fetch_foreign_flow(sym, start=START_DATE)
            if len(df) > 0:
                dfs.append(df)
                print(f"{len(df)} rows")
            else:
                print("empty")
            time.sleep(0.3)
        except Exception as e:
            print(f"FAILED: {e}")
            failed.append(sym)

    if not dfs:
        print("No foreign flow fetched.")
        return pd.DataFrame()

    out = pd.concat(dfs, ignore_index=True).sort_values(["symbol", "date"])
    path = DATA_DIR / "foreign_flow.parquet"
    out.to_parquet(path, index=False)
    print(f"Saved {len(out)} rows → {path}")
    if failed:
        print(f"  Failed: {failed}")
    return out


def main() -> None:
    universe = read_universe()
    print(f"Universe: {len(universe)} symbols")

    what = sys.argv[1] if len(sys.argv) > 1 else "all"

    if what in ("all", "ohlcv"):
        fetch_all_ohlcv(universe)
    if what in ("all", "fundamentals"):
        fetch_all_fundamentals(universe)
    if what in ("all", "foreign"):
        fetch_all_foreign(universe)


if __name__ == "__main__":
    main()
