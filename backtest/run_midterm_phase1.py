"""Phase 1: Verify 4 mid-term patterns với realistic trailing exit + grid search hold.

Patterns:
  A. Base Breakout      — tích lũy ≥30 phiên (range <10%) + break + vol confirm
  B. Relative Strength  — outperform VNI 60d ≥+10% + uptrend confirm
  C. 52w Pullback       — gần 52w high + pullback nhỏ + bounce
  D. Trend Extend       — HH/HL + uptrend (giống production, extend hold dài hơn)

Grid: hold ∈ {20, 30, 40, 60}, trail ∈ {10%, 12%, 15%}, initSL = 10% (fixed)
Universe filter: above 200MA + median turnover 60d ≥ 5 tỷ

Cross-val Train 2022-2024 / Test 2025-2026 (post-covid).
Pass: Test Sharpe ≥ 0.5, PF ≥ 1.3, avg ret > 0, n_test ≥ 30.
"""

from __future__ import annotations
import numpy as np
import pandas as pd
from src.backtest import DEFAULT_COST_RT
from src.load_data import load_universe, load_vnindex

TRAIN_START, TRAIN_END, TEST_START = "2022-01-01", "2024-12-31", "2025-01-01"
TURNOVER_MIN_BN = 5.0  # cao hơn T+ swing (3 tỷ) vì hold lâu cần exit dễ
INIT_SL_PCT = 0.10
HOLDS = [20, 30, 40, 60]
TRAILS = [0.10, 0.12, 0.15]


def filter_universe(u):
    """Above 200MA at scan date + median turnover 60d ≥ 5 tỷ."""
    recent = u[u.date >= "2024-01-01"].copy()
    recent["turnover"] = recent["close"] * recent["volume"] * 1000
    liq = recent.groupby("symbol")["turnover"].median() / 1e9
    return u[u.symbol.isin(liq[liq >= TURNOVER_MIN_BN].index)].copy()


def enrich(group):
    g = group.copy().reset_index(drop=True)
    c, o, h, l, v = (g["close"].values, g["open"].values, g["high"].values,
                    g["low"].values, g["volume"].values)
    cs = pd.Series(c)
    g["ma20"] = cs.rolling(20).mean()
    g["ma50"] = cs.rolling(50).mean()
    g["ma200"] = cs.rolling(200).mean()
    g["above_ma200"] = c > g["ma200"]
    g["vol_avg20"] = pd.Series(v).rolling(20).mean()
    g["vol_ratio"] = v / g["vol_avg20"]
    g["day_green"] = c > o

    # A. Base Breakout: tích lũy 30 phiên (range <10%) + today break high prev 30d
    high_30 = pd.Series(h).rolling(30).max()
    low_30 = pd.Series(l).rolling(30).min()
    range_30 = (high_30 - low_30) / low_30
    prev_high_30 = high_30.shift(1)  # high of previous 30 days (exclude today)
    g["base_range_ok"] = range_30.shift(1) < 0.10
    g["break_above"] = c > prev_high_30

    # B. Relative Strength — needs VNI to compare
    g["ret_60d_stock"] = cs.pct_change(60) * 100

    # C. 52w Pullback
    high_252 = pd.Series(h).rolling(252).max()
    g["near_52w_high"] = (c / high_252) >= 0.93  # within 7% of 52w high
    # pullback recent 5-10%: từ max(high) trong 10 phiên gần nhất, drop xuống 5-10%
    high_10 = pd.Series(h).rolling(10).max()
    pullback_pct = (c - high_10) / high_10 * 100  # negative = pulled back
    g["pullback_5_10"] = (pullback_pct < -3) & (pullback_pct > -12)
    g["bounce"] = c > cs.shift(1)  # close > yesterday close

    # D. Trend Extend (HH/HL)
    hs, ls = pd.Series(h), pd.Series(l)
    g["hh_3"] = (hs > hs.shift(1)) & (hs.shift(1) > hs.shift(2)) & (hs.shift(2) > hs.shift(3))
    g["hl_3"] = (ls > ls.shift(1)) & (ls.shift(1) > ls.shift(2)) & (ls.shift(2) > ls.shift(3))
    g["yh_3"] = (hs.shift(1) > hs.shift(2)) & (hs.shift(2) > hs.shift(3)) & (hs.shift(3) > hs.shift(4))
    g["yl_3"] = (ls.shift(1) > ls.shift(2)) & (ls.shift(2) > ls.shift(3)) & (ls.shift(3) > ls.shift(4))
    g["trend_first_day"] = ~(g["yh_3"] & g["yl_3"])
    g["uptrend_strong"] = (g["ma20"] > g["ma50"]) & (cs > g["ma50"])
    return g


def add_vni_signal(df, vni):
    """Add VNI 60d return to df for Relative Strength comparison."""
    vni = vni.sort_values("date").reset_index(drop=True).copy()
    vni["vni_close"] = vni["close"]
    vni["vni_ret_60d"] = vni["vni_close"].pct_change(60) * 100
    return df.merge(vni[["date", "vni_close", "vni_ret_60d"]], on="date", how="left")


def build_signals(df):
    """Return df with 4 signal columns added."""
    # Universe filter (above 200MA)
    base = df["above_ma200"]

    # A. Base Breakout
    df["sig_A"] = base & df["base_range_ok"] & df["break_above"] & (df["vol_ratio"] > 1.5)

    # B. Relative Strength: stock outperform VNI 60d by ≥10pp
    df["rs_diff"] = df["ret_60d_stock"] - df["vni_ret_60d"]
    df["sig_B"] = base & (df["rs_diff"] >= 10) & (df["ma20"] > df["ma50"])

    # C. 52w Pullback
    df["sig_C"] = base & df["near_52w_high"] & df["pullback_5_10"] & df["bounce"]

    # D. Trend Extend (HH/HL with uptrend confirm)
    df["sig_D"] = (base & df["hh_3"] & df["hl_3"] & df["day_green"] &
                  df["uptrend_strong"] & df["trend_first_day"] &
                  (df["vol_ratio"] > 1.2))
    return df


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
                    ex, eh = dc, h_step
                    break
                if h_step == max_hold:
                    ex, eh = dc, h_step
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
    vni = load_vnindex()
    f = filter_universe(u)
    print(f"  Universe filter (turnover ≥ {TURNOVER_MIN_BN}B): {f.symbol.nunique()} mã")
    parts = [enrich(g) for _, g in f.groupby("symbol", sort=False)]
    df = pd.concat(parts, ignore_index=True)
    df = add_vni_signal(df, vni)
    df = build_signals(df)
    print(f"  {len(df):,} rows")

    # Per-pattern signal count
    print("\nSignal count per pattern (full period):")
    for sig in ["sig_A", "sig_B", "sig_C", "sig_D"]:
        n = df[sig].sum()
        print(f"  {sig}: {n} fires")

    train = df[(df["date"] >= TRAIN_START) & (df["date"] <= TRAIN_END)].copy()
    test = df[df["date"] >= TEST_START].copy()
    print(f"\n  Train {len(train):,} rows, Test {len(test):,} rows")

    pattern_names = {
        "sig_A": "A. Base Breakout",
        "sig_B": "B. Relative Strength",
        "sig_C": "C. 52w Pullback",
        "sig_D": "D. Trend Extend (HH/HL)",
    }

    all_results = []
    for sig_col, label in pattern_names.items():
        print(f"\n═══ {label} ═══")
        print(f"  {'h_max':>5} {'trail':>5} | {'TRAIN n  win   avg    sh   pf':<35} | {'TEST n  win   avg    sh   pf':<35}")
        print(f"  {'-'*5} {'-'*5}-+-{'-'*35}-+-{'-'*35}")
        for h_max in HOLDS:
            for trail in TRAILS:
                t_tr = simulate_trailing(train, sig_col, h_max, trail, INIT_SL_PCT)
                t_te = simulate_trailing(test, sig_col, h_max, trail, INIT_SL_PCT)
                s_tr, s_te = stats(t_tr), stats(t_te)
                if s_tr is None or s_te is None:
                    continue
                tr_str = f"{s_tr['n']:4d} {s_tr['win']*100:5.1f}% {s_tr['avg']*100:+5.2f}% {s_tr['sharpe']:+.2f} {s_tr['pf']:.2f}"
                te_str = f"{s_te['n']:4d} {s_te['win']*100:5.1f}% {s_te['avg']*100:+5.2f}% {s_te['sharpe']:+.2f} {s_te['pf']:.2f}"
                marker = ""
                if (s_te["sharpe"] >= 0.5 and s_te["pf"] >= 1.3 and s_te["avg"] > 0
                    and s_te["n"] >= 30):
                    marker = "🟢"
                elif s_te["sharpe"] >= 0.3 and s_te["avg"] > 0:
                    marker = "🟡"
                print(f"  {marker} h{h_max:<3} t{int(trail*100):<3}% | {tr_str:<35} | {te_str:<35}")
                all_results.append({
                    "pattern": label, "sig_col": sig_col,
                    "h_max": h_max, "trail": trail,
                    "tr": s_tr, "te": s_te,
                })

    # Final ranking
    print("\n═══ Variants PASS (Test Sharpe≥0.5, PF≥1.3, avg>0, n≥30) ═══")
    passed = [r for r in all_results
              if r["te"]["sharpe"] >= 0.5 and r["te"]["pf"] >= 1.3
              and r["te"]["avg"] > 0 and r["te"]["n"] >= 30]
    if not passed:
        print("  ❌ KHÔNG variant nào pass — mid-term patterns không edge ở regime 2025-26.")
        # Top 5 by Test Sharpe để inspect
        all_results.sort(key=lambda r: r["te"]["sharpe"], reverse=True)
        print("\n  Top 5 by Test Sharpe (inspect):")
        for r in all_results[:5]:
            print(f"    {r['pattern']} h{r['h_max']} t{int(r['trail']*100)}%: "
                  f"Test n={r['te']['n']} win={r['te']['win']*100:.1f}% "
                  f"avg={r['te']['avg']*100:+.2f}% sh={r['te']['sharpe']:+.2f} pf={r['te']['pf']:.2f}")
        return

    passed.sort(key=lambda r: r["te"]["sharpe"], reverse=True)
    print(f"  ✅ {len(passed)} variants pass — ranked by Test Sharpe:")
    for r in passed:
        print(f"  🟢 {r['pattern']} h{r['h_max']} t{int(r['trail']*100)}% sl{int(INIT_SL_PCT*100)}%: "
              f"Test n={r['te']['n']} win={r['te']['win']*100:.1f}% "
              f"avg={r['te']['avg']*100:+.2f}% sh={r['te']['sharpe']:+.2f} pf={r['te']['pf']:.2f} "
              f"avg_hold={r['te']['avg_h']:.0f}d")


if __name__ == "__main__":
    main()
