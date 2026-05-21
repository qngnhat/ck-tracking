"""HH/HL + trailing stop exit (giống Momentum tier).

Hypothesis: P3 HH/HL fail với target +3% T+3-5 vì exit logic mean-reversion.
Test với hold dài hơn + trailing stop 8% từ peak (giống Strength Continuation).
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
    g["ma20"] = cs.rolling(20).mean()
    g["ma50"] = cs.rolling(50).mean()
    g["vol_avg20"] = pd.Series(v).rolling(20).mean()
    g["vol_ratio"] = v / g["vol_avg20"]
    g["day_green"] = c > o

    h_series = pd.Series(h)
    l_series = pd.Series(l)
    g["hh_3"] = (h_series > h_series.shift(1)) & (h_series.shift(1) > h_series.shift(2)) & (h_series.shift(2) > h_series.shift(3))
    g["hl_3"] = (l_series > l_series.shift(1)) & (l_series.shift(1) > l_series.shift(2)) & (l_series.shift(2) > l_series.shift(3))

    g["uptrend"] = (g["ma20"] > g["ma50"]) & (cs > g["ma50"])
    return g


def simulate_trailing(df, sig_col, max_hold=20, trail_pct=0.08,
                     init_sl_pct=0.08, cost=DEFAULT_COST_RT):
    """Trailing stop: peak từ entry, exit khi close < peak × (1 - trail).
    Init SL = entry × (1 - init_sl). Force exit max_hold."""
    df = df.sort_values(["symbol", "date"])
    trades = []
    for sym, group in df.groupby("symbol", sort=False):
        g = group.reset_index(drop=True)
        sig = g[sig_col].values
        for i in range(len(g) - 1 - max_hold):
            if not sig[i]: continue
            ep = g.iloc[i + 1]["open"]
            if pd.isna(ep) or ep <= 0: continue

            init_sl = ep * (1 - init_sl_pct)
            peak = ep
            exit_price = None; exit_day = None

            for h in range(1, max_hold + 1):
                day_idx = i + 1 + h
                if day_idx >= len(g): break
                day_close = g.iloc[day_idx]["close"]
                if pd.isna(day_close): continue

                # Update peak (intraday high)
                day_high = g.iloc[day_idx]["high"]
                if not pd.isna(day_high) and day_high > peak:
                    peak = day_high

                # Trailing stop check (close-based)
                trail_sl = peak * (1 - trail_pct)
                effective_sl = max(init_sl, trail_sl)

                if day_close <= effective_sl:
                    exit_price = day_close; exit_day = h; break
                if h == max_hold:
                    exit_price = day_close; exit_day = h

            if exit_price is None: continue
            trades.append({
                "symbol": sym, "date": g.iloc[i]["date"],
                "net_ret": (exit_price - ep) / ep - cost,
                "exit_day": exit_day,
            })
    return pd.DataFrame(trades)


def stats(trades):
    if len(trades) == 0: return {"n": 0, "win": 0, "avg": 0, "sharpe": 0, "pf": 0}
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

    df["sig"] = df["hh_3"] & df["hl_3"] & df["day_green"] & df["uptrend"]
    df["sig_vol"] = df["sig"] & (df["vol_ratio"] > 1.2)

    VARIANTS = [
        ("HH/HL basic, hold 10 trail 8%", "sig", 10, 0.08),
        ("HH/HL basic, hold 15 trail 7%", "sig", 15, 0.07),
        ("HH/HL basic, hold 20 trail 8%", "sig", 20, 0.08),
        ("HH/HL basic, hold 20 trail 10%", "sig", 20, 0.10),
        ("HH/HL + vol>1.2, hold 15 trail 7%", "sig_vol", 15, 0.07),
        ("HH/HL + vol>1.2, hold 20 trail 8%", "sig_vol", 20, 0.08),
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
        for label, col, max_hold, trail in VARIANTS:
            tr = simulate_trailing(win_df, col, max_hold=max_hold, trail_pct=trail)
            print_row(label, stats(tr))


if __name__ == "__main__":
    main()
