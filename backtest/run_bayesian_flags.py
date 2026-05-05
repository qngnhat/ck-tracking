"""Bayesian flag impact analysis cho T+ ranking.

Mục tiêu: tính multiplier per risk flag để Bayesian update
P(win | flags) = P(win baseline) × Π multiplier_per_flag

Steps:
1. Load universe + compute T+ scores
2. Compute risk flags per stock-date (bearTrap, sellPressure, lowSessionLiq,
   lowVol, deepDowntrend, volCritical)
3. Run T+ simulation: pick top 10 score≥4, hold 10 phiên, label win/loss
4. Group trades by flag combos → compute win rate
5. Output multipliers: winRate(flag ON) / baseline winRate

Decision: hard-code multipliers vào JS app sau khi run.
"""

from __future__ import annotations

import json
from pathlib import Path
import numpy as np
import pandas as pd

from src.backtest import DEFAULT_COST_RT
from src.indicators import adx, sma
from src.load_data import load_universe
from src.tplus_score import add_tplus_scores

OUT_DIR = Path(__file__).parent / "results"
OUT_DIR.mkdir(exist_ok=True)
BAYES_DIR = OUT_DIR / "bayesian_flags"
BAYES_DIR.mkdir(exist_ok=True)

HOLD_DAYS = 10
TOP_N = 10
TPLUS_MIN = 4.0
COST_RT = DEFAULT_COST_RT


def compute_flags_per_symbol(g: pd.DataFrame) -> pd.DataFrame:
    """Compute 6 risk flags per stock-date."""
    g = g.sort_values("date").reset_index(drop=True).copy()
    n = len(g)

    # Day change
    day_change = g["close"].pct_change() * 100

    # ADX (14) — đã compute trong indicators.adx()
    adx_df = adx(g["high"], g["low"], g["close"], 14)
    g["adx14"] = adx_df["adx"]
    g["plus_di"] = adx_df["plus_di"]
    g["minus_di"] = adx_df["minus_di"]

    # MA50
    ma50 = sma(g["close"], 50)

    # Volume metrics
    avg_vol_20 = g["volume"].rolling(20, min_periods=20).mean()
    vol_ratio = g["volume"] / avg_vol_20.shift(1)  # exclude today

    # Session turnover
    session_turnover = g["close"] * g["volume"] * 1000

    # Flags
    g["flag_bearTrap"] = (g["adx14"] > 45) & (g["minus_di"] > g["plus_di"])
    g["flag_sellPressure"] = (vol_ratio > 1.5) & (day_change < -2)
    g["flag_lowSessionLiq"] = session_turnover < 2e9
    g["flag_lowVol"] = (vol_ratio > 0) & (vol_ratio < 0.8)
    g["flag_volCritical"] = (vol_ratio > 0) & (vol_ratio < 0.4)
    g["flag_deepDowntrend"] = ma50.notna() & (g["close"] < ma50 * 0.88)

    return g


def simulate_picks(df: pd.DataFrame, top_n: int = TOP_N, hold: int = HOLD_DAYS) -> pd.DataFrame:
    """Pick top N score >= 4 per day, hold N phiên, record outcome + flags at entry."""
    df = df.copy()
    df["date"] = pd.to_datetime(df["date"])

    open_pivot = df.pivot_table(index="date", columns="symbol", values="open", aggfunc="first")
    close_pivot = df.pivot_table(index="date", columns="symbol", values="close", aggfunc="first")
    score_pivot = df.pivot_table(index="date", columns="symbol", values="tplus_score", aggfunc="first")

    flag_cols = [c for c in df.columns if c.startswith("flag_")]
    flag_pivots = {fc: df.pivot_table(index="date", columns="symbol", values=fc, aggfunc="first") for fc in flag_cols}

    all_dates = score_pivot.index
    trades = []

    for i, sig_date in enumerate(all_dates):
        scores = score_pivot.loc[sig_date].dropna()
        valid = scores[scores >= TPLUS_MIN]
        if len(valid) == 0:
            continue
        top = valid.nlargest(top_n)

        entry_idx = i + 1
        exit_idx = entry_idx + hold
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
            net = gross - COST_RT

            row = {
                "signal_date": sig_date,
                "entry_date": entry_date,
                "symbol": sym,
                "score": score,
                "gross_ret": gross,
                "net_ret": net,
                "win": net > 0,
            }
            # Record flags at signal date
            for fc in flag_cols:
                fp = flag_pivots[fc]
                row[fc] = bool(fp.loc[sig_date, sym]) if sig_date in fp.index and not pd.isna(fp.loc[sig_date, sym]) else False
            trades.append(row)

    return pd.DataFrame(trades)


def analyze_flag_impact(trades: pd.DataFrame) -> dict:
    """Compute win rate baseline + per flag + multipliers."""
    if len(trades) == 0:
        return {}

    flag_cols = [c for c in trades.columns if c.startswith("flag_")]

    baseline_win = trades["win"].mean()
    baseline_n = len(trades)

    result = {
        "baseline": {
            "n_trades": baseline_n,
            "win_rate": float(baseline_win),
            "avg_ret": float(trades["net_ret"].mean()),
        },
        "flags": {},
        "by_flag_count": {},
        "multipliers": {},
    }

    # Per flag
    for fc in flag_cols:
        flag_name = fc.replace("flag_", "")
        on_trades = trades[trades[fc] == True]
        off_trades = trades[trades[fc] == False]
        if len(on_trades) == 0 or len(off_trades) == 0:
            continue
        on_win = on_trades["win"].mean()
        off_win = off_trades["win"].mean()
        multiplier = on_win / baseline_win if baseline_win > 0 else 1.0

        result["flags"][flag_name] = {
            "n_on": len(on_trades),
            "n_off": len(off_trades),
            "win_rate_on": float(on_win),
            "win_rate_off": float(off_win),
            "avg_ret_on": float(on_trades["net_ret"].mean()),
            "avg_ret_off": float(off_trades["net_ret"].mean()),
            "multiplier": float(multiplier),
        }

    # By flag count
    flag_count_series = trades[flag_cols].astype(int).sum(axis=1)
    for k in range(0, 7):
        bucket = trades[flag_count_series == k]
        if len(bucket) == 0:
            continue
        result["by_flag_count"][k] = {
            "n_trades": len(bucket),
            "win_rate": float(bucket["win"].mean()),
            "avg_ret": float(bucket["net_ret"].mean()),
        }

    # Final multipliers (clean for JS export)
    result["multipliers"] = {
        flag: data["multiplier"]
        for flag, data in result["flags"].items()
    }
    result["baseline_win_rate"] = float(baseline_win)

    return result


def main():
    print("[Bayesian flags] Loading universe + indicators...")
    df = load_universe()

    print("[Bayesian flags] Computing T+ scores...")
    df = add_tplus_scores(df)

    print("[Bayesian flags] Computing risk flags per stock-date...")
    parts = [compute_flags_per_symbol(group) for _, group in df.groupby("symbol", sort=False)]
    df = pd.concat(parts, ignore_index=True).sort_values(["symbol", "date"]).reset_index(drop=True)

    print(f"[Bayesian flags] Simulating T+ picks (top {TOP_N}, hold {HOLD_DAYS} phiên, score≥{TPLUS_MIN})...")
    trades = simulate_picks(df)
    print(f"  Total trades: {len(trades)}")

    print("[Bayesian flags] Analyzing flag impact...")
    result = analyze_flag_impact(trades)

    # Save trades CSV
    trades.to_csv(BAYES_DIR / "trades.csv", index=False)
    # Save analysis JSON
    with open(BAYES_DIR / "multipliers.json", "w") as f:
        json.dump(result, f, indent=2, default=str)

    # Print summary
    print(f"\n=== BAYESIAN FLAG ANALYSIS ===")
    print(f"\nBaseline (score≥4, hold {HOLD_DAYS} phiên, top{TOP_N}):")
    print(f"  n_trades={result['baseline']['n_trades']}")
    print(f"  win_rate={result['baseline']['win_rate']:.1%}")
    print(f"  avg_ret={result['baseline']['avg_ret']:.2%}")

    print(f"\nPer-flag impact:")
    for flag, data in result["flags"].items():
        print(f"  {flag}:")
        print(f"    n_on={data['n_on']}, n_off={data['n_off']}")
        print(f"    win_on={data['win_rate_on']:.1%}, win_off={data['win_rate_off']:.1%}")
        print(f"    avg_on={data['avg_ret_on']:+.2%}, avg_off={data['avg_ret_off']:+.2%}")
        print(f"    MULTIPLIER: {data['multiplier']:.3f}")

    print(f"\nBy flag count:")
    for k, data in sorted(result["by_flag_count"].items()):
        print(f"  {k} flags: n={data['n_trades']}, win={data['win_rate']:.1%}, avg={data['avg_ret']:+.2%}")

    print(f"\nMultipliers JSON for JS:")
    print(json.dumps({
        "baseline_win_rate": result["baseline_win_rate"],
        "multipliers": result["multipliers"],
    }, indent=2))

    print(f"\nOutput: {BAYES_DIR}/")


if __name__ == "__main__":
    main()
