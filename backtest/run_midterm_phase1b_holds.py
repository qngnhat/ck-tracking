"""Phase 1b: Extended hold/trail grid cho Pattern A (Base Breakout) — winner Phase 1.

Find sweet spot:
- holds = 30, 40, 50, 60, 70
- trails = 10%, 12%, 15%, 18%, 20%
- init SL = 10% fixed

Cross-val Train 2022-2024 / Test 2025-2026.
Output: ranked table + winning combinations.
"""

from __future__ import annotations
import numpy as np
import pandas as pd
from src.backtest import DEFAULT_COST_RT
from src.load_data import load_universe

TRAIN_START, TRAIN_END, TEST_START = "2022-01-01", "2024-12-31", "2025-01-01"
TURNOVER_MIN_BN = 5.0
INIT_SL_PCT = 0.10
HOLDS = [30, 40, 50, 60, 70]
TRAILS = [0.10, 0.12, 0.15, 0.18, 0.20]


def filter_universe(u):
    recent = u[u.date >= "2024-01-01"].copy()
    recent["turnover"] = recent["close"] * recent["volume"] * 1000
    liq = recent.groupby("symbol")["turnover"].median() / 1e9
    return u[u.symbol.isin(liq[liq >= TURNOVER_MIN_BN].index)].copy()


def enrich(group):
    g = group.copy().reset_index(drop=True)
    c, h, l, v = g["close"].values, g["high"].values, g["low"].values, g["volume"].values
    cs = pd.Series(c)
    g["ma200"] = cs.rolling(200).mean()
    g["above_ma200"] = c > g["ma200"]
    g["vol_avg20"] = pd.Series(v).rolling(20).mean()
    g["vol_ratio"] = v / g["vol_avg20"]

    # Base Breakout: 30d range <10%, today break high prev 30d, vol>1.5×
    high_30 = pd.Series(h).rolling(30).max()
    low_30 = pd.Series(l).rolling(30).min()
    range_30 = (high_30 - low_30) / low_30
    prev_high_30 = high_30.shift(1)
    g["base_range_ok"] = range_30.shift(1) < 0.10
    g["break_above"] = c > prev_high_30
    g["sig"] = (g["above_ma200"] & g["base_range_ok"] & g["break_above"]
               & (g["vol_ratio"] > 1.5))
    return g


def simulate_trailing(df, max_hold, trail_pct, init_sl_pct, cost=DEFAULT_COST_RT):
    df = df.sort_values(["symbol", "date"])
    trades = []
    for sym, group in df.groupby("symbol", sort=False):
        g = group.reset_index(drop=True)
        sig = g["sig"].values
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
                    ex, eh = dc, h_step
                    break
                if h_step == max_hold:
                    ex, eh = dc, h_step
            if ex is None:
                continue
            trades.append({"exit_day": eh, "net_ret": (ex - ep) / ep - cost})
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
    print("Load + enrich Base Breakout signals...")
    u = load_universe()
    f = filter_universe(u)
    parts = [enrich(g) for _, g in f.groupby("symbol", sort=False)]
    df = pd.concat(parts, ignore_index=True)
    print(f"  Universe {f.symbol.nunique()} mã, {len(df):,} rows, {df['sig'].sum()} signal fires")

    train = df[(df["date"] >= TRAIN_START) & (df["date"] <= TRAIN_END)].copy()
    test = df[df["date"] >= TEST_START].copy()
    print(f"  Train {len(train):,}, Test {len(test):,}\n")

    print("═══ Pattern A (Base Breakout) — Extended hold/trail grid ═══")
    print(f"  {'hold':>5} {'trail':>5} | {'TRAIN n  win   avg     sh   pf':<37} | {'TEST n  win   avg     sh   pf':<37}")
    print(f"  {'-'*5} {'-'*5}-+-{'-'*37}-+-{'-'*37}")
    results = []
    for max_hold in HOLDS:
        for trail in TRAILS:
            t_tr = simulate_trailing(train, max_hold, trail, INIT_SL_PCT)
            t_te = simulate_trailing(test, max_hold, trail, INIT_SL_PCT)
            s_tr, s_te = stats(t_tr), stats(t_te)
            if s_tr is None or s_te is None:
                continue
            tr_str = f"{s_tr['n']:4d} {s_tr['win']*100:5.1f}% {s_tr['avg']*100:+6.2f}% {s_tr['sharpe']:+.2f} {s_tr['pf']:.2f}"
            te_str = f"{s_te['n']:4d} {s_te['win']*100:5.1f}% {s_te['avg']*100:+6.2f}% {s_te['sharpe']:+.2f} {s_te['pf']:.2f}"
            marker = ""
            if s_te["sharpe"] >= 1.0 and s_te["pf"] >= 2.5 and s_te["avg"] > 0:
                marker = "🟢🟢"  # excellent
            elif s_te["sharpe"] >= 0.7 and s_te["pf"] >= 2.0 and s_te["avg"] > 0:
                marker = "🟢"   # strong
            elif s_te["sharpe"] >= 0.5 and s_te["pf"] >= 1.5 and s_te["avg"] > 0:
                marker = "🟡"
            print(f"  {marker} h{max_hold:<3} t{int(trail*100):<3}% | {tr_str:<37} | {te_str:<37}")
            results.append({
                "hold": max_hold, "trail": trail,
                "tr": s_tr, "te": s_te,
            })

    print("\n═══ Ranking by Test Sharpe (top 10) ═══")
    results.sort(key=lambda r: r["te"]["sharpe"], reverse=True)
    for i, r in enumerate(results[:10], 1):
        print(f"  #{i:2d} h{r['hold']} t{int(r['trail']*100)}% sl{int(INIT_SL_PCT*100)}%: "
              f"Test n={r['te']['n']} win={r['te']['win']*100:.1f}% "
              f"avg={r['te']['avg']*100:+.2f}% sh={r['te']['sharpe']:+.2f} pf={r['te']['pf']:.2f} "
              f"hold={r['te']['avg_h']:.0f}d")

    print("\n═══ Sweet spot analysis ═══")
    if results:
        # Group by hold
        from collections import defaultdict
        by_hold = defaultdict(list)
        for r in results:
            by_hold[r["hold"]].append(r["te"]["sharpe"])
        print(f"  Test Sharpe trung bình theo hold:")
        for h_max in sorted(by_hold):
            avg_sh = np.mean(by_hold[h_max])
            max_sh = max(by_hold[h_max])
            print(f"    h={h_max}: avg Sharpe {avg_sh:+.2f}, max Sharpe {max_sh:+.2f}")

        # Group by trail
        by_trail = defaultdict(list)
        for r in results:
            by_trail[r["trail"]].append(r["te"]["sharpe"])
        print(f"  Test Sharpe trung bình theo trail:")
        for trail in sorted(by_trail):
            avg_sh = np.mean(by_trail[trail])
            max_sh = max(by_trail[trail])
            print(f"    trail={int(trail*100)}%: avg Sharpe {avg_sh:+.2f}, max Sharpe {max_sh:+.2f}")


if __name__ == "__main__":
    main()
