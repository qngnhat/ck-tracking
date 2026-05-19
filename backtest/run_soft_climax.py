"""Soft Climax — Tier B Climax MỀM dựa trên fingerprint analysis.

Insight từ per_stock_fingerprint.py: median surge feature across 49 mã:
- ret_3d ~ -5.5% ± 0.26 (universal)
- RSI ~ 40 ± 4.6 (moderate variance)
- vol_ratio ~ 1.09 ± 0.14 (vol bình thường, KHÔNG cần spike)
- dist_to_MA20 ~ -4.6% ± 1.4

→ Test pattern: drop -7%..-4%, RSI < 45, vol > 1.0 (no spike), dist MA20 < 0
Bỏ yêu cầu vol > 2× của Tier B (universe đã verify không cần)
"""

from __future__ import annotations
import numpy as np
import pandas as pd
from src.backtest import DEFAULT_COST_RT
from src.load_data import load_universe

TURNOVER_MIN_BN = 3.0


def filter_largemid(universe):
    recent = universe[universe.date >= "2024-01-01"].copy()
    recent["turnover"] = recent["close"] * recent["volume"] * 1000
    liq = recent.groupby("symbol")["turnover"].median() / 1e9
    keep = liq[liq >= TURNOVER_MIN_BN].index.tolist()
    return universe[universe.symbol.isin(keep)].copy()


def enrich(group):
    g = group.copy().reset_index(drop=True)
    c, o, v = g["close"].values, g["open"].values, g["volume"].values
    cs = pd.Series(c)
    g["ma20"] = cs.rolling(20).mean()
    g["vol_avg20"] = pd.Series(v).rolling(20).mean()
    g["vol_ratio"] = v / g["vol_avg20"]
    g["ret_3d"] = cs.pct_change(3)
    g["dist_ma20"] = (cs - g["ma20"]) / g["ma20"]
    g["day_green"] = c > o

    delta = np.diff(c, prepend=c[0])
    up = np.where(delta > 0, delta, 0)
    dn = np.where(delta < 0, -delta, 0)
    avg_up = pd.Series(up).rolling(14).mean()
    avg_dn = pd.Series(dn).rolling(14).mean()
    rs = avg_up / avg_dn.replace(0, np.nan)
    g["rsi"] = 100 - 100 / (1 + rs)
    return g


def simulate(df, sig_col, min_hold=3, max_hold=5, target_pct=0.03, sl_close_pct=0.08, cost=DEFAULT_COST_RT):
    df = df.sort_values(["symbol", "date"])
    trades = []
    for sym, group in df.groupby("symbol", sort=False):
        g = group.reset_index(drop=True)
        sig = g[sig_col].values
        for i in range(len(g) - 1 - max_hold):
            if not sig[i]: continue
            ep = g.iloc[i + 1]["open"]
            if pd.isna(ep) or ep <= 0: continue
            exit_price = None; exit_day = None
            for h in range(1, max_hold + 1):
                day_idx = i + 1 + h
                if day_idx >= len(g): break
                day_close = g.iloc[day_idx]["close"]
                if pd.isna(day_close): continue
                if sl_close_pct and day_close <= ep * (1 - sl_close_pct):
                    exit_price = day_close; exit_day = h; break
                if h >= min_hold:
                    ret = (day_close - ep) / ep
                    if ret >= target_pct:
                        exit_price = day_close; exit_day = h; break
                if h == max_hold:
                    exit_price = day_close; exit_day = h
            if exit_price is None: continue
            trades.append({
                "date": g.iloc[i]["date"], "symbol": sym,
                "net_ret": (exit_price - ep) / ep - cost,
                "exit_day": exit_day,
            })
    return pd.DataFrame(trades)


def stats(trades):
    if len(trades) == 0:
        return {"n": 0, "win": 0, "avg": 0, "sharpe": 0, "pf": 0}
    win = (trades["net_ret"] > 0).mean()
    avg = trades["net_ret"].mean()
    std = trades["net_ret"].std()
    hold_avg = trades["exit_day"].mean()
    sharpe = (avg / std * (252 / hold_avg) ** 0.5) if std > 0 and hold_avg > 0 else 0
    pos = trades.loc[trades["net_ret"] > 0, "net_ret"].sum()
    neg = abs(trades.loc[trades["net_ret"] < 0, "net_ret"].sum())
    pf = pos / neg if neg > 0 else float("inf")
    return {"n": len(trades), "win": win, "avg": avg, "sharpe": sharpe, "pf": pf}


def print_row(label, s):
    yr = s['n'] / 8.5 if s['n'] > 0 else 0
    print(f"  {label:<55} {s['n']:5d} ({yr:5.1f}/yr) {s['win']*100:5.1f}% {s['avg']*100:+5.2f}% {s['sharpe']:+.2f} {s['pf']:.2f}")


def main():
    print("Load + filter Large+Mid...")
    universe = load_universe()
    filtered = filter_largemid(universe)
    print(f"  {filtered.symbol.nunique()} mã\n")

    parts = [enrich(g) for _, g in filtered.groupby("symbol", sort=False)]
    df = pd.concat(parts, ignore_index=True)
    df["date"] = pd.to_datetime(df["date"])

    # Baseline (current production)
    df["tier_a"] = (df["ret_3d"] < -0.07) & (df["vol_ratio"] > 2.0) & df["day_green"] & (df["rsi"] < 35)
    df["tier_b"] = (df["ret_3d"] < -0.05) & (df["vol_ratio"] > 2.0) & df["day_green"] & (df["rsi"] < 50)

    # Soft Climax variants (based on fingerprint medians)
    # Core idea: drop -5 to -7%, RSI < 45, vol > 1.0 (no spike requirement)
    df["v1_soft"] = (
        (df["ret_3d"] >= -0.07) & (df["ret_3d"] < -0.04) &
        (df["rsi"] < 45) & (df["vol_ratio"] > 1.0) &
        df["day_green"] & (df["dist_ma20"] < 0)
    )
    df["v2_soft_no_ma"] = (
        (df["ret_3d"] >= -0.07) & (df["ret_3d"] < -0.04) &
        (df["rsi"] < 45) & (df["vol_ratio"] > 1.0) & df["day_green"]
    )
    df["v3_soft_rsi40"] = (
        (df["ret_3d"] >= -0.07) & (df["ret_3d"] < -0.04) &
        (df["rsi"] < 40) & (df["vol_ratio"] > 1.0) &
        df["day_green"] & (df["dist_ma20"] < 0)
    )
    df["v4_soft_vol12"] = (
        (df["ret_3d"] >= -0.07) & (df["ret_3d"] < -0.04) &
        (df["rsi"] < 45) & (df["vol_ratio"] > 1.2) &
        df["day_green"] & (df["dist_ma20"] < 0)
    )
    df["v5_soft_wider"] = (
        (df["ret_3d"] >= -0.08) & (df["ret_3d"] < -0.03) &
        (df["rsi"] < 50) & (df["vol_ratio"] > 1.0) &
        df["day_green"] & (df["dist_ma20"] < 0)
    )
    df["v6_soft_no_green"] = (
        (df["ret_3d"] >= -0.07) & (df["ret_3d"] < -0.04) &
        (df["rsi"] < 45) & (df["vol_ratio"] > 1.0) &
        (df["dist_ma20"] < 0)
    )

    VARIANTS = [
        ("Tier A baseline", "tier_a"),
        ("Tier B baseline", "tier_b"),
        ("v1 soft: drop -7..-4, RSI<45, vol>1, green, <MA20", "v1_soft"),
        ("v2 soft no MA filter", "v2_soft_no_ma"),
        ("v3 RSI<40 (stricter)", "v3_soft_rsi40"),
        ("v4 vol>1.2", "v4_soft_vol12"),
        ("v5 wider: drop -8..-3, RSI<50, vol>1", "v5_soft_wider"),
        ("v6 no green requirement", "v6_soft_no_green"),
    ]

    WINDOWS = [
        ("2018-01-01", "2026-05-13", "ALL 8.5y"),
        ("2024-01-01", "2026-05-13", "2024-2026 in-sample"),
        ("2018-01-01", "2023-12-31", "2018-2023 out-sample"),
    ]

    for s, e, l in WINDOWS:
        win_df = df[(df["date"] >= s) & (df["date"] <= e)].copy()
        print(f"\n═══ {l} ═══")
        print(f"  {'Variant':<55} {'n':>5}  {'/yr':<7} {'Win%':>6} {'Avg':>7} {'Sharpe':>7} {'PF':>5}")
        for vl, vc in VARIANTS:
            tr = simulate(win_df, vc)
            print_row(vl, stats(tr))


if __name__ == "__main__":
    main()
