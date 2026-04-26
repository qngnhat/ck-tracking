"""Top-N monthly rebalance backtest engine.

Mỗi rebalance day (đầu tháng):
  1. Lấy DCA score TẠI cuối tháng trước (avoid lookahead)
  2. Loại các mã ineligible (filter cứng)
  3. Áp sector cap (max N mã/ngành)
  4. Pick top N
  5. Equal weight
  6. Hold đến rebalance kế tiếp
  7. Cost: turnover × cost_oneway tại rebalance day
"""

from __future__ import annotations

from typing import Optional

import numpy as np
import pandas as pd

from .sectors import get_sector

DEFAULT_COST_ONEWAY = 0.002  # 0.2% per side (commission + tax + slippage)


def _select_top_n(
    scores_at_date: pd.Series,
    top_n: int,
    sector_cap: Optional[int] = None,
) -> list[str]:
    """Given a Series of {symbol: score}, pick top N with optional sector cap."""
    s = scores_at_date.dropna().sort_values(ascending=False)
    picks: list[str] = []
    sector_count: dict[str, int] = {}
    for sym, _ in s.items():
        sector = get_sector(sym)
        if sector_cap is not None and sector_count.get(sector, 0) >= sector_cap:
            continue
        picks.append(sym)
        sector_count[sector] = sector_count.get(sector, 0) + 1
        if len(picks) >= top_n:
            break
    return picks


def get_rebalance_dates(dates: pd.DatetimeIndex, freq: str = "MS") -> pd.DatetimeIndex:
    """Get first trading date of each period.

    freq: 'MS' = month start, 'QS' = quarter start
    """
    dates = pd.DatetimeIndex(dates).sort_values()
    # Resample to get period starts
    df = pd.DataFrame(index=dates, data={"x": 1})
    period_first = df.resample(freq).first().dropna().index
    # Map to actual trading dates (first trading day on/after period start)
    actual = []
    for p in period_first:
        future = dates[dates >= p]
        if len(future) > 0:
            actual.append(future[0])
    return pd.DatetimeIndex(actual)


def simulate_topn_strategy(
    universe_df: pd.DataFrame,
    top_n: int = 10,
    sector_cap: Optional[int] = 2,
    rebalance_freq: str = "MS",
    cost_oneway: float = DEFAULT_COST_ONEWAY,
) -> dict:
    """Run top-N rebalance strategy on universe (which has 'dca_score' col).

    Returns dict with:
      daily_ret: Series — daily portfolio returns (after cost)
      holdings:  DataFrame — historical holdings (date × symbol → weight)
      picks_log: DataFrame — per rebalance: date, picks
      turnover:  Series — turnover at each rebalance
    """
    df = universe_df.copy()
    df["date"] = pd.to_datetime(df["date"])

    # Pivot: dates × symbols
    close_pivot = df.pivot_table(index="date", columns="symbol", values="close", aggfunc="first")
    score_pivot = df.pivot_table(index="date", columns="symbol", values="dca_score", aggfunc="first")
    daily_ret = close_pivot.pct_change().fillna(0)

    all_dates = close_pivot.index
    rebalance_dates = get_rebalance_dates(all_dates, rebalance_freq)

    # Initialize weights with NaN; fill on rebalance dates; then ffill
    weights = pd.DataFrame(np.nan, index=all_dates, columns=close_pivot.columns)
    picks_log = []
    turnover_log = []

    prev_weights = pd.Series(0.0, index=close_pivot.columns)

    for r_date in rebalance_dates:
        try:
            prev_idx = all_dates.get_loc(r_date) - 1
        except KeyError:
            continue
        if prev_idx < 0:
            continue
        prev_date = all_dates[prev_idx]
        if prev_date not in score_pivot.index:
            continue
        scores = score_pivot.loc[prev_date]
        picks = _select_top_n(scores, top_n, sector_cap)
        if not picks:
            continue

        new_weights = pd.Series(0.0, index=close_pivot.columns)
        new_weights[picks] = 1.0 / len(picks)

        to_change = (new_weights - prev_weights).abs().sum()
        turnover_log.append({"date": r_date, "turnover": to_change})

        weights.loc[r_date] = new_weights.values
        prev_weights = new_weights

        picks_log.append({"date": r_date, "n_picks": len(picks), "picks": picks})

    weights = weights.ffill().fillna(0)

    # Daily portfolio return = sum of weight_yesterday * return_today
    weights_lagged = weights.shift(1).fillna(0)
    portfolio_ret = (weights_lagged * daily_ret).sum(axis=1)

    # Apply cost on rebalance days
    cost_series = pd.Series(0.0, index=all_dates)
    for entry in turnover_log:
        cost_series.loc[entry["date"]] = entry["turnover"] * cost_oneway

    portfolio_ret = portfolio_ret - cost_series

    return {
        "daily_ret": portfolio_ret,
        "holdings": weights,
        "picks_log": pd.DataFrame(picks_log),
        "turnover": pd.Series([e["turnover"] for e in turnover_log],
                              index=[e["date"] for e in turnover_log]),
    }
