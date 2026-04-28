"""Strong Mode Score — trend-following swing 1-3 tháng.

11 binary factors chia 4 group:
  A. Trend Technical: ma_stack, adx_uptrend, rsi_healthy, hh_hl
  B. Money Flow: mfi_accum, foreign_buy, vol_up_dom
  C. Relative Strength: ret_3m_strong, ret_1m_strong
  D. Quality: roe_high, foreign_own_high

Score = weighted sum (default weights = 1 each).

Hard rejects (filter trước):
  - close < ma50 (out of trend)
  - avg_turnover_20d < 5e9 (illiquid)
  - min(daily_change in last 30d) < -7% (volatile)

Threshold default = 7/11 (configurable).

Backtest first — magnitude weights chỉ là starting point, sẽ tune.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


# Default uniform weights (Phase 1 baseline)
DEFAULT_WEIGHTS = {
    # Trend Technical
    "ma_stack": 1.0,
    "adx_uptrend": 1.0,
    "rsi_healthy": 1.0,
    "hh_hl": 1.0,
    # Money Flow
    "mfi_accum": 1.0,
    "foreign_buy": 1.0,
    "vol_up_dom": 1.0,
    # Relative Strength
    "ret_3m_strong": 1.0,
    "ret_1m_strong": 1.0,
    # Quality
    "roe_high": 1.0,
    "foreign_own_high": 1.0,
}

DEFAULT_THRESHOLD = 7.0


def _compute_factors_per_symbol(g: pd.DataFrame) -> pd.DataFrame:
    """Compute 11 binary factor columns for ONE symbol.

    g must have indicators (ma20, ma50, ma200, rsi14, adx14, plus_di, minus_di,
    mfi14, stoch_*, macd_*, bb_*) + OHLCV + net_val (foreign).

    Adds columns: f_<name> (binary 0/1) + score columns + filter columns.
    """
    g = g.sort_values("date").reset_index(drop=True).copy()
    n = len(g)
    close = g["close"]

    # ── Group A — Trend Technical ──
    # 1. MA stack: close > ma20 > ma50 > ma200
    g["f_ma_stack"] = (
        (close > g["ma20"])
        & (g["ma20"] > g["ma50"])
        & (g["ma50"] > g["ma200"])
    ).astype(float)

    # 2. ADX uptrend: adx > 25 + +DI > -DI
    g["f_adx_uptrend"] = (
        (g["adx14"] > 25) & (g["plus_di"] > g["minus_di"])
    ).astype(float)

    # 3. RSI healthy: 50-65 (bullish, không OB)
    g["f_rsi_healthy"] = ((g["rsi14"] >= 50) & (g["rsi14"] <= 65)).astype(float)

    # 4. HH/HL pattern: 3 swing lows ascending (rolling min over 20-day, vs 40 và 60-day)
    # Approx: rolling min 20d > rolling min 40d > rolling min 60d
    rmin_20 = close.rolling(20, min_periods=20).min()
    rmin_40 = close.rolling(40, min_periods=40).min()
    rmin_60 = close.rolling(60, min_periods=60).min()
    g["f_hh_hl"] = ((rmin_20 > rmin_40) & (rmin_40 > rmin_60)).astype(float)

    # ── Group B — Money Flow ──
    # 5. MFI accumulation: mfi > 50 + tăng so với 5 phiên trước
    g["f_mfi_accum"] = (
        (g["mfi14"] > 50) & (g["mfi14"] > g["mfi14"].shift(5))
    ).astype(float)

    # 6. Foreign net buy: 5+/10 phiên gần đây có net_val > 0
    if "net_val" in g.columns:
        nn_pos = (g["net_val"] > 0).astype(float)
        nn_count_10d = nn_pos.rolling(10, min_periods=10).sum()
        g["f_foreign_buy"] = (nn_count_10d >= 5).astype(float)
    else:
        g["f_foreign_buy"] = 0.0

    # 7. Volume up-day vs down-day (10-day window):
    # mean(vol on up days) > 1.2 × mean(vol on down days)
    daily_chg = close.pct_change()
    up_days = (daily_chg > 0).astype(float)
    down_days = (daily_chg < 0).astype(float)
    vol_up_sum = (g["volume"] * up_days).rolling(10, min_periods=10).sum()
    vol_dn_sum = (g["volume"] * down_days).rolling(10, min_periods=10).sum()
    n_up = up_days.rolling(10, min_periods=10).sum()
    n_dn = down_days.rolling(10, min_periods=10).sum()
    avg_vol_up = vol_up_sum / n_up.where(n_up > 0, 1)
    avg_vol_dn = vol_dn_sum / n_dn.where(n_dn > 0, 1)
    g["f_vol_up_dom"] = ((avg_vol_dn > 0) & (avg_vol_up > 1.2 * avg_vol_dn)).astype(float)

    # ── Group C — Relative Strength ──
    # 8. 3M return > +10% (~63 phiên ≈ 3 tháng)
    ret_3m = close / close.shift(63) - 1
    g["f_ret_3m_strong"] = (ret_3m > 0.10).astype(float)

    # 9. 1M return > +5% (~21 phiên ≈ 1 tháng)
    ret_1m = close / close.shift(21) - 1
    g["f_ret_1m_strong"] = (ret_1m > 0.05).astype(float)

    # ── Group D — Quality (chỉ tính nếu có fundamentals data) ──
    # 10. ROE > 15%
    if "roe" in g.columns:
        g["f_roe_high"] = (g["roe"] > 0.15).astype(float)
    else:
        g["f_roe_high"] = 0.0

    # 11. Foreign ownership > 15% (proxy: dùng current_room thay vì owned ratio nếu chưa có)
    # foreign_pct cần fundamentals.parquet có column foreign_pct
    if "foreign_pct" in g.columns:
        g["f_foreign_own_high"] = (g["foreign_pct"] > 0.15).astype(float)
    else:
        g["f_foreign_own_high"] = 0.0

    # ── Hard rejects (filter trước scoring) ──
    # Below MA50 → out of trend
    g["filter_below_ma50"] = (close < g["ma50"]).astype(float)

    # Illiquid: avg turnover 20d < 5 tỷ VND (close × volume × 1000)
    avg_turnover = (close * g["volume"] * 1000).rolling(20, min_periods=20).mean()
    g["filter_illiquid"] = (avg_turnover < 5e9).astype(float)

    # Recent crash: any single-day -7%+ drop in last 30 phiên
    crashed = (daily_chg < -0.07).astype(float)
    g["filter_recent_crash"] = (crashed.rolling(30, min_periods=30).sum() > 0).astype(float)

    return g


def add_strong_scores(
    df: pd.DataFrame,
    weights: dict[str, float] | None = None,
    threshold: float = DEFAULT_THRESHOLD,
) -> pd.DataFrame:
    """Add strong score columns to universe DataFrame.

    df must have indicators computed (use load_data.load_universe() first).
    Optional: merge fundamentals (roe, foreign_pct) before calling this.

    Adds:
      - f_<name> binary columns (per factor)
      - filter_<name> reject columns
      - strong_score = weighted sum (excluding rejected mã)
      - strong_eligible = score >= threshold AND not filtered
      - strong_reasons = list of factor names that fired
    """
    weights = weights or DEFAULT_WEIGHTS

    parts = []
    for _, group in df.groupby("symbol", sort=False):
        g = _compute_factors_per_symbol(group)
        parts.append(g)
    out = pd.concat(parts, ignore_index=True)

    # Compute weighted score
    score = pd.Series(0.0, index=out.index)
    for name, w in weights.items():
        col = f"f_{name}"
        if col in out.columns:
            score = score + out[col] * w

    # Apply hard reject filters: score = -inf nếu reject
    rejected = (
        (out.get("filter_below_ma50", 0) > 0)
        | (out.get("filter_illiquid", 0) > 0)
        | (out.get("filter_recent_crash", 0) > 0)
    )
    score = score.where(~rejected, -np.inf)

    out["strong_score"] = score
    out["strong_eligible"] = (score >= threshold) & (~rejected)

    # Reasons: list of fired factors
    factor_cols = [f"f_{n}" for n in weights.keys() if f"f_{n}" in out.columns]

    def _reasons(row) -> list[str]:
        return [c[2:] for c in factor_cols if row.get(c, 0) > 0]

    out["strong_reasons"] = out.apply(_reasons, axis=1)

    return out


def merge_fundamentals(df: pd.DataFrame, fundamentals_path: str | None = None) -> pd.DataFrame:
    """Merge ROE and foreign ownership từ fundamentals.parquet.

    fundamentals.parquet expected columns: symbol, roe, foreign_pct (or similar).
    Falls back gracefully if file missing or columns absent.
    """
    if fundamentals_path is None:
        from pathlib import Path
        fundamentals_path = Path(__file__).resolve().parent.parent / "data" / "fundamentals.parquet"

    try:
        fund = pd.read_parquet(fundamentals_path)
    except Exception:
        return df

    # Pick latest fundamentals per symbol (or merge as-of date if time-series)
    keep_cols = ["symbol"]
    if "roe" in fund.columns:
        keep_cols.append("roe")
    if "foreign_pct" in fund.columns:
        keep_cols.append("foreign_pct")
    elif "foreign_ownership" in fund.columns:
        fund = fund.rename(columns={"foreign_ownership": "foreign_pct"})
        keep_cols.append("foreign_pct")

    if len(keep_cols) == 1:
        return df

    # If fundamentals has 'date' col → merge as-of (last known up to row date)
    if "date" in fund.columns:
        fund_sorted = fund[keep_cols + ["date"]].sort_values(["symbol", "date"])
        df_sorted = df.sort_values(["symbol", "date"])
        merged = pd.merge_asof(
            df_sorted, fund_sorted,
            on="date", by="symbol", direction="backward",
        )
        return merged.sort_values(["symbol", "date"]).reset_index(drop=True)
    else:
        # Static fundamentals: merge on symbol only (latest values for all dates)
        fund_unique = fund[keep_cols].drop_duplicates(subset=["symbol"], keep="last")
        return df.merge(fund_unique, on="symbol", how="left")
