"""Extra momentum patterns — add depth to 'Đà tăng' style.

Existing: Strength Continuation (MA stack + range + vol + RSI 50-70) — Sharpe 0.60.

Test 4 new candidates:
1. MACD bullish cross — MACD line crosses signal line + uptrend
2. 60-day high breakout — close > 60d high + vol confirm
3. HH/HL trend continuation — 3 higher highs + 3 higher lows
4. Vol expansion breakout — consolidation low vol, today vol expansion

T+ exit same as Climax (target +3% T+3-5, SL -8% close) cho easy comparison.

Already FAILED earlier (this session, don't retry):
- Pullback MA20 + dry-up — Sharpe -0.53
- Breakout retest — Sharpe -0.26
- Vol+price thrust standalone — Sharpe -0.35
- Gap up follow-through — Sharpe -0.44
- Oversold reversal soft — all variants Win <50%

Ship pattern nếu Sharpe > 0.5 cross-val cả 2 windows.
"""

from __future__ import annotations
import numpy as np
import pandas as pd
from src.backtest import DEFAULT_COST_RT
from src.load_data import load_universe


def filter_largemid(universe):
    recent = universe[universe.date >= "2024-01-01"].copy()
    recent["turnover"] = recent["close"] * recent["volume"] * 1000
    liq = recent.groupby("symbol")["turnover"].median() / 1e9
    keep = liq[liq >= 3.0].index.tolist()
    return universe[universe.symbol.isin(keep)].copy()


def enrich(group):
    g = group.copy().reset_index(drop=True)
    c, o, h, l, v = g["close"].values, g["open"].values, g["high"].values, g["low"].values, g["volume"].values
    cs = pd.Series(c)
    g["ma5"] = cs.rolling(5).mean()
    g["ma20"] = cs.rolling(20).mean()
    g["ma50"] = cs.rolling(50).mean()
    g["ma200"] = cs.rolling(200).mean()
    g["vol_avg20"] = pd.Series(v).rolling(20).mean()
    g["vol_ratio"] = v / g["vol_avg20"]
    g["range_pct"] = (pd.Series(h) - pd.Series(l)) / cs
    g["day_green"] = c > o
    g["ret_1d"] = cs.pct_change(1)

    # MACD (12,26,9)
    ema12 = cs.ewm(span=12, adjust=False).mean()
    ema26 = cs.ewm(span=26, adjust=False).mean()
    macd_line = ema12 - ema26
    macd_signal = macd_line.ewm(span=9, adjust=False).mean()
    g["macd_diff"] = macd_line - macd_signal
    g["macd_cross_up"] = (g["macd_diff"] > 0) & (g["macd_diff"].shift(1) <= 0)

    # 60-day high
    g["high_60"] = pd.Series(h).rolling(60).max()
    g["new_60d_high"] = pd.Series(h).values >= pd.Series(h).rolling(60).max().shift(1).values
    # Convert to clean bool series
    g["new_60d_high"] = pd.Series(g["new_60d_high"]).fillna(False)

    # HH/HL trend
    h_series = pd.Series(h)
    l_series = pd.Series(l)
    g["hh_3"] = (h_series > h_series.shift(1)) & (h_series.shift(1) > h_series.shift(2)) & (h_series.shift(2) > h_series.shift(3))
    g["hl_3"] = (l_series > l_series.shift(1)) & (l_series.shift(1) > l_series.shift(2)) & (l_series.shift(2) > l_series.shift(3))

    # Vol expansion (vs 5-day average vol)
    g["vol_avg5"] = pd.Series(v).rolling(5).mean()
    g["vol_expansion"] = v / g["vol_avg5"]

    # RSI
    delta = np.diff(c, prepend=c[0])
    up = np.where(delta > 0, delta, 0)
    dn = np.where(delta < 0, -delta, 0)
    avg_up = pd.Series(up).rolling(14).mean()
    avg_dn = pd.Series(dn).rolling(14).mean()
    rs = avg_up / avg_dn.replace(0, np.nan)
    g["rsi"] = 100 - 100 / (1 + rs)

    g["uptrend"] = (g["ma20"] > g["ma50"]) & (cs > g["ma50"])
    g["uptrend_strong"] = (g["ma5"] > g["ma20"]) & (g["ma20"] > g["ma50"]) & (g["ma50"] > g["ma200"])
    return g


def simulate(df, sig_col, cost=DEFAULT_COST_RT):
    df = df.sort_values(["symbol", "date"])
    trades = []
    for sym, group in df.groupby("symbol", sort=False):
        g = group.reset_index(drop=True)
        sig = g[sig_col].values
        for i in range(len(g) - 6):
            if not sig[i]: continue
            ep = g.iloc[i + 1]["open"]
            if pd.isna(ep) or ep <= 0: continue
            exit_price = None; exit_day = None
            for h in range(1, 6):
                day_idx = i + 1 + h
                if day_idx >= len(g): break
                day_close = g.iloc[day_idx]["close"]
                if pd.isna(day_close): continue
                if day_close <= ep * 0.92:
                    exit_price = day_close; exit_day = h; break
                if h >= 3:
                    if (day_close - ep) / ep >= 0.03:
                        exit_price = day_close; exit_day = h; break
                if h == 5:
                    exit_price = day_close; exit_day = h
            if exit_price is None: continue
            trades.append({
                "symbol": sym, "date": g.iloc[i]["date"],
                "net_ret": (exit_price - ep) / ep - cost,
                "exit_day": exit_day,
            })
    return pd.DataFrame(trades)


def stats(trades):
    if len(trades) == 0:
        return {"n": 0, "win": 0, "avg": 0, "sharpe": 0, "pf": 0}
    win = (trades["net_ret"] > 0).mean()
    avg = trades["net_ret"].mean()
    std = trades["net_ret"].std()
    hold = trades["exit_day"].mean()
    sharpe = (avg / std * (252 / hold) ** 0.5) if std > 0 and hold > 0 else 0
    pos = trades.loc[trades["net_ret"] > 0, "net_ret"].sum()
    neg = abs(trades.loc[trades["net_ret"] < 0, "net_ret"].sum())
    pf = pos / neg if neg > 0 else float("inf")
    return {"n": len(trades), "win": win, "avg": avg, "sharpe": sharpe, "pf": pf}


def print_row(label, s):
    yr = s['n'] / 8.5 if s['n'] > 0 else 0
    print(f"  {label:<60} {s['n']:5d} ({yr:5.1f}/yr) {s['win']*100:5.1f}% {s['avg']*100:+5.2f}% {s['sharpe']:+.2f} {s['pf']:.2f}")


def main():
    print("Load + enrich...")
    universe = load_universe()
    filtered = filter_largemid(universe)
    print(f"  {filtered.symbol.nunique()} mã\n")
    parts = [enrich(g) for _, g in filtered.groupby("symbol", sort=False)]
    df = pd.concat(parts, ignore_index=True)
    df["date"] = pd.to_datetime(df["date"])

    # P1: MACD bullish cross — variant
    df["p1_macd"] = df["macd_cross_up"] & df["uptrend"] & df["day_green"] & (df["vol_ratio"] > 1.0)
    df["p1_macd_strict"] = df["macd_cross_up"] & df["uptrend_strong"] & df["day_green"] & (df["vol_ratio"] > 1.2)

    # P2: 60-day high breakout
    df["p2_60d_break"] = df["new_60d_high"] & (df["vol_ratio"] > 1.5) & df["day_green"]
    df["p2_60d_strict"] = df["new_60d_high"] & (df["vol_ratio"] > 2.0) & df["day_green"] & df["uptrend"]

    # P3: HH/HL trend continuation
    df["p3_hh_hl"] = df["hh_3"] & df["hl_3"] & df["day_green"] & df["uptrend"]
    df["p3_hh_hl_vol"] = df["hh_3"] & df["hl_3"] & df["day_green"] & (df["vol_ratio"] > 1.2)

    # P4: Vol expansion breakout (5d vol expansion)
    df["p4_vol_expand"] = (df["vol_expansion"] > 2.5) & df["day_green"] & df["uptrend"] & (df["rsi"] > 50) & (df["rsi"] < 75)

    VARIANTS = [
        ("P1 MACD cross + uptrend + green + vol>1", "p1_macd"),
        ("P1b MACD cross + uptrend STRONG + vol>1.2", "p1_macd_strict"),
        ("P2 60d high break + vol>1.5 + green", "p2_60d_break"),
        ("P2b 60d high + vol>2 + uptrend (strict)", "p2_60d_strict"),
        ("P3 HH/HL 3 + green + uptrend", "p3_hh_hl"),
        ("P3b HH/HL + vol>1.2", "p3_hh_hl_vol"),
        ("P4 Vol expansion 2.5× + uptrend + RSI 50-75", "p4_vol_expand"),
    ]

    WINDOWS = [
        ("2018-01-01", "2026-05-13", "ALL 8.5y"),
        ("2024-01-01", "2026-05-13", "2024-2026 in-sample"),
        ("2018-01-01", "2023-12-31", "2018-2023 out-sample"),
    ]

    for s, e, l in WINDOWS:
        win_df = df[(df["date"] >= s) & (df["date"] <= e)].copy()
        print(f"\n═══ {l} ═══")
        print(f"  {'Variant':<60} {'n':>5}  {'/yr':<7} {'Win%':>6} {'Avg':>7} {'Sharpe':>7} {'PF':>5}")
        for vl, vc in VARIANTS:
            print_row(vl, stats(simulate(win_df, vc)))


if __name__ == "__main__":
    main()
