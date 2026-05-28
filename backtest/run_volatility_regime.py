"""Idea 1: Volatility Regime Switcher.

Hypothesis: pattern detection edge thay đổi theo VNI volatility regime.
- Low vol  + uptrend = "stable trend" → Base Breakout work tốt nhất
- High vol + downtrend = "panic/correction" → Climax mean-reversion work
- Khác = caution / no edge

Test 4 regimes × 2 patterns:
- VNI vol 20d (realized): low / high split at median
- VNI trend: above MA50 (uptrend) vs below (downtrend)
- 4 regimes: low_up / low_down / high_up / high_down

Per regime, measure:
- Base Breakout Sharpe (using detect logic + trailing 10%)
- Climax Tier B Sharpe (drop >5%, vol >2×, rsi <50, day green, hold T+5 target/SL)

Cross-val: Train 2024-2025, Test 2026.
"""

from __future__ import annotations
import numpy as np
import pandas as pd
from src.backtest import DEFAULT_COST_RT
from src.load_data import load_universe, load_vnindex

TRAIN_START, TRAIN_END, TEST_START = "2024-01-01", "2025-12-31", "2026-01-01"
TURNOVER_MIN_BN = 5.0
VOL_LOOKBACK = 20


def filter_universe(u):
    recent = u[u.date >= "2024-01-01"].copy()
    recent["turnover"] = recent["close"] * recent["volume"] * 1000
    liq = recent.groupby("symbol")["turnover"].median() / 1e9
    return u[u.symbol.isin(liq[liq >= TURNOVER_MIN_BN].index)].copy()


def compute_vni_regime(vni):
    """Tag each date with regime label."""
    vni = vni.sort_values("date").reset_index(drop=True).copy()
    cs = vni["close"]
    # Realized vol 20d (std of daily returns)
    daily_ret = cs.pct_change()
    vni["vni_vol_20d"] = daily_ret.rolling(VOL_LOOKBACK).std() * 100
    vni["vni_ma50"] = cs.rolling(50).mean()
    vni["vni_uptrend"] = cs > vni["vni_ma50"]
    return vni[["date", "vni_vol_20d", "vni_uptrend"]]


def label_regime(row, vol_median):
    if pd.isna(row["vni_vol_20d"]):
        return "unknown"
    is_low_vol = row["vni_vol_20d"] < vol_median
    is_up = row["vni_uptrend"]
    if is_low_vol and is_up:
        return "low_up"
    if is_low_vol and not is_up:
        return "low_down"
    if not is_low_vol and is_up:
        return "high_up"
    return "high_down"


def enrich_stock(group):
    g = group.copy().reset_index(drop=True)
    c, o, h, l, v = g["close"].values, g["open"].values, g["high"].values, g["low"].values, g["volume"].values
    cs = pd.Series(c)
    g["ma200"] = cs.rolling(200).mean()
    g["above_ma200"] = c > g["ma200"]
    g["vol_avg20"] = pd.Series(v).rolling(20).mean()
    g["vol_ratio"] = v / g["vol_avg20"]

    # Base Breakout
    high_30 = pd.Series(h).rolling(30).max()
    low_30 = pd.Series(l).rolling(30).min()
    range_30 = (high_30 - low_30) / low_30
    g["base_range_ok"] = range_30.shift(1) < 0.10
    g["break_above"] = c > high_30.shift(1)
    g["sig_base_breakout"] = (g["above_ma200"] & g["base_range_ok"] & g["break_above"] & (g["vol_ratio"] > 1.5))

    # Climax Tier B
    g["day_green"] = c > o
    g["ret_3d"] = cs.pct_change(3) * 100
    delta = np.diff(c, prepend=c[0])
    up = np.where(delta > 0, delta, 0)
    dn = np.where(delta < 0, -delta, 0)
    avg_up = pd.Series(up).rolling(14).mean()
    avg_dn = pd.Series(dn).rolling(14).mean()
    rs = avg_up / avg_dn.replace(0, np.nan)
    g["rsi"] = 100 - 100 / (1 + rs)
    g["sig_climax"] = (g["day_green"] & (g["vol_ratio"] > 2.0) & (g["ret_3d"] < -5) & (g["rsi"] < 50))
    return g


def simulate_trailing(df, sig_col, max_hold, trail_pct, init_sl_pct, cost=DEFAULT_COST_RT):
    """Trailing-stop exit (cho Base Breakout)."""
    df = df.sort_values(["symbol", "date"])
    trades = []
    for sym, group in df.groupby("symbol", sort=False):
        g = group.reset_index(drop=True)
        sig = g[sig_col].values
        opens, closes, highs = g["open"].values, g["close"].values, g["high"].values
        regimes = g["regime"].values
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
            trades.append({
                "date": g.iloc[i]["date"], "regime": regimes[i], "exit_day": eh,
                "net_ret": (ex - ep) / ep - cost,
            })
    return pd.DataFrame(trades)


def simulate_climax(df, sig_col, max_hold=5, target_pct=0.03, sl_pct=0.08, cost=DEFAULT_COST_RT):
    """Target/SL exit (cho Climax)."""
    df = df.sort_values(["symbol", "date"])
    trades = []
    for sym, group in df.groupby("symbol", sort=False):
        g = group.reset_index(drop=True)
        sig = g[sig_col].values
        opens, closes = g["open"].values, g["close"].values
        regimes = g["regime"].values
        for i in range(len(g) - 1 - max_hold):
            if not sig[i]:
                continue
            ep = opens[i + 1]
            if pd.isna(ep) or ep <= 0:
                continue
            ex, eh = None, None
            for h_step in range(1, max_hold + 1):
                di = i + 1 + h_step
                if di >= len(g):
                    break
                dc = closes[di]
                if pd.isna(dc):
                    continue
                if dc <= ep * (1 - sl_pct):
                    ex, eh = dc, h_step; break
                if h_step >= 3 and dc >= ep * (1 + target_pct):
                    ex, eh = dc, h_step; break
                if h_step == max_hold:
                    ex, eh = dc, h_step
            if ex is None:
                continue
            trades.append({
                "date": g.iloc[i]["date"], "regime": regimes[i], "exit_day": eh,
                "net_ret": (ex - ep) / ep - cost,
            })
    return pd.DataFrame(trades)


def stats_by_regime(trades, hold_avg):
    """Per-regime stats."""
    if len(trades) == 0:
        return {}
    out = {}
    for regime, sub in trades.groupby("regime"):
        if len(sub) < 10:
            out[regime] = None
            continue
        win = (sub["net_ret"] > 0).mean()
        avg = sub["net_ret"].mean()
        std = sub["net_ret"].std()
        sh = (avg / std * (252 / hold_avg) ** 0.5) if std > 0 else 0
        pos = sub.loc[sub["net_ret"] > 0, "net_ret"].sum()
        neg = abs(sub.loc[sub["net_ret"] < 0, "net_ret"].sum())
        pf = pos / neg if neg > 0 else float("inf")
        out[regime] = {"n": len(sub), "win": win, "avg": avg, "sharpe": sh, "pf": pf}
    return out


def print_regime_table(label, regime_stats):
    print(f"\n  {label}:")
    print(f"    {'Regime':<12} {'n':>5} {'Win':>6} {'Avg':>8} {'Sharpe':>8} {'PF':>6}")
    for regime in ["low_up", "low_down", "high_up", "high_down"]:
        s = regime_stats.get(regime)
        if s is None:
            print(f"    {regime:<12} (n<10)")
        else:
            marker = ""
            if s["sharpe"] >= 0.5 and s["pf"] >= 1.3 and s["avg"] > 0:
                marker = "🟢"
            elif s["avg"] > 0:
                marker = "🟡"
            print(f"   {marker} {regime:<10} {s['n']:>5} {s['win']*100:>5.1f}% {s['avg']*100:>+6.2f}% {s['sharpe']:>+7.2f} {s['pf']:>6.2f}")


def main():
    print("Load + enrich VNI regime + universe...")
    u = load_universe()
    vni = load_vnindex()
    f = filter_universe(u)
    print(f"  {f.symbol.nunique()} mã, {len(f):,} rows")

    vni_reg = compute_vni_regime(vni)
    print(f"  VNI rows: {len(vni_reg)}")

    # Compute median vol on full period for regime split
    vol_median = vni_reg["vni_vol_20d"].median()
    print(f"  VNI vol_20d median: {vol_median:.3f}%")

    # Label regime per VNI date
    vni_reg["regime"] = vni_reg.apply(lambda r: label_regime(r, vol_median), axis=1)

    # Merge regime into stock data
    parts = [enrich_stock(g) for _, g in f.groupby("symbol", sort=False)]
    df = pd.concat(parts, ignore_index=True)
    df = df.merge(vni_reg[["date", "regime"]], on="date", how="left")
    df = df[df["regime"] != "unknown"]
    print(f"  After regime merge: {len(df):,} rows")

    train = df[(df["date"] >= TRAIN_START) & (df["date"] <= TRAIN_END)].copy()
    test = df[df["date"] >= TEST_START].copy()
    print(f"  Train {len(train):,}, Test {len(test):,}")

    # Regime distribution
    print("\n═══ Regime distribution (Test 2026) ═══")
    print(test.groupby("regime").size().to_string())

    # Base Breakout per regime
    print("\n═══ Base Breakout (hold 30, trail 10%, SL 10%) per regime ═══")
    bb_train = simulate_trailing(train, "sig_base_breakout", 30, 0.10, 0.10)
    bb_test = simulate_trailing(test, "sig_base_breakout", 30, 0.10, 0.10)
    print_regime_table("TRAIN 2024-2025", stats_by_regime(bb_train, 23))
    print_regime_table("TEST 2026", stats_by_regime(bb_test, 23))

    # Climax per regime
    print("\n═══ Climax Tier B (hold T+5, target +3%, SL -8%) per regime ═══")
    clx_train = simulate_climax(train, "sig_climax")
    clx_test = simulate_climax(test, "sig_climax")
    print_regime_table("TRAIN 2024-2025", stats_by_regime(clx_train, 4))
    print_regime_table("TEST 2026", stats_by_regime(clx_test, 4))

    # Best regime per pattern (Test)
    print("\n═══ Pass criteria: Test Sharpe ≥ 0.5, PF ≥ 1.3, avg > 0 ═══")
    bb_test_stats = stats_by_regime(bb_test, 23)
    clx_test_stats = stats_by_regime(clx_test, 4)

    def find_pass(stats_dict, label):
        passing = [(r, s) for r, s in stats_dict.items()
                  if s and s["sharpe"] >= 0.5 and s["pf"] >= 1.3 and s["avg"] > 0]
        if passing:
            for r, s in passing:
                print(f"  🟢 {label} regime={r}: Sharpe {s['sharpe']:+.2f}, PF {s['pf']:.2f}, Win {s['win']*100:.1f}%, n={s['n']}")
        return passing

    bb_pass = find_pass(bb_test_stats, "Base Breakout")
    clx_pass = find_pass(clx_test_stats, "Climax")

    if not bb_pass and not clx_pass:
        print("  ❌ KHÔNG regime-pattern combination nào pass Test 2026.")
    else:
        print(f"\n  ✅ Có regime filter rõ ràng → tab Rà soát có thể dùng regime hint.")


if __name__ == "__main__":
    main()
