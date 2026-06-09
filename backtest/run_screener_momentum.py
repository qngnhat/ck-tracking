"""Screener backtest: top performer N-day → hold M-day.

Strategy variants (idea từ user):
  V1. Momentum 10d : Top 10 mã ret 10d cao nhất → hold 10d
  V2. Momentum 20d : Top 10 mã ret 20d cao nhất → hold 20d
  V3. Momentum 30d : Top 10 mã ret 30d cao nhất → hold 30d
  V4. Mean-reversion 30d : Top 10 mã ret 30d THẤP nhất → hold 30d (bounce)

Plus variants với top_n = 5, 15, 20.

Cross-val Train 2024-2025 (24 tháng) / Test 2026 (~5 tháng out-of-sample).
Pass: Test Sharpe ≥ 0.5, PF ≥ 1.3, avg ret > 0.
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


def enrich_ret(df, window):
    """Add column ret_Nd = close pct_change N days, per-symbol."""
    df = df.sort_values(["symbol", "date"]).copy()
    df[f"ret_{window}d"] = df.groupby("symbol")["close"].pct_change(window) * 100
    return df


def build_signal_top_n(df, ret_col, top_n=10, mode="momentum"):
    """For each date, rank symbols by ret_col. Mark sig=True if in top N.
    mode='momentum': top N highest. mode='mean_reversion': bottom N lowest."""
    df = df.copy()
    ascending = (mode == "mean_reversion")
    df["rank"] = df.groupby("date")[ret_col].rank(ascending=ascending, method="dense")
    df["sig"] = df["rank"] <= top_n
    # Drop rows without past return (early period)
    df.loc[df[ret_col].isna(), "sig"] = False
    return df


def simulate_fixed_hold(df, sig_col, hold, cost=DEFAULT_COST_RT):
    """Entry open T+1, exit close T+1+hold."""
    df = df.sort_values(["symbol", "date"]).reset_index(drop=True)
    grp = df.groupby("symbol", sort=False)
    entry = grp["open"].shift(-1)
    exit_ = grp["close"].shift(-(1 + hold))
    ret = (exit_ - entry) / entry - cost
    mask = df[sig_col] & entry.notna() & exit_.notna() & (entry > 0)
    return pd.DataFrame({
        "date": df.loc[mask, "date"].values,
        "symbol": df.loc[mask, "symbol"].values,
        "net_ret": ret.loc[mask].values,
    })


def stats(t, hold):
    if len(t) < 10:
        return None
    win = (t["net_ret"] > 0).mean()
    avg = t["net_ret"].mean()
    std = t["net_ret"].std()
    sh = (avg / std * (252 / hold) ** 0.5) if std > 0 else 0
    pos = t.loc[t["net_ret"] > 0, "net_ret"].sum()
    neg = abs(t.loc[t["net_ret"] < 0, "net_ret"].sum())
    pf = pos / neg if neg > 0 else float("inf")
    return {"n": len(t), "win": win, "avg": avg, "sharpe": sh, "pf": pf}


def main():
    print("Load + filter universe (turnover ≥ 5B)...")
    u = load_universe()
    f = filter_universe(u)
    print(f"  {f.symbol.nunique()} mã, {len(f):,} rows")

    train = f[(f["date"] >= TRAIN_START) & (f["date"] <= TRAIN_END)].copy()
    test = f[f["date"] >= TEST_START].copy()
    print(f"  Train {len(train):,} ({train['date'].min().date()} → {train['date'].max().date()})")
    print(f"  Test  {len(test):,} ({test['date'].min().date()} → {test['date'].max().date()})")

    # Variants: (label, ret_window, hold, top_n, mode)
    variants = [
        # Momentum top performers
        ("Momentum  ret10d top10  hold10", 10, 10, 10, "momentum"),
        ("Momentum  ret20d top10  hold20", 20, 20, 10, "momentum"),
        ("Momentum  ret30d top10  hold30", 30, 30, 10, "momentum"),
        ("Momentum  ret40d top10  hold40", 40, 40, 10, "momentum"),
        # Different top_n
        ("Momentum  ret30d top5   hold30", 30, 30, 5, "momentum"),
        ("Momentum  ret30d top15  hold30", 30, 30, 15, "momentum"),
        ("Momentum  ret30d top20  hold30", 30, 30, 20, "momentum"),
        # Mean-reversion (bottom performers)
        ("MeanRev   ret10d bot10  hold10", 10, 10, 10, "mean_reversion"),
        ("MeanRev   ret20d bot10  hold20", 20, 20, 10, "mean_reversion"),
        ("MeanRev   ret30d bot10  hold30", 30, 30, 10, "mean_reversion"),
        ("MeanRev   ret30d bot5   hold30", 30, 30,  5, "mean_reversion"),
    ]

    print(f"\n═══ Screener strategies — Train 2024-25 vs Test 2026 ═══")
    print(f"  {'Variant':<35} | {'TRAIN n  win   avg     sh   pf':<35} | {'TEST n  win   avg     sh   pf':<35}")
    print(f"  {'-'*35}-+-{'-'*35}-+-{'-'*35}")

    results = []
    for label, ret_window, hold, top_n, mode in variants:
        # Need to enrich + build signal on FULL df (so ranking has access to history)
        df_full = enrich_ret(f, ret_window)
        df_full = build_signal_top_n(df_full, f"ret_{ret_window}d", top_n=top_n, mode=mode)

        # Filter to splits
        df_train = df_full[(df_full["date"] >= TRAIN_START) & (df_full["date"] <= TRAIN_END)].copy()
        df_test = df_full[df_full["date"] >= TEST_START].copy()

        t_tr = simulate_fixed_hold(df_train, "sig", hold)
        t_te = simulate_fixed_hold(df_test, "sig", hold)
        s_tr, s_te = stats(t_tr, hold), stats(t_te, hold)
        if s_tr is None or s_te is None:
            print(f"  {label:<35} | (insufficient sample)")
            continue
        tr_str = f"{s_tr['n']:4d} {s_tr['win']*100:5.1f}% {s_tr['avg']*100:+5.2f}% {s_tr['sharpe']:+.2f} {s_tr['pf']:.2f}"
        te_str = f"{s_te['n']:4d} {s_te['win']*100:5.1f}% {s_te['avg']*100:+5.2f}% {s_te['sharpe']:+.2f} {s_te['pf']:.2f}"
        marker = ""
        if s_te["sharpe"] >= 0.5 and s_te["pf"] >= 1.3 and s_te["avg"] > 0:
            marker = "🟢"
        elif s_te["sharpe"] >= 0.3 and s_te["avg"] > 0:
            marker = "🟡"
        print(f"  {marker} {label:<33} | {tr_str:<35} | {te_str:<35}")
        results.append({"label": label, "tr": s_tr, "te": s_te, "ret_window": ret_window,
                       "hold": hold, "top_n": top_n, "mode": mode})

    print("\n═══ Pass criteria: Test Sharpe ≥ 0.5, PF ≥ 1.3, avg > 0 ═══")
    passed = [r for r in results if r["te"]["sharpe"] >= 0.5 and r["te"]["pf"] >= 1.3 and r["te"]["avg"] > 0]
    if not passed:
        print("  ❌ KHÔNG variant nào pass — screener (momentum / mean-rev) không có edge ở regime 2026.")
        results.sort(key=lambda r: r["te"]["sharpe"], reverse=True)
        print("\n  Top 3 Test Sharpe (inspect):")
        for r in results[:3]:
            print(f"    {r['label']}: Test n={r['te']['n']} win={r['te']['win']*100:.1f}% avg={r['te']['avg']*100:+.2f}% sh={r['te']['sharpe']:+.2f}")
    else:
        passed.sort(key=lambda r: r["te"]["sharpe"], reverse=True)
        print(f"  ✅ {len(passed)} variants pass:")
        for r in passed:
            print(f"    🟢 {r['label']}: Test n={r['te']['n']} win={r['te']['win']*100:.1f}% avg={r['te']['avg']*100:+.2f}% sh={r['te']['sharpe']:+.2f} pf={r['te']['pf']:.2f}")


if __name__ == "__main__":
    main()
