"""Idea 5: Foreign Flow DEEP track.

VN academic + market evidence: foreign flow drives behavior. Test variants:
- V1: NN net 5d > 0 + drop signal (mean-reversion)
- V2: NN net 10d > X tỷ + breakout (institutional accumulation)
- V3: NN net 20d trend up (consistent accumulation) + above MA50
- V4: NN net 5d as confirmation cho Base Breakout
- V5: NN net 20d consistent positive (days_net_buy >= 15/20)

Cross-val Train 2024-2025 / Test 2026.
Pattern aware: VN regime 2025-26 = foreign bán ròng → có thể inverse signal?
- V6: NN bán mạnh + RSI thấp → bounce (contrarian play)
"""

from __future__ import annotations
import numpy as np
import pandas as pd
from src.backtest import DEFAULT_COST_RT
from src.load_data import load_universe

TRAIN_START, TRAIN_END, TEST_START = "2024-01-01", "2025-12-31", "2026-01-01"
TURNOVER_MIN_BN = 5.0


def filter_universe(u):
    recent = u[u.date >= "2024-01-01"].copy()
    recent["turnover"] = recent["close"] * recent["volume"] * 1000
    liq = recent.groupby("symbol")["turnover"].median() / 1e9
    return u[u.symbol.isin(liq[liq >= TURNOVER_MIN_BN].index)].copy()


def enrich(group):
    g = group.copy().reset_index(drop=True)
    c, o, h, l, v = g["close"].values, g["open"].values, g["high"].values, g["low"].values, g["volume"].values
    cs = pd.Series(c)
    g["ma50"] = cs.rolling(50).mean()
    g["ma200"] = cs.rolling(200).mean()
    g["above_ma50"] = c > g["ma50"]
    g["above_ma200"] = c > g["ma200"]
    g["vol_avg20"] = pd.Series(v).rolling(20).mean()
    g["vol_ratio"] = v / g["vol_avg20"]
    g["day_green"] = c > o
    g["ret_3d"] = cs.pct_change(3) * 100
    g["ret_5d"] = cs.pct_change(5) * 100

    # RSI
    delta = np.diff(c, prepend=c[0])
    up = np.where(delta > 0, delta, 0)
    dn = np.where(delta < 0, -delta, 0)
    avg_up = pd.Series(up).rolling(14).mean()
    avg_dn = pd.Series(dn).rolling(14).mean()
    rs = avg_up / avg_dn.replace(0, np.nan)
    g["rsi"] = 100 - 100 / (1 + rs)

    # Foreign flow aggregates
    if "net_val" in g.columns:
        net = g["net_val"].fillna(0)
        g["nn_5d"] = net.rolling(5).sum() / 1e9     # billion VND
        g["nn_10d"] = net.rolling(10).sum() / 1e9
        g["nn_20d"] = net.rolling(20).sum() / 1e9
        g["nn_days_buy_20"] = (net > 0).rolling(20).sum()
        # Trend: nn_5d > nn_5d shifted by 5 (accelerating accumulation)
        g["nn_5d_accelerate"] = g["nn_5d"] > g["nn_5d"].shift(5)
    else:
        for col in ["nn_5d", "nn_10d", "nn_20d", "nn_days_buy_20", "nn_5d_accelerate"]:
            g[col] = 0

    # Base Breakout
    high_30 = pd.Series(h).rolling(30).max()
    low_30 = pd.Series(l).rolling(30).min()
    range_30 = (high_30 - low_30) / low_30
    g["base_range_ok"] = range_30.shift(1) < 0.10
    g["break_above"] = c > high_30.shift(1)
    g["base_breakout"] = (
        g["above_ma200"] & g["base_range_ok"] & g["break_above"] & (g["vol_ratio"] > 1.5)
    )
    return g


def simulate_trailing(df, sig_col, max_hold, trail_pct, init_sl_pct, cost=DEFAULT_COST_RT):
    df = df.sort_values(["symbol", "date"])
    trades = []
    for sym, group in df.groupby("symbol", sort=False):
        g = group.reset_index(drop=True)
        sig = g[sig_col].values
        opens, closes, highs = g["open"].values, g["close"].values, g["high"].values
        for i in range(len(g) - 1 - max_hold):
            if not sig[i]:
                continue
            ep = opens[i + 1]
            if pd.isna(ep) or ep <= 0:
                continue
            init_sl = ep * (1 - init_sl_pct)
            peak = ep
            ex, eh = None, None
            for h_step in range(1, max_hold + 1):
                di = i + 1 + h_step
                if di >= len(g):
                    break
                dc = closes[di]
                if pd.isna(dc):
                    continue
                dh = highs[di]
                if not pd.isna(dh) and dh > peak:
                    peak = dh
                trail_sl = peak * (1 - trail_pct)
                eff = max(init_sl, trail_sl)
                if dc <= eff:
                    ex, eh = dc, h_step; break
                if h_step == max_hold:
                    ex, eh = dc, h_step
            if ex is None:
                continue
            trades.append({"date": g.iloc[i]["date"], "exit_day": eh,
                          "net_ret": (ex - ep) / ep - cost})
    return pd.DataFrame(trades)


def stats(t):
    if len(t) < 10:
        return None
    win = (t["net_ret"] > 0).mean()
    avg = t["net_ret"].mean()
    std = t["net_ret"].std()
    h = t["exit_day"].mean()
    sh = (avg / std * (252 / h) ** 0.5) if std > 0 else 0
    pos = t.loc[t["net_ret"] > 0, "net_ret"].sum()
    neg = abs(t.loc[t["net_ret"] < 0, "net_ret"].sum())
    pf = pos / neg if neg > 0 else float("inf")
    return {"n": len(t), "win": win, "avg": avg, "sharpe": sh, "pf": pf}


def main():
    print("Load + enrich (foreign flow + technicals)...")
    u = load_universe()
    f = filter_universe(u)
    parts = [enrich(g) for _, g in f.groupby("symbol", sort=False)]
    df = pd.concat(parts, ignore_index=True)
    print(f"  {f.symbol.nunique()} mã, {len(df):,} rows")

    train = df[(df["date"] >= TRAIN_START) & (df["date"] <= TRAIN_END)].copy()
    test = df[df["date"] >= TEST_START].copy()
    print(f"  Train {len(train):,}, Test {len(test):,}\n")

    # Variants
    variants = [
        # (label, signal_lambda, hold, trail, sl)
        ("V1. NN 5d>0 + drop 3d<-5% (MR)",
         lambda d: (d["nn_5d"] > 0) & (d["ret_3d"] < -5) & d["day_green"] & (d["rsi"] < 50),
         5, 0.08, 0.08),
        ("V2. NN 10d>5B + Base Breakout",
         lambda d: d["base_breakout"] & (d["nn_10d"] > 5),
         30, 0.10, 0.10),
        ("V3. NN 20d>10B + above MA50",
         lambda d: (d["nn_20d"] > 10) & d["above_ma50"] & d["day_green"],
         20, 0.10, 0.10),
        ("V4. NN 5d>0 alone + above MA200",
         lambda d: (d["nn_5d"] > 0) & d["above_ma200"] & d["day_green"],
         15, 0.10, 0.10),
        ("V5. NN consistent buy ≥15/20 days",
         lambda d: (d["nn_days_buy_20"] >= 15) & d["above_ma50"],
         20, 0.10, 0.10),
        ("V6. NN bán mạnh 5d <-5B + RSI<30 (contrarian)",
         lambda d: (d["nn_5d"] < -5) & (d["rsi"] < 30) & d["day_green"],
         10, 0.10, 0.10),
        ("V7. NN accelerating (5d > prev5d) + Base Breakout",
         lambda d: d["base_breakout"] & d["nn_5d_accelerate"] & (d["nn_5d"] > 0),
         30, 0.10, 0.10),
        ("V8. NN buy >0 + RSI 40-60 (steady accumulation)",
         lambda d: (d["nn_5d"] > 0) & (d["rsi"] >= 40) & (d["rsi"] <= 60) & d["above_ma50"] & d["day_green"],
         20, 0.10, 0.10),
    ]

    print(f"═══ Foreign Flow Variants — Train 2024-25 / Test 2026 ═══")
    print(f"  {'Variant':<48} | {'TRAIN n  win   avg     sh   pf':<33} | {'TEST n  win   avg     sh   pf':<33}")
    print(f"  {'-'*48}-+-{'-'*33}-+-{'-'*33}")
    results = []
    for label, sig_fn, hold, trail, sl in variants:
        df_v = df.copy()
        df_v["sig"] = sig_fn(df_v)
        train_v = df_v[(df_v["date"] >= TRAIN_START) & (df_v["date"] <= TRAIN_END)]
        test_v = df_v[df_v["date"] >= TEST_START]
        t_tr = simulate_trailing(train_v, "sig", hold, trail, sl)
        t_te = simulate_trailing(test_v, "sig", hold, trail, sl)
        s_tr, s_te = stats(t_tr), stats(t_te)
        if s_tr is None or s_te is None:
            print(f"  {label:<48} | (insufficient)")
            continue
        tr_str = f"{s_tr['n']:4d} {s_tr['win']*100:5.1f}% {s_tr['avg']*100:+5.2f}% {s_tr['sharpe']:+.2f} {s_tr['pf']:.2f}"
        te_str = f"{s_te['n']:4d} {s_te['win']*100:5.1f}% {s_te['avg']*100:+5.2f}% {s_te['sharpe']:+.2f} {s_te['pf']:.2f}"
        marker = ""
        if s_te["sharpe"] >= 0.5 and s_te["pf"] >= 1.3 and s_te["avg"] > 0:
            marker = "🟢"
        elif s_te["avg"] > 0:
            marker = "🟡"
        print(f"  {marker} {label:<46} | {tr_str:<33} | {te_str:<33}")
        results.append({"label": label, "tr": s_tr, "te": s_te})

    print(f"\n═══ Pass criteria: Test Sharpe ≥ 0.5, PF ≥ 1.3, avg > 0 ═══")
    passed = [r for r in results if r["te"]["sharpe"] >= 0.5 and r["te"]["pf"] >= 1.3 and r["te"]["avg"] > 0]
    if not passed:
        print("  ❌ KHÔNG variant nào pass.")
        results.sort(key=lambda r: r["te"]["sharpe"], reverse=True)
        print("\n  Top 3 Test Sharpe (inspect):")
        for r in results[:3]:
            print(f"    {r['label']}: Test n={r['te']['n']} Sharpe {r['te']['sharpe']:+.2f}")
    else:
        passed.sort(key=lambda r: r["te"]["sharpe"], reverse=True)
        print(f"  ✅ {len(passed)} variants pass:")
        for r in passed:
            print(f"  🟢 {r['label']}: Test n={r['te']['n']} sh={r['te']['sharpe']:+.2f} pf={r['te']['pf']:.2f} avg={r['te']['avg']*100:+.2f}%")


if __name__ == "__main__":
    main()
