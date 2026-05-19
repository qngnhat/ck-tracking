"""Per-stock fingerprint analyzer.

Concept: mỗi mã có "đặc điểm riêng" lúc nó tăng mạnh. Tìm:
1. Surge days lịch sử (mỗi mã, các phiên tăng ≥5% trong 3-5 phiên forward)
2. Features ở surge entry day: RSI, vol_ratio, ret_5d, ret_20d, range_pct, ATR%, distance to MA20, etc.
3. Compute median + std cho từng feature per stock
4. Output: fingerprint table per stock

Decision: nếu fingerprints DIFFERENT across stocks → viable approach. Nếu giống nhau (universal) → không thêm value.
"""

from __future__ import annotations
import numpy as np
import pandas as pd
from src.load_data import load_universe

SURGE_THRESHOLD = 0.05    # 5% gain trong window
SURGE_WINDOW = 5          # T+1 → T+5 phiên forward
LOOKBACK = 252 * 3        # 3 năm history
TURNOVER_MIN_BN = 3.0


def filter_largemid(universe: pd.DataFrame) -> pd.DataFrame:
    recent = universe[universe.date >= "2024-01-01"].copy()
    recent["turnover"] = recent["close"] * recent["volume"] * 1000
    liq = recent.groupby("symbol")["turnover"].median().sort_values(ascending=False)
    return liq.head(50).index.tolist()  # top 50 liquid


def calc_features(df: pd.DataFrame) -> pd.DataFrame:
    g = df.copy().reset_index(drop=True)
    c, o, h, l, v = g["close"].values, g["open"].values, g["high"].values, g["low"].values, g["volume"].values
    cs = pd.Series(c)

    g["ma5"] = cs.rolling(5).mean()
    g["ma20"] = cs.rolling(20).mean()
    g["ma50"] = cs.rolling(50).mean()
    g["vol_avg20"] = pd.Series(v).rolling(20).mean()
    g["vol_ratio"] = v / g["vol_avg20"]
    g["range_pct"] = (pd.Series(h) - pd.Series(l)) / cs * 100
    g["ret_3d"] = cs.pct_change(3) * 100
    g["ret_5d"] = cs.pct_change(5) * 100
    g["ret_20d"] = cs.pct_change(20) * 100
    g["dist_to_ma20"] = (cs - g["ma20"]) / g["ma20"] * 100
    g["dist_to_ma50"] = (cs - g["ma50"]) / g["ma50"] * 100
    g["day_green"] = c > o

    delta = np.diff(c, prepend=c[0])
    up = np.where(delta > 0, delta, 0)
    dn = np.where(delta < 0, -delta, 0)
    avg_up = pd.Series(up).rolling(14).mean()
    avg_dn = pd.Series(dn).rolling(14).mean()
    rs = avg_up / avg_dn.replace(0, np.nan)
    g["rsi"] = 100 - 100 / (1 + rs)

    # Forward return — measure surge
    g["fwd_max_close"] = cs.shift(-1).rolling(SURGE_WINDOW).max()
    g["fwd_max_ret"] = (g["fwd_max_close"] - cs) / cs * 100
    g["is_surge"] = g["fwd_max_ret"] >= SURGE_THRESHOLD * 100

    return g


def analyze_stock(df: pd.DataFrame, sym: str):
    """Compute surge fingerprint for one stock."""
    df = calc_features(df).copy()
    # Recent N bars only
    df = df.tail(LOOKBACK).copy()
    surges = df[df["is_surge"]].copy()
    non_surges = df[~df["is_surge"]].copy()

    if len(surges) < 10:
        return None

    features = ["rsi", "vol_ratio", "ret_3d", "ret_5d", "ret_20d",
                "range_pct", "dist_to_ma20", "dist_to_ma50"]
    fingerprint = {}
    for f in features:
        s_vals = surges[f].dropna()
        n_vals = non_surges[f].dropna()
        if len(s_vals) < 5 or len(n_vals) < 50:
            continue
        fingerprint[f] = {
            "surge_median": s_vals.median(),
            "surge_p25": s_vals.quantile(0.25),
            "surge_p75": s_vals.quantile(0.75),
            "non_median": n_vals.median(),
            "diff": s_vals.median() - n_vals.median(),
        }
    return {
        "symbol": sym,
        "n_surges": len(surges),
        "n_total": len(df),
        "surge_rate": len(surges) / len(df) * 100,
        "fingerprint": fingerprint,
    }


def main():
    print("Load universe...")
    universe = load_universe()
    universe["date"] = pd.to_datetime(universe["date"])
    top_syms = filter_largemid(universe)
    print(f"  Top 50 liquid: {len(top_syms)} mã\n")

    all_fingerprints = []
    for sym in top_syms:
        sdf = universe[universe["symbol"] == sym].sort_values("date").reset_index(drop=True)
        if len(sdf) < 250:
            continue
        result = analyze_stock(sdf, sym)
        if result:
            all_fingerprints.append(result)

    print(f"Analyzed {len(all_fingerprints)} stocks with enough surge history\n")
    if not all_fingerprints:
        return

    # Build summary table: each row a stock, columns are features
    features = ["rsi", "vol_ratio", "ret_3d", "ret_5d", "ret_20d", "range_pct", "dist_to_ma20"]

    rows = []
    for fp in all_fingerprints:
        row = {"symbol": fp["symbol"], "n_surges": fp["n_surges"], "surge_rate": round(fp["surge_rate"], 1)}
        for f in features:
            if f in fp["fingerprint"]:
                row[f"{f}_surge"] = round(fp["fingerprint"][f]["surge_median"], 2)
                row[f"{f}_diff"] = round(fp["fingerprint"][f]["diff"], 2)
        rows.append(row)

    df_out = pd.DataFrame(rows)
    print("=== Surge feature MEDIAN per stock (top 30 by surge count) ===")
    cols = ["symbol", "n_surges", "surge_rate"] + [f"{f}_surge" for f in features]
    print(df_out[cols].sort_values("n_surges", ascending=False).head(30).to_string(index=False))

    print("\n=== Surge vs Non-surge DIFF per stock (positive = feature higher at surge) ===")
    cols2 = ["symbol", "n_surges"] + [f"{f}_diff" for f in features]
    print(df_out[cols2].sort_values("n_surges", ascending=False).head(30).to_string(index=False))

    # Variance analysis: how different are fingerprints?
    print("\n=== Cross-stock variance per feature (high = fingerprints DIFFER) ===")
    for f in features:
        col = f"{f}_surge"
        if col in df_out.columns:
            vals = df_out[col].dropna()
            if len(vals) > 5:
                print(f"  {f:<15} median across stocks: {vals.median():+.2f} · std: {vals.std():.2f} · min: {vals.min():+.2f} · max: {vals.max():+.2f}")

    print("\n=== INTERPRETATION ===")
    print("  Nếu std cao (vd > 0.5 cho rsi_surge) → fingerprints khác nhau → per-stock approach viable")
    print("  Nếu std thấp (~0.1) → tất cả mã surge ở same setup → universal pattern đủ, per-stock không thêm value")


if __name__ == "__main__":
    main()
