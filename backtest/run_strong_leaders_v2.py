"""Strong Leaders v2 — add SL/TP cap + test more hold variants.

V1 found edge but Sharpe 0.165 (too low). Hypothesis: variance high vì
không cut losers + không lock winners. Add SL -8%, TP +12% intraday
(walk through daily OHLC) để xem có giảm variance không.
"""

from __future__ import annotations

from pathlib import Path
import numpy as np
import pandas as pd

from src.backtest import DEFAULT_COST_RT, summarize
from src.load_data import load_universe, load_vnindex
from src.strong_leaders_score import add_strong_leaders_scores

OUT_DIR = Path(__file__).parent / "results"

TEST_START = "2024-01-01"

# T+ TP/SL per Strong Leaders spec
TP1_PCT = 0.05   # +5%
TP2_PCT = 0.12   # +12%
SL_PCT = 0.08    # -8%


def simulate_with_tp_sl(
    universe_df: pd.DataFrame,
    top_n: int,
    max_hold: int,
    min_score: float,
    cost_rt: float = DEFAULT_COST_RT,
) -> pd.DataFrame:
    """Simulate với intraday SL/TP exit:
       - SL hit (low <= entry × 0.92) → exit at SL
       - TP2 hit (high >= entry × 1.12) → exit at TP2 (priority over TP1)
       - TP1 hit (high >= entry × 1.05) → exit at TP1 (50% size effectively → use TP1)
       - Else hold tới max_hold, exit close
       Daily check, SL ưu tiên nếu cùng ngày met cả 2 (conservative).
    """
    df = universe_df.copy()
    df["date"] = pd.to_datetime(df["date"])

    open_pivot = df.pivot_table(index="date", columns="symbol", values="open", aggfunc="first")
    high_pivot = df.pivot_table(index="date", columns="symbol", values="high", aggfunc="first")
    low_pivot = df.pivot_table(index="date", columns="symbol", values="low", aggfunc="first")
    close_pivot = df.pivot_table(index="date", columns="symbol", values="close", aggfunc="first")
    score_pivot = df.pivot_table(index="date", columns="symbol", values="strong_score", aggfunc="first")

    all_dates = score_pivot.index
    trades = []

    for i, sig_date in enumerate(all_dates):
        scores = score_pivot.loc[sig_date].dropna()
        valid = scores[scores >= min_score]
        if len(valid) == 0 or i + 1 >= len(all_dates):
            continue

        top = valid.sort_values(ascending=False).head(top_n)
        entry_date = all_dates[i + 1]

        for sym, score in top.items():
            entry_price = open_pivot.loc[entry_date, sym] if sym in open_pivot.columns else np.nan
            if pd.isna(entry_price) or entry_price <= 0:
                continue

            sl_px = entry_price * (1 - SL_PCT)
            tp1_px = entry_price * (1 + TP1_PCT)
            tp2_px = entry_price * (1 + TP2_PCT)

            exit_price = None
            exit_kind = None
            exit_idx = None

            # Walk through daily bars from entry_date to entry+max_hold
            max_walk = min(max_hold, len(all_dates) - i - 1)
            for j in range(1, max_walk + 1):
                bar_date = all_dates[i + j]
                hi = high_pivot.loc[bar_date, sym] if sym in high_pivot.columns else np.nan
                lo = low_pivot.loc[bar_date, sym] if sym in low_pivot.columns else np.nan
                cl = close_pivot.loc[bar_date, sym] if sym in close_pivot.columns else np.nan
                if pd.isna(hi) or pd.isna(lo) or pd.isna(cl):
                    continue
                # SL priority same-bar (conservative)
                if lo <= sl_px:
                    exit_price = sl_px
                    exit_kind = "sl"
                    exit_idx = i + j
                    break
                if hi >= tp2_px:
                    exit_price = tp2_px
                    exit_kind = "tp2"
                    exit_idx = i + j
                    break
                if hi >= tp1_px:
                    exit_price = tp1_px
                    exit_kind = "tp1"
                    exit_idx = i + j
                    break

            if exit_price is None:
                # Held to max_hold, exit close
                final_idx = i + max_walk
                if final_idx >= len(all_dates):
                    continue
                exit_date = all_dates[final_idx]
                exit_price = close_pivot.loc[exit_date, sym] if sym in close_pivot.columns else np.nan
                exit_kind = "expired"
                exit_idx = final_idx
                if pd.isna(exit_price):
                    continue

            gross = (exit_price - entry_price) / entry_price
            net = gross - cost_rt
            trades.append({
                "signal_date": sig_date,
                "entry_date": entry_date,
                "exit_date": all_dates[exit_idx],
                "symbol": sym,
                "score": float(score),
                "entry_price": entry_price,
                "exit_price": exit_price,
                "gross_ret": gross,
                "net_ret": net,
                "exit_kind": exit_kind,
                "hold_days": exit_idx - i,
            })

    return pd.DataFrame(trades)


def main():
    print("Loading + scoring...")
    universe = load_universe()
    vni = load_vnindex()
    universe = add_strong_leaders_scores(universe, vni)
    universe_test = universe[universe["date"] >= TEST_START].copy()
    print(f"  Test rows: {len(universe_test)}")

    print("\n=== With TP/SL exit (max hold variants) ===")
    print(f"  TP1={TP1_PCT*100}%, TP2={TP2_PCT*100}%, SL={SL_PCT*100}%")
    results = []
    for min_score in [4.0, 5.0, 6.0]:
        for top_n in [3, 5]:
            for max_hold in [10, 15, 20]:
                trades = simulate_with_tp_sl(universe_test, top_n, max_hold, min_score)
                if len(trades) == 0:
                    continue
                stats = summarize(trades)
                # Exit distribution
                exit_dist = trades["exit_kind"].value_counts().to_dict()
                avg_hold = trades["hold_days"].mean()
                stats.update({
                    "min_score": min_score, "top_n": top_n, "max_hold": max_hold,
                    "avg_hold_actual": avg_hold,
                    "sl_pct": exit_dist.get("sl", 0) / len(trades) * 100,
                    "tp1_pct": exit_dist.get("tp1", 0) / len(trades) * 100,
                    "tp2_pct": exit_dist.get("tp2", 0) / len(trades) * 100,
                    "expired_pct": exit_dist.get("expired", 0) / len(trades) * 100,
                })
                results.append(stats)
                print(f"  min={min_score:.1f} top={top_n} hold≤{max_hold}d: "
                      f"n={stats['n_trades']:4} "
                      f"win={stats['win_rate']*100:5.1f}% "
                      f"avg={stats['avg_ret']*100:+6.2f}% "
                      f"sharpe={stats['sharpe']:.3f} "
                      f"pf={stats['profit_factor']:.2f} | "
                      f"TP2:{stats['tp2_pct']:.0f}% TP1:{stats['tp1_pct']:.0f}% "
                      f"SL:{stats['sl_pct']:.0f}% exp:{stats['expired_pct']:.0f}% "
                      f"avgHold:{avg_hold:.1f}d")

    pd.DataFrame(results).to_csv(OUT_DIR / "strong_leaders_v2_metrics.csv", index=False)
    valid = [r for r in results if r["n_trades"] >= 50]
    if valid:
        best = max(valid, key=lambda r: r["sharpe"])
        print(f"\n=== Best variant (v2) ===")
        print(f"  min_score={best['min_score']} top_n={best['top_n']} hold≤{best['max_hold']}d")
        print(f"  n={best['n_trades']} win={best['win_rate']*100:.1f}% "
              f"avg={best['avg_ret']*100:+.2f}% sharpe={best['sharpe']:.3f}")
        print(f"  Exit dist: TP2 {best['tp2_pct']:.0f}% / TP1 {best['tp1_pct']:.0f}% / "
              f"SL {best['sl_pct']:.0f}% / expired {best['expired_pct']:.0f}%")


if __name__ == "__main__":
    main()
