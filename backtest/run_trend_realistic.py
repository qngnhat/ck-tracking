"""Trend (HH/HL) với realistic trailing-stop exit + cross-val post-covid.

Câu hỏi: Trend tier deploy trong production có edge realistic ở regime
2025-26 không? (Khác Climax — Climax đã verified KHÔNG edge.)

Logic giống production detectTrendTier (ranking.js:428):
- 3 HH + 3 HL (high higher each day, low higher each day)
- Day green (close > open)
- Close > MA50, MA20 > MA50 (uptrend confirm)
- volRatio ≥ 1.2

Exit: trailing stop từ peak (giống production planTrailPct=6, init SL=-6%).
Backtest test maxHold = 10 (per production planMaxHold=10).

Cross-val Train 2022-2024 (post-covid) / Test 2025-2026.
Pass: Test Sharpe ≥ 0.3, PF ≥ 1.2, avg ret > 0.
"""

from __future__ import annotations
import numpy as np
import pandas as pd
from src.backtest import DEFAULT_COST_RT
from src.load_data import load_universe

TRAIN_START, TRAIN_END, TEST_START = "2022-01-01", "2024-12-31", "2025-01-01"
TURNOVER_MIN_BN = 3.0


def filter_largemid(u):
    recent = u[u.date >= "2024-01-01"].copy()
    recent["turnover"] = recent["close"] * recent["volume"] * 1000
    liq = recent.groupby("symbol")["turnover"].median() / 1e9
    return u[u.symbol.isin(liq[liq >= TURNOVER_MIN_BN].index)].copy()


def enrich(group):
    g = group.copy().reset_index(drop=True)
    c, o, h, l, v = g["close"].values, g["open"].values, g["high"].values, g["low"].values, g["volume"].values
    cs = pd.Series(c)
    g["ma20"] = cs.rolling(20).mean()
    g["ma50"] = cs.rolling(50).mean()
    g["vol_avg20"] = pd.Series(v).rolling(20).mean()
    g["vol_ratio"] = v / g["vol_avg20"]
    g["day_green"] = c > o
    hs, ls = pd.Series(h), pd.Series(l)
    g["hh_3"] = (hs > hs.shift(1)) & (hs.shift(1) > hs.shift(2)) & (hs.shift(2) > hs.shift(3))
    g["hl_3"] = (ls > ls.shift(1)) & (ls.shift(1) > ls.shift(2)) & (ls.shift(2) > ls.shift(3))
    # Dedup: first day of HH/HL streak only
    g["yh_3"] = (hs.shift(1) > hs.shift(2)) & (hs.shift(2) > hs.shift(3)) & (hs.shift(3) > hs.shift(4))
    g["yl_3"] = (ls.shift(1) > ls.shift(2)) & (ls.shift(2) > ls.shift(3)) & (ls.shift(3) > ls.shift(4))
    g["first_day"] = ~(g["yh_3"] & g["yl_3"])
    g["uptrend"] = (g["ma20"] > g["ma50"]) & (cs > g["ma50"])
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
            for h in range(1, max_hold + 1):
                di = i + 1 + h
                if di >= len(g):
                    break
                dc = closes[di]
                if pd.isna(dc):
                    continue
                dh = highs[di]
                if not pd.isna(dh) and dh > peak:
                    peak = dh
                trail = peak * (1 - trail_pct)
                eff = max(init_sl, trail)
                if dc <= eff:
                    ex, eh = dc, h
                    break
                if h == max_hold:
                    ex, eh = dc, h
            if ex is None:
                continue
            trades.append({"date": g.iloc[i]["date"], "exit_day": eh,
                          "net_ret": (ex - ep) / ep - cost})
    return pd.DataFrame(trades)


def stats(t):
    if len(t) < 20:
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
    print("Load + enrich...")
    u = load_universe()
    f = filter_largemid(u)
    parts = [enrich(g) for _, g in f.groupby("symbol", sort=False)]
    df = pd.concat(parts, ignore_index=True)
    print(f"  {len(df):,} rows, {f.symbol.nunique()} mã")

    # Signal variants
    df["sig_strict"] = df["hh_3"] & df["hl_3"] & df["day_green"] & df["uptrend"] & df["first_day"] & (df["vol_ratio"] > 1.2)
    df["sig_no_first"] = df["hh_3"] & df["hl_3"] & df["day_green"] & df["uptrend"] & (df["vol_ratio"] > 1.2)
    df["sig_no_vol"] = df["hh_3"] & df["hl_3"] & df["day_green"] & df["uptrend"] & df["first_day"]

    train = df[(df["date"] >= TRAIN_START) & (df["date"] <= TRAIN_END)].copy()
    test = df[df["date"] >= TEST_START].copy()
    print(f"  Train {len(train):,}, Test {len(test):,}\n")

    # Variants: signal × (max_hold, trail_pct, init_sl_pct)
    variants = [
        ("PROD: strict, h=10 trail=6% sl=6%", "sig_strict", 10, 0.06, 0.06),
        ("PROD: strict, h=10 trail=7% sl=7%", "sig_strict", 10, 0.07, 0.07),
        ("strict, h=15 trail=8% sl=8%",       "sig_strict", 15, 0.08, 0.08),
        ("strict, h=20 trail=10% sl=8%",      "sig_strict", 20, 0.10, 0.08),
        ("no_first, h=10 trail=6%",           "sig_no_first", 10, 0.06, 0.06),
        ("no_vol, h=10 trail=6%",             "sig_no_vol", 10, 0.06, 0.06),
    ]

    print("═══ Trend (HH/HL) — Train 2022-24 vs Test 2025-26 ═══")
    print(f"  {'Variant':<40} | {'TRAIN n  win   avg    sh   pf':<35} | {'TEST n  win   avg    sh   pf':<35}")
    print(f"  {'-'*40}-+-{'-'*35}-+-{'-'*35}")
    for label, col, mh, trail, sl in variants:
        t_tr = simulate_trailing(train, col, mh, trail, sl)
        t_te = simulate_trailing(test, col, mh, trail, sl)
        s_tr = stats(t_tr); s_te = stats(t_te)
        tr_str = f"{s_tr['n']:4d} {s_tr['win']*100:5.1f}% {s_tr['avg']*100:+5.2f}% {s_tr['sharpe']:+.2f} {s_tr['pf']:.2f}" if s_tr else "  (n<20)"
        te_str = f"{s_te['n']:4d} {s_te['win']*100:5.1f}% {s_te['avg']*100:+5.2f}% {s_te['sharpe']:+.2f} {s_te['pf']:.2f}" if s_te else "  (n<20)"
        marker = ""
        if s_te and s_te["sharpe"] >= 0.3 and s_te["avg"] > 0 and s_te["pf"] >= 1.2:
            marker = "🟢"
        elif s_te and s_te["avg"] > 0:
            marker = "🟡"
        print(f"  {marker} {label:<38} | {tr_str:<35} | {te_str:<35}")

    print("\n═══ Pass criteria: Test Sharpe ≥ 0.3, PF ≥ 1.2, avg > 0 ═══")
    has_pass = False
    for label, col, mh, trail, sl in variants:
        t_te = simulate_trailing(test, col, mh, trail, sl)
        s_te = stats(t_te)
        if s_te and s_te["sharpe"] >= 0.3 and s_te["avg"] > 0 and s_te["pf"] >= 1.2:
            has_pass = True
            print(f"  🟢 {label}: Test n={s_te['n']} win={s_te['win']*100:.1f}% "
                  f"avg={s_te['avg']*100:+.2f}% sh={s_te['sharpe']:+.2f} pf={s_te['pf']:.2f}")
    if not has_pass:
        print("  ❌ KHÔNG variant nào pass Trend tier realistic ở regime 2025-26.")


if __name__ == "__main__":
    main()
