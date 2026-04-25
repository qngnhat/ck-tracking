"""Signal functions for backtest.

Each function takes a DataFrame (single symbol, sorted by date asc, with
indicators already computed) and returns a boolean Series of same length
where True = entry signal triggers on that day.

Convention: signal at day t means "decide to buy at end of day t",
with backtest entry at day t+1 open.
"""

from __future__ import annotations

import pandas as pd


# ── RSI ─────────────────────────────────────────────────

def sig_rsi_oversold_cross(df: pd.DataFrame, threshold: float = 30) -> pd.Series:
    """RSI just dropped to below threshold today (was above yesterday)."""
    rsi = df["rsi14"]
    return (rsi < threshold) & (rsi.shift(1) >= threshold)


def sig_rsi_bounce(df: pd.DataFrame, threshold: float = 30) -> pd.Series:
    """RSI was below threshold, recovered above today (oversold bounce)."""
    rsi = df["rsi14"]
    return (rsi.shift(1) < threshold) & (rsi >= threshold)


def sig_rsi_below(df: pd.DataFrame, threshold: float = 30) -> pd.Series:
    """RSI is currently below threshold (any day in oversold zone)."""
    return df["rsi14"] < threshold


# ── MACD ────────────────────────────────────────────────

def sig_macd_golden_cross(df: pd.DataFrame) -> pd.Series:
    """MACD crosses above signal line."""
    cur = df["macd"] > df["macd_signal"]
    prev = df["macd"].shift(1) <= df["macd_signal"].shift(1)
    return cur & prev


def sig_macd_hist_turn_pos(df: pd.DataFrame) -> pd.Series:
    """Histogram turns from negative to positive."""
    return (df["macd_hist"] > 0) & (df["macd_hist"].shift(1) <= 0)


# ── Bollinger Bands ─────────────────────────────────────

def sig_bb_lower_touch(df: pd.DataFrame) -> pd.Series:
    """Close at or below lower BB."""
    return df["close"] <= df["bb_lower"]


def sig_bb_lower_bounce(df: pd.DataFrame) -> pd.Series:
    """Was below BB lower, now back above (bounce)."""
    below = df["close"].shift(1) <= df["bb_lower"].shift(1)
    above = df["close"] > df["bb_lower"]
    return below & above


# ── Stochastic ──────────────────────────────────────────

def sig_stoch_oversold_cross(df: pd.DataFrame) -> pd.Series:
    """%K below 20 and crosses above %D."""
    in_oversold = df["stoch_k"] < 20
    cur_above = df["stoch_k"] > df["stoch_d"]
    prev_below = df["stoch_k"].shift(1) <= df["stoch_d"].shift(1)
    return in_oversold & cur_above & prev_below


# ── ADX ─────────────────────────────────────────────────

def sig_adx_trend_up(df: pd.DataFrame, threshold: float = 25) -> pd.Series:
    """ADX >= threshold and +DI > -DI (confirmed up trend)."""
    return (df["adx14"] >= threshold) & (df["plus_di"] > df["minus_di"])


def sig_adx_trend_starting(df: pd.DataFrame) -> pd.Series:
    """ADX just crossed above 25 today."""
    return (df["adx14"] >= 25) & (df["adx14"].shift(1) < 25)


# ── MFI ─────────────────────────────────────────────────

def sig_mfi_oversold(df: pd.DataFrame, threshold: float = 20) -> pd.Series:
    return df["mfi14"] < threshold


# ── Moving Averages ─────────────────────────────────────

def sig_ma_golden_cross(df: pd.DataFrame) -> pd.Series:
    """MA20 crosses above MA50."""
    return (df["ma20"] > df["ma50"]) & (df["ma20"].shift(1) <= df["ma50"].shift(1))


def sig_above_ma200(df: pd.DataFrame) -> pd.Series:
    """Price above MA200 (long-term uptrend)."""
    return df["close"] > df["ma200"]


# ── Volume ──────────────────────────────────────────────

def sig_volume_spike(df: pd.DataFrame, multiplier: float = 2.0) -> pd.Series:
    """Volume > multiplier * 20-day avg."""
    avg = df["volume"].rolling(20, min_periods=20).mean()
    return df["volume"] > multiplier * avg


# ── Foreign Flow (NN) ───────────────────────────────────
# These need foreign_flow data merged into df (column `net_val`)

def sig_nn_buying_streak(df: pd.DataFrame, n_buy: int = 6, lookback: int = 10) -> pd.Series:
    """NN net buy at least N out of last lookback days."""
    if "net_val" not in df.columns:
        return pd.Series(False, index=df.index)
    is_buy = (df["net_val"] > 0).astype(int)
    return is_buy.rolling(lookback, min_periods=lookback).sum() >= n_buy


def sig_nn_strong_buy_today(df: pd.DataFrame, val_threshold: float = 5e9) -> pd.Series:
    """NN net buy today > threshold (5 tỷ default)."""
    if "net_val" not in df.columns:
        return pd.Series(False, index=df.index)
    return df["net_val"] > val_threshold


def sig_nn_buy_after_sell(df: pd.DataFrame, lookback: int = 5) -> pd.Series:
    """NN bought today AND sold majority of last 5 days (reversal)."""
    if "net_val" not in df.columns:
        return pd.Series(False, index=df.index)
    today_buy = df["net_val"] > 0
    sell_count = (df["net_val"].shift(1) < 0).rolling(lookback, min_periods=lookback).sum()
    return today_buy & (sell_count >= 3)


# ── Combined / convenience ──────────────────────────────

ALL_SIGNALS = {
    "rsi_oversold_cross": sig_rsi_oversold_cross,
    "rsi_bounce": sig_rsi_bounce,
    "rsi_below_30": lambda df: sig_rsi_below(df, 30),
    "rsi_below_25": lambda df: sig_rsi_below(df, 25),
    "macd_golden_cross": sig_macd_golden_cross,
    "macd_hist_turn_pos": sig_macd_hist_turn_pos,
    "bb_lower_touch": sig_bb_lower_touch,
    "bb_lower_bounce": sig_bb_lower_bounce,
    "stoch_oversold_cross": sig_stoch_oversold_cross,
    "adx_trend_up_25": lambda df: sig_adx_trend_up(df, 25),
    "adx_trend_up_30": lambda df: sig_adx_trend_up(df, 30),
    "adx_trend_starting": sig_adx_trend_starting,
    "mfi_oversold_20": lambda df: sig_mfi_oversold(df, 20),
    "ma_golden_cross": sig_ma_golden_cross,
    "above_ma200": sig_above_ma200,
    "volume_spike_2x": lambda df: sig_volume_spike(df, 2.0),
    "volume_spike_3x": lambda df: sig_volume_spike(df, 3.0),
    "nn_buying_6_of_10": lambda df: sig_nn_buying_streak(df, 6, 10),
    "nn_buying_8_of_10": lambda df: sig_nn_buying_streak(df, 8, 10),
    "nn_strong_buy_5b": lambda df: sig_nn_strong_buy_today(df, 5e9),
    "nn_buy_after_sell": sig_nn_buy_after_sell,
}
