"""DCA Ranking Score — chấm điểm mã cho tích lũy dài hạn.

Mục tiêu: chọn top N mã có chất lượng + entry timing tốt cho DCA hàng tháng.

Vì không có fundamentals lịch sử, score này dựa thuần technical:
  1. ma200_quality   — % thời gian giá trên MA200 (252 phiên gần nhất)
  2. low_drawdown    — max drawdown 252 phiên (negative — càng thấp càng tốt)
  3. momentum_6m     — return 6 tháng (cap ở 100% để loại mã quá nóng)
  4. trend_consistency — Sharpe 252 phiên (return / vol)
  5. liquidity       — log(avg daily turnover 20 phiên)
  6. foreign_flow_60d — net NN flow 60 phiên (smart money)

Filter cứng (loại sớm):
  - Giá < MA200 hoặc MA200 đang giảm → loại
  - Return 6 tháng > 100% → loại (quá nóng)
  - Liquidity < 5 tỷ/ngày → loại

Score = trung bình z-score cross-sectional của các factor (đo tương đối với
universe tại cùng thời điểm — tránh bias theo thị trường chung).
"""

from __future__ import annotations

import numpy as np
import pandas as pd


# ── Per-symbol factor computation ───────────────────────

def _compute_factors_per_symbol(g: pd.DataFrame) -> pd.DataFrame:
    g = g.sort_values("date").reset_index(drop=True).copy()
    close = g["close"]

    # 1. MA200 quality: % time above MA200 (rolling 252 days)
    above_ma200 = (close > g["ma200"]).astype(float)
    g["f_ma200_quality"] = above_ma200.rolling(252, min_periods=60).mean()

    # 2. Low drawdown: 252-day max drawdown (negate so higher = better)
    rolling_max = close.rolling(252, min_periods=60).max()
    dd = (close - rolling_max) / rolling_max
    g["f_low_drawdown"] = dd.rolling(252, min_periods=60).min().abs() * -1
    # Negative because we want SMALL drawdown = HIGH score
    g["f_low_drawdown"] = -dd.rolling(252, min_periods=60).min()  # absolute value of min DD
    # Wait: dd is negative numbers. min of dd is the worst (most negative).
    # |min(dd)| = magnitude of worst drawdown. We want SMALL magnitude = good.
    # So score = -|min(dd)| = min(dd) (which is negative).
    # Higher (less negative) = lower drawdown = better.
    g["f_low_drawdown"] = dd.rolling(252, min_periods=60).min()

    # 3. Momentum 6m (126 trading days), cap at 100%
    ret_6m = close / close.shift(126) - 1
    g["f_momentum_6m"] = ret_6m.clip(upper=1.0)

    # 4. Trend consistency: 252-day Sharpe (return / vol)
    daily_ret = close.pct_change()
    rolling_mean = daily_ret.rolling(252, min_periods=60).mean()
    rolling_std = daily_ret.rolling(252, min_periods=60).std()
    g["f_trend_consistency"] = rolling_mean / rolling_std.replace(0, np.nan)

    # 5. Liquidity: log of avg 20-day turnover (close is in thousand-VND)
    turnover = g["volume"] * close * 1000  # convert to actual VND
    avg_turnover = turnover.rolling(20, min_periods=10).mean()
    g["f_liquidity"] = np.log1p(avg_turnover)
    g["_avg_turnover"] = avg_turnover  # keep for hard filter

    # 6. Foreign flow 60-day cumulative
    if "net_val" in g.columns:
        nn_60d = g["net_val"].rolling(60, min_periods=20).sum()
        # Sign × log magnitude (handle big values gracefully)
        g["f_foreign_flow_60d"] = np.sign(nn_60d) * np.log1p(nn_60d.abs() / 1e9)
    else:
        g["f_foreign_flow_60d"] = 0.0

    # ── Hard filter flags ──
    ma200_declining = g["ma200"] < g["ma200"].shift(20)  # MA200 lower than 20 days ago
    g["filter_below_ma200"] = (close < g["ma200"]) | ma200_declining
    g["filter_too_hot"] = ret_6m > 1.0
    g["filter_illiquid"] = avg_turnover < 10e9  # < 10 tỷ/day (actual VND)

    return g


def compute_factors(universe_df: pd.DataFrame) -> pd.DataFrame:
    parts = [_compute_factors_per_symbol(g) for _, g in universe_df.groupby("symbol", sort=False)]
    return pd.concat(parts, ignore_index=True).sort_values(["symbol", "date"]).reset_index(drop=True)


# ── Cross-sectional z-score per date ────────────────────

FACTOR_COLS = [
    "f_ma200_quality",
    "f_low_drawdown",
    "f_momentum_6m",
    "f_trend_consistency",
    "f_liquidity",
    "f_foreign_flow_60d",
]


def add_zscores(df: pd.DataFrame, factor_cols: list[str] = FACTOR_COLS) -> pd.DataFrame:
    """Z-score each factor cross-sectionally (relative to universe at each date)."""
    df = df.copy()
    for col in factor_cols:
        # group by date, compute (x - mean) / std
        grp = df.groupby("date")[col]
        mean = grp.transform("mean")
        std = grp.transform("std").replace(0, np.nan)
        df[f"{col}_z"] = (df[col] - mean) / std
    return df


# ── Combine z-scores → DCA score + apply filters ────────

def compute_dca_score(df: pd.DataFrame, factor_cols: list[str] = FACTOR_COLS) -> pd.DataFrame:
    """Add 'dca_score' and 'dca_eligible' columns.

    Excluded rows have dca_score = NaN (not -inf, so they don't pollute aggregates).
    """
    df = df.copy()
    z_cols = [f"{c}_z" for c in factor_cols]
    # Require at least 4 of 6 factors to have z-score (avoid early-period bias)
    valid_count = df[z_cols].notna().sum(axis=1)
    df["dca_score"] = df[z_cols].mean(axis=1, skipna=True)
    df.loc[valid_count < 4, "dca_score"] = np.nan

    df["dca_eligible"] = ~(
        df["filter_below_ma200"]
        | df["filter_too_hot"]
        | df["filter_illiquid"]
        | df["dca_score"].isna()
    )
    df.loc[~df["dca_eligible"], "dca_score"] = np.nan
    return df


def prepare_dca_data(universe_df: pd.DataFrame) -> pd.DataFrame:
    """Full pipeline: factors → z-scores → score + eligibility."""
    df = compute_factors(universe_df)
    df = add_zscores(df)
    df = compute_dca_score(df)
    return df
