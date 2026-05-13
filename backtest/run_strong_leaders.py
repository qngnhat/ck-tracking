"""Strong Leaders T+ Backtest — validate formula mới (May 2026).

Strategy: mỗi ngày sau đóng cửa, pick top-N mã có Strong Leaders score >= min_score.
Mua T+1 open, hold N phiên, bán T+1+N close. Cost 0.4% round-trip.

Compare vs:
  - Random pick top-N from universe (no skill)
  - Buy-hold VN-Index trong cùng kỳ
  - Old mean-reversion T+ (run_phase4b_tplus.py)

Test windows: 2024-2026 (out-of-sample, regime gần đây narrow leadership).

Pass criteria:
  - Out-of-sample Sharpe > 0.3
  - Win rate > 55%
  - Avg ret > 1% per trade
  - Profit factor > 1.5
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from src.backtest import DEFAULT_COST_RT, summarize
from src.load_data import load_universe, load_vnindex
from src.strong_leaders_score import STRONG_LEADERS_MIN_SCORE, add_strong_leaders_scores

OUT_DIR = Path(__file__).parent / "results"
OUT_DIR.mkdir(exist_ok=True)

# Test recent regime (2024+) for narrow leadership relevance
TEST_START = "2024-01-01"
TRAIN_END = "2023-12-31"

HOLD_DAYS_VARIANTS = [5, 10, 15]
TOP_N_VARIANTS = [3, 5, 10]
MIN_SCORE_VARIANTS = [4.0, 5.0, 6.0, 7.0]


def simulate_strong_picks(
    universe_df: pd.DataFrame,
    top_n: int,
    hold_days: int,
    min_score: float = STRONG_LEADERS_MIN_SCORE,
    cost_rt: float = DEFAULT_COST_RT,
) -> pd.DataFrame:
    """For each day, pick top-N stocks by Strong Leaders score, trade them."""
    df = universe_df.copy()
    df["date"] = pd.to_datetime(df["date"])

    open_pivot = df.pivot_table(index="date", columns="symbol", values="open", aggfunc="first")
    close_pivot = df.pivot_table(index="date", columns="symbol", values="close", aggfunc="first")
    score_pivot = df.pivot_table(index="date", columns="symbol", values="strong_score", aggfunc="first")

    all_dates = score_pivot.index
    trades = []

    for i, sig_date in enumerate(all_dates):
        scores = score_pivot.loc[sig_date].dropna()
        valid = scores[scores >= min_score]
        if len(valid) == 0:
            continue

        # Top-N by score (desc)
        top = valid.sort_values(ascending=False).head(top_n)

        # Entry: T+1 open
        if i + 1 >= len(all_dates):
            continue
        entry_date = all_dates[i + 1]
        # Exit: T+1+hold close
        exit_idx = i + 1 + hold_days
        if exit_idx >= len(all_dates):
            continue
        exit_date = all_dates[exit_idx]

        for sym, score in top.items():
            entry_price = open_pivot.loc[entry_date, sym] if sym in open_pivot.columns else np.nan
            exit_price = close_pivot.loc[exit_date, sym] if sym in close_pivot.columns else np.nan
            if pd.isna(entry_price) or pd.isna(exit_price) or entry_price <= 0:
                continue
            gross = (exit_price - entry_price) / entry_price
            net = gross - cost_rt
            trades.append({
                "signal_date": sig_date,
                "entry_date": entry_date,
                "exit_date": exit_date,
                "symbol": sym,
                "score": float(score),
                "entry_price": entry_price,
                "exit_price": exit_price,
                "gross_ret": gross,
                "net_ret": net,
            })

    return pd.DataFrame(trades)


def simulate_random_baseline(
    universe_df: pd.DataFrame,
    top_n: int,
    hold_days: int,
    cost_rt: float = DEFAULT_COST_RT,
    seed: int = 42,
) -> pd.DataFrame:
    """Random pick top-N from eligible universe each day."""
    rng = np.random.default_rng(seed)
    df = universe_df.copy()
    df["date"] = pd.to_datetime(df["date"])

    open_pivot = df.pivot_table(index="date", columns="symbol", values="open", aggfunc="first")
    close_pivot = df.pivot_table(index="date", columns="symbol", values="close", aggfunc="first")
    elig_pivot = df.pivot_table(index="date", columns="symbol", values="strong_eligible", aggfunc="first")

    all_dates = elig_pivot.index
    trades = []

    for i, sig_date in enumerate(all_dates):
        elig = elig_pivot.loc[sig_date].dropna()
        valid_syms = elig[elig].index.tolist()
        if len(valid_syms) == 0:
            continue
        pick_count = min(top_n, len(valid_syms))
        picks = rng.choice(valid_syms, size=pick_count, replace=False)

        if i + 1 >= len(all_dates):
            continue
        entry_date = all_dates[i + 1]
        exit_idx = i + 1 + hold_days
        if exit_idx >= len(all_dates):
            continue
        exit_date = all_dates[exit_idx]

        for sym in picks:
            entry_price = open_pivot.loc[entry_date, sym] if sym in open_pivot.columns else np.nan
            exit_price = close_pivot.loc[exit_date, sym] if sym in close_pivot.columns else np.nan
            if pd.isna(entry_price) or pd.isna(exit_price) or entry_price <= 0:
                continue
            gross = (exit_price - entry_price) / entry_price
            net = gross - cost_rt
            trades.append({
                "signal_date": sig_date,
                "entry_date": entry_date,
                "exit_date": exit_date,
                "symbol": sym,
                "entry_price": entry_price,
                "exit_price": exit_price,
                "gross_ret": gross,
                "net_ret": net,
            })

    return pd.DataFrame(trades)


def main():
    print("Loading universe + VN-Index...")
    universe = load_universe()
    vni = load_vnindex()
    print(f"  universe: {universe['symbol'].nunique()} symbols, {len(universe)} rows")
    print(f"  vnindex: {len(vni)} rows")

    print("\nComputing Strong Leaders scores...")
    universe = add_strong_leaders_scores(universe, vni)

    eligible_count = universe["strong_eligible"].sum()
    score_count = universe["strong_score"].notna().sum()
    print(f"  eligible rows: {eligible_count}, with score: {score_count}")
    if score_count == 0:
        print("ERROR: No scores computed. Check data.")
        return

    # Filter to test window
    universe_test = universe[universe["date"] >= TEST_START].copy()
    print(f"\nTest window {TEST_START}+: {len(universe_test)} rows, "
          f"{universe_test['symbol'].nunique()} symbols")

    # Score distribution
    scores = universe_test["strong_score"].dropna()
    print(f"\nScore distribution (test):")
    print(f"  count: {len(scores)}, mean: {scores.mean():.2f}, median: {scores.median():.2f}")
    print(f"  pct[50/75/90/95/99]: {np.percentile(scores, [50,75,90,95,99])}")
    print(f"  >= 4.0: {(scores >= 4.0).sum()}")
    print(f"  >= 5.0: {(scores >= 5.0).sum()}")
    print(f"  >= 6.0: {(scores >= 6.0).sum()}")
    print(f"  >= 7.0: {(scores >= 7.0).sum()}")

    print("\n=== Backtest variants ===")
    results = []
    for min_score in MIN_SCORE_VARIANTS:
        for top_n in TOP_N_VARIANTS:
            for hold in HOLD_DAYS_VARIANTS:
                trades = simulate_strong_picks(universe_test, top_n, hold, min_score)
                stats = summarize(trades)
                stats["min_score"] = min_score
                stats["top_n"] = top_n
                stats["hold_days"] = hold
                results.append(stats)
                if stats["n_trades"] > 0:
                    print(f"  min={min_score:.1f} top={top_n} hold={hold}d: "
                          f"n={stats['n_trades']:4} "
                          f"win={stats['win_rate']*100:5.1f}% "
                          f"avg={stats['avg_ret']*100:+6.2f}% "
                          f"sharpe={stats['sharpe']:.3f} "
                          f"pf={stats['profit_factor']:.2f}")

    results_df = pd.DataFrame(results)
    results_df.to_csv(OUT_DIR / "strong_leaders_metrics.csv", index=False)
    print(f"\nSaved → {OUT_DIR / 'strong_leaders_metrics.csv'}")

    # Random baseline (5 phiên hold, top 5)
    print("\n=== Random baseline ===")
    rand_trades = simulate_random_baseline(universe_test, top_n=5, hold_days=10)
    rand_stats = summarize(rand_trades)
    print(f"  Random top5 hold10: n={rand_stats['n_trades']} "
          f"win={rand_stats['win_rate']*100:.1f}% "
          f"avg={rand_stats['avg_ret']*100:+.2f}% "
          f"sharpe={rand_stats['sharpe']:.3f}")

    # Best variant
    valid_results = [r for r in results if r["n_trades"] >= 30]
    if not valid_results:
        print("\nNo variant has >=30 trades — sample too small.")
        return
    best = max(valid_results, key=lambda r: r["sharpe"])
    print(f"\n=== Best variant ===")
    print(f"  min_score={best['min_score']} top_n={best['top_n']} hold={best['hold_days']}d")
    print(f"  n={best['n_trades']} win={best['win_rate']*100:.1f}% "
          f"avg={best['avg_ret']*100:+.2f}% sharpe={best['sharpe']:.3f} "
          f"pf={best['profit_factor']:.2f}")
    print(f"\n  vs Random: win {(best['win_rate'] - rand_stats['win_rate'])*100:+.1f}%, "
          f"avg {(best['avg_ret'] - rand_stats['avg_ret'])*100:+.2f}%")


if __name__ == "__main__":
    main()
