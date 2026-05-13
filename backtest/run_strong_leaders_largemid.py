"""V7 — Strong Leaders backtest trên Large+Mid universe (~200 mã liquid).

Filter universe theo median daily turnover >= 3 tỷ VND (rank top ~200 in 655).
Re-run V1 baseline + V3 ablation + V5 regime filter để check findings.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from src.backtest import DEFAULT_COST_RT, summarize
from src.load_data import load_universe, load_vnindex
from run_strong_leaders_ablation import add_scores_modular
from run_strong_leaders_regime import classify_regime, simulate_with_regime

TEST_START = "2024-01-01"
TURNOVER_MIN_BN = 3.0  # tỷ VND/ngày (median) → top ~200 mã
OUT_DIR = Path(__file__).parent / "results"


def filter_largemid(universe: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
    recent = universe[universe.date >= "2024-01-01"].copy()
    recent["turnover"] = recent["close"] * recent["volume"] * 1000
    liq = recent.groupby("symbol")["turnover"].median() / 1e9  # tỷ VND
    keep = liq[liq >= TURNOVER_MIN_BN].index.tolist()
    filtered = universe[universe.symbol.isin(keep)].copy()
    return filtered, keep


def simulate_picks(df: pd.DataFrame, top_n: int, hold: int, min_score: float, cost: float = DEFAULT_COST_RT) -> pd.DataFrame:
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
            trades.append({"net_ret": (xp - ep) / ep - cost})
    return pd.DataFrame(trades)


def main():
    print("Load full universe...")
    universe = load_universe()
    vni = load_vnindex()

    print(f"\n=== Filter Large+Mid (median turnover >= {TURNOVER_MIN_BN} tỷ/ngày) ===")
    filtered, keep = filter_largemid(universe)
    print(f"  Kept: {len(keep)} mã (from {universe.symbol.nunique()})")
    print(f"  Top 20: {keep[:20]}")

    print(f"\n=== V7.1 Baseline (all 7 signals) ===")
    full_enabled = {k: True for k in "ABCDEFG"}
    scored = add_scores_modular(filtered, vni, full_enabled)
    test_df = scored[scored["date"] >= TEST_START].copy()

    best = None
    for tn in [1, 3, 5, 10]:
        for hd in [10, 15, 20]:
            for ms in [3.0, 4.0, 5.0]:
                trades = simulate_picks(test_df, tn, hd, ms)
                if len(trades) < 50:
                    continue
                s = summarize(trades)
                row = (tn, hd, ms, s["n_trades"], s["win_rate"] * 100, s["avg_ret"] * 100,
                       s["sharpe"], s["profit_factor"])
                if best is None or s["sharpe"] > best[6]:
                    best = row
                print(f"  min={ms} top={tn} hold={hd}d  n={s['n_trades']:5d} "
                      f"win={s['win_rate']*100:5.1f}% avg={s['avg_ret']*100:+6.2f}% "
                      f"sharpe={s['sharpe']:+.3f} pf={s['profit_factor']:.2f}")
    print(f"\n  Best baseline: top={best[0]} hold={best[1]}d min={best[2]} "
          f"sharpe={best[6]:.3f} avg={best[5]:+.2f}% pf={best[7]:.2f}")

    print(f"\n=== V7.2 Ablation (top=3, hold=15d, min=4.0) ===")
    BASE = simulate_picks(test_df, 3, 15, 4.0)
    base_s = summarize(BASE)
    print(f"  Baseline: n={base_s['n_trades']} win={base_s['win_rate']*100:.1f}% "
          f"avg={base_s['avg_ret']*100:+.2f}% sharpe={base_s['sharpe']:+.3f}")

    GROUP_LABELS = {"A": "RS vs VNI", "B": "Breakout", "C": "Vol accum", "D": "MA align",
                    "E": "ADX/DI", "F": "RSI<30", "G": "Foreign flow"}
    print(f"\n  Removed              n     Win%   Avg     ΔSharpe  ΔAvg")
    drop_helpers = []
    for grp in "ABCDEFG":
        en = {**full_enabled, grp: False}
        sc = add_scores_modular(filtered, vni, en)
        tst = sc[sc["date"] >= TEST_START].copy()
        tr = simulate_picks(tst, 3, 15, 4.0)
        s = summarize(tr)
        d_sharpe = s["sharpe"] - base_s["sharpe"]
        d_avg = s["avg_ret"] - base_s["avg_ret"]
        verdict = "[HURT]" if d_sharpe > 0.015 else "[KEEP]" if d_sharpe < -0.015 else "[NEUTRAL]"
        if d_sharpe > 0.015:
            drop_helpers.append(grp)
        print(f"  -{grp} ({GROUP_LABELS[grp]:<14}) {s['n_trades']:5d} "
              f"{s['win_rate']*100:5.1f}% {s['avg_ret']*100:+6.2f}%  "
              f"{d_sharpe:+.3f}  {d_avg*100:+.2f}% {verdict}")

    print(f"\n  Drop-helpers: {drop_helpers} ({[GROUP_LABELS[g] for g in drop_helpers]})")

    if drop_helpers:
        print(f"\n=== V7.3 Optimal subset (drop {drop_helpers}) ===")
        opt_en = {g: g not in drop_helpers for g in "ABCDEFG"}
        opt_sc = add_scores_modular(filtered, vni, opt_en)
        opt_tst = opt_sc[opt_sc["date"] >= TEST_START].copy()

        for tn in [1, 3]:
            for hd in [15, 20]:
                for ms in [3.0, 4.0]:
                    tr = simulate_picks(opt_tst, tn, hd, ms)
                    if len(tr) < 50:
                        continue
                    s = summarize(tr)
                    print(f"  top={tn} hold={hd}d min={ms}  n={s['n_trades']:5d} "
                          f"win={s['win_rate']*100:5.1f}% avg={s['avg_ret']*100:+6.2f}% "
                          f"sharpe={s['sharpe']:+.3f} pf={s['profit_factor']:.2f}")

        print(f"\n=== V7.4 Regime filter on optimal subset ===")
        regime = classify_regime(vni)
        REGIMES = [
            ("All", None),
            ("BULL only", {"BULL"}),
            ("BULL+BULL_WEAK", {"BULL", "BULL_WEAK"}),
            ("Skip BEAR", {"BULL", "BULL_WEAK", "RANGE"}),
        ]
        for label, allowed in REGIMES:
            for tn in [1, 3]:
                for hd in [15, 20]:
                    trades, _ = simulate_with_regime(opt_tst, regime, tn, hd, 4.0, allowed or set())
                    if len(trades) < 30:
                        continue
                    s = summarize(trades)
                    print(f"  {label:<16} top={tn} hold={hd}d  n={s['n_trades']:5d} "
                          f"win={s['win_rate']*100:5.1f}% avg={s['avg_ret']*100:+6.2f}% "
                          f"sharpe={s['sharpe']:+.3f} pf={s['profit_factor']:.2f}")


if __name__ == "__main__":
    main()
