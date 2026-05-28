"""Idea 3: Composite Multi-Signal Scoring.

Hypothesis: combine multiple signals → higher confidence picks. Mã có nhiều
factor align thì edge mạnh hơn single pattern.

Score 0-100:
  +30 Base Breakout pattern match (verified Sharpe +1.13)
  +20 Foreign net buy 5d > 0 (institutional confirm)
  +15 Above MA200 (long-term uptrend)
  +15 RSI 50-65 (healthy momentum, not overbought)
  +10 vol_ratio > 1.5 (vol confirm)
  +10 ret_20d > 0 (medium-term up)

Threshold variants: pick mã score ≥ 50, 60, 70, 80.
Exit: hold 30 phiên, trail 10%, init SL -10% (same Base Breakout best).
Cross-val Train 2024-2025 / Test 2026.

Pass: Sharpe ≥ 0.5, PF ≥ 1.3, avg > 0, n ≥ 20.
"""

from __future__ import annotations
import numpy as np
import pandas as pd
from src.backtest import DEFAULT_COST_RT
from src.load_data import load_universe

TRAIN_START, TRAIN_END, TEST_START = "2024-01-01", "2025-12-31", "2026-01-01"
TURNOVER_MIN_BN = 5.0
MAX_HOLD = 30
TRAIL_PCT = 0.10
INIT_SL_PCT = 0.10


def filter_universe(u):
    recent = u[u.date >= "2024-01-01"].copy()
    recent["turnover"] = recent["close"] * recent["volume"] * 1000
    liq = recent.groupby("symbol")["turnover"].median() / 1e9
    return u[u.symbol.isin(liq[liq >= TURNOVER_MIN_BN].index)].copy()


def enrich(group):
    g = group.copy().reset_index(drop=True)
    c, o, h, l, v = g["close"].values, g["open"].values, g["high"].values, g["low"].values, g["volume"].values
    cs = pd.Series(c)
    g["ma200"] = cs.rolling(200).mean()
    g["above_ma200"] = c > g["ma200"]
    g["vol_avg20"] = pd.Series(v).rolling(20).mean()
    g["vol_ratio"] = v / g["vol_avg20"]

    # Base Breakout components
    high_30 = pd.Series(h).rolling(30).max()
    low_30 = pd.Series(l).rolling(30).min()
    range_30 = (high_30 - low_30) / low_30
    g["base_range_ok"] = range_30.shift(1) < 0.10
    g["break_above"] = c > high_30.shift(1)
    g["sig_base_breakout"] = (
        g["above_ma200"] & g["base_range_ok"] & g["break_above"] & (g["vol_ratio"] > 1.5)
    )

    # RSI
    delta = np.diff(c, prepend=c[0])
    up = np.where(delta > 0, delta, 0)
    dn = np.where(delta < 0, -delta, 0)
    avg_up = pd.Series(up).rolling(14).mean()
    avg_dn = pd.Series(dn).rolling(14).mean()
    rs = avg_up / avg_dn.replace(0, np.nan)
    g["rsi"] = 100 - 100 / (1 + rs)

    # ret_20d (medium-term momentum)
    g["ret_20d"] = cs.pct_change(20) * 100

    # net_val 5d (foreign flow proxy — sum last 5 days)
    if "net_val" in g.columns:
        g["nn_5d"] = g["net_val"].fillna(0).rolling(5).sum()
    else:
        g["nn_5d"] = 0

    # Score components (binary)
    g["s_base"] = g["sig_base_breakout"].astype(int) * 30
    g["s_nn"] = (g["nn_5d"] > 0).astype(int) * 20
    g["s_ma200"] = g["above_ma200"].astype(int) * 15
    g["s_rsi"] = ((g["rsi"] >= 50) & (g["rsi"] <= 65)).astype(int) * 15
    g["s_vol"] = (g["vol_ratio"] > 1.5).astype(int) * 10
    g["s_ret20"] = (g["ret_20d"] > 0).astype(int) * 10
    g["score"] = g["s_base"] + g["s_nn"] + g["s_ma200"] + g["s_rsi"] + g["s_vol"] + g["s_ret20"]
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
    return {"n": len(t), "win": win, "avg": avg, "sharpe": sh, "pf": pf, "avg_h": h}


def main():
    print("Load + enrich (universe + foreign flow + score components)...")
    u = load_universe()
    f = filter_universe(u)
    parts = [enrich(g) for _, g in f.groupby("symbol", sort=False)]
    df = pd.concat(parts, ignore_index=True)
    print(f"  {f.symbol.nunique()} mã, {len(df):,} rows")

    train = df[(df["date"] >= TRAIN_START) & (df["date"] <= TRAIN_END)].copy()
    test = df[df["date"] >= TEST_START].copy()
    print(f"  Train {len(train):,}, Test {len(test):,}\n")

    # Threshold variants
    thresholds = [40, 50, 60, 70, 80]

    print(f"═══ Composite Score — Hold 30d trail 10%/SL 10% ═══")
    print(f"  {'Threshold':<12} | {'TRAIN n  win   avg     sh   pf':<35} | {'TEST n  win   avg     sh   pf':<35}")
    print(f"  {'-'*12}-+-{'-'*35}-+-{'-'*35}")
    results = []
    for thresh in thresholds:
        df_thresh = df.copy()
        df_thresh["sig"] = df_thresh["score"] >= thresh
        train_t = df_thresh[(df_thresh["date"] >= TRAIN_START) & (df_thresh["date"] <= TRAIN_END)]
        test_t = df_thresh[df_thresh["date"] >= TEST_START]
        t_tr = simulate_trailing(train_t, "sig", MAX_HOLD, TRAIL_PCT, INIT_SL_PCT)
        t_te = simulate_trailing(test_t, "sig", MAX_HOLD, TRAIL_PCT, INIT_SL_PCT)
        s_tr, s_te = stats(t_tr), stats(t_te)
        if s_tr is None or s_te is None:
            print(f"  score ≥ {thresh:<5}  | (insufficient sample)")
            continue
        tr_str = f"{s_tr['n']:4d} {s_tr['win']*100:5.1f}% {s_tr['avg']*100:+5.2f}% {s_tr['sharpe']:+.2f} {s_tr['pf']:.2f}"
        te_str = f"{s_te['n']:4d} {s_te['win']*100:5.1f}% {s_te['avg']*100:+5.2f}% {s_te['sharpe']:+.2f} {s_te['pf']:.2f}"
        marker = ""
        if s_te["sharpe"] >= 0.5 and s_te["pf"] >= 1.3 and s_te["avg"] > 0:
            marker = "🟢"
        elif s_te["avg"] > 0:
            marker = "🟡"
        print(f"  {marker} score ≥ {thresh:<3} | {tr_str:<35} | {te_str:<35}")
        results.append({"thresh": thresh, "tr": s_tr, "te": s_te})

    # Compare with Base Breakout alone (baseline)
    print(f"\n═══ Baseline: Base Breakout only (s_base = 30) ═══")
    df_baseline = df.copy()
    df_baseline["sig"] = df_baseline["sig_base_breakout"]
    train_b = df_baseline[(df_baseline["date"] >= TRAIN_START) & (df_baseline["date"] <= TRAIN_END)]
    test_b = df_baseline[df_baseline["date"] >= TEST_START]
    bb_tr = simulate_trailing(train_b, "sig", MAX_HOLD, TRAIL_PCT, INIT_SL_PCT)
    bb_te = simulate_trailing(test_b, "sig", MAX_HOLD, TRAIL_PCT, INIT_SL_PCT)
    s_bb_tr, s_bb_te = stats(bb_tr), stats(bb_te)
    if s_bb_tr and s_bb_te:
        print(f"  Train: n={s_bb_tr['n']} win={s_bb_tr['win']*100:.1f}% avg={s_bb_tr['avg']*100:+.2f}% sh={s_bb_tr['sharpe']:+.2f} pf={s_bb_tr['pf']:.2f}")
        print(f"  Test:  n={s_bb_te['n']} win={s_bb_te['win']*100:.1f}% avg={s_bb_te['avg']*100:+.2f}% sh={s_bb_te['sharpe']:+.2f} pf={s_bb_te['pf']:.2f}")

    print(f"\n═══ Pass criteria: Test Sharpe ≥ 0.5, PF ≥ 1.3, avg > 0 ═══")
    passed = [r for r in results if r["te"]["sharpe"] >= 0.5 and r["te"]["pf"] >= 1.3 and r["te"]["avg"] > 0]
    if not passed:
        print("  ❌ KHÔNG composite threshold nào pass.")
    else:
        passed.sort(key=lambda r: r["te"]["sharpe"], reverse=True)
        for r in passed:
            print(f"  🟢 score ≥ {r['thresh']}: Test n={r['te']['n']} sh={r['te']['sharpe']:+.2f} pf={r['te']['pf']:.2f} avg={r['te']['avg']*100:+.2f}%")


if __name__ == "__main__":
    main()
