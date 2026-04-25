"""Port của hệ scoring trong stock-pwa/analysis.js sang vectorized pandas.

Computes a combined score per (symbol, date) using all indicators currently
in the PWA app. The score is then mapped to one of 5 recommendation levels:

  score >= 4 : STRONG_BUY (MUA MẠNH)
  score >= 2 : BUY (MUA)
  score >= -1: HOLD (QUAN SÁT)
  score >= -3: AVOID (TRÁNH MUA)
  else       : SELL (KHÔNG NÊN MUA)

Note: P/E-based valuation signal is SKIPPED (no historical fundamentals).
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def compute_score(df: pd.DataFrame) -> pd.DataFrame:
    """Add 'score' and 'recommendation' columns to a single-symbol DataFrame.

    Expects columns from indicators.compute_all() + (optional) net_val.
    """
    g = df.sort_values("date").reset_index(drop=True).copy()
    score = pd.Series(0.0, index=g.index)

    # ── RSI (±2 / ±1) ──
    rsi = g["rsi14"]
    score += np.where(rsi < 30, 2, 0)
    score += np.where((rsi >= 30) & (rsi < 45), 1, 0)
    score += np.where((rsi > 55) & (rsi <= 70), -1, 0)
    score += np.where(rsi > 70, -2, 0)

    # ── Trend via MA20/MA50 (±2 / ±1) ──
    ma20_above = g["ma20"] > g["ma50"]
    price_above_ma20 = g["close"] > g["ma20"]
    trend_up_strong = ma20_above & price_above_ma20
    trend_up_weak = ma20_above & ~price_above_ma20
    trend_down_strong = ~ma20_above & ~price_above_ma20
    trend_down_weak = ~ma20_above & price_above_ma20
    score += trend_up_strong.astype(float) * 2
    score += trend_up_weak.astype(float) * 1
    score += trend_down_weak.astype(float) * -1
    score += trend_down_strong.astype(float) * -2

    # ── 52w position (±1) ──
    high_52w = g["high"].rolling(252, min_periods=20).max()
    low_52w = g["low"].rolling(252, min_periods=20).min()
    rng = (high_52w - low_52w).replace(0, np.nan)
    pos_pct = (g["close"] - low_52w) / rng * 100
    score += (pos_pct < 30).fillna(False).astype(float) * 1
    score += (pos_pct > 85).fillna(False).astype(float) * -1

    # ── Distance to support/resistance (60-day high/low approximation, ±1) ──
    high_60 = g["high"].rolling(60, min_periods=10).max()
    low_60 = g["low"].rolling(60, min_periods=10).min()
    dist_support = (g["close"] - low_60) / g["close"] * 100
    dist_resistance = (high_60 - g["close"]) / g["close"] * 100
    near_support = (dist_support < 3) & (dist_support > 0)
    near_resistance = (dist_resistance < 3) & (dist_resistance > 0)
    score += near_support.fillna(False).astype(float) * 1
    score += near_resistance.fillna(False).astype(float) * -1

    # ── MACD (±1) ──
    macd_pos = (g["macd_hist"] > 0) & (g["macd"] > g["macd_signal"])
    macd_neg = (g["macd_hist"] < 0) & (g["macd"] < g["macd_signal"])
    score += macd_pos.fillna(False).astype(float) * 1
    score += macd_neg.fillna(False).astype(float) * -1

    # ── Bollinger (±1) ──
    score += (g["close"] > g["bb_upper"]).fillna(False).astype(float) * -1
    score += (g["close"] < g["bb_lower"]).fillna(False).astype(float) * 1

    # ── MA200 (±1) ──
    score += (g["close"] > g["ma200"]).fillna(False).astype(float) * 1
    score += (g["close"] < g["ma200"]).fillna(False).astype(float) * -1

    # ── ADX trend strength (±1, only if ADX >= 25) ──
    adx_strong = g["adx14"] >= 25
    plus_dom = g["plus_di"] > g["minus_di"]
    score += (adx_strong & plus_dom).fillna(False).astype(float) * 1
    score += (adx_strong & ~plus_dom).fillna(False).astype(float) * -1

    # ── Stochastic (±1) ──
    stoch_oversold = (g["stoch_k"] < 20) & (g["stoch_k"] > g["stoch_d"])
    stoch_overbought = (g["stoch_k"] > 80) & (g["stoch_k"] < g["stoch_d"])
    score += stoch_oversold.fillna(False).astype(float) * 1
    score += stoch_overbought.fillna(False).astype(float) * -1

    # ── MFI (±1) ──
    score += (g["mfi14"] < 20).fillna(False).astype(float) * 1
    score += (g["mfi14"] > 80).fillna(False).astype(float) * -1

    # ── Foreign flow streak (±2) ──
    if "net_val" in g.columns:
        is_buy = (g["net_val"] > 0).astype(int)
        is_sell = (g["net_val"] < 0).astype(int)
        buy_count = is_buy.rolling(10, min_periods=10).sum()
        sell_count = is_sell.rolling(10, min_periods=10).sum()
        sum_10 = g["net_val"].rolling(10, min_periods=10).sum()
        nn_strong_buy = (sum_10 > 0) & (buy_count >= 6)
        nn_strong_sell = (sum_10 < 0) & (sell_count >= 6)
        score += nn_strong_buy.fillna(False).astype(float) * 2
        score += nn_strong_sell.fillna(False).astype(float) * -2

    g["score"] = score

    # ── Map to recommendation labels ──
    g["recommendation"] = np.select(
        [score >= 4, score >= 2, score >= -1, score >= -3],
        ["STRONG_BUY", "BUY", "HOLD", "AVOID"],
        default="SELL",
    )
    return g


def add_scores(universe_df: pd.DataFrame) -> pd.DataFrame:
    """Apply compute_score per symbol and concat back."""
    parts = [compute_score(g) for _, g in universe_df.groupby("symbol", sort=False)]
    return pd.concat(parts, ignore_index=True).sort_values(["symbol", "date"]).reset_index(drop=True)
