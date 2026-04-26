"""Phase 4 — DCA Ranking Backtest.

Test top-N rebalance strategies với DCA score, so với:
  - Equal-Weight 55 (baseline)
  - VN-Index B&H

Variants:
  - Top 5, 10, 15 mã
  - Sector cap 2 vs no cap
  - Monthly vs quarterly rebalance
"""

from __future__ import annotations

from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd

from src.dca_score import prepare_dca_data
from src.load_data import load_universe, load_vnindex
from src.portfolio import (
    benchmark_buy_hold,
    benchmark_equal_weight_bh,
    compute_metrics,
    equity_curve,
    print_metrics_table,
)
from src.rebalance import simulate_topn_strategy

OUT_DIR = Path(__file__).parent / "results"
OUT_DIR.mkdir(exist_ok=True)

TRAIN_END = "2022-12-31"
TEST_START = "2023-01-01"


def evaluate_period(label: str, universe: pd.DataFrame, vnindex: pd.DataFrame) -> tuple[dict, dict]:
    print(f"\n{'='*72}\n{label}\n{'='*72}")

    date_min = universe["date"].min()
    date_max = universe["date"].max()
    vni = vnindex[(vnindex["date"] >= date_min) & (vnindex["date"] <= date_max)]

    metrics = {}
    curves = {}

    bh_vni = benchmark_buy_hold(vni)
    bh_eq = benchmark_equal_weight_bh(universe)
    metrics["VN-Index B&H"] = compute_metrics(bh_vni)
    metrics["EW 55 B&H"] = compute_metrics(bh_eq)
    curves["VN-Index B&H"] = equity_curve(bh_vni)
    curves["EW 55 B&H"] = equity_curve(bh_eq)

    variants = [
        ("Top 5 / sector cap 2 / Monthly", 5, 2, "MS"),
        ("Top 10 / sector cap 2 / Monthly", 10, 2, "MS"),
        ("Top 15 / sector cap 2 / Monthly", 15, 2, "MS"),
        ("Top 10 / no sector cap / Monthly", 10, None, "MS"),
        ("Top 10 / sector cap 2 / Quarterly", 10, 2, "QS"),
    ]

    for name, top_n, scap, freq in variants:
        result = simulate_topn_strategy(universe, top_n=top_n, sector_cap=scap, rebalance_freq=freq)
        m = compute_metrics(result["daily_ret"])
        m["n_rebalances"] = len(result["picks_log"])
        m["avg_turnover"] = result["turnover"].mean() if len(result["turnover"]) else 0
        metrics[name] = m
        curves[name] = equity_curve(result["daily_ret"])

    print_metrics_table(metrics)

    print("\nStrategy details:")
    for name in [n for n, *_ in variants]:
        m = metrics[name]
        print(f"  {name}: rebalances={m.get('n_rebalances')}, avg turnover={m.get('avg_turnover', 0):.2f}")

    return metrics, curves


def plot_curves(curves: dict[str, pd.Series], title: str, out_path: Path) -> None:
    plt.figure(figsize=(12, 6))
    # Sort by total return so top performers are clearly visible
    sorted_curves = sorted(curves.items(), key=lambda x: x[1].iloc[-1], reverse=True)
    for name, eq in sorted_curves:
        plt.plot(eq.index, eq.values, label=f"{name} ({eq.iloc[-1]:.2f}x)", linewidth=1.5)
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


def show_recent_picks(universe_with_score: pd.DataFrame) -> None:
    """In ra top picks gần nhất để user xem."""
    last_date = universe_with_score["date"].max()
    snap = universe_with_score[universe_with_score["date"] == last_date].sort_values(
        "dca_score", ascending=False
    )
    print(f"\n=== Top 15 mã DCA tại {last_date.date()} ===")
    cols = ["symbol", "dca_score", "f_ma200_quality", "f_low_drawdown", "f_momentum_6m",
            "f_trend_consistency", "f_liquidity", "f_foreign_flow_60d"]
    print(snap[cols].head(15).to_string(index=False, float_format=lambda x: f"{x:.3f}"))


def main() -> None:
    print("Loading universe + indicators...")
    universe = load_universe()
    print(f"  {len(universe):,} rows, {universe.symbol.nunique()} symbols")

    print("Computing DCA factors + scores...")
    universe = prepare_dca_data(universe)
    eligible = universe["dca_eligible"].sum()
    print(f"  Eligible rows: {eligible:,} / {len(universe):,} ({eligible/len(universe)*100:.1f}%)")

    show_recent_picks(universe)

    vnindex = load_vnindex()

    train = universe[universe["date"] <= pd.Timestamp(TRAIN_END)]
    metrics_train, curves_train = evaluate_period("TRAIN (2018 → 2022)", train, vnindex)
    plot_curves(curves_train, "Phase 4 — DCA Ranking (TRAIN 2018-2022)",
                OUT_DIR / "phase4_dca_train.png")

    test = universe[universe["date"] >= pd.Timestamp(TEST_START)]
    metrics_test, curves_test = evaluate_period("TEST out-of-sample (2023 → now)", test, vnindex)
    plot_curves(curves_test, "Phase 4 — DCA Ranking (TEST 2023+)",
                OUT_DIR / "phase4_dca_test.png")

    metrics_full, curves_full = evaluate_period("FULL PERIOD (2018 → now)", universe, vnindex)
    plot_curves(curves_full, "Phase 4 — DCA Ranking (FULL 2018+)",
                OUT_DIR / "phase4_dca_full.png")

    rows = []
    for period, mdict in [("train", metrics_train), ("test", metrics_test), ("full", metrics_full)]:
        for strat, m in mdict.items():
            rows.append({"period": period, "strategy": strat, **m})
    pd.DataFrame(rows).to_csv(OUT_DIR / "phase4_dca_metrics.csv", index=False)
    print(f"\nSaved metrics → {OUT_DIR}/phase4_dca_metrics.csv")


if __name__ == "__main__":
    main()
