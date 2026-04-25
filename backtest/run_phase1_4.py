"""Phase 1.4 — Combined scoring system backtest.

Tests the FULL scoring logic from stock-pwa/analysis.js as a tradeable strategy.
- Long when score >= entry threshold
- Flat when score <= exit threshold (hysteresis)
- Compares against VN-Index B&H, equal-weight 55-stock B&H

Output: equity curves, metrics table, train/test comparison.
"""

from __future__ import annotations

from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd

from src.load_data import load_universe, load_vnindex
from src.portfolio import (
    aggregate_long_only,
    benchmark_buy_hold,
    benchmark_equal_weight_bh,
    compute_metrics,
    equity_curve,
    print_metrics_table,
)
from src.scoring import add_scores
from src.strategy import simulate_universe

OUT_DIR = Path(__file__).parent / "results"
OUT_DIR.mkdir(exist_ok=True)

TRAIN_END = "2022-12-31"
TEST_START = "2023-01-01"

VARIANTS = [
    {"name": "BUY (entry=2, exit=0)", "entry": 2.0, "exit": 0.0},
    {"name": "BUY tight (entry=2, exit=2)", "entry": 2.0, "exit": 2.0},
    {"name": "STRONG_BUY only (entry=4, exit=2)", "entry": 4.0, "exit": 2.0},
]


def evaluate_period(label: str, universe: pd.DataFrame, vnindex: pd.DataFrame) -> dict[str, dict]:
    print(f"\n{'='*70}\n{label}\n{'='*70}")

    # Limit VN-Index to same date range
    date_min = universe["date"].min()
    date_max = universe["date"].max()
    vni = vnindex[(vnindex["date"] >= date_min) & (vnindex["date"] <= date_max)]

    # Benchmarks
    bh_vni = benchmark_buy_hold(vni)
    bh_eq = benchmark_equal_weight_bh(universe)

    metrics: dict[str, dict] = {}
    metrics["VN-Index B&H"] = compute_metrics(bh_vni)
    metrics["Equal-Weight 55 B&H"] = compute_metrics(bh_eq)

    equity_curves: dict[str, pd.Series] = {}
    equity_curves["VN-Index B&H"] = equity_curve(bh_vni)
    equity_curves["Equal-Weight 55 B&H"] = equity_curve(bh_eq)

    # Strategy variants
    for v in VARIANTS:
        per_sym, trades = simulate_universe(
            universe, entry=v["entry"], exit_=v["exit"]
        )
        portfolio = aggregate_long_only(per_sym)
        m = compute_metrics(portfolio["ret"])
        m["n_trades"] = len(trades)
        m["avg_n_long_per_day"] = portfolio["n_long"].mean()
        m["avg_trade_days"] = trades["days_held"].mean() if len(trades) else None
        m["avg_trade_ret"] = trades["net_ret"].mean() if len(trades) else None
        m["trade_win_rate"] = (trades["net_ret"] > 0).mean() if len(trades) else None
        metrics[v["name"]] = m
        equity_curves[v["name"]] = equity_curve(portfolio["ret"])

    print_metrics_table(metrics)

    print("\nStrategy details:")
    for v in VARIANTS:
        m = metrics[v["name"]]
        print(
            f"  {v['name']}: trades={m.get('n_trades', 0)}, "
            f"avg long/day={m.get('avg_n_long_per_day', 0):.1f}, "
            f"avg hold={m.get('avg_trade_days', 0):.1f}d, "
            f"avg trade ret={m.get('avg_trade_ret', 0)*100:.2f}%, "
            f"trade win rate={m.get('trade_win_rate', 0)*100:.1f}%"
        )

    return metrics, equity_curves


def plot_equity_curves(curves: dict[str, pd.Series], title: str, out_path: Path) -> None:
    plt.figure(figsize=(11, 6))
    for name, eq in curves.items():
        plt.plot(eq.index, eq.values, label=name, linewidth=1.5)
    plt.title(title)
    plt.xlabel("Date")
    plt.ylabel("Equity (start = 1.0)")
    plt.legend(loc="best", fontsize=9)
    plt.grid(True, alpha=0.3)
    plt.yscale("log")
    plt.tight_layout()
    plt.savefig(out_path, dpi=120)
    plt.close()
    print(f"Saved chart → {out_path}")


def main() -> None:
    print("Loading universe + indicators...")
    universe = load_universe()
    print(f"  {len(universe):,} rows, {universe.symbol.nunique()} symbols")

    print("Computing scores per symbol...")
    universe = add_scores(universe)
    print(f"  Score distribution: min={universe.score.min()}, max={universe.score.max()}")
    print(f"  Recommendation breakdown:")
    print(universe["recommendation"].value_counts().to_string())

    vnindex = load_vnindex()

    # Train period
    train = universe[universe["date"] <= pd.Timestamp(TRAIN_END)]
    metrics_train, curves_train = evaluate_period("TRAIN (2018 → 2022)", train, vnindex)
    plot_equity_curves(curves_train, "Phase 1.4 — Equity Curve (TRAIN 2018-2022)",
                       OUT_DIR / "phase1_4_equity_train.png")

    # Test period
    test = universe[universe["date"] >= pd.Timestamp(TEST_START)]
    metrics_test, curves_test = evaluate_period("TEST (2023 → now)", test, vnindex)
    plot_equity_curves(curves_test, "Phase 1.4 — Equity Curve (TEST 2023+)",
                       OUT_DIR / "phase1_4_equity_test.png")

    # Full period
    metrics_full, curves_full = evaluate_period("FULL PERIOD (2018 → now)", universe, vnindex)
    plot_equity_curves(curves_full, "Phase 1.4 — Equity Curve (FULL 2018+)",
                       OUT_DIR / "phase1_4_equity_full.png")

    # Save metrics to CSV for later analysis
    rows = []
    for period, mdict in [("train", metrics_train), ("test", metrics_test), ("full", metrics_full)]:
        for strat, m in mdict.items():
            rows.append({"period": period, "strategy": strat, **m})
    pd.DataFrame(rows).to_csv(OUT_DIR / "phase1_4_metrics.csv", index=False)
    print(f"\nSaved metrics → {OUT_DIR}/phase1_4_metrics.csv")


if __name__ == "__main__":
    main()
