"""Verify Ichimoku Kinko Hyo signals — có edge ở VN regime 2024-26 không?

3 variants:
  V1. Pure Ichimoku entry:
      - Giá vừa break above Kumo (cloud) trong last 3 bars
      - TK Cross UP (Tenkan cắt lên Kijun) within last 3 bars
      - Mây tương lai xanh (Senkou A > B)

  V2. Ichimoku filter cho Base Breakout:
      - Base Breakout signal (above MA200, range <10% 30d, break, vol>1.5×)
      - + Giá trên Kumo
      - + Mây tương lai xanh

  V3. TK Cross momentum entry:
      - Tenkan vừa cắt lên Kijun (within last 3 bars)
      - + Giá trên MA50 (uptrend filter)

Exit: hold T+30 trading, trailing 10% từ peak, init SL -10%.
Cross-val: Train 2024-2025 / Test 2026.
Pass: Sharpe ≥ 0.5, PF ≥ 1.3, avg ret > 0, n ≥ 20.

Compare với Base Breakout baseline (Sharpe 1.13) — nếu V2 boost ≥0.15 → worth deploy.
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
    c, o, h, l, v = (
        g["close"].values, g["open"].values, g["high"].values,
        g["low"].values, g["volume"].values
    )
    cs = pd.Series(c)
    hs = pd.Series(h)
    ls = pd.Series(l)

    # Ichimoku components
    g["tenkan"] = (hs.rolling(9).max() + ls.rolling(9).min()) / 2
    g["kijun"] = (hs.rolling(26).max() + ls.rolling(26).min()) / 2
    g["senkou_a_now"] = (g["tenkan"] + g["kijun"]) / 2          # Senkou A as of TODAY (forward 26)
    g["senkou_b_now"] = (hs.rolling(52).max() + ls.rolling(52).min()) / 2
    # Cloud at current bar = Senkou A/B computed 26 bars ago
    g["cloud_top_cur"] = pd.concat([g["senkou_a_now"].shift(26), g["senkou_b_now"].shift(26)], axis=1).max(axis=1)
    g["cloud_bot_cur"] = pd.concat([g["senkou_a_now"].shift(26), g["senkou_b_now"].shift(26)], axis=1).min(axis=1)
    g["above_cloud"] = c > g["cloud_top_cur"]
    g["below_cloud"] = c < g["cloud_bot_cur"]
    # Future cloud color
    g["future_kumo_bull"] = g["senkou_a_now"] > g["senkou_b_now"]
    # TK Cross
    g["tk_diff"] = g["tenkan"] - g["kijun"]
    g["tk_cross_up_today"] = (g["tk_diff"] > 0) & (g["tk_diff"].shift(1) <= 0)
    # Within last 3 bars
    g["tk_cross_up_recent"] = (
        g["tk_cross_up_today"] | g["tk_cross_up_today"].shift(1) | g["tk_cross_up_today"].shift(2)
    ).fillna(False)
    # Cloud break-up recent (within last 3 bars)
    g["cloud_break_today"] = g["above_cloud"] & (~g["above_cloud"].shift(1).fillna(False))
    g["cloud_break_recent"] = (
        g["cloud_break_today"] | g["cloud_break_today"].shift(1) | g["cloud_break_today"].shift(2)
    ).fillna(False)

    # MA + vol + RSI + Base Breakout components
    g["ma50"] = cs.rolling(50).mean()
    g["ma200"] = cs.rolling(200).mean()
    g["above_ma50"] = c > g["ma50"]
    g["above_ma200"] = c > g["ma200"]
    g["vol_avg20"] = pd.Series(v).rolling(20).mean()
    g["vol_ratio"] = v / g["vol_avg20"]
    # Base Breakout
    high_30 = hs.rolling(30).max()
    low_30 = ls.rolling(30).min()
    g["base_range_ok"] = ((high_30 - low_30) / low_30).shift(1) < 0.10
    g["break_above"] = c > high_30.shift(1)
    g["sig_base_breakout"] = (
        g["above_ma200"] & g["base_range_ok"] & g["break_above"] & (g["vol_ratio"] > 1.5)
    )

    # Variants signals
    g["sig_v1"] = (
        g["cloud_break_recent"]
        & g["tk_cross_up_recent"]
        & g["future_kumo_bull"]
    ).fillna(False)
    g["sig_v2"] = (
        g["sig_base_breakout"]
        & g["above_cloud"]
        & g["future_kumo_bull"]
    ).fillna(False)
    g["sig_v3"] = (
        g["tk_cross_up_recent"]
        & g["above_ma50"]
    ).fillna(False)
    g["sig_baseline_bb"] = g["sig_base_breakout"]
    return g


def simulate_trailing(df, sig_col, max_hold=MAX_HOLD, trail_pct=TRAIL_PCT,
                     init_sl_pct=INIT_SL_PCT, cost=DEFAULT_COST_RT):
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
    print("Load + enrich Ichimoku features...")
    u = load_universe()
    f = filter_universe(u)
    parts = [enrich(g) for _, g in f.groupby("symbol", sort=False)]
    df = pd.concat(parts, ignore_index=True)
    print(f"  {f.symbol.nunique()} mã, {len(df):,} rows")

    # Signal fire counts
    print("\nSignal fire counts (full period):")
    for sig in ["sig_v1", "sig_v2", "sig_v3", "sig_baseline_bb"]:
        n = df[sig].sum()
        print(f"  {sig}: {n} fires")

    train = df[(df["date"] >= TRAIN_START) & (df["date"] <= TRAIN_END)].copy()
    test = df[df["date"] >= TEST_START].copy()
    print(f"\nTrain {len(train):,}, Test {len(test):,}\n")

    variants = [
        ("BASELINE Base Breakout (no Ichimoku)", "sig_baseline_bb"),
        ("V1. Pure Ichimoku (cloud break + TK cross + future bull)", "sig_v1"),
        ("V2. Base Breakout + Ichimoku filter", "sig_v2"),
        ("V3. TK Cross + above MA50", "sig_v3"),
    ]

    print(f"═══ Ichimoku Variants — Train 2024-25 vs Test 2026 ═══")
    print(f"  {'Variant':<60} | {'TRAIN n  win   avg     sh   pf':<35} | {'TEST n  win   avg     sh   pf':<35}")
    print(f"  {'-'*60}-+-{'-'*35}-+-{'-'*35}")
    results = []
    for label, sig in variants:
        t_tr = simulate_trailing(train, sig)
        t_te = simulate_trailing(test, sig)
        s_tr, s_te = stats(t_tr), stats(t_te)
        if s_tr is None or s_te is None:
            tr_str = "(n<10)" if s_tr is None else f"{s_tr['n']:4d} {s_tr['win']*100:5.1f}% {s_tr['avg']*100:+5.2f}% {s_tr['sharpe']:+.2f} {s_tr['pf']:.2f}"
            te_str = "(n<10)" if s_te is None else f"{s_te['n']:4d} {s_te['win']*100:5.1f}% {s_te['avg']*100:+5.2f}% {s_te['sharpe']:+.2f} {s_te['pf']:.2f}"
            print(f"  {label:<60} | {tr_str:<35} | {te_str:<35}")
            continue
        tr_str = f"{s_tr['n']:4d} {s_tr['win']*100:5.1f}% {s_tr['avg']*100:+5.2f}% {s_tr['sharpe']:+.2f} {s_tr['pf']:.2f}"
        te_str = f"{s_te['n']:4d} {s_te['win']*100:5.1f}% {s_te['avg']*100:+5.2f}% {s_te['sharpe']:+.2f} {s_te['pf']:.2f}"
        marker = ""
        if s_te["sharpe"] >= 0.5 and s_te["pf"] >= 1.3 and s_te["avg"] > 0:
            marker = "🟢"
        elif s_te["avg"] > 0:
            marker = "🟡"
        print(f"  {marker} {label:<58} | {tr_str:<35} | {te_str:<35}")
        results.append({"label": label, "sig": sig, "tr": s_tr, "te": s_te})

    print(f"\n═══ Pass criteria: Test Sharpe ≥ 0.5, PF ≥ 1.3, avg > 0, n ≥ 20 ═══")
    passed = [r for r in results if r["te"]["sharpe"] >= 0.5 and r["te"]["pf"] >= 1.3
              and r["te"]["avg"] > 0 and r["te"]["n"] >= 20]
    baseline = next((r for r in results if "BASELINE" in r["label"]), None)

    if not passed:
        print("  ❌ KHÔNG variant nào pass.")
    else:
        passed.sort(key=lambda r: r["te"]["sharpe"], reverse=True)
        for r in passed:
            improve = ""
            if baseline and "BASELINE" not in r["label"]:
                delta = r["te"]["sharpe"] - baseline["te"]["sharpe"]
                improve = f" ({'+' if delta >= 0 else ''}{delta:.2f} vs baseline)"
            print(f"  🟢 {r['label']}: Test Sharpe {r['te']['sharpe']:+.2f}{improve}")

    if baseline:
        print(f"\n  Baseline Base Breakout: Test Sharpe {baseline['te']['sharpe']:+.2f}")
        print(f"\n  → Decision rule:")
        print(f"     · V2 boost ≥ +0.15 Sharpe → worth deploy Ichimoku filter")
        print(f"     · V2 boost < +0.10 → marginal, không worth complexity")
        print(f"     · V2 worse → KHÔNG deploy, giữ baseline")


if __name__ == "__main__":
    main()
