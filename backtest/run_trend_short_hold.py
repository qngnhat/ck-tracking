"""HH/HL Trend với hold ngắn (T+3 → T+10) + target/trail combo.

User concern: T+20 quá dài cho VN T+ trader. Prefer T+3 → T+10.

Test variations:
1. Shorter hold (5, 7, 10) + various trail
2. Hybrid: target +3% OR trailing (whichever first)
3. Tighter entry filter (higher vol threshold) để boost win rate
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

    # RSI
    delta = np.diff(c, prepend=c[0])
    up = np.where(delta > 0, delta, 0)
    dn = np.where(delta < 0, -delta, 0)
    avg_up = pd.Series(up).rolling(14).mean()
    avg_dn = pd.Series(dn).rolling(14).mean()
    rs = avg_up / avg_dn.replace(0, np.nan)
    g["rsi"] = 100 - 100 / (1 + rs)

    g["uptrend"] = (g["ma20"] > g["ma50"]) & (cs > g["ma50"])
    return g


def simulate(df, sig_col, max_hold=10, trail_pct=0.05, init_sl_pct=0.06,
             target_pct=None, cost=DEFAULT_COST_RT):
    """Hybrid exit: init SL + trailing + optional target."""
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

                day_high = g.iloc[day_idx]["high"]
                if not pd.isna(day_high) and day_high > peak:
                    peak = day_high

                trail_sl = peak * (1 - trail_pct)
                effective_sl = max(init_sl, trail_sl)

                # Hard target (optional)
                if target_pct and day_close >= ep * (1 + target_pct):
                    exit_price = day_close; exit_day = h; break
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
    print(f"  {label:<58} {s['n']:5d} ({yr:5.1f}/yr) {s['win']*100:5.1f}% {s['avg']*100:+5.2f}% {s['sharpe']:+.2f} {s['pf']:.2f}")


def main():
    print("Load + enrich...")
    universe = load_universe()
    filtered = filter_largemid(universe)
    parts = [enrich(g) for _, g in filtered.groupby("symbol", sort=False)]
    df = pd.concat(parts, ignore_index=True)
    df["date"] = pd.to_datetime(df["date"])

    df["sig_basic"] = df["hh_3"] & df["hl_3"] & df["day_green"] & df["uptrend"]
    df["sig_vol"] = df["sig_basic"] & (df["vol_ratio"] > 1.2)
    df["sig_vol_strict"] = df["sig_basic"] & (df["vol_ratio"] > 2.0)
    df["sig_rsi"] = df["sig_basic"] & (df["vol_ratio"] > 1.2) & (df["rsi"] > 55) & (df["rsi"] < 75)

    SIGNALS = [
        ("HH/HL basic", "sig_basic"),
        ("HH/HL + vol>1.2", "sig_vol"),
        ("HH/HL + vol>2 (strict)", "sig_vol_strict"),
        ("HH/HL + vol>1.2 + RSI 55-75", "sig_rsi"),
    ]

    # Test variants — focus T+3 to T+10
    EXITS = [
        ("hold 5 trail 4%", 5, 0.04, None),
        ("hold 5 trail 5% +target 5%", 5, 0.05, 0.05),
        ("hold 7 trail 5%", 7, 0.05, None),
        ("hold 7 trail 5% +target 5%", 7, 0.05, 0.05),
        ("hold 7 trail 6% +target 6%", 7, 0.06, 0.06),
        ("hold 10 trail 5%", 10, 0.05, None),
        ("hold 10 trail 6%", 10, 0.06, None),
        ("hold 10 trail 5% +target 5%", 10, 0.05, 0.05),
        ("hold 10 trail 6% +target 7%", 10, 0.06, 0.07),
    ]

    # Use full 8.5y window
    win_df = df[(df["date"] >= "2018-01-01") & (df["date"] <= "2026-05-13")].copy()
    print(f"  Window: 2018-2026 (8.5y), {win_df.symbol.nunique()} mã\n")

    for sig_label, sig_col in SIGNALS:
        print(f"═══ {sig_label} ═══")
        print(f"  {'Exit config':<58} {'n':>5}  {'/yr':<7} {'Win%':>6} {'Avg':>7} {'Sharpe':>7} {'PF':>5}")
        for elabel, hold, trail, target in EXITS:
            tr = simulate(win_df, sig_col, max_hold=hold, trail_pct=trail, target_pct=target)
            print_row(elabel, stats(tr))
        print()


if __name__ == "__main__":
    main()
