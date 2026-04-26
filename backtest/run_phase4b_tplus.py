"""Phase 4b — T+ Ranking Backtest.

Strategy: mỗi ngày sau khi đóng cửa, lấy top N mã có T+ score cao nhất (>= 2.0).
Mua giá mở cửa T+1, hold 20 phiên, bán giá đóng cửa T+1+20.

Mục tiêu: validate xem chiến lược pick top-N theo T+ score có edge so với:
  - Random pick top-N từ universe (no skill)
  - Buy-and-hold VN-Index trong cùng kỳ
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from src.backtest import DEFAULT_COST_RT, summarize
from src.load_data import load_universe, load_vnindex
from src.tplus_score import T_PLUS_MIN_SCORE, add_tplus_scores

OUT_DIR = Path(__file__).parent / "results"
OUT_DIR.mkdir(exist_ok=True)

TRAIN_END = "2022-12-31"
TEST_START = "2023-01-01"

HOLD_DAYS_VARIANTS = [10, 15, 20, 30]
TOP_N_VARIANTS = [3, 5, 10]
MIN_SCORE_VARIANTS = [2.0, 3.0, 4.0, 5.0]


def simulate_tplus_picks(
    universe_df: pd.DataFrame,
    top_n: int,
    hold_days: int,
    min_score: float = T_PLUS_MIN_SCORE,
    cost_rt: float = DEFAULT_COST_RT,
) -> pd.DataFrame:
    """For each day, pick top-N stocks by T+ score (>= min_score), trade them.

    Returns DataFrame of trades: signal_date, entry_date, exit_date, symbol,
    entry_price, exit_price, gross_ret, net_ret.
    """
    df = universe_df.copy()
    df["date"] = pd.to_datetime(df["date"])

    # Pivot for fast lookup
    open_pivot = df.pivot_table(index="date", columns="symbol", values="open", aggfunc="first")
    close_pivot = df.pivot_table(index="date", columns="symbol", values="close", aggfunc="first")
    score_pivot = df.pivot_table(index="date", columns="symbol", values="tplus_score", aggfunc="first")

    all_dates = score_pivot.index
    trades = []

    for i, sig_date in enumerate(all_dates):
        scores = score_pivot.loc[sig_date].dropna()
        valid = scores[scores >= min_score]
        if len(valid) == 0:
            continue
        top = valid.nlargest(top_n)

        entry_idx = i + 1
        exit_idx = entry_idx + hold_days
        if exit_idx >= len(all_dates):
            continue
        entry_date = all_dates[entry_idx]
        exit_date = all_dates[exit_idx]

        for sym, score in top.items():
            entry_price = open_pivot.loc[entry_date, sym] if entry_date in open_pivot.index else np.nan
            exit_price = close_pivot.loc[exit_date, sym] if exit_date in close_pivot.index else np.nan
            if pd.isna(entry_price) or pd.isna(exit_price) or entry_price <= 0:
                continue
            gross = (exit_price - entry_price) / entry_price
            trades.append({
                "signal_date": sig_date,
                "entry_date": entry_date,
                "exit_date": exit_date,
                "symbol": sym,
                "score": score,
                "entry_price": entry_price,
                "exit_price": exit_price,
                "gross_ret": gross,
                "net_ret": gross - cost_rt,
            })

    return pd.DataFrame(trades)


def random_baseline(
    universe_df: pd.DataFrame,
    top_n: int,
    hold_days: int,
    cost_rt: float = DEFAULT_COST_RT,
    seed: int = 42,
) -> pd.DataFrame:
    """Pick random N stocks each day from eligible universe (no-skill baseline)."""
    rng = np.random.default_rng(seed)
    df = universe_df.copy()
    df["date"] = pd.to_datetime(df["date"])
    open_pivot = df.pivot_table(index="date", columns="symbol", values="open", aggfunc="first")
    close_pivot = df.pivot_table(index="date", columns="symbol", values="close", aggfunc="first")
    elig_pivot = df.pivot_table(index="date", columns="symbol", values="tplus_eligible", aggfunc="first")

    all_dates = open_pivot.index
    trades = []

    for i, sig_date in enumerate(all_dates):
        eligible_today = elig_pivot.loc[sig_date]
        eligible_syms = eligible_today[eligible_today == True].index.tolist()
        if len(eligible_syms) < top_n:
            continue
        chosen = rng.choice(eligible_syms, size=top_n, replace=False)

        entry_idx = i + 1
        exit_idx = entry_idx + hold_days
        if exit_idx >= len(all_dates):
            continue
        entry_date = all_dates[entry_idx]
        exit_date = all_dates[exit_idx]

        for sym in chosen:
            entry_price = open_pivot.loc[entry_date, sym]
            exit_price = close_pivot.loc[exit_date, sym]
            if pd.isna(entry_price) or pd.isna(exit_price) or entry_price <= 0:
                continue
            gross = (exit_price - entry_price) / entry_price
            trades.append({
                "signal_date": sig_date,
                "entry_date": entry_date,
                "exit_date": exit_date,
                "symbol": sym,
                "gross_ret": gross,
                "net_ret": gross - cost_rt,
            })
    return pd.DataFrame(trades)


def evaluate_period(label: str, universe: pd.DataFrame) -> dict:
    print(f"\n{'='*72}\n{label}\n{'='*72}")

    # Sample: how often is min_score met?
    score_dist = universe["tplus_score"].dropna()
    valid = score_dist[score_dist >= T_PLUS_MIN_SCORE]
    print(f"  Total day-stock observations with score: {len(score_dist):,}")
    print(f"  Where score >= {T_PLUS_MIN_SCORE}: {len(valid):,} ({len(valid)/len(score_dist)*100:.1f}%)")
    print(f"  Score percentiles: 50%={score_dist.quantile(0.5):.2f}, 75%={score_dist.quantile(0.75):.2f}, 90%={score_dist.quantile(0.9):.2f}, 95%={score_dist.quantile(0.95):.2f}")

    print(f"\n  {'MinSc':<7} {'TopN':<6} {'Hold':<6} {'N':<7} {'WinRt':<7} {'Avg%':<7} {'Sharpe':<8} {'PF':<6}")
    print("  " + "-" * 60)

    results: dict = {}
    for min_sc in MIN_SCORE_VARIANTS:
        for hold in [20]:  # focus on hold=20 (sweet spot from Phase 1.3)
            for top_n in TOP_N_VARIANTS:
                trades = simulate_tplus_picks(universe, top_n, hold, min_score=min_sc)
                stats = summarize(trades)
                key = f"min{min_sc}_top{top_n}_hold{hold}"
                results[key] = stats
                print(
                    f"  {min_sc:<7.1f} {top_n:<6} {hold:<6} {stats['n_trades']:<7} "
                    f"{stats['win_rate']*100:>5.1f}% "
                    f"{stats['avg_ret']*100:>+6.2f}% "
                    f"{stats['sharpe']:>+6.3f} "
                    f"{stats['profit_factor']:>5.2f}"
                )

    # Random baseline (only at top 5, hold 20 — same params as main strategy)
    print("\n  Random baseline (no-skill):")
    rand_trades = random_baseline(universe, 5, 20)
    rand_stats = summarize(rand_trades)
    results["random_top5_hold20"] = rand_stats
    print(
        f"    Top 5 random / Hold 20:  N={rand_stats['n_trades']}, "
        f"WinRt={rand_stats['win_rate']*100:.1f}%, Avg={rand_stats['avg_ret']*100:+.2f}%, "
        f"Sharpe={rand_stats['sharpe']:+.3f}"
    )

    return results


def main() -> None:
    print("Loading universe + indicators...")
    universe = load_universe()
    print(f"  {len(universe):,} rows, {universe.symbol.nunique()} symbols")

    print("Computing T+ scores...")
    universe = add_tplus_scores(universe)

    train = universe[universe["date"] <= pd.Timestamp(TRAIN_END)]
    test = universe[universe["date"] >= pd.Timestamp(TEST_START)]
    full = universe

    train_results = evaluate_period(f"TRAIN ({train['date'].min().date()} → {TRAIN_END})", train)
    test_results = evaluate_period(f"TEST out-of-sample ({TEST_START} → {test['date'].max().date()})", test)
    full_results = evaluate_period(f"FULL ({full['date'].min().date()} → {full['date'].max().date()})", full)

    # Save CSV
    rows = []
    for period, results in [("train", train_results), ("test", test_results), ("full", full_results)]:
        for variant, stats in results.items():
            rows.append({"period": period, "variant": variant, **stats})
    pd.DataFrame(rows).to_csv(OUT_DIR / "phase4b_tplus_metrics.csv", index=False)
    print(f"\nSaved → {OUT_DIR}/phase4b_tplus_metrics.csv")


if __name__ == "__main__":
    main()
