"""Strong Leaders Ablation — identify which signals help vs hurt.

Approach: disable each signal group 1 lúc, đo Sharpe delta vs baseline.
Signals that ADD edge → keep. Signals that SUBTRACT or NEUTRAL → drop.

7 signal groups (theo strong_leaders_score.py):
  A. RS vs VNI 5d + 20d
  B. Breakout (w20, w52, ceiling streak)
  C. Volume accumulation (up/down ratio + today spike)
  D. MA alignment (5>10>20>50 + partial + slope)
  E. ADX + DI direction
  F. RSI<30 residual
  G. Foreign flow 5-day
"""

from __future__ import annotations

from pathlib import Path
import numpy as np
import pandas as pd

from src.backtest import DEFAULT_COST_RT, summarize
from src.load_data import load_universe, load_vnindex


TEST_START = "2024-01-01"
OUT_DIR = Path(__file__).parent / "results"


def compute_score_modular(g: pd.DataFrame, vni: pd.DataFrame, enabled: dict) -> pd.DataFrame:
    """Score per-symbol với each signal group có thể disabled."""
    g = g.sort_values("date").reset_index(drop=True).copy()
    g["date"] = pd.to_datetime(g["date"])
    n = len(g)
    score = pd.Series(0.0, index=g.index)

    close = g["close"]
    high = g["high"]
    low = g["low"]
    vol = g["volume"]

    # A. RS vs VNI
    rs_5 = np.full(n, np.nan)
    rs_20 = np.full(n, np.nan)
    if enabled.get("A") and not vni.empty:
        vni_close = vni.set_index("date")["close"] if "date" in vni.columns else vni["close"]
        vni_aligned = vni_close.reindex(g["date"].values, method="ffill")
        stock_5 = close / close.shift(5) - 1
        stock_20 = close / close.shift(21) - 1
        v5 = vni_aligned.values / np.roll(vni_aligned.values, 5) - 1
        v20 = vni_aligned.values / np.roll(vni_aligned.values, 21) - 1
        v5[:5] = np.nan; v20[:21] = np.nan
        rs_5 = (stock_5.values - v5) * 100
        rs_20 = (stock_20.values - v20) * 100
        m_lead = (rs_5 > 5) & (rs_20 > 8)
        m_out = (rs_5 > 2) & (rs_20 > 3) & ~m_lead
        m_lag = (rs_5 < -3) & (rs_20 < -5)
        score += pd.Series(m_lead, index=g.index).astype(float) * 3
        score += pd.Series(m_out, index=g.index).astype(float) * 1.5
        score -= pd.Series(m_lag, index=g.index).astype(float) * 2

    # B. Breakout
    if enabled.get("B"):
        w20_high = close.rolling(20, min_periods=20).max().shift(1)
        breakout_5 = (close > w20_high * 1.005).rolling(5, min_periods=1).max().astype(bool)
        score += breakout_5.astype(float) * 2
        if n >= 252:
            w52 = close.rolling(252, min_periods=252).max().shift(1)
            score += (close > w52 * 0.99).astype(float) * 3
        daily_pct = (close / close.shift(1) - 1) * 100
        is_ceil = daily_pct >= 6.5
        streak = pd.Series(0, index=g.index)
        s = 0
        for i in range(n):
            s = s + 1 if is_ceil.iloc[i] else 0
            streak.iloc[i] = s
        score += ((streak >= 2).astype(float) * 2 + (streak == 1).astype(float) * 1)

    # C. Volume accumulation
    if enabled.get("C"):
        change = close - close.shift(1)
        up_v = vol.where(change > 0, 0).rolling(20, min_periods=10).sum()
        up_d = (change > 0).astype(float).rolling(20, min_periods=10).sum()
        dn_v = vol.where(change < 0, 0).rolling(20, min_periods=10).sum()
        dn_d = (change < 0).astype(float).rolling(20, min_periods=10).sum()
        ratio = (up_v / up_d.replace(0, np.nan)) / (dn_v / dn_d.replace(0, np.nan)).replace(0, np.nan)
        score += (ratio > 1.5).astype(float) * 2
        score += ((ratio > 1.2) & (ratio <= 1.5)).astype(float) * 1
        score -= (ratio < 0.7).astype(float) * 1
        avg_v = vol.rolling(20, min_periods=20).mean().shift(1)
        vr = vol / avg_v
        dc = (close / close.shift(1) - 1) * 100
        score += ((vr > 2) & (dc >= 0)).astype(float) * 1.5
        score -= ((vr > 1.5) & (dc < -2)).astype(float) * 1.5

    # D. MA alignment
    if enabled.get("D"):
        ma5 = close.rolling(5, min_periods=5).mean()
        ma10 = close.rolling(10, min_periods=10).mean()
        ma20 = close.rolling(20, min_periods=20).mean()
        ma50 = close.rolling(50, min_periods=50).mean()
        aligned = (ma5 > ma10) & (ma10 > ma20) & (ma20 > ma50) & (close > ma5)
        score += aligned.astype(float) * 2
        partial = (close > ma20) & (ma20 > ma50) & ~aligned
        score += partial.astype(float) * 1
        score += (ma20 > ma20.shift(5) * 1.005).astype(float) * 0.5

    # E. ADX
    if enabled.get("E") and "adx14" in g.columns and "plus_di" in g.columns:
        adx_up = (g["adx14"] > 25) & (g["plus_di"] > g["minus_di"])
        adx_dn = (g["adx14"] > 25) & (g["minus_di"] > g["plus_di"])
        score += adx_up.astype(float) * 1.5
        score -= adx_dn.astype(float) * 1.5

    # F. RSI residual
    rsi = g.get("rsi14", pd.Series(np.nan, index=g.index))
    if enabled.get("F"):
        score += (rsi < 30).astype(float) * 1.5

    # G. Foreign flow
    if enabled.get("G") and "net_val" in g.columns:
        nn = g["net_val"]
        pos5 = (nn > 0).rolling(5, min_periods=5).sum()
        sum5 = nn.rolling(5, min_periods=5).sum()
        score += ((pos5 >= 4) & (sum5 > 0)).astype(float) * 1.5
        score -= ((pos5 <= 1) & (sum5 < 0)).astype(float) * 1

    # Hard filters
    turnover = close * vol * 1000
    avg_to = turnover.rolling(20, min_periods=10).mean()
    f_illiquid = avg_to < 5e9
    ret_20 = (close / close.shift(20) - 1) * 100
    f_overext = ret_20 > 50

    eligible = ~(f_illiquid | f_overext) & rsi.notna()
    score = score.where(eligible, np.nan)
    g["strong_score"] = score
    g["strong_eligible"] = eligible
    return g


def add_scores_modular(universe_df: pd.DataFrame, vni: pd.DataFrame, enabled: dict) -> pd.DataFrame:
    parts = [compute_score_modular(group, vni, enabled) for _, group in universe_df.groupby("symbol", sort=False)]
    return pd.concat(parts, ignore_index=True).sort_values(["symbol", "date"]).reset_index(drop=True)


def simulate(df: pd.DataFrame, top_n: int, hold: int, min_score: float, cost: float = DEFAULT_COST_RT) -> pd.DataFrame:
    df["date"] = pd.to_datetime(df["date"])
    open_pv = df.pivot_table(index="date", columns="symbol", values="open", aggfunc="first")
    close_pv = df.pivot_table(index="date", columns="symbol", values="close", aggfunc="first")
    score_pv = df.pivot_table(index="date", columns="symbol", values="strong_score", aggfunc="first")
    dates = score_pv.index
    trades = []
    for i, d in enumerate(dates):
        s = score_pv.loc[d].dropna()
        valid = s[s >= min_score]
        if len(valid) == 0 or i + 1 >= len(dates) or i + 1 + hold >= len(dates):
            continue
        top = valid.sort_values(ascending=False).head(top_n)
        e_date = dates[i + 1]
        x_date = dates[i + 1 + hold]
        for sym in top.index:
            ep = open_pv.loc[e_date, sym] if sym in open_pv.columns else np.nan
            xp = close_pv.loc[x_date, sym] if sym in close_pv.columns else np.nan
            if pd.isna(ep) or pd.isna(xp) or ep <= 0:
                continue
            gross = (xp - ep) / ep
            trades.append({"net_ret": gross - cost})
    return pd.DataFrame(trades)


def main():
    print("Load...")
    universe = load_universe()
    vni = load_vnindex()

    ALL_GROUPS = ["A", "B", "C", "D", "E", "F", "G"]
    NAMES = {
        "A": "RS vs VNI", "B": "Breakout", "C": "Vol accumulation",
        "D": "MA alignment", "E": "ADX/DI", "F": "RSI<30", "G": "Foreign flow",
    }

    # Test config: top_n=3, hold=15d, min_score=4 (best variant từ V1)
    TOP_N = 3
    HOLD = 15
    MIN_SCORE = 4.0

    print(f"Ablation config: top={TOP_N}, hold={HOLD}d, min_score={MIN_SCORE}")

    # Baseline = all enabled
    print(f"\n=== Baseline (all signals) ===")
    full_enabled = {g: True for g in ALL_GROUPS}
    scored = add_scores_modular(universe, vni, full_enabled)
    test = scored[scored["date"] >= TEST_START]
    trades = simulate(test, TOP_N, HOLD, MIN_SCORE)
    base = summarize(trades)
    print(f"  n={base['n_trades']} win={base['win_rate']*100:.1f}% avg={base['avg_ret']*100:+.2f}% "
          f"sharpe={base['sharpe']:.3f} pf={base['profit_factor']:.2f}")

    # Drop 1 signal at a time
    print(f"\n=== Drop each signal (delta vs baseline) ===")
    print(f"  {'Removed':<22} {'n':>5} {'Win%':>6} {'Avg':>7} {'ΔSharpe':>9} {'ΔAvg':>7}")
    drop_results = []
    for drop_grp in ALL_GROUPS:
        enabled = {g: (g != drop_grp) for g in ALL_GROUPS}
        scored2 = add_scores_modular(universe, vni, enabled)
        test2 = scored2[scored2["date"] >= TEST_START]
        trades2 = simulate(test2, TOP_N, HOLD, MIN_SCORE)
        s2 = summarize(trades2)
        d_sharpe = s2["sharpe"] - base["sharpe"]
        d_avg = s2["avg_ret"] - base["avg_ret"]
        verdict = "HURT" if d_sharpe > 0.02 else ("HELP" if d_sharpe < -0.02 else "NEUTRAL")
        print(f"  -{drop_grp} ({NAMES[drop_grp]:<18}) {s2['n_trades']:>5} "
              f"{s2['win_rate']*100:5.1f}% {s2['avg_ret']*100:+6.2f}% "
              f"{d_sharpe:+9.3f} {d_avg*100:+6.2f}% [{verdict}]")
        drop_results.append({"removed": drop_grp, "name": NAMES[drop_grp], "verdict": verdict,
                             "delta_sharpe": d_sharpe, "delta_avg": d_avg, **s2})

    # Identify keepers vs hurters
    hurters = [r for r in drop_results if r["delta_sharpe"] > 0.02]
    helpers = [r for r in drop_results if r["delta_sharpe"] < -0.02]
    print(f"\nKEEP (drop hurts):    {[r['removed'] for r in helpers]} ({[NAMES[r['removed']] for r in helpers]})")
    print(f"DROP (drop helps):    {[r['removed'] for r in hurters]} ({[NAMES[r['removed']] for r in hurters]})")

    # Drop all signals that HURT (delta_sharpe > 0.02)
    drop_groups = [r["removed"] for r in hurters]
    keep_groups = [g for g in ALL_GROUPS if g not in drop_groups]
    print(f"\n=== Optimal subset (drop hurters: {drop_groups}) ===")
    optimal_enabled = {g: (g in keep_groups) for g in ALL_GROUPS}
    scored3 = add_scores_modular(universe, vni, optimal_enabled)
    test3 = scored3[scored3["date"] >= TEST_START]
    trades3 = simulate(test3, TOP_N, HOLD, MIN_SCORE)
    opt = summarize(trades3)
    print(f"  Enabled: {[NAMES[g] for g in keep_groups]}")
    print(f"  n={opt['n_trades']} win={opt['win_rate']*100:.1f}% avg={opt['avg_ret']*100:+.2f}% "
          f"sharpe={opt['sharpe']:.3f} pf={opt['profit_factor']:.2f}")
    print(f"  Delta vs baseline: sharpe {opt['sharpe']-base['sharpe']:+.3f}, "
          f"avg {(opt['avg_ret']-base['avg_ret'])*100:+.2f}%")

    # Test multiple variants of optimal subset (vary top_n, hold, min_score)
    print(f"\n=== Variants on optimal subset (drop {drop_groups}) ===")
    print(f"  {'min':>4} {'top':>3} {'hold':>4} {'n':>5} {'Win%':>6} {'Avg':>7} {'Sharpe':>7} {'PF':>5}")
    for ms in [3.0, 4.0, 5.0, 6.0]:
        for tn in [1, 3, 5]:
            for hd in [10, 15, 20]:
                tt = simulate(scored3[scored3["date"] >= TEST_START], tn, hd, ms)
                ss = summarize(tt)
                if ss["n_trades"] < 30:
                    continue
                marker = "★" if ss["sharpe"] >= 0.3 else ""
                print(f"  {ms:4.1f} {tn:3d} {hd:4d} {ss['n_trades']:5d} "
                      f"{ss['win_rate']*100:5.1f}% {ss['avg_ret']*100:+6.2f}% "
                      f"{ss['sharpe']:+7.3f} {ss['profit_factor']:5.2f} {marker}")

    pd.DataFrame(drop_results).to_csv(OUT_DIR / "strong_leaders_ablation.csv", index=False)


if __name__ == "__main__":
    main()
