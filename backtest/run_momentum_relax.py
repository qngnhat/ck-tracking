"""V9.1 — Tier Momentum relax variants.

Original Pattern 3 (Strength Continuation):
- MA5 > MA20 > MA50 > MA200
- range < 2.5% AND vol > 1.5× AND green AND RSI 50-70
→ Backtest 8.5y: ~59 trades/năm, Win 48.9%, Sharpe 0.87 — quá hiếm cho daily app.

Test variants relax để tăng tần suất, miễn edge không bị crush.
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
    g["ma5"] = cs.rolling(5).mean()
    g["ma20"] = cs.rolling(20).mean()
    g["ma50"] = cs.rolling(50).mean()
    g["ma200"] = cs.rolling(200).mean()
    g["vol_avg20"] = pd.Series(v).rolling(20).mean()
    g["vol_ratio"] = v / g["vol_avg20"]
    g["range_pct"] = (pd.Series(h) - pd.Series(l)) / cs
    g["day_green"] = c > o

    delta = np.diff(c, prepend=c[0])
    up = np.where(delta > 0, delta, 0)
    dn = np.where(delta < 0, -delta, 0)
    avg_up = pd.Series(up).rolling(14).mean()
    avg_dn = pd.Series(dn).rolling(14).mean()
    rs = avg_up / avg_dn.replace(0, np.nan)
    g["rsi"] = 100 - 100 / (1 + rs)

    g["uptrend_strong"] = (g["ma5"] > g["ma20"]) & (g["ma20"] > g["ma50"]) & (g["ma50"] > g["ma200"])
    g["uptrend_mid"] = (cs > g["ma20"]) & (g["ma20"] > g["ma50"])  # softer

    return g


def simulate(df, sig_col, min_hold=3, max_hold=20, target_pct=0.035, sl_close_pct=0.08, cost=DEFAULT_COST_RT):
    """Momentum hold ~20 phiên với target +3.5% per backtest gốc."""
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


def stats(trades, hold_avg=10):
    if len(trades) == 0:
        return {"n": 0, "win": 0, "avg": 0, "sharpe": 0, "pf": 0, "avg_hold": 0}
    win = (trades["net_ret"] > 0).mean()
    avg = trades["net_ret"].mean()
    std = trades["net_ret"].std()
    sharpe = (avg / std * (252 / hold_avg) ** 0.5) if std > 0 and hold_avg > 0 else 0
    pos = trades.loc[trades["net_ret"] > 0, "net_ret"].sum()
    neg = abs(trades.loc[trades["net_ret"] < 0, "net_ret"].sum())
    pf = pos / neg if neg > 0 else float("inf")
    avg_hold = trades.get("exit_day", pd.Series([hold_avg])).mean()
    return {"n": len(trades), "win": win, "avg": avg, "sharpe": sharpe, "pf": pf, "avg_hold": avg_hold}


def print_row(label, s):
    n_per_year = s['n'] / 8.5 if s['n'] > 0 else 0
    print(f"  {label:<55} {s['n']:5d} ({n_per_year:5.1f}/yr) "
          f"{s['win']*100:5.1f}% {s['avg']*100:+5.2f}% {s['sharpe']:+.2f} {s['pf']:.2f}")


def main():
    print("Load data...")
    universe = load_universe()
    filtered = filter_largemid(universe)
    print(f"  {filtered.symbol.nunique()} mã")
    parts = [enrich(g) for _, g in filtered.groupby("symbol", sort=False)]
    df = pd.concat(parts, ignore_index=True)
    df["date"] = pd.to_datetime(df["date"])

    # Variants:
    df["v1_original"] = (
        df["uptrend_strong"] & (df["range_pct"] < 0.025) &
        (df["vol_ratio"] > 1.5) & df["day_green"] &
        (df["rsi"] > 50) & (df["rsi"] < 70)
    )
    # Relax vol 1.5 → 1.2
    df["v2_vol_1_2"] = (
        df["uptrend_strong"] & (df["range_pct"] < 0.025) &
        (df["vol_ratio"] > 1.2) & df["day_green"] &
        (df["rsi"] > 50) & (df["rsi"] < 70)
    )
    # Relax range 2.5 → 3.5
    df["v3_range_3_5"] = (
        df["uptrend_strong"] & (df["range_pct"] < 0.035) &
        (df["vol_ratio"] > 1.5) & df["day_green"] &
        (df["rsi"] > 50) & (df["rsi"] < 70)
    )
    # Relax cả vol + range
    df["v4_vol_range_relax"] = (
        df["uptrend_strong"] & (df["range_pct"] < 0.035) &
        (df["vol_ratio"] > 1.2) & df["day_green"] &
        (df["rsi"] > 50) & (df["rsi"] < 70)
    )
    # Relax uptrend (drop MA200 requirement) → uptrend_mid only
    df["v5_uptrend_mid"] = (
        df["uptrend_mid"] & (df["range_pct"] < 0.025) &
        (df["vol_ratio"] > 1.5) & df["day_green"] &
        (df["rsi"] > 50) & (df["rsi"] < 70)
    )
    # Relax RSI band
    df["v6_rsi_45_75"] = (
        df["uptrend_strong"] & (df["range_pct"] < 0.025) &
        (df["vol_ratio"] > 1.5) & df["day_green"] &
        (df["rsi"] > 45) & (df["rsi"] < 75)
    )
    # Combined moderate relax (target ~3-5 trades/week)
    df["v7_moderate"] = (
        df["uptrend_mid"] & (df["range_pct"] < 0.035) &
        (df["vol_ratio"] > 1.2) & df["day_green"] &
        (df["rsi"] > 50) & (df["rsi"] < 75)
    )
    # Aggressive relax (more signals)
    df["v8_aggressive"] = (
        df["uptrend_mid"] & (df["range_pct"] < 0.04) &
        (df["vol_ratio"] > 1.0) & df["day_green"] &
        (df["rsi"] > 45) & (df["rsi"] < 75)
    )

    VARIANTS = [
        ("v1_original (range<2.5, vol>1.5, MA200, RSI 50-70)", "v1_original"),
        ("v2 relax vol > 1.2", "v2_vol_1_2"),
        ("v3 relax range < 3.5", "v3_range_3_5"),
        ("v4 relax vol+range", "v4_vol_range_relax"),
        ("v5 drop MA200 req (uptrend_mid)", "v5_uptrend_mid"),
        ("v6 relax RSI 45-75", "v6_rsi_45_75"),
        ("v7 moderate (vol>1.2, range<3.5, mid, RSI<75)", "v7_moderate"),
        ("v8 aggressive (vol>1.0, range<4, RSI<75)", "v8_aggressive"),
    ]

    WINDOWS = [
        ("2018-01-01", "2026-05-13", "ALL 8.5y"),
        ("2024-01-01", "2026-05-13", "2024-2026 in-sample"),
        ("2018-01-01", "2023-12-31", "2018-2023 out-sample"),
    ]

    for win_start, win_end, label in WINDOWS:
        win_df = df[(df["date"] >= win_start) & (df["date"] <= win_end)].copy()
        print(f"\n═══ {label} ═══")
        print(f"  {'Variant':<55} {'n':>5}  {'/yr':<6} {'Win%':>6} {'Avg':>7} {'Sharpe':>7} {'PF':>5}")
        for vlabel, vcol in VARIANTS:
            tr = simulate(win_df, vcol)
            avg_h = tr["exit_day"].mean() if len(tr) > 0 else 10
            s = stats(tr, avg_h)
            print_row(vlabel, s)


if __name__ == "__main__":
    main()
