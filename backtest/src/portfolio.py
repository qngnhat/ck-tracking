"""Aggregate per-symbol returns into portfolio + compute benchmarks + metrics."""

from __future__ import annotations

from typing import Optional

import numpy as np
import pandas as pd


def aggregate_equal_weight(per_symbol_df: pd.DataFrame) -> pd.DataFrame:
    """Equal-weight portfolio: average returns across all symbols by date.

    Symbols absent on a given date are excluded from average that day.
    """
    pivot = per_symbol_df.pivot_table(
        index="date", columns="symbol", values="ret", aggfunc="first"
    )
    # Mean across symbols (skipna)
    portfolio_ret = pivot.mean(axis=1)
    n_active = pivot.notna().sum(axis=1)
    return pd.DataFrame({"ret": portfolio_ret, "n_symbols": n_active})


def aggregate_long_only(per_symbol_df: pd.DataFrame) -> pd.DataFrame:
    """Active-position weighted: only stocks currently long contribute equally.

    If only 3 of 55 stocks are long today → portfolio = avg of those 3 (and
    cash for the remaining 52). This models full-allocation when long signals exist.

    Returns: ret (= mean over long stocks * frac_long, where frac_long = n_long / 55)
    """
    pivot_ret = per_symbol_df.pivot_table(
        index="date", columns="symbol", values="ret", aggfunc="first"
    )
    pivot_long = per_symbol_df.pivot_table(
        index="date", columns="symbol", values="is_long", aggfunc="first"
    ).fillna(False)

    n_total = pivot_long.shape[1]
    # Sum of returns across long stocks, divide by total universe (cash for non-long)
    sum_long_ret = pivot_ret.where(pivot_long, 0).sum(axis=1)
    portfolio_ret = sum_long_ret / n_total
    n_long = pivot_long.sum(axis=1)
    return pd.DataFrame({"ret": portfolio_ret, "n_long": n_long, "n_total": n_total})


def benchmark_buy_hold(price_df: pd.DataFrame, value_col: str = "close") -> pd.Series:
    """Buy & hold a single time series. Returns daily pct change."""
    return price_df.set_index("date")[value_col].pct_change().fillna(0)


def benchmark_equal_weight_bh(universe_df: pd.DataFrame) -> pd.Series:
    """Equal weight buy-and-hold across all symbols in universe."""
    pivot = universe_df.pivot_table(
        index="date", columns="symbol", values="close", aggfunc="first"
    )
    daily = pivot.pct_change().fillna(0)
    return daily.mean(axis=1)


def equity_curve(daily_ret: pd.Series, start: float = 1.0) -> pd.Series:
    """Compound daily returns into equity curve."""
    return (1 + daily_ret.fillna(0)).cumprod() * start


def compute_metrics(
    daily_ret: pd.Series,
    periods_per_year: int = 252,
    risk_free: float = 0.0,
) -> dict:
    """Compute key strategy metrics from daily returns."""
    r = daily_ret.dropna()
    if len(r) == 0:
        return {}
    eq = equity_curve(r)
    total_ret = eq.iloc[-1] - 1
    years = len(r) / periods_per_year
    cagr = (eq.iloc[-1]) ** (1 / years) - 1 if years > 0 else 0
    vol = r.std() * np.sqrt(periods_per_year)
    sharpe = (r.mean() * periods_per_year - risk_free) / vol if vol > 0 else 0
    # Max drawdown
    rolling_max = eq.cummax()
    dd = (eq - rolling_max) / rolling_max
    max_dd = dd.min()
    return {
        "total_return": total_ret,
        "cagr": cagr,
        "annual_vol": vol,
        "sharpe": sharpe,
        "max_drawdown": max_dd,
        "n_days": len(r),
        "years": years,
        "best_day": r.max(),
        "worst_day": r.min(),
        "pct_positive_days": (r > 0).mean(),
    }


def fmt_pct(v: Optional[float]) -> str:
    return "--" if v is None or pd.isna(v) else f"{v * 100:+.2f}%"


def print_metrics_table(metrics_by_strategy: dict[str, dict]) -> None:
    """Pretty-print comparison table."""
    cols = ["total_return", "cagr", "annual_vol", "sharpe", "max_drawdown", "pct_positive_days"]
    headers = ["Strategy", "Total", "CAGR", "Vol", "Sharpe", "MaxDD", "%Pos"]

    print(f"\n{headers[0]:<25}", end="")
    for h in headers[1:]:
        print(f"{h:>10}", end="")
    print()
    print("-" * 85)

    for name, m in metrics_by_strategy.items():
        print(f"{name:<25}", end="")
        print(f"{fmt_pct(m.get('total_return')):>10}", end="")
        print(f"{fmt_pct(m.get('cagr')):>10}", end="")
        print(f"{fmt_pct(m.get('annual_vol')):>10}", end="")
        s = m.get("sharpe", 0)
        print(f"{s:>10.3f}" if pd.notna(s) else f"{'--':>10}", end="")
        print(f"{fmt_pct(m.get('max_drawdown')):>10}", end="")
        print(f"{fmt_pct(m.get('pct_positive_days')):>10}")
