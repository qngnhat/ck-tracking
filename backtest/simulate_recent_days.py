"""Mô phỏng scan các ngày gần đây với detection logic giống production.

Để verify: nếu scan ngày X với threshold cũ (vol 1.5) vs mới (vol 1.2),
sẽ có bao nhiêu mã match cho mỗi pattern?

Run trên parquet data (cached).
"""

from __future__ import annotations
import numpy as np
import pandas as pd
from src.load_data import load_universe

TURNOVER_MIN_BN = 3.0


def filter_largemid(universe: pd.DataFrame) -> pd.DataFrame:
    recent = universe[universe.date >= "2024-01-01"].copy()
    recent["turnover"] = recent["close"] * recent["volume"] * 1000
    liq = recent.groupby("symbol")["turnover"].median() / 1e9
    keep = liq[liq >= TURNOVER_MIN_BN].index.tolist()
    return universe[universe.symbol.isin(keep)].copy()


def enrich(group: pd.DataFrame) -> pd.DataFrame:
    g = group.copy().reset_index(drop=True)
    c, o, h, l, v = g["close"].values, g["open"].values, g["high"].values, g["low"].values, g["volume"].values
    cs = pd.Series(c)
    g["ma5"] = cs.rolling(5).mean()
    g["ma20"] = cs.rolling(20).mean()
    g["ma50"] = cs.rolling(50).mean()
    g["ma200"] = cs.rolling(200).mean()
    g["vol_avg20"] = pd.Series(v).rolling(20).mean()
    g["vol_ratio"] = v / g["vol_avg20"]
    g["range_pct"] = (pd.Series(h) - pd.Series(l)) / cs
    g["day_green"] = c > o
    g["ret_3d"] = cs.pct_change(3)

    delta = np.diff(c, prepend=c[0])
    up = np.where(delta > 0, delta, 0)
    dn = np.where(delta < 0, -delta, 0)
    avg_up = pd.Series(up).rolling(14).mean()
    avg_dn = pd.Series(dn).rolling(14).mean()
    rs = avg_up / avg_dn.replace(0, np.nan)
    g["rsi"] = 100 - 100 / (1 + rs)
    return g


def detect_climax(row, tier="A"):
    """Tier A: drop3<-7 + vol>2 + green + RSI<35
    Tier B: drop3<-5 + vol>2 + green + RSI<50"""
    if pd.isna(row.get("ret_3d")) or pd.isna(row.get("rsi")) or pd.isna(row.get("vol_ratio")):
        return False
    base = row["day_green"] and row["vol_ratio"] > 2.0
    if tier == "A":
        return base and row["ret_3d"] < -0.07 and row["rsi"] < 35
    elif tier == "B":
        return base and row["ret_3d"] < -0.05 and row["rsi"] < 50
    return False


def detect_momentum(row, vol_threshold=1.2, rsi_low=50, rsi_high=70, range_max=0.025):
    """Strength continuation."""
    required = ["ma5", "ma20", "ma50", "ma200", "vol_ratio", "rsi", "range_pct", "day_green"]
    if any(pd.isna(row.get(k)) for k in required):
        return False
    return (
        row["ma5"] > row["ma20"] > row["ma50"] > row["ma200"]
        and row["range_pct"] < range_max
        and row["vol_ratio"] > vol_threshold
        and row["day_green"]
        and rsi_low < row["rsi"] < rsi_high
    )


def main():
    print("Load + filter Large+Mid...")
    universe = load_universe()
    filtered = filter_largemid(universe)
    parts = [enrich(g) for _, g in filtered.groupby("symbol", sort=False)]
    df = pd.concat(parts, ignore_index=True)
    df["date"] = pd.to_datetime(df["date"])

    max_date = df["date"].max()
    print(f"  Last bar: {max_date.date()}")
    print(f"  Universe: {filtered.symbol.nunique()} mã\n")

    # Last 15 trading days
    recent_dates = sorted(df["date"].unique())[-15:]

    print(f"{'Date':<12} {'Tier A':<7} {'Tier B':<7} {'Mom v1.5':<10} {'Mom v1.2 (new)':<14} {'Mom v1.0':<10}")
    print("-" * 70)

    for d in recent_dates:
        day = df[df["date"] == d]
        tier_a = day.apply(lambda r: detect_climax(r, "A"), axis=1).sum()
        tier_b = day.apply(lambda r: detect_climax(r, "B"), axis=1).sum()
        mom_15 = day.apply(lambda r: detect_momentum(r, vol_threshold=1.5), axis=1).sum()
        mom_12 = day.apply(lambda r: detect_momentum(r, vol_threshold=1.2), axis=1).sum()
        mom_10 = day.apply(lambda r: detect_momentum(r, vol_threshold=1.0), axis=1).sum()
        date_str = pd.to_datetime(d).strftime("%Y-%m-%d")
        print(f"{date_str:<12} {tier_a:<7} {tier_b:<7} {mom_15:<10} {mom_12:<14} {mom_10:<10}")

    # Show specific matches for last day with details
    last_day = recent_dates[-1]
    print(f"\n=== Chi tiết ngày {pd.to_datetime(last_day).strftime('%Y-%m-%d')} ===")
    day = df[df["date"] == last_day]

    for tier, label in [("A", "Climax Tier A"), ("B", "Climax Tier B")]:
        matches = day[day.apply(lambda r: detect_climax(r, tier), axis=1)]
        if len(matches) > 0:
            print(f"\n{label} ({len(matches)} mã):")
            cols = ["symbol", "close", "ret_3d", "vol_ratio", "rsi"]
            print(matches[cols].to_string(index=False))

    for vol_t, label in [(1.5, "Mom v1.5 (old)"), (1.2, "Mom v1.2 (NEW)"), (1.0, "Mom v1.0 (relax)")]:
        matches = day[day.apply(lambda r: detect_momentum(r, vol_threshold=vol_t), axis=1)]
        if len(matches) > 0:
            print(f"\n{label} ({len(matches)} mã):")
            cols = ["symbol", "close", "ma5", "ma20", "ma50", "vol_ratio", "rsi", "range_pct"]
            print(matches[cols].to_string(index=False))

    # Also show "đang gần signal" Mom (uptrend mạnh, fail vì 1 condition)
    print(f"\n=== Mã 'gần signal' ngày {pd.to_datetime(last_day).strftime('%Y-%m-%d')} ===")
    uptrend = day[
        (day["ma5"] > day["ma20"]) & (day["ma20"] > day["ma50"]) & (day["ma50"] > day["ma200"])
    ].copy()
    print(f"Mã có uptrend stack MA5>MA20>MA50>MA200: {len(uptrend)}")
    if len(uptrend) > 0:
        uptrend["pass_range"] = uptrend["range_pct"] < 0.025
        uptrend["pass_vol_12"] = uptrend["vol_ratio"] > 1.2
        uptrend["pass_green"] = uptrend["day_green"]
        uptrend["pass_rsi"] = (uptrend["rsi"] > 50) & (uptrend["rsi"] < 70)
        uptrend["passes"] = uptrend["pass_range"].astype(int) + uptrend["pass_vol_12"].astype(int) + uptrend["pass_green"].astype(int) + uptrend["pass_rsi"].astype(int)
        # Top mã pass 3/4
        near = uptrend[uptrend["passes"] == 3].copy()
        print(f"\nMã pass 3/4 (chỉ thiếu 1):")
        if len(near) > 0:
            cols = ["symbol", "close", "range_pct", "vol_ratio", "day_green", "rsi", "pass_range", "pass_vol_12", "pass_green", "pass_rsi"]
            print(near[cols].head(15).to_string(index=False))


if __name__ == "__main__":
    main()
