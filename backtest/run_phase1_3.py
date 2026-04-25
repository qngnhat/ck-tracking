"""Phase 1.3 — Single signal backtest runner.

Runs every signal in src.signals.ALL_SIGNALS at multiple hold periods,
compares against a no-skill baseline, and prints a ranking table.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

from src.backtest import baseline_return, run_signal, summarize
from src.load_data import load_universe
from src.signals import ALL_SIGNALS

HOLD_PERIODS = [5, 10, 20]  # trading days
TRAIN_END = "2022-12-31"  # in-sample / train period
TEST_START = "2023-01-01"  # out-of-sample / test period


def run_period(label: str, df: pd.DataFrame, hold_periods: list[int]) -> pd.DataFrame:
    print(f"\n=== {label} (hold periods: {hold_periods}) ===")

    rows: list[dict] = []
    baselines: dict[int, dict] = {}
    for hd in hold_periods:
        baselines[hd] = baseline_return(df, hd)

    for sig_name, sig_fn in ALL_SIGNALS.items():
        for hd in hold_periods:
            trades = run_signal(df, sig_fn, hd)
            stats = summarize(trades)
            edge = stats.get("avg_ret", 0) - baselines[hd].get("avg_ret", 0)
            rows.append({
                "signal": sig_name,
                "hold": hd,
                "n_trades": stats["n_trades"],
                "win_rate": stats["win_rate"],
                "avg_ret": stats["avg_ret"],
                "median_ret": stats["median_ret"],
                "sharpe": stats["sharpe"],
                "best": stats["best"],
                "worst": stats["worst"],
                "profit_factor": stats["profit_factor"],
                "baseline_ret": baselines[hd].get("avg_ret"),
                "edge_vs_baseline": edge,
            })
        print(f"  ✓ {sig_name}")

    return pd.DataFrame(rows)


def print_ranking(results: pd.DataFrame, hold_days: int = 10) -> None:
    sub = results[results["hold"] == hold_days].copy()
    sub = sub.sort_values("sharpe", ascending=False)

    print(f"\n--- Ranking by Sharpe (hold={hold_days} days) ---")
    print(f"{'Signal':<25} {'N':>6} {'WinRt':>7} {'Avg%':>7} {'Med%':>7} {'Sharpe':>7} {'Edge%':>7}")
    print("-" * 75)
    for _, row in sub.iterrows():
        if pd.isna(row["sharpe"]):
            continue
        print(
            f"{row['signal']:<25} "
            f"{int(row['n_trades']):>6} "
            f"{row['win_rate'] * 100:>6.1f}% "
            f"{row['avg_ret'] * 100:>6.2f}% "
            f"{row['median_ret'] * 100:>6.2f}% "
            f"{row['sharpe']:>7.3f} "
            f"{row['edge_vs_baseline'] * 100:>6.2f}%"
        )


def main():
    out_dir = Path(__file__).parent / "results"
    out_dir.mkdir(exist_ok=True)

    print("Loading universe with indicators...")
    full = load_universe()
    print(f"  Total: {len(full):,} rows, {full.symbol.nunique()} symbols")

    train = full[full["date"] <= pd.Timestamp(TRAIN_END)]
    test = full[full["date"] >= pd.Timestamp(TEST_START)]
    print(f"  Train (2018 → {TRAIN_END}): {len(train):,} rows")
    print(f"  Test  ({TEST_START} → now): {len(test):,} rows")

    # Train (in-sample)
    train_results = run_period("TRAIN (in-sample)", train, HOLD_PERIODS)
    train_results.to_csv(out_dir / "phase1_3_train.csv", index=False)
    for hd in HOLD_PERIODS:
        print_ranking(train_results, hd)

    # Test (out-of-sample)
    test_results = run_period("TEST (out-of-sample)", test, HOLD_PERIODS)
    test_results.to_csv(out_dir / "phase1_3_test.csv", index=False)
    for hd in HOLD_PERIODS:
        print_ranking(test_results, hd)

    # Print baseline summary
    print("\n=== BASELINES (no-skill: random entry, hold N days) ===")
    for hd in HOLD_PERIODS:
        b_train = baseline_return(train, hd)
        b_test = baseline_return(test, hd)
        print(f"hold={hd:>2}d: TRAIN avg={b_train['avg_ret']*100:.2f}%/winRt={b_train['win_rate']*100:.1f}% | "
              f"TEST avg={b_test['avg_ret']*100:.2f}%/winRt={b_test['win_rate']*100:.1f}%")

    print(f"\nResults saved → {out_dir}/phase1_3_train.csv, phase1_3_test.csv")


if __name__ == "__main__":
    main()
