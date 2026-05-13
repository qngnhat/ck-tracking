"""Test regime filter: only trade khi VN-Index trong BULL / BULL_WEAK.

Based on ablation findings: drop RS (group A), keep rest. Test variants
top=1/3, hold=15/20d với regime filter on/off.
"""

from __future__ import annotations

from pathlib import Path
import numpy as np
import pandas as pd

from src.backtest import DEFAULT_COST_RT, summarize
from src.load_data import load_universe, load_vnindex
from run_strong_leaders_ablation import add_scores_modular

TEST_START = "2024-01-01"
OUT_DIR = Path(__file__).parent / "results"


def classify_regime(vni: pd.DataFrame) -> pd.Series:
    """Replicate ranking.js getMarketRegime logic (simplified).

    BULL: ma50 > ma200 + price > ma200 + 3m return > +3%
    BEAR: ma50 < ma200 + price < ma200 + 3m return < -3%
    Else: BULL_WEAK / BEAR_WEAK / RANGE
    """
    df = vni.set_index("date") if "date" in vni.columns else vni.copy()
    close = df["close"]
    ma50 = close.rolling(50, min_periods=50).mean()
    ma200 = close.rolling(200, min_periods=200).mean()
    ret_3m = close / close.shift(63) - 1

    regime = pd.Series("RANGE", index=close.index)
    bull_strong = (ma50 > ma200) & (close > ma200) & (ret_3m > 0.03)
    bear_strong = (ma50 < ma200) & (close < ma200) & (ret_3m < -0.03)
    bull_weak = (ma50 > ma200) & ~bull_strong
    bear_weak = (ma50 < ma200) & ~bear_strong

    regime[bull_strong] = "BULL"
    regime[bull_weak] = "BULL_WEAK"
    regime[bear_strong] = "BEAR"
    regime[bear_weak] = "BEAR_WEAK"
    return regime


def simulate_with_regime(
    df: pd.DataFrame, regime_series: pd.Series,
    top_n: int, hold: int, min_score: float, allowed_regimes: set,
    cost: float = DEFAULT_COST_RT,
) -> pd.DataFrame:
    df["date"] = pd.to_datetime(df["date"])
    open_pv = df.pivot_table(index="date", columns="symbol", values="open", aggfunc="first")
    close_pv = df.pivot_table(index="date", columns="symbol", values="close", aggfunc="first")
    score_pv = df.pivot_table(index="date", columns="symbol", values="strong_score", aggfunc="first")
    dates = score_pv.index
    trades = []
    skipped_regime = 0
    for i, d in enumerate(dates):
        # Regime check
        if regime_series is not None:
            reg = regime_series.get(d, "RANGE")
            if allowed_regimes and reg not in allowed_regimes:
                skipped_regime += 1
                continue
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
            trades.append({"net_ret": gross - cost, "regime": reg if regime_series is not None else "ALL"})
    return pd.DataFrame(trades), skipped_regime


def main():
    print("Load...")
    universe = load_universe()
    vni = load_vnindex()
    regime = classify_regime(vni)
    print(f"  Regime distribution: {regime.value_counts().to_dict()}")

    # Full-universe ablation (655 mã): drop B (Breakout) — RS giờ neutral, Breakout hurts
    enabled = {"A": True, "B": False, "C": True, "D": True, "E": True, "F": True, "G": True}
    scored = add_scores_modular(universe, vni, enabled)
    test_df = scored[scored["date"] >= TEST_START]

    REGIME_VARIANTS = [
        ("All (no filter)", None),
        ("BULL only", {"BULL"}),
        ("BULL + BULL_WEAK", {"BULL", "BULL_WEAK"}),
        ("Skip BEAR", {"BULL", "BULL_WEAK", "RANGE"}),
    ]

    print(f"\n=== Regime filter variants (drop A) ===")
    print(f"  {'Regime':<20} {'top':>3} {'hold':>4} {'n':>5} {'Win%':>6} {'Avg':>7} {'Sharpe':>7} {'PF':>5}")
    for label, allowed in REGIME_VARIANTS:
        for tn in [1, 3]:
            for hd in [15, 20]:
                trades, skipped = simulate_with_regime(
                    test_df, regime, tn, hd, 4.0, allowed or set()
                )
                if len(trades) < 30:
                    continue
                s = summarize(trades)
                marker = "★" if s["sharpe"] >= 0.3 else ""
                print(f"  {label:<20} {tn:3d} {hd:4d} {s['n_trades']:5d} "
                      f"{s['win_rate']*100:5.1f}% {s['avg_ret']*100:+6.2f}% "
                      f"{s['sharpe']:+7.3f} {s['profit_factor']:5.2f} {marker}")


if __name__ == "__main__":
    main()
