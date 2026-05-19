"""B1 — Oversold Reversal Soft pattern.

Hypothesis: mã có drop nhẹ (-1 → -5%) + RSI deeply oversold + nến xanh
xác nhận → bounce, nhỏ hơn capitulation Tier A/B nhưng phổ biến hơn.

Backtest 8.5y cross-val so với Tier A/B.

Spec:
- drop3d ∈ [-5%, -1%]  (soft drop, không phải capitulation)
- RSI < 30
- Day green
- vol_ratio ≥ 0.8 (any reasonable vol)
- turnover ≥ 3 tỷ

T+ exit (same as Climax): dynamic T+3→T+5, target +3% close, SL -8% close.
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
    c, o, v = g["close"].values, g["open"].values, g["volume"].values

    g["vol_avg20"] = pd.Series(v).rolling(20).mean()
    g["vol_ratio"] = v / g["vol_avg20"]
    g["ret_3d"] = pd.Series(c).pct_change(3)
    g["day_green"] = c > o

    delta = np.diff(c, prepend=c[0])
    up = np.where(delta > 0, delta, 0)
    dn = np.where(delta < 0, -delta, 0)
    avg_up = pd.Series(up).rolling(14).mean()
    avg_dn = pd.Series(dn).rolling(14).mean()
    rs = avg_up / avg_dn.replace(0, np.nan)
    g["rsi"] = 100 - 100 / (1 + rs)
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
    avg_hold = trades.get("exit_day", pd.Series([hold_avg])).mean()
    return {"n": len(trades), "win": win, "avg": avg, "sharpe": sharpe, "pf": pf, "avg_hold": avg_hold}


def print_row(label, s):
    n_per_year = s['n'] / 8.5 if s['n'] > 0 else 0
    print(f"  {label:<60} {s['n']:5d} ({n_per_year:5.1f}/yr) "
          f"{s['win']*100:5.1f}% {s['avg']*100:+5.2f}% {s['sharpe']:+.2f} {s['pf']:.2f}")


def main():
    print("Load + filter Large+Mid...")
    universe = load_universe()
    filtered = filter_largemid(universe)
    print(f"  {filtered.symbol.nunique()} mã\n")

    parts = [enrich(g) for _, g in filtered.groupby("symbol", sort=False)]
    df = pd.concat(parts, ignore_index=True)
    df["date"] = pd.to_datetime(df["date"])

    # Tier A/B baseline
    df["sig_tier_a"] = (
        (df["ret_3d"] < -0.07) & (df["vol_ratio"] > 2.0) &
        df["day_green"] & (df["rsi"] < 35)
    )
    df["sig_tier_b"] = (
        (df["ret_3d"] < -0.05) & (df["vol_ratio"] > 2.0) &
        df["day_green"] & (df["rsi"] < 50)
    )

    # B1 variants — Oversold Reversal Soft
    df["v1_rsi30_vol08"] = (
        (df["ret_3d"] >= -0.05) & (df["ret_3d"] < -0.01) &
        (df["rsi"] < 30) & df["day_green"] & (df["vol_ratio"] >= 0.8)
    )
    df["v2_rsi30_anyvol"] = (
        (df["ret_3d"] >= -0.05) & (df["ret_3d"] < -0.01) &
        (df["rsi"] < 30) & df["day_green"]
    )
    df["v3_rsi35_vol12"] = (
        (df["ret_3d"] >= -0.05) & (df["ret_3d"] < -0.01) &
        (df["rsi"] < 35) & df["day_green"] & (df["vol_ratio"] >= 1.2)
    )
    df["v4_rsi28_strict"] = (
        (df["ret_3d"] >= -0.05) & (df["ret_3d"] < -0.01) &
        (df["rsi"] < 28) & df["day_green"] & (df["vol_ratio"] >= 0.8)
    )
    df["v5_rsi30_drop_wider"] = (
        (df["ret_3d"] >= -0.07) & (df["ret_3d"] < 0) &
        (df["rsi"] < 30) & df["day_green"] & (df["vol_ratio"] >= 0.8)
    )

    VARIANTS = [
        ("Tier A baseline (drop<-7, vol>2, RSI<35)", "sig_tier_a"),
        ("Tier B baseline (drop<-5, vol>2, RSI<50)", "sig_tier_b"),
        ("v1: drop -5..-1, RSI<30, green, vol>=0.8", "v1_rsi30_vol08"),
        ("v2: same v1 nhưng anyvol", "v2_rsi30_anyvol"),
        ("v3: drop -5..-1, RSI<35, vol>=1.2", "v3_rsi35_vol12"),
        ("v4: drop -5..-1, RSI<28 strict", "v4_rsi28_strict"),
        ("v5: drop -7..0, RSI<30, vol>=0.8 (wider drop)", "v5_rsi30_drop_wider"),
    ]

    WINDOWS = [
        ("2018-01-01", "2026-05-13", "ALL 8.5y"),
        ("2024-01-01", "2026-05-13", "2024-2026 in-sample"),
        ("2018-01-01", "2023-12-31", "2018-2023 out-sample"),
    ]

    for start, end, label in WINDOWS:
        win_df = df[(df["date"] >= start) & (df["date"] <= end)].copy()
        print(f"\n═══ {label} ═══")
        print(f"  {'Variant':<60} {'n':>5}  {'/yr':<7} {'Win%':>6} {'Avg':>7} {'Sharpe':>7} {'PF':>5}")
        for vlabel, vcol in VARIANTS:
            tr = simulate(win_df, vcol)
            avg_h = tr["exit_day"].mean() if len(tr) > 0 else 4
            s = stats(tr, avg_h)
            print_row(vlabel, s)


if __name__ == "__main__":
    main()
