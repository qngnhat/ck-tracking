"""Strong Leaders T+ Score — port của ranking.js computeTPlusFactors mới (May 2026).

VN narrow-leadership regime: chỉ 1 vài mã mạnh tăng, mean-reversion fail.
Formula focus momentum/RS/breakout/accumulation thay vì oversold bounce.

Signals (theo thứ tự JS):
  A. Relative Strength vs VN-Index 5d + 20d
  B. Breakout: w20-high, w52-high near, ceiling streak (≥6.5% / phiên)
  C. Volume accumulation: up-day vol vs down-day vol + today spike
  D. MA alignment 5>10>20>50 (perfect uptrend stack)
  E. ADX + DI direction (≥25 +DI dominant)
  F. RSI<30 residual (giảm weight, không adaptive vì backtest không có profile)
  G. Foreign flow 5-day net

Hard filters:
  - avg_turnover_20d < 5 tỷ/day
  - return 20d > 50% (over-extended → pump risk)

Min score = 4.0 (default app threshold)
"""

from __future__ import annotations

import numpy as np
import pandas as pd


STRONG_LEADERS_MIN_SCORE = 4.0


def _compute_strong_leaders_per_symbol(g: pd.DataFrame, vni: pd.DataFrame) -> pd.DataFrame:
    """Compute Strong Leaders score series for ONE symbol.

    g must have indicators (rsi14, etc.) already.
    vni is VN-Index DataFrame indexed by date with 'close' column.
    """
    g = g.sort_values("date").reset_index(drop=True).copy()
    g["date"] = pd.to_datetime(g["date"])
    n = len(g)

    score = pd.Series(0.0, index=g.index)
    reasons_list: list[list[str]] = [[] for _ in range(n)]

    close = g["close"]
    high = g["high"]
    low = g["low"]
    vol = g["volume"]

    # ── A. RS vs VN-Index 5d + 20d ──
    if not vni.empty:
        # Align VNI close to dates of g
        vni_close = vni.set_index("date")["close"] if "date" in vni.columns else vni["close"]
        vni_aligned = vni_close.reindex(g["date"].values, method="ffill")
        stock_ret_5d = close / close.shift(5) - 1
        stock_ret_20d = close / close.shift(21) - 1
        vni_ret_5d = (vni_aligned.values / np.roll(vni_aligned.values, 5) - 1)
        vni_ret_20d = (vni_aligned.values / np.roll(vni_aligned.values, 21) - 1)
        # First few values invalid (roll wraps around)
        vni_ret_5d[:5] = np.nan
        vni_ret_20d[:21] = np.nan
        rs_5 = (stock_ret_5d.values - vni_ret_5d) * 100
        rs_20 = (stock_ret_20d.values - vni_ret_20d) * 100

        mask_strong_leader = (rs_5 > 5) & (rs_20 > 8)
        mask_outperform = (rs_5 > 2) & (rs_20 > 3) & ~mask_strong_leader
        mask_laggard = (rs_5 < -3) & (rs_20 < -5)

        score = score + pd.Series(mask_strong_leader, index=g.index).astype(float) * 3
        score = score + pd.Series(mask_outperform, index=g.index).astype(float) * 1.5
        score = score - pd.Series(mask_laggard, index=g.index).astype(float) * 2
    else:
        rs_5 = np.full(n, np.nan)
        rs_20 = np.full(n, np.nan)

    # ── B. Breakout signals ──
    # w20-high break trong 5 phiên qua
    w20_high = close.rolling(20, min_periods=20).max().shift(1)
    breakout_5 = (close > w20_high * 1.005).rolling(5, min_periods=1).max().astype(bool)
    score = score + breakout_5.astype(float) * 2

    # w52-high gần (close >= 99% of 252-day high)
    if n >= 252:
        w52_high = close.rolling(252, min_periods=252).max().shift(1)
        near_w52 = close > w52_high * 0.99
        score = score + near_w52.astype(float) * 3

    # Ceiling streak (>= 6.5% / day, count consecutive ending today)
    daily_pct = (close / close.shift(1) - 1) * 100
    is_ceiling = daily_pct >= 6.5
    ceil_streak = pd.Series(0, index=g.index)
    # Compute rolling count of consecutive True
    streak = 0
    for i in range(n):
        if is_ceiling.iloc[i]:
            streak += 1
        else:
            streak = 0
        ceil_streak.iloc[i] = streak
    score = score + ((ceil_streak >= 2).astype(float) * 2 + ((ceil_streak == 1).astype(float) * 1))

    # ── C. Volume accumulation ──
    change_signed = close - close.shift(1)
    up_mask = change_signed > 0
    down_mask = change_signed < 0
    # Up volume avg over 20 days
    up_vol = vol.where(up_mask, 0).rolling(20, min_periods=10).sum()
    up_days = up_mask.astype(float).rolling(20, min_periods=10).sum()
    down_vol = vol.where(down_mask, 0).rolling(20, min_periods=10).sum()
    down_days = down_mask.astype(float).rolling(20, min_periods=10).sum()
    avg_up_vol = up_vol / up_days.replace(0, np.nan)
    avg_down_vol = down_vol / down_days.replace(0, np.nan)
    updown_ratio = avg_up_vol / avg_down_vol.replace(0, np.nan)

    score = score + ((updown_ratio > 1.5).astype(float) * 2)
    score = score + (((updown_ratio > 1.2) & (updown_ratio <= 1.5)).astype(float) * 1)
    score = score - ((updown_ratio < 0.7).astype(float) * 1)

    # Today vol spike + giá tăng
    avg_vol_20 = vol.rolling(20, min_periods=20).mean().shift(1)
    vol_ratio = vol / avg_vol_20
    day_change_pct = (close / close.shift(1) - 1) * 100
    mask_vol_spike_up = (vol_ratio > 2) & (day_change_pct >= 0)
    mask_distribution = (vol_ratio > 1.5) & (day_change_pct < -2)
    score = score + mask_vol_spike_up.astype(float) * 1.5
    score = score - mask_distribution.astype(float) * 1.5

    # ── D. MA alignment ──
    ma5 = close.rolling(5, min_periods=5).mean()
    ma10 = close.rolling(10, min_periods=10).mean()
    ma20 = close.rolling(20, min_periods=20).mean()
    ma50 = close.rolling(50, min_periods=50).mean()
    aligned = (ma5 > ma10) & (ma10 > ma20) & (ma20 > ma50) & (close > ma5)
    score = score + aligned.astype(float) * 2
    # Partial trend up (giá>MA20>MA50)
    partial_up = (close > ma20) & (ma20 > ma50) & ~aligned
    score = score + partial_up.astype(float) * 1

    # MA20 rising slope (so với 5 phiên trước)
    ma20_rising = ma20 > ma20.shift(5) * 1.005
    score = score + ma20_rising.astype(float) * 0.5

    # ── E. ADX + DI ──
    # Reuse adx columns nếu có; else skip
    if "adx14" in g.columns and "plusDI14" in g.columns and "minusDI14" in g.columns:
        adx_strong_up = (g["adx14"] > 25) & (g["plusDI14"] > g["minusDI14"])
        adx_strong_down = (g["adx14"] > 25) & (g["minusDI14"] > g["plusDI14"])
        score = score + adx_strong_up.astype(float) * 1.5
        score = score - adx_strong_down.astype(float) * 1.5

    # ── F. RSI<30 residual (no adaptive in backtest — use default 1.0 weight) ──
    rsi = g.get("rsi14", pd.Series(np.nan, index=g.index))
    mask_rsi_oversold = rsi < 30
    score = score + mask_rsi_oversold.astype(float) * 1.5

    # ── G. Foreign flow 5-day ──
    if "net_val" in g.columns:
        nn = g["net_val"]
        positive_days_5 = (nn > 0).rolling(5, min_periods=5).sum()
        sum_5 = nn.rolling(5, min_periods=5).sum()
        mask_nn_buy = (positive_days_5 >= 4) & (sum_5 > 0)
        mask_nn_sell = (positive_days_5 <= 1) & (sum_5 < 0)
        score = score + mask_nn_buy.astype(float) * 1.5
        score = score - mask_nn_sell.astype(float) * 1

    # ── Hard filters ──
    turnover = close * vol * 1000  # VND
    avg_turnover_20 = turnover.rolling(20, min_periods=10).mean()
    filter_illiquid = avg_turnover_20 < 5e9
    # Over-extended: tăng > 50% trong 20 phiên
    ret_20d_pct = (close / close.shift(20) - 1) * 100
    filter_overextended = ret_20d_pct > 50

    eligible = ~(filter_illiquid | filter_overextended) & rsi.notna()
    score = score.where(eligible, np.nan)

    g["strong_score"] = score
    g["strong_eligible"] = eligible
    g["rs_5d"] = rs_5
    g["rs_20d"] = rs_20
    return g


def add_strong_leaders_scores(universe_df: pd.DataFrame, vni: pd.DataFrame) -> pd.DataFrame:
    """Apply per-symbol and concat back. universe_df needs date sorted per symbol."""
    parts = []
    for _, group in universe_df.groupby("symbol", sort=False):
        parts.append(_compute_strong_leaders_per_symbol(group, vni))
    return pd.concat(parts, ignore_index=True).sort_values(["symbol", "date"]).reset_index(drop=True)
