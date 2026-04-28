"""Phase 5 — Strong Mode Backtest (trend-following swing).

Strategy: pick top-N mã có strong_score cao nhất (>= threshold) làm pick T+1,
hold N phiên (test 30/60/90), exit close. Apply -8% hard SL.

Mục tiêu: validate xem strong setup có edge so với:
  - Random pick from eligible universe (no skill)
  - Buy-and-hold VN-Index
  - Buy-and-hold VN30 ETF (~E1VFVN30 proxy = top liquid universe)

Decision criteria (sau khi run):
  - OOS Sharpe ≥ 0.5, CAGR > VN-Index by 3%+, max_dd < 25% → ship
  - Else: reject mode, không integrate vào app

Run:
  cd backtest
  python run_phase5_strong.py
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from src.backtest import DEFAULT_COST_RT, summarize
from src.load_data import load_universe, load_vnindex
from src.strong_score import (
    DEFAULT_THRESHOLD,
    DEFAULT_WEIGHTS,
    add_strong_scores,
    merge_fundamentals,
)

OUT_DIR = Path(__file__).parent / "results"
OUT_DIR.mkdir(exist_ok=True)
PHASE5_DIR = OUT_DIR / "phase5_strong"
PHASE5_DIR.mkdir(exist_ok=True)

TRAIN_END = "2024-12-31"
TEST_START = "2025-01-01"

# Test variants
HOLD_DAYS_VARIANTS = [30, 60, 90]
TOP_N_VARIANTS = [5, 10, 15]
THRESHOLD_VARIANTS = [5.0, 6.0, 7.0, 8.0, 9.0]
HARD_SL = -0.08  # -8% from entry


def simulate_strong_picks(
    universe_df: pd.DataFrame,
    top_n: int,
    hold_days: int,
    threshold: float = DEFAULT_THRESHOLD,
    cost_rt: float = DEFAULT_COST_RT,
    hard_sl: float = HARD_SL,
) -> pd.DataFrame:
    """Pick top-N strong scores per day, hold N days với SL kiểm tra mỗi ngày.

    Entry: open T+1
    Exit: close T+1+hold_days HOẶC SL trigger (close < entry × (1 + hard_sl))
    """
    df = universe_df.copy()
    df["date"] = pd.to_datetime(df["date"])

    open_pivot = df.pivot_table(index="date", columns="symbol", values="open", aggfunc="first")
    close_pivot = df.pivot_table(index="date", columns="symbol", values="close", aggfunc="first")
    score_pivot = df.pivot_table(index="date", columns="symbol", values="strong_score", aggfunc="first")

    all_dates = score_pivot.index
    trades = []

    for i, sig_date in enumerate(all_dates):
        scores = score_pivot.loc[sig_date].dropna()
        # Filter: score >= threshold AND không bị reject (-inf)
        valid = scores[(scores >= threshold) & (scores > -np.inf)]
        if len(valid) == 0:
            continue
        top = valid.nlargest(top_n)

        entry_idx = i + 1
        if entry_idx >= len(all_dates):
            continue
        entry_date = all_dates[entry_idx]

        for sym, score in top.items():
            if entry_date not in open_pivot.index:
                continue
            entry_price = open_pivot.loc[entry_date, sym]
            if pd.isna(entry_price) or entry_price <= 0:
                continue

            # Walk through hold period, check SL each day
            sl_price = entry_price * (1 + hard_sl)
            exit_price = None
            exit_date = None
            exit_reason = "time_stop"

            max_idx = min(entry_idx + hold_days, len(all_dates) - 1)
            for j in range(entry_idx + 1, max_idx + 1):
                d = all_dates[j]
                px = close_pivot.loc[d, sym] if d in close_pivot.index else np.nan
                if pd.isna(px):
                    continue
                if px <= sl_price:
                    exit_price = px
                    exit_date = d
                    exit_reason = "stop_loss"
                    break

            # No SL trigger: exit at hold_days close
            if exit_price is None:
                exit_idx = max_idx
                exit_date = all_dates[exit_idx]
                exit_price = close_pivot.loc[exit_date, sym] if exit_date in close_pivot.index else np.nan

            if pd.isna(exit_price) or exit_price <= 0:
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
                "exit_reason": exit_reason,
                "days_held": (exit_date - entry_date).days if exit_date else None,
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
    score_pivot = df.pivot_table(index="date", columns="symbol", values="strong_score", aggfunc="first")

    all_dates = score_pivot.index
    trades = []

    for i, sig_date in enumerate(all_dates):
        scores = score_pivot.loc[sig_date].dropna()
        # Eligible = không bị reject (score > -inf)
        eligible_syms = scores[scores > -np.inf].index.tolist()
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
                "entry_price": entry_price,
                "exit_price": exit_price,
                "gross_ret": gross,
                "net_ret": gross - cost_rt,
            })
    return pd.DataFrame(trades)


def vnindex_baseline(vnindex_df: pd.DataFrame, hold_days: int, cost_rt: float = DEFAULT_COST_RT) -> dict:
    """Buy-and-hold VN-Index baseline."""
    df = vnindex_df.copy()
    df["date"] = pd.to_datetime(df["date"]).reset_index(drop=True)
    df = df.sort_values("date").reset_index(drop=True)
    rets = []
    for i in range(len(df) - hold_days - 1):
        entry = df.iloc[i + 1]["open"]
        exit_ = df.iloc[i + 1 + hold_days]["close"]
        if entry > 0:
            rets.append((exit_ - entry) / entry - cost_rt)
    if not rets:
        return {"avg_ret": np.nan, "win_rate": np.nan, "n": 0}
    arr = np.array(rets)
    return {
        "avg_ret": arr.mean(),
        "win_rate": (arr > 0).mean(),
        "n": len(arr),
    }


def run_grid(
    universe_df: pd.DataFrame,
    period_label: str,
) -> pd.DataFrame:
    """Grid search across threshold × top_n × hold_days, output stats CSV."""
    rows = []
    for threshold in THRESHOLD_VARIANTS:
        for top_n in TOP_N_VARIANTS:
            for hold in HOLD_DAYS_VARIANTS:
                trades = simulate_strong_picks(universe_df, top_n, hold, threshold)
                if len(trades) == 0:
                    continue
                stats = summarize(trades)
                stats.update({
                    "period": period_label,
                    "threshold": threshold,
                    "top_n": top_n,
                    "hold_days": hold,
                })
                rows.append(stats)
                print(
                    f"[{period_label}] thr={threshold} top_n={top_n} hold={hold}: "
                    f"n={stats['n_trades']} win={stats['win_rate']:.1%} "
                    f"avg={stats['avg_ret']:.2%} sharpe={stats['sharpe']:.2f}"
                )
    return pd.DataFrame(rows)


def main():
    print("[Phase 5] Loading universe + computing indicators...")
    df = load_universe()
    print(f"  → {df['symbol'].nunique()} symbols, {len(df)} rows")

    print("[Phase 5] Merging fundamentals (ROE, foreign_pct)...")
    df = merge_fundamentals(df)

    print("[Phase 5] Computing strong scores (uniform weights)...")
    df = add_strong_scores(df, weights=DEFAULT_WEIGHTS, threshold=DEFAULT_THRESHOLD)

    # Train / test split
    train_df = df[df["date"] <= TRAIN_END].copy()
    test_df = df[df["date"] >= TEST_START].copy()

    print(f"\n[Phase 5] === TRAIN ({df['date'].min().date()} → {TRAIN_END}) ===")
    train_grid = run_grid(train_df, "train")
    train_grid.to_csv(PHASE5_DIR / "grid_train.csv", index=False)

    print(f"\n[Phase 5] === TEST OOS (>= {TEST_START}) ===")
    test_grid = run_grid(test_df, "test")
    test_grid.to_csv(PHASE5_DIR / "grid_test.csv", index=False)

    # Pick best train config by Sharpe (with min n_trades guard)
    train_eligible = train_grid[train_grid["n_trades"] >= 30]
    if len(train_eligible) > 0:
        best_train = train_eligible.sort_values("sharpe", ascending=False).iloc[0]
        print(f"\n[Phase 5] Best train config: thr={best_train['threshold']} "
              f"top_n={best_train['top_n']} hold={best_train['hold_days']}")
        print(f"  Train: n={best_train['n_trades']} win={best_train['win_rate']:.1%} "
              f"avg={best_train['avg_ret']:.2%} sharpe={best_train['sharpe']:.2f}")

        # Find same config in test
        oos_match = test_grid[
            (test_grid["threshold"] == best_train["threshold"])
            & (test_grid["top_n"] == best_train["top_n"])
            & (test_grid["hold_days"] == best_train["hold_days"])
        ]
        if len(oos_match) > 0:
            o = oos_match.iloc[0]
            print(f"  OOS:   n={o['n_trades']} win={o['win_rate']:.1%} "
                  f"avg={o['avg_ret']:.2%} sharpe={o['sharpe']:.2f}")
            metric_drop = (best_train["sharpe"] - o["sharpe"]) / abs(best_train["sharpe"]) if best_train["sharpe"] else 0
            print(f"  Sharpe drop: {metric_drop:.1%}")

    # Baselines for context
    print("\n[Phase 5] === BASELINES (hold=60 phiên, top_n=10) ===")
    bench_random = random_baseline(test_df, top_n=10, hold_days=60)
    bench_random_stats = summarize(bench_random) if len(bench_random) else None
    if bench_random_stats:
        print(f"  Random: n={bench_random_stats['n_trades']} win={bench_random_stats['win_rate']:.1%} "
              f"avg={bench_random_stats['avg_ret']:.2%}")

    vni = load_vnindex()
    vni_test = vni[vni["date"] >= TEST_START]
    bench_vni = vnindex_baseline(vni_test, hold_days=60)
    print(f"  VN-Index B&H: n={bench_vni['n']} win={bench_vni['win_rate']:.1%} "
          f"avg={bench_vni['avg_ret']:.2%}")

    print(f"\n[Phase 5] Output saved to {PHASE5_DIR}/")
    print("  - grid_train.csv: tuning results on train")
    print("  - grid_test.csv: OOS validation")
    print("\nNext: review CSVs, decide ship/reject per criteria in plan.")


if __name__ == "__main__":
    main()
