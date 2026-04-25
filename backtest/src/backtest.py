"""Backtest engine for single signals.

Convention:
- Signal day t means "decide today after close"
- Entry: NEXT day open (t+1)
- Exit: hold_days trading days later, at close (t+1+hold_days)
- Round-trip cost = 2 × one-way cost (commission + tax + slippage)
"""

from __future__ import annotations

from typing import Callable

import numpy as np
import pandas as pd


# Default cost: VN broker fee ~0.15% one-way + 0.1% sell tax + slippage = ~0.4% round-trip
DEFAULT_COST_RT = 0.004


def run_signal_per_symbol(
    df: pd.DataFrame,
    signal: pd.Series,
    hold_days: int,
    cost_rt: float = DEFAULT_COST_RT,
) -> pd.DataFrame:
    """Backtest a signal on ONE symbol's data (sorted by date).

    Returns DataFrame of trades.
    """
    df = df.reset_index(drop=True)
    signal = signal.reset_index(drop=True)
    n = len(df)
    rows: list[dict] = []

    entry_indices = signal[signal.fillna(False)].index
    for i in entry_indices:
        entry_idx = i + 1
        exit_idx = entry_idx + hold_days
        if exit_idx >= n:
            continue
        entry_price = df.iloc[entry_idx]["open"]
        exit_price = df.iloc[exit_idx]["close"]
        if pd.isna(entry_price) or pd.isna(exit_price) or entry_price <= 0:
            continue
        gross = (exit_price - entry_price) / entry_price
        net = gross - cost_rt
        rows.append({
            "symbol": df.iloc[entry_idx]["symbol"],
            "signal_date": df.iloc[i]["date"],
            "entry_date": df.iloc[entry_idx]["date"],
            "exit_date": df.iloc[exit_idx]["date"],
            "entry_price": entry_price,
            "exit_price": exit_price,
            "gross_ret": gross,
            "net_ret": net,
        })
    return pd.DataFrame(rows)


def run_signal(
    universe_df: pd.DataFrame,
    signal_fn: Callable[[pd.DataFrame], pd.Series],
    hold_days: int,
    cost_rt: float = DEFAULT_COST_RT,
) -> pd.DataFrame:
    """Run signal on entire universe. Returns concatenated trades."""
    out: list[pd.DataFrame] = []
    for _, group in universe_df.groupby("symbol", sort=False):
        g = group.sort_values("date").reset_index(drop=True)
        sig = signal_fn(g)
        trades = run_signal_per_symbol(g, sig, hold_days, cost_rt)
        if len(trades):
            out.append(trades)
    return pd.concat(out, ignore_index=True) if out else pd.DataFrame()


def summarize(trades: pd.DataFrame) -> dict:
    """Compute win rate, avg return, Sharpe, etc."""
    if len(trades) == 0:
        return {
            "n_trades": 0, "win_rate": np.nan, "avg_ret": np.nan,
            "median_ret": np.nan, "std_ret": np.nan, "sharpe": np.nan,
            "best": np.nan, "worst": np.nan, "profit_factor": np.nan,
        }
    r = trades["net_ret"]
    wins = r[r > 0]
    losses = r[r < 0]
    pf = wins.sum() / abs(losses.sum()) if len(losses) and losses.sum() != 0 else float("inf")
    sharpe = r.mean() / r.std() if r.std() and r.std() > 0 else 0.0
    return {
        "n_trades": len(trades),
        "win_rate": (r > 0).mean(),
        "avg_ret": r.mean(),
        "median_ret": r.median(),
        "std_ret": r.std(),
        "sharpe": sharpe,
        "best": r.max(),
        "worst": r.min(),
        "profit_factor": pf,
    }


def baseline_return(universe_df: pd.DataFrame, hold_days: int, cost_rt: float = DEFAULT_COST_RT) -> dict:
    """Average return if you buy on a random day at next-day open and hold N days.

    This is the 'no-skill' baseline — what you'd earn picking dates randomly.
    """
    rows: list[float] = []
    for _, group in universe_df.groupby("symbol", sort=False):
        g = group.sort_values("date").reset_index(drop=True)
        entry = g["open"].shift(-1)
        exit_ = g["close"].shift(-1 - hold_days)
        rets = (exit_ - entry) / entry - cost_rt
        rows.append(rets.dropna())
    rets = pd.concat(rows) if rows else pd.Series(dtype=float)
    if len(rets) == 0:
        return {}
    return {
        "n_samples": len(rets),
        "avg_ret": rets.mean(),
        "median_ret": rets.median(),
        "win_rate": (rets > 0).mean(),
        "std_ret": rets.std(),
        "sharpe": rets.mean() / rets.std() if rets.std() else 0.0,
    }
