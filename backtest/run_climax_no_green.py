"""Verify: bỏ `day_green` requirement có giữ được Win rate không?

Diagnose live (diagnose_live_scan.py) cho thấy 37% near-miss Tier B miss chỉ
vì `day_green=False` (mã drop sâu nhưng đóng red). Nhiều winner thực tế trong
verify_algo có `day_green=False` (66%) — nến confirm thường ở phiên T+1, T+2.

Test 4 variants Tier B (drop<-5%, vol>2×, rsi<50, turnover≥3B):
  V0: + day_green (current production)
  V1: - day_green (drop requirement)
  V2: - day_green + RSI <45 (tighter to compensate)
  V3: - day_green + close_in_range > 0.4 (close không phải đáy phiên)

Cross-validation Train 2022-2024 / Test 2025-2026 (loại covid).
Pass: Win ≥ 50% + Sharpe ≥ 0.3 cả 2 splits.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from src.backtest import DEFAULT_COST_RT
from src.load_data import load_universe

TRAIN_START = "2022-01-01"
TRAIN_END = "2024-12-31"
TEST_START = "2025-01-01"
TURNOVER_MIN_BN = 3.0


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

    delta = np.diff(c, prepend=c[0])
    up = np.where(delta > 0, delta, 0)
    dn = np.where(delta < 0, -delta, 0)
    avg_up = pd.Series(up).rolling(14).mean()
    avg_dn = pd.Series(dn).rolling(14).mean()
    rs = avg_up / avg_dn.replace(0, np.nan)
    g["rsi"] = 100 - 100 / (1 + rs)

    rng = h - l
    g["close_in_range"] = np.where(rng > 0, (c - l) / rng, 0.5)
    g["ret_3d"] = pd.Series(c).pct_change(3) * 100
    g["day_green"] = c > o

    return g


def simulate(df: pd.DataFrame, signal_col: str, hold: int,
             cost: float = DEFAULT_COST_RT) -> pd.DataFrame:
    df = df.sort_values(["symbol", "date"]).reset_index(drop=True)
    grp = df.groupby("symbol", sort=False)
    entry = grp["open"].shift(-1)
    exit_ = grp["close"].shift(-(1 + hold))
    ret = (exit_ - entry) / entry - cost
    mask = df[signal_col] & entry.notna() & exit_.notna() & (entry > 0)
    return pd.DataFrame({
        "date": df.loc[mask, "date"].values,
        "symbol": df.loc[mask, "symbol"].values,
        "net_ret": ret.loc[mask].values,
    })


def stats(trades: pd.DataFrame, hold: int) -> dict | None:
    if len(trades) < 20:
        return None
    win = (trades["net_ret"] > 0).mean()
    avg = trades["net_ret"].mean()
    std = trades["net_ret"].std()
    sharpe = (avg / std * (252 / hold) ** 0.5) if std > 0 else 0
    pos = trades.loc[trades["net_ret"] > 0, "net_ret"].sum()
    neg = abs(trades.loc[trades["net_ret"] < 0, "net_ret"].sum())
    pf = pos / neg if neg > 0 else float("inf")
    return {"n": len(trades), "win": win, "avg": avg, "sharpe": sharpe, "pf": pf}


def run_variants(df: pd.DataFrame, label: str) -> dict:
    """Test 4 variants on a date-filtered split. Return dict label→stats per hold."""
    base_cond = (
        (df["ret_3d"] < -5) &
        (df["vol_ratio"] > 2.0) &
        (df["rsi"] < 50)
    )
    variants = {
        "V0 +green (PROD)":              base_cond & df["day_green"],
        "V1 -green":                     base_cond,
        "V2 -green +rsi<45":             base_cond & (df["rsi"] < 45),
        "V3 -green +close>40%range":     base_cond & (df["close_in_range"] > 0.4),
    }
    out = {}
    for vname, sig in variants.items():
        df["sig"] = sig
        for hold in [3, 5]:
            t = simulate(df, "sig", hold)
            s = stats(t, hold)
            if s is None:
                continue
            out[(vname, hold)] = s
    return out


def main():
    print("Load + filter Large+Mid...")
    universe = load_universe()
    filtered = filter_largemid(universe)
    print(f"  {filtered.symbol.nunique()} mã")

    print("Enrich...")
    parts = [enrich(g) for _, g in filtered.groupby("symbol", sort=False)]
    df = pd.concat(parts, ignore_index=True)
    print(f"  {len(df):,} rows")

    train = df[(df["date"] >= TRAIN_START) & (df["date"] <= TRAIN_END)].copy()
    test = df[df["date"] >= TEST_START].copy()
    print(f"  Train: {len(train):,} rows ({train['date'].min().date()} → {train['date'].max().date()})")
    print(f"  Test:  {len(test):,} rows ({test['date'].min().date()} → {test['date'].max().date()})")

    print("\nRun variants on Train + Test...")
    train_res = run_variants(train, "train")
    test_res = run_variants(test, "test")

    # Display all 4 variants per hold
    print("\n═══ Tier B variants — Train vs Test ═══")
    print(f"  {'Variant':<32} {'hold':>4} | {'TRAIN':>20} | {'TEST':>20}")
    print(f"  {'':<32} {'':>4} | {'n   win    sharpe':>20} | {'n   win    sharpe':>20}")
    print(f"  {'-'*32} {'-'*4}-+-{'-'*20}-+-{'-'*20}")
    for vname in ["V0 +green (PROD)", "V1 -green", "V2 -green +rsi<45", "V3 -green +close>40%range"]:
        for hold in [3, 5]:
            tr = train_res.get((vname, hold))
            te = test_res.get((vname, hold))
            tr_str = f"{tr['n']:5d} {tr['win']*100:5.1f}% {tr['sharpe']:+.2f}" if tr else "  --"
            te_str = f"{te['n']:5d} {te['win']*100:5.1f}% {te['sharpe']:+.2f}" if te else "  --"
            marker = ""
            if tr and te and te["win"] >= 0.5 and te["sharpe"] >= 0.3:
                marker = "🟢"
            print(f"  {marker} {vname:<30} {hold:>4} | {tr_str:>20} | {te_str:>20}")

    print("\n═══ Pass criteria: Test Win ≥ 50% + Sharpe ≥ 0.3 ═══")
    print("  Variants pass:")
    pass_count = 0
    for vname in ["V1 -green", "V2 -green +rsi<45", "V3 -green +close>40%range"]:
        for hold in [3, 5]:
            tr = train_res.get((vname, hold))
            te = test_res.get((vname, hold))
            if tr and te and te["win"] >= 0.5 and te["sharpe"] >= 0.3 \
               and tr["win"] >= 0.5 and tr["sharpe"] >= 0.3:
                pass_count += 1
                # Annualized fire rate
                test_days = (pd.to_datetime("2026-05-13") - pd.to_datetime(TEST_START)).days
                per_year = te["n"] / (test_days / 365)
                print(f"  🟢 {vname} hold={hold}: "
                      f"Train n={tr['n']} win={tr['win']*100:.1f}% sh={tr['sharpe']:+.2f} "
                      f"| Test n={te['n']} win={te['win']*100:.1f}% sh={te['sharpe']:+.2f} "
                      f"({per_year:.0f}/year)")
    if pass_count == 0:
        print("  ❌ KHÔNG variant nào pass — day_green requirement có lý do giữ lại.")
    else:
        print(f"\n  ✅ {pass_count} variant(s) pass — có thể deploy 1 trong số đó.")


if __name__ == "__main__":
    main()
