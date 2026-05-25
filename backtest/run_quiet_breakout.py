"""Quiet Accumulation Breakout — REJECTED (cả V1 lẫn V2).

V1 (Train 2018-2023): Train Sharpe 0.58 nhưng Test 2024-26 ~0.
  → Suspected covid bull 2020-2021 pump Train artificially.

V2 (Train 2022-2024 post-covid): Train Sharpe chỉ 0.22, Test 0.02-0.08,
  Win rate 46-47% cả 2 splits (consistent, KHÔNG overfit) NHƯNG < 50%
  → lỗ chậm sau cost. Pattern thật sự không có edge.

KẾT LUẬN: Recall 0.3% (per verify_algo_vs_reality.py) là tradeoff cho
  precision-first strategy, KHÔNG phải bug có thể fix bằng pattern mới.
  "Winners" T+3..T+5 phần lớn random noise. Algo hiện tại
  (Climax precision 33% > baseline 19%) chấp nhận được.

────────────────────────────────────────────────────────────────────
Original hypothesis từ verify_algo_vs_reality diagnose:

Diagnose result (verify_algo_vs_reality.py, 20 phiên gần nhất, 199 mã):
- Recall 0.3% — app catch 2/638 winners (≥5% trong T+3..T+5 window)
- Missed winners characteristics (n=636):
    day_green   = 34%   (most winners NOT green at signal day)
    uptrend     = 11.6% (most winners NOT in uptrend stack)
    vol > 2×    = 8.2%  (most winners NOT have volume spike)
    median vol_ratio = 0.86×
    avg ret3d  = +0.24%, ret5d +0.55% (winners sideways before pump)
    avg range  = 3.31%

→ Pattern thực của winners VN T+: "tích lũy âm thầm → bứt phá đột ngột"
   (vol thấp, range nhỏ, sideways trước break).

Spec Quiet Accumulation:
- vol_ratio < vol_max (lặng lẽ, không pre-pump)
- range_pct < range_max (consolidation tight)
- |ret_5d| < ret_abs_max (sideways, không trend mạnh)
- close > MA20 (above structure — không deep downtrend, có thể đi tiếp)
- turnover ≥ 3 tỷ (liquidity gate)

Baseline: random pick = 19.4% (638 winner/3294 bars trong verify).
Target: Win rate >25% → có edge thật.

Cross-validation:
- Train: 2018-2023 (in-sample)
- Test:  2024-2026 (out-sample)
- Drop variants nào Train OK nhưng Test fail (overfit).
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from src.backtest import DEFAULT_COST_RT
from src.load_data import load_universe

TURNOVER_MIN_BN = 3.0
# Skip 2018-2021 (covid regime bất thường: crash + V-recovery + bull mạnh).
# Train 2022-2024 cover bear 2022 + recovery 2023 + sideways 2024.
# Test 2025-2026 cover up 2025 + correction 2026.
TRAIN_START = "2022-01-01"
TRAIN_END = "2024-12-31"
TEST_START = "2025-01-01"


def filter_largemid(universe: pd.DataFrame) -> pd.DataFrame:
    recent = universe[universe.date >= "2024-01-01"].copy()
    recent["turnover"] = recent["close"] * recent["volume"] * 1000
    liq = recent.groupby("symbol")["turnover"].median() / 1e9
    keep = liq[liq >= TURNOVER_MIN_BN].index.tolist()
    return universe[universe.symbol.isin(keep)].copy()


def enrich(group: pd.DataFrame) -> pd.DataFrame:
    g = group.copy().reset_index(drop=True)
    c = g["close"].values
    o = g["open"].values
    h = g["high"].values
    l = g["low"].values
    v = g["volume"].values

    g["vol_avg20"] = pd.Series(v).rolling(20).mean()
    g["vol_ratio"] = v / g["vol_avg20"]

    g["ma20"] = pd.Series(c).rolling(20).mean()
    g["ma50"] = pd.Series(c).rolling(50).mean()

    rng = h - l
    g["range_pct"] = np.where(c > 0, rng / c * 100, np.nan)
    g["ret_5d"] = pd.Series(c).pct_change(5) * 100  # %
    g["ret_10d"] = pd.Series(c).pct_change(10) * 100
    g["day_green"] = c > o

    g["above_ma20"] = c > g["ma20"]
    g["above_ma50"] = c > g["ma50"]
    g["ma20_above_ma50"] = g["ma20"] > g["ma50"]

    return g


def simulate(df: pd.DataFrame, signal_col: str, hold: int, cost: float = DEFAULT_COST_RT) -> pd.DataFrame:
    """Vectorized: compute entry/exit price for every row via groupby.shift, then filter signals."""
    df = df.sort_values(["symbol", "date"]).reset_index(drop=True)
    grp = df.groupby("symbol", sort=False)
    entry = grp["open"].shift(-1)
    exit_ = grp["close"].shift(-(1 + hold))
    ret = (exit_ - entry) / entry - cost
    mask = df[signal_col] & entry.notna() & exit_.notna() & (entry > 0)
    out = pd.DataFrame({
        "date": df.loc[mask, "date"].values,
        "symbol": df.loc[mask, "symbol"].values,
        "net_ret": ret.loc[mask].values,
    })
    return out


def stats(trades: pd.DataFrame, hold: int) -> dict | None:
    if len(trades) < 30:
        return None
    win = (trades["net_ret"] > 0).mean()
    avg = trades["net_ret"].mean()
    std = trades["net_ret"].std()
    sharpe = (avg / std * (252 / hold) ** 0.5) if std > 0 else 0
    pos_sum = trades.loc[trades["net_ret"] > 0, "net_ret"].sum()
    neg_sum = abs(trades.loc[trades["net_ret"] < 0, "net_ret"].sum())
    pf = pos_sum / neg_sum if neg_sum > 0 else float("inf")
    return {"n": len(trades), "win": win, "avg": avg, "sharpe": sharpe, "pf": pf}


def build_signal(df: pd.DataFrame, vol_max: float, range_max: float,
                 ret5d_abs_max: float, structure: str) -> pd.Series:
    cond = (
        (df["vol_ratio"] < vol_max) &
        (df["range_pct"] < range_max) &
        (df["ret_5d"].abs() < ret5d_abs_max)
    )
    if structure == "above_ma20":
        cond &= df["above_ma20"]
    elif structure == "above_ma50":
        cond &= df["above_ma50"]
    elif structure == "ma20_above_ma50":
        cond &= df["ma20_above_ma50"]
    elif structure == "ma20_above_ma50_and_close_above_ma20":
        cond &= df["ma20_above_ma50"] & df["above_ma20"]
    return cond


def run_split(df_split: pd.DataFrame, label: str):
    """Run all variants on a date-filtered split. Returns list of variant results."""
    results = []
    for vol_max in [1.0, 1.2]:
        for range_max in [2.5, 3.0]:
            for ret5d_abs in [3.0, 5.0]:
                for structure in ["above_ma20", "above_ma50", "ma20_above_ma50"]:
                    sig = build_signal(df_split, vol_max, range_max, ret5d_abs, structure)
                    df_split["sig"] = sig
                    for hold in [3, 5, 7]:
                        trades = simulate(df_split, "sig", hold)
                        s = stats(trades, hold)
                        if s is None:
                            continue
                        results.append({
                            "split": label,
                            "vol_max": vol_max,
                            "range_max": range_max,
                            "ret5d_abs": ret5d_abs,
                            "structure": structure,
                            "hold": hold,
                            **s,
                        })
    return results


def main():
    print("Load + filter Large+Mid (turnover ≥ 3 tỷ)...")
    universe = load_universe()
    filtered = filter_largemid(universe)
    print(f"  {filtered.symbol.nunique()} mã")

    print("Enrich features...")
    parts = []
    for _, group in filtered.groupby("symbol", sort=False):
        parts.append(enrich(group))
    df = pd.concat(parts, ignore_index=True)
    print(f"  {len(df):,} rows")

    train = df[(df["date"] >= TRAIN_START) & (df["date"] <= TRAIN_END)].copy()
    test = df[df["date"] >= TEST_START].copy()
    print(f"  Train: {len(train):,} rows ({train['date'].min()} → {train['date'].max()})")
    print(f"  Test:  {len(test):,} rows ({test['date'].min()} → {test['date'].max()})")

    print("\n═══ Run all variants on Train + Test ═══")
    train_res = run_split(train, "train")
    test_res = run_split(test, "test")

    train_df = pd.DataFrame(train_res)
    test_df = pd.DataFrame(test_res)

    # Merge train + test on variant keys
    keys = ["vol_max", "range_max", "ret5d_abs", "structure", "hold"]
    merged = train_df.merge(test_df, on=keys, suffixes=("_train", "_test"))

    # Filter: train pass AND test pass
    # Baseline = 19.4%. Cần Win >= 25% trong cả train + test.
    EDGE_WIN = 0.25
    EDGE_SHARPE = 0.3
    promising = merged[
        (merged["win_train"] >= EDGE_WIN) &
        (merged["win_test"] >= EDGE_WIN) &
        (merged["sharpe_train"] >= EDGE_SHARPE) &
        (merged["sharpe_test"] >= EDGE_SHARPE) &
        (merged["n_train"] >= 100) &
        (merged["n_test"] >= 30)
    ].copy()
    promising["avg_sharpe"] = (promising["sharpe_train"] + promising["sharpe_test"]) / 2
    promising = promising.sort_values("avg_sharpe", ascending=False)

    print(f"\n═══ Variants pass cả Train + Test (win>={EDGE_WIN*100:.0f}%, sharpe>={EDGE_SHARPE}) ═══")
    if len(promising) == 0:
        print("  ❌ KHÔNG có variant nào pass cross-validation.")
        print("  → Pattern Quiet Accumulation không có edge robust → bỏ.")
        print("\n  Top 10 train (sort by sharpe) để inspect overfit:")
        top_train = train_df.sort_values("sharpe", ascending=False).head(10)
        for _, r in top_train.iterrows():
            t = test_df[
                (test_df["vol_max"] == r["vol_max"]) &
                (test_df["range_max"] == r["range_max"]) &
                (test_df["ret5d_abs"] == r["ret5d_abs"]) &
                (test_df["structure"] == r["structure"]) &
                (test_df["hold"] == r["hold"])
            ]
            test_win = t["win"].iloc[0] if len(t) else None
            test_sh = t["sharpe"].iloc[0] if len(t) else None
            test_n = t["n"].iloc[0] if len(t) else 0
            print(f"  vol<{r['vol_max']} range<{r['range_max']}% |ret5d|<{r['ret5d_abs']}% "
                  f"{r['structure']:<35} h={r['hold']} "
                  f"TRAIN n={r['n']} win={r['win']*100:.1f}% sh={r['sharpe']:.2f} "
                  f"| TEST n={test_n} win={test_win*100 if test_win else 0:.1f}% sh={test_sh:.2f}" if test_sh else "")
        return

    print(f"\n  Top 15 variants (sorted by avg Sharpe):")
    for _, r in promising.head(15).iterrows():
        print(f"  vol<{r['vol_max']:.1f} range<{r['range_max']:.1f}% |ret5d|<{r['ret5d_abs']:.0f}% "
              f"{r['structure']:<40} h={r['hold']}  "
              f"TRAIN n={r['n_train']:4d} win={r['win_train']*100:5.1f}% avg={r['avg_train']*100:+.2f}% sh={r['sharpe_train']:+.2f}  "
              f"| TEST n={r['n_test']:4d} win={r['win_test']*100:5.1f}% avg={r['avg_test']*100:+.2f}% sh={r['sharpe_test']:+.2f}")

    print("\n═══ BEST variant — recommended for production ═══")
    if len(promising) > 0:
        best = promising.iloc[0]
        print(f"  vol_max={best['vol_max']:.1f}, range_max={best['range_max']:.1f}%, "
              f"|ret5d|<{best['ret5d_abs']:.0f}%, structure={best['structure']}, hold={best['hold']}")
        print(f"  Train: n={best['n_train']} win={best['win_train']*100:.1f}% avg={best['avg_train']*100:+.2f}% sharpe={best['sharpe_train']:+.2f}")
        print(f"  Test:  n={best['n_test']} win={best['win_test']*100:.1f}% avg={best['avg_test']*100:+.2f}% sharpe={best['sharpe_test']:+.2f}")
        # Annualized fire rate from test (more relevant)
        test_days = (pd.to_datetime("2026-05-01") - pd.to_datetime(TEST_START)).days
        per_year = best['n_test'] / (test_days / 365)
        print(f"  Fire rate test: {per_year:.0f}/year (~{per_year/250:.2f}/day across universe)")


if __name__ == "__main__":
    main()
