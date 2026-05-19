"""B2 — Momentum Acceleration pattern.

Hypothesis: mã đã tăng 3-5 phiên + RSI cao + consolidation nhỏ → tiếp tục tăng
(acceleration phase, market FOMO). Khác Strength Continuation (yêu cầu RSI 50-70).

Spec:
- ret_3d ≥ +3% AND ret_5d ≥ +3%
- RSI ∈ [60, 85]  (allow overbought)
- range_pct < 3.5%
- day_green
- vol_ratio ≥ 1.0
- close > MA20
- turnover ≥ 3 tỷ

Test multiple variants.
"""

from __future__ import annotations
import numpy as np
import pandas as pd
from src.backtest import DEFAULT_COST_RT
from src.load_data import load_universe

TURNOVER_MIN_BN = 3.0


def filter_largemid(universe: pd.DataFrame) -> pd.DataFrame:
    recent = universe[universe.date >= "2024-01-01"].copy()
    recent["turnover"] = recent["close"] * recent["volume"] * 1000
    liq = recent.groupby("symbol")["turnover"].median() / 1e9
    keep = liq[liq >= TURNOVER_MIN_BN].index.tolist()
    return universe[universe.symbol.isin(keep)].copy()


def enrich(group: pd.DataFrame) -> pd.DataFrame:
    g = group.copy().reset_index(drop=True)
    c, o, h, l, v = g["close"].values, g["open"].values, g["high"].values, g["low"].values, g["volume"].values
    cs = pd.Series(c)
    g["ma20"] = cs.rolling(20).mean()
    g["ma50"] = cs.rolling(50).mean()
    g["vol_avg20"] = pd.Series(v).rolling(20).mean()
    g["vol_ratio"] = v / g["vol_avg20"]
    g["range_pct"] = (pd.Series(h) - pd.Series(l)) / cs
    g["day_green"] = c > o
    g["ret_3d"] = cs.pct_change(3)
    g["ret_5d"] = cs.pct_change(5)

    delta = np.diff(c, prepend=c[0])
    up = np.where(delta > 0, delta, 0)
    dn = np.where(delta < 0, -delta, 0)
    avg_up = pd.Series(up).rolling(14).mean()
    avg_dn = pd.Series(dn).rolling(14).mean()
    rs = avg_up / avg_dn.replace(0, np.nan)
    g["rsi"] = 100 - 100 / (1 + rs)

    g["above_ma20"] = cs > g["ma20"]
    g["above_ma50"] = cs > g["ma50"]
    return g


def simulate(df, sig_col, min_hold=3, max_hold=5, target_pct=0.03,
             sl_close_pct=0.08, cost=DEFAULT_COST_RT):
    df = df.sort_values(["symbol", "date"])
    trades = []
    for sym, group in df.groupby("symbol", sort=False):
        g = group.reset_index(drop=True)
        sig = g[sig_col].values
        for i in range(len(g) - 1 - max_hold):
            if not sig[i]:
                continue
            ep = g.iloc[i + 1]["open"]
            if pd.isna(ep) or ep <= 0:
                continue
            exit_price = None
            exit_day = None
            for h in range(1, max_hold + 1):
                day_idx = i + 1 + h
                if day_idx >= len(g):
                    break
                day_close = g.iloc[day_idx]["close"]
                if pd.isna(day_close):
                    continue
                if sl_close_pct and day_close <= ep * (1 - sl_close_pct):
                    exit_price = day_close
                    exit_day = h
                    break
                if h >= min_hold:
                    ret = (day_close - ep) / ep
                    if ret >= target_pct:
                        exit_price = day_close
                        exit_day = h
                        break
                if h == max_hold:
                    exit_price = day_close
                    exit_day = h
            if exit_price is None:
                continue
            trades.append({
                "date": g.iloc[i]["date"], "symbol": sym,
                "net_ret": (exit_price - ep) / ep - cost,
                "exit_day": exit_day,
            })
    return pd.DataFrame(trades)


def stats(trades, hold_avg=4):
    if len(trades) == 0:
        return {"n": 0, "win": 0, "avg": 0, "sharpe": 0, "pf": 0, "avg_hold": 0}
    win = (trades["net_ret"] > 0).mean()
    avg = trades["net_ret"].mean()
    std = trades["net_ret"].std()
    sharpe = (avg / std * (252 / hold_avg) ** 0.5) if std > 0 and hold_avg > 0 else 0
    pos = trades.loc[trades["net_ret"] > 0, "net_ret"].sum()
    neg = abs(trades.loc[trades["net_ret"] < 0, "net_ret"].sum())
    pf = pos / neg if neg > 0 else float("inf")
    return {"n": len(trades), "win": win, "avg": avg, "sharpe": sharpe, "pf": pf}


def print_row(label, s):
    n_per_year = s['n'] / 8.5 if s['n'] > 0 else 0
    print(f"  {label:<58} {s['n']:5d} ({n_per_year:5.1f}/yr) "
          f"{s['win']*100:5.1f}% {s['avg']*100:+5.2f}% {s['sharpe']:+.2f} {s['pf']:.2f}")


def main():
    print("Load + filter Large+Mid...")
    universe = load_universe()
    filtered = filter_largemid(universe)
    print(f"  {filtered.symbol.nunique()} mã\n")

    parts = [enrich(g) for _, g in filtered.groupby("symbol", sort=False)]
    df = pd.concat(parts, ignore_index=True)
    df["date"] = pd.to_datetime(df["date"])

    # B2 variants
    df["v1_loose"] = (
        (df["ret_3d"] >= 0.03) & (df["ret_5d"] >= 0.03) &
        (df["rsi"] >= 60) & (df["rsi"] <= 85) &
        (df["range_pct"] < 0.035) & df["day_green"] &
        (df["vol_ratio"] >= 1.0) & df["above_ma20"]
    )
    df["v2_higher_rsi"] = (
        (df["ret_3d"] >= 0.03) & (df["ret_5d"] >= 0.03) &
        (df["rsi"] >= 65) & (df["rsi"] <= 85) &
        (df["range_pct"] < 0.035) & df["day_green"] &
        (df["vol_ratio"] >= 1.0) & df["above_ma20"]
    )
    df["v3_vol_15"] = (
        (df["ret_3d"] >= 0.03) & (df["ret_5d"] >= 0.03) &
        (df["rsi"] >= 60) & (df["rsi"] <= 80) &
        (df["range_pct"] < 0.035) & df["day_green"] &
        (df["vol_ratio"] >= 1.5) & df["above_ma20"]
    )
    df["v4_tight_range"] = (
        (df["ret_3d"] >= 0.03) & (df["ret_5d"] >= 0.03) &
        (df["rsi"] >= 60) & (df["rsi"] <= 80) &
        (df["range_pct"] < 0.025) & df["day_green"] &
        (df["vol_ratio"] >= 1.0) & df["above_ma20"]
    )
    df["v5_strong_uptrend"] = (
        (df["ret_3d"] >= 0.03) & (df["ret_5d"] >= 0.03) &
        (df["rsi"] >= 60) & (df["rsi"] <= 80) &
        (df["range_pct"] < 0.035) & df["day_green"] &
        (df["vol_ratio"] >= 1.0) & df["above_ma20"] & df["above_ma50"]
    )
    df["v6_higher_ret"] = (
        (df["ret_3d"] >= 0.05) & (df["ret_5d"] >= 0.05) &
        (df["rsi"] >= 60) & (df["rsi"] <= 80) &
        (df["range_pct"] < 0.035) & df["day_green"] &
        (df["vol_ratio"] >= 1.0) & df["above_ma20"]
    )

    VARIANTS = [
        ("v1: ret>=3%, RSI 60-85, range<3.5, vol>=1, >MA20", "v1_loose"),
        ("v2: same v1 nhưng RSI 65-85", "v2_higher_rsi"),
        ("v3: vol>=1.5 (stricter)", "v3_vol_15"),
        ("v4: range<2.5 (tighter)", "v4_tight_range"),
        ("v5: +above MA50 (strong uptrend)", "v5_strong_uptrend"),
        ("v6: ret>=5% (higher momentum)", "v6_higher_ret"),
    ]

    WINDOWS = [
        ("2018-01-01", "2026-05-13", "ALL 8.5y"),
        ("2024-01-01", "2026-05-13", "2024-2026 in-sample"),
        ("2018-01-01", "2023-12-31", "2018-2023 out-sample"),
    ]

    for start, end, label in WINDOWS:
        win_df = df[(df["date"] >= start) & (df["date"] <= end)].copy()
        print(f"\n═══ {label} ═══")
        print(f"  {'Variant':<58} {'n':>5}  {'/yr':<7} {'Win%':>6} {'Avg':>7} {'Sharpe':>7} {'PF':>5}")
        for vlabel, vcol in VARIANTS:
            tr = simulate(win_df, vcol)
            s = stats(tr)
            print_row(vlabel, s)


if __name__ == "__main__":
    main()
