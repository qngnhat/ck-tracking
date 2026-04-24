"""Technical indicators — port của stock-pwa/analysis.js sang Python.

All functions take pandas Series/DataFrame and return vector series
(not just the last value) so they can be used for backtest at every date.

Verified against JS app: giá trị tại ngày cuối phải khớp với PWA.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


# ── Moving averages ─────────────────────────────────────

def sma(series: pd.Series, period: int) -> pd.Series:
    """Simple Moving Average."""
    return series.rolling(window=period, min_periods=period).mean()


def ema(series: pd.Series, period: int) -> pd.Series:
    """Exponential Moving Average (seeded with SMA of first `period` values)."""
    values = series.to_numpy(dtype=float)
    result = np.full_like(values, np.nan, dtype=float)
    if len(values) < period:
        return pd.Series(result, index=series.index)

    k = 2.0 / (period + 1)
    seed = values[:period].mean()
    result[period - 1] = seed
    for i in range(period, len(values)):
        result[i] = values[i] * k + result[i - 1] * (1 - k)
    return pd.Series(result, index=series.index)


# ── RSI (Wilder's smoothing, default 14) ────────────────

def rsi(close: pd.Series, period: int = 14) -> pd.Series:
    values = close.to_numpy(dtype=float)
    n = len(values)
    out = np.full(n, np.nan, dtype=float)
    if n < period + 1:
        return pd.Series(out, index=close.index)

    gains = 0.0
    losses = 0.0
    for i in range(1, period + 1):
        diff = values[i] - values[i - 1]
        if diff >= 0:
            gains += diff
        else:
            losses -= diff
    avg_gain = gains / period
    avg_loss = losses / period

    # First RSI at index `period`
    out[period] = 100.0 if avg_loss == 0 else 100.0 - 100.0 / (1 + avg_gain / avg_loss)

    for i in range(period + 1, n):
        diff = values[i] - values[i - 1]
        gain = diff if diff > 0 else 0.0
        loss = -diff if diff < 0 else 0.0
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period
        out[i] = 100.0 if avg_loss == 0 else 100.0 - 100.0 / (1 + avg_gain / avg_loss)

    return pd.Series(out, index=close.index)


# ── MACD (12, 26, 9) ────────────────────────────────────

def macd(close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9) -> pd.DataFrame:
    """Returns DataFrame with columns: macd, signal, hist."""
    ema_fast = ema(close, fast)
    ema_slow = ema(close, slow)
    macd_line = ema_fast - ema_slow
    signal_line = ema(macd_line.dropna(), signal).reindex(close.index)
    hist = macd_line - signal_line
    return pd.DataFrame({"macd": macd_line, "signal": signal_line, "hist": hist})


# ── Bollinger Bands (20, 2σ) ────────────────────────────

def bollinger(close: pd.Series, period: int = 20, std_mult: float = 2.0) -> pd.DataFrame:
    middle = sma(close, period)
    std = close.rolling(window=period, min_periods=period).std(ddof=0)
    upper = middle + std * std_mult
    lower = middle - std * std_mult
    width_pct = (upper - lower) / middle * 100
    return pd.DataFrame({
        "bb_upper": upper,
        "bb_middle": middle,
        "bb_lower": lower,
        "bb_width_pct": width_pct,
    })


# ── True Range + ATR ────────────────────────────────────

def true_range(high: pd.Series, low: pd.Series, close: pd.Series) -> pd.Series:
    prev_close = close.shift(1)
    tr = pd.concat([
        high - low,
        (high - prev_close).abs(),
        (low - prev_close).abs(),
    ], axis=1).max(axis=1)
    return tr


def atr(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> pd.Series:
    tr = true_range(high, low, close)
    n = len(tr)
    out = np.full(n, np.nan, dtype=float)
    vals = tr.to_numpy(dtype=float)
    if n < period + 1:
        return pd.Series(out, index=tr.index)

    # seed
    out[period] = np.nanmean(vals[1 : period + 1])
    for i in range(period + 1, n):
        out[i] = (out[i - 1] * (period - 1) + vals[i]) / period
    return pd.Series(out, index=tr.index)


# ── ADX (Average Directional Index) ─────────────────────

def adx(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> pd.DataFrame:
    """Returns DataFrame with adx, plus_di, minus_di."""
    h = high.to_numpy(dtype=float)
    l = low.to_numpy(dtype=float)
    c = close.to_numpy(dtype=float)
    n = len(h)

    adx_out = np.full(n, np.nan, dtype=float)
    plus_out = np.full(n, np.nan, dtype=float)
    minus_out = np.full(n, np.nan, dtype=float)

    if n < period * 2 + 1:
        return pd.DataFrame(
            {"adx": adx_out, "plus_di": plus_out, "minus_di": minus_out},
            index=high.index,
        )

    trs = np.zeros(n - 1)
    plus_dms = np.zeros(n - 1)
    minus_dms = np.zeros(n - 1)
    for i in range(1, n):
        tr = max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1]))
        up_move = h[i] - h[i - 1]
        down_move = l[i - 1] - l[i]
        pdm = up_move if (up_move > down_move and up_move > 0) else 0.0
        ndm = down_move if (down_move > up_move and down_move > 0) else 0.0
        trs[i - 1] = tr
        plus_dms[i - 1] = pdm
        minus_dms[i - 1] = ndm

    # Wilder smoothing.
    # trs[k] corresponds to day k+1. dxs[j] corresponds to day j + period + 1.
    s_tr = trs[:period].sum()
    s_pdm = plus_dms[:period].sum()
    s_ndm = minus_dms[:period].sum()

    dxs = []
    for i in range(period, len(trs)):
        s_tr = s_tr - s_tr / period + trs[i]
        s_pdm = s_pdm - s_pdm / period + plus_dms[i]
        s_ndm = s_ndm - s_ndm / period + minus_dms[i]
        p_di = 100.0 * s_pdm / s_tr if s_tr else 0.0
        m_di = 100.0 * s_ndm / s_tr if s_tr else 0.0
        di_sum = p_di + m_di
        dx = 100.0 * abs(p_di - m_di) / di_sum if di_sum else 0.0
        dxs.append(dx)
        orig_i = i + 1  # trs[i] corresponds to day i+1
        plus_out[orig_i] = p_di
        minus_out[orig_i] = m_di

    # First ADX = average of first `period` DX values.
    # dxs[0..period-1] cover days (period+1)..(2*period). First ADX at day 2*period.
    if len(dxs) >= period:
        a = float(np.mean(dxs[:period]))
        first_adx_idx = 2 * period
        if first_adx_idx < n:
            adx_out[first_adx_idx] = a
        for j in range(period, len(dxs)):
            a = (a * (period - 1) + dxs[j]) / period
            orig_i = j + period + 1  # dxs[j] → day j + period + 1
            if orig_i < n:
                adx_out[orig_i] = a

    return pd.DataFrame(
        {"adx": adx_out, "plus_di": plus_out, "minus_di": minus_out},
        index=high.index,
    )


# ── Stochastic Oscillator ───────────────────────────────

def stochastic(high: pd.Series, low: pd.Series, close: pd.Series,
               k_period: int = 14, d_period: int = 3) -> pd.DataFrame:
    lowest = low.rolling(window=k_period, min_periods=k_period).min()
    highest = high.rolling(window=k_period, min_periods=k_period).max()
    denom = (highest - lowest).replace(0, np.nan)
    k = 100 * (close - lowest) / denom
    k = k.fillna(50)  # flat range → neutral
    d = k.rolling(window=d_period, min_periods=d_period).mean()
    return pd.DataFrame({"stoch_k": k, "stoch_d": d})


# ── MFI (Money Flow Index) ──────────────────────────────

def mfi(high: pd.Series, low: pd.Series, close: pd.Series,
        volume: pd.Series, period: int = 14) -> pd.Series:
    tp = (high + low + close) / 3
    rmf = tp * volume
    tp_diff = tp.diff()
    pos_flow = rmf.where(tp_diff > 0, 0)
    neg_flow = rmf.where(tp_diff < 0, 0)
    pos_sum = pos_flow.rolling(window=period, min_periods=period).sum()
    neg_sum = neg_flow.rolling(window=period, min_periods=period).sum()
    mfr = pos_sum / neg_sum.replace(0, np.nan)
    out = 100 - 100 / (1 + mfr)
    out = out.where(neg_sum != 0, 100.0)  # all positive = 100
    return out


# ── Helper: compute all indicators for a single symbol's OHLCV ──

def compute_all(df: pd.DataFrame) -> pd.DataFrame:
    """Given OHLCV DataFrame (columns: open, high, low, close, volume),
    add columns for all indicators.

    Expects df sorted by date ascending.
    """
    out = df.copy()
    c = df["close"]
    h = df["high"]
    l = df["low"]
    v = df["volume"]

    out["ma20"] = sma(c, 20)
    out["ma50"] = sma(c, 50)
    out["ma200"] = sma(c, 200)
    out["rsi14"] = rsi(c, 14)

    m = macd(c)
    out["macd"] = m["macd"]
    out["macd_signal"] = m["signal"]
    out["macd_hist"] = m["hist"]

    bb = bollinger(c)
    out["bb_upper"] = bb["bb_upper"]
    out["bb_middle"] = bb["bb_middle"]
    out["bb_lower"] = bb["bb_lower"]
    out["bb_width_pct"] = bb["bb_width_pct"]

    out["atr14"] = atr(h, l, c, 14)

    adx_df = adx(h, l, c, 14)
    out["adx14"] = adx_df["adx"]
    out["plus_di"] = adx_df["plus_di"]
    out["minus_di"] = adx_df["minus_di"]

    stoch = stochastic(h, l, c, 14, 3)
    out["stoch_k"] = stoch["stoch_k"]
    out["stoch_d"] = stoch["stoch_d"]

    out["mfi14"] = mfi(h, l, c, v, 14)

    return out
