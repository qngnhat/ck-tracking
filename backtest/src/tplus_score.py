"""T+ Ranking Score — port của ranking.js T+ logic sang Python.

Port chính xác theo client để backtest cho ra kết quả khớp với app live.

Score factors (mean-reversion focus, theo Phase 1.3 winners):
  - RSI<25: +3, RSI<30: +2, RSI bounce from <25: +3
  - BB lower touch: +1.5, BB lower bounce: +2
  - MFI<20: +1.5
  - Stoch K<20 cross above D: +1.5
  - Volume spike >1.5x TB20: +1
  - MACD histogram turn positive: +1
  - NN reversal (today buy after 3+/5 sell days): +1.5

Hard filters:
  - Avg turnover < 5 tỷ/day → exclude
  - 6m return < -50% → exclude (catching-knife)

Min score = 2.0 to be eligible.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


T_PLUS_MIN_SCORE = 2.0


def _compute_tplus_per_symbol(g: pd.DataFrame) -> pd.DataFrame:
    """Compute T+ score series for ONE symbol.

    g must have indicators (rsi14, bb_*, mfi14, stoch_*, macd_*) already.
    Adds 'tplus_score', 'tplus_eligible', 'tplus_reasons' columns.
    """
    g = g.sort_values("date").reset_index(drop=True).copy()
    n = len(g)

    score = pd.Series(0.0, index=g.index)
    reasons_list: list[list[str]] = [[] for _ in range(n)]

    rsi = g["rsi14"]
    rsi_3back = rsi.shift(3)

    # 1. RSI<25
    mask_rsi_25 = rsi < 25
    score = score + mask_rsi_25.astype(float) * 3
    # 2. RSI<30 (only if not already <25)
    mask_rsi_30 = (rsi >= 25) & (rsi < 30)
    score = score + mask_rsi_30.astype(float) * 2
    # 3. RSI bounce from <25 (today >=30 but 3 days ago was <25)
    mask_bounce = (rsi >= 30) & (rsi < 35) & (rsi_3back < 25)
    score = score + mask_bounce.astype(float) * 3

    # 4. BB lower touch / bounce
    mask_bb_touch = g["close"] <= g["bb_lower"]
    mask_bb_bounce = (g["close"].shift(1) <= g["bb_lower"].shift(1)) & (g["close"] > g["bb_lower"])
    score = score + mask_bb_touch.astype(float) * 1.5
    score = score + mask_bb_bounce.astype(float) * 2

    # 5. MFI<20
    mask_mfi = g["mfi14"] < 20
    score = score + mask_mfi.astype(float) * 1.5

    # 6. Stoch oversold cross
    mask_stoch = (g["stoch_k"] < 20) & (g["stoch_k"] > g["stoch_d"]) & (
        g["stoch_k"].shift(1) <= g["stoch_d"].shift(1)
    )
    score = score + mask_stoch.astype(float) * 1.5

    # 7. Volume spike
    avg_vol = g["volume"].rolling(20, min_periods=20).mean().shift(1)
    vol_ratio = g["volume"] / avg_vol
    mask_vol = vol_ratio > 1.5
    score = score + mask_vol.astype(float) * 1

    # 8. MACD histogram turn positive
    mask_macd = (g["macd_hist"] > 0) & (g["macd_hist"].shift(1) <= 0)
    score = score + mask_macd.astype(float) * 1

    # 9. NN reversal: today buy after 3+/5 sell days
    if "net_val" in g.columns:
        today_buy = g["net_val"] > 0
        is_sell = (g["net_val"] < 0).astype(int)
        sell_count_prev_4 = is_sell.shift(1).rolling(4, min_periods=4).sum()
        mask_nn = today_buy & (sell_count_prev_4 >= 3)
        score = score + mask_nn.astype(float) * 1.5

    # ── Hard filters ──
    turnover = g["close"] * g["volume"] * 1000  # actual VND
    avg_turnover = turnover.rolling(20, min_periods=10).mean()
    filter_illiquid = avg_turnover < 5e9

    # 6m return
    ret_6m = g["close"] / g["close"].shift(127) - 1
    filter_crash = ret_6m < -0.5

    eligible = ~(filter_illiquid | filter_crash) & rsi.notna()
    score = score.where(eligible, np.nan)

    g["tplus_score"] = score
    g["tplus_eligible"] = eligible
    return g


def add_tplus_scores(universe_df: pd.DataFrame) -> pd.DataFrame:
    """Apply per-symbol and concat back."""
    parts = [_compute_tplus_per_symbol(group) for _, group in universe_df.groupby("symbol", sort=False)]
    return pd.concat(parts, ignore_index=True).sort_values(["symbol", "date"]).reset_index(drop=True)
