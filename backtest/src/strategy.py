"""Strategy simulation: convert score series → daily strategy returns.

Strategy: long-only signal-based.
- Enter long when score >= entry_score (decision at close T → enter at T+1 open)
- Exit when score <= exit_score
- Cash (0% return) when flat
- Cost: cost_rt round-trip, charged at exit (or split entry/exit)
"""

from __future__ import annotations

import numpy as np
import pandas as pd

DEFAULT_COST_RT = 0.004


def compute_position_state(score: pd.Series, entry: float, exit_: float) -> pd.Series:
    """Walk through score series, return bool series indicating in-position state.

    State at index i = decision based on score[0..i].
    The actual market position is delayed by 1 day (set in caller).
    """
    n = len(score)
    state = np.zeros(n, dtype=bool)
    in_pos = False
    s = score.values
    for i in range(n):
        if pd.isna(s[i]):
            state[i] = in_pos
            continue
        if not in_pos and s[i] >= entry:
            in_pos = True
        elif in_pos and s[i] <= exit_:
            in_pos = False
        state[i] = in_pos
    return pd.Series(state, index=score.index)


def simulate_per_symbol(
    g: pd.DataFrame,
    entry: float = 2.0,
    exit_: float = 0.0,
    cost_rt: float = DEFAULT_COST_RT,
) -> pd.DataFrame:
    """Simulate strategy on ONE symbol's data.

    Returns DataFrame: date, symbol, ret, is_long
    """
    g = g.sort_values("date").reset_index(drop=True)

    decision_state = compute_position_state(g["score"], entry, exit_)
    # Position effective from next day (decision T → in position T+1)
    is_long = decision_state.shift(1).fillna(False).astype(bool)

    pct_change = g["close"].pct_change().fillna(0)
    strat_ret = np.where(is_long, pct_change, 0.0)

    # Apply cost on transitions (entry day or exit day)
    transitions = is_long.values != np.r_[False, is_long.values[:-1]]
    # Half cost per transition (entry + exit = full round-trip)
    cost = np.where(transitions, cost_rt / 2, 0.0)
    strat_ret = strat_ret - cost

    return pd.DataFrame({
        "date": g["date"].values,
        "symbol": g["symbol"].iloc[0],
        "ret": strat_ret,
        "is_long": is_long.values,
        "score": g["score"].values,
        "close": g["close"].values,
    })


def extract_trades(per_sym_df: pd.DataFrame) -> pd.DataFrame:
    """Given per-symbol simulation df, identify discrete trades."""
    g = per_sym_df.reset_index(drop=True)
    is_long = g["is_long"].values
    n = len(g)
    trades = []
    in_pos = False
    entry_i = None
    for i in range(n):
        if not in_pos and is_long[i]:
            in_pos = True
            entry_i = i
        elif in_pos and not is_long[i]:
            # exit at this row's close (we already started at entry_i open)
            entry_close = g.iloc[entry_i]["close"] if entry_i is not None else np.nan
            exit_close = g.iloc[i]["close"]
            ret = g["ret"].iloc[entry_i:i].sum()  # accumulated daily ret
            trades.append({
                "symbol": g.iloc[i]["symbol"],
                "entry_date": g.iloc[entry_i]["date"],
                "exit_date": g.iloc[i]["date"],
                "days_held": i - entry_i,
                "entry_close": entry_close,
                "exit_close": exit_close,
                "net_ret": ret,
            })
            in_pos = False
            entry_i = None
    # Close open position at end
    if in_pos and entry_i is not None and entry_i < n:
        trades.append({
            "symbol": g.iloc[-1]["symbol"],
            "entry_date": g.iloc[entry_i]["date"],
            "exit_date": g.iloc[-1]["date"],
            "days_held": n - 1 - entry_i,
            "entry_close": g.iloc[entry_i]["close"],
            "exit_close": g.iloc[-1]["close"],
            "net_ret": g["ret"].iloc[entry_i:].sum(),
        })
    return pd.DataFrame(trades)


def simulate_universe(
    universe_df: pd.DataFrame,
    entry: float = 2.0,
    exit_: float = 0.0,
    cost_rt: float = DEFAULT_COST_RT,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Simulate strategy across all symbols.

    Returns:
        per_symbol: long DataFrame with daily ret per symbol (date, symbol, ret, is_long)
        trades:     all individual trades concatenated
    """
    per_sym_dfs = []
    trades_dfs = []
    for sym, group in universe_df.groupby("symbol", sort=False):
        sim = simulate_per_symbol(group, entry, exit_, cost_rt)
        per_sym_dfs.append(sim)
        trades_dfs.append(extract_trades(sim))
    per_symbol = pd.concat(per_sym_dfs, ignore_index=True)
    trades = pd.concat(trades_dfs, ignore_index=True) if trades_dfs else pd.DataFrame()
    return per_symbol, trades
