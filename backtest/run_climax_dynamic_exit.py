"""V8.4 — Vol Climax Bounce với dynamic exit T+3 → T+5.

Plan exit rules:
- Buy @ open T+1
- Day T+3 close: if return >= target_pct → sell ATC
- Day T+4 close: if return >= target_pct → sell ATC
- Day T+5 close: sell ATC (force exit)
- SL: nếu close <= entry × (1 - sl_pct) bất kỳ phiên nào → sell next open

So sánh với:
- Fixed T+3 (baseline): hold đúng 3 phiên ATC
- Fixed T+5: hold đúng 5 phiên ATC
- Dynamic T+3→T+5 với target +3%

Test trên 8.5 năm (2018-2026) cross-validation.
"""

from __future__ import annotations

from pathlib import Path
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
    c = g["close"].values
    o = g["open"].values
    v = g["volume"].values

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


def simulate_dynamic_exit(
    df: pd.DataFrame,
    signal_col: str,
    min_hold: int = 3,
    max_hold: int = 5,
    target_pct: float = 0.03,
    sl_close_pct: float = None,  # close-based SL (None = no SL)
    cost: float = DEFAULT_COST_RT,
) -> pd.DataFrame:
    """Convention VN: T+0 = entry day = i+1. T+h = h days after entry = i+1+h.
    Dynamic: check target từ T+min_hold close, force exit T+max_hold close.
    SL CLOSE-based (không intraday) để tránh false trigger trên bounce volatility."""
    df = df.sort_values(["symbol", "date"])
    trades = []
    for sym, group in df.groupby("symbol", sort=False):
        g = group.reset_index(drop=True)
        sig = g[signal_col].values
        for i in range(len(g) - 1 - max_hold):
            if not sig[i]:
                continue
            ep = g.iloc[i + 1]["open"]
            if pd.isna(ep) or ep <= 0:
                continue

            exit_price = None
            exit_day = None
            # h = number of trading days after entry (1, 2, ..., max_hold)
            for h in range(1, max_hold + 1):
                day_idx = i + 1 + h
                if day_idx >= len(g):
                    break
                day_close = g.iloc[day_idx]["close"]
                if pd.isna(day_close):
                    continue

                # Close-based SL
                if sl_close_pct and day_close <= ep * (1 - sl_close_pct):
                    exit_price = day_close
                    exit_day = h
                    break

                # Min hold: check target
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
                "date": g.iloc[i]["date"],
                "symbol": sym,
                "exit_day": exit_day,
                "net_ret": (exit_price - ep) / ep - cost,
            })
    return pd.DataFrame(trades)


def simulate_fixed_exit(
    df: pd.DataFrame, signal_col: str, hold: int,
    sl_close_pct: float = None, cost: float = DEFAULT_COST_RT,
) -> pd.DataFrame:
    """Fixed T+hold: entry open(i+1), exit close(i+1+hold)."""
    df = df.sort_values(["symbol", "date"])
    trades = []
    for sym, group in df.groupby("symbol", sort=False):
        g = group.reset_index(drop=True)
        sig = g[signal_col].values
        for i in range(len(g) - 1 - hold):
            if not sig[i]:
                continue
            ep = g.iloc[i + 1]["open"]
            if pd.isna(ep) or ep <= 0:
                continue
            exit_price = None
            exit_day = None
            for h in range(1, hold + 1):
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
                if h == hold:
                    exit_price = day_close
                    exit_day = h
            if exit_price is None:
                continue
            trades.append({
                "date": g.iloc[i]["date"],
                "symbol": sym,
                "net_ret": (exit_price - ep) / ep - cost,
                "exit_day": exit_day,
            })
    return pd.DataFrame(trades)


def stats(trades: pd.DataFrame, hold_avg: float, window_years: float) -> dict:
    if len(trades) == 0:
        return {"n": 0, "win": 0, "avg": 0, "sharpe": 0, "pf": 0, "avg_hold": 0}
    win = (trades["net_ret"] > 0).mean()
    avg = trades["net_ret"].mean()
    std = trades["net_ret"].std()
    sharpe = (avg / std * (252 / hold_avg) ** 0.5) if std > 0 and hold_avg > 0 else 0
    pos_sum = trades.loc[trades["net_ret"] > 0, "net_ret"].sum()
    neg_sum = abs(trades.loc[trades["net_ret"] < 0, "net_ret"].sum())
    pf = pos_sum / neg_sum if neg_sum > 0 else float("inf")
    avg_hold = trades.get("exit_day", pd.Series([hold_avg])).mean()
    return {"n": len(trades), "win": win, "avg": avg, "sharpe": sharpe,
            "pf": pf, "avg_hold": avg_hold}


def main():
    print("Load + filter Large+Mid...")
    universe = load_universe()
    filtered = filter_largemid(universe)

    parts = [enrich(g) for _, g in filtered.groupby("symbol", sort=False)]
    df = pd.concat(parts, ignore_index=True)

    # Pattern: drop3d<-7% + vol>2× + green + RSI<35
    df["sig"] = (
        (df["ret_3d"] < -0.07) &
        (df["vol_ratio"] > 2.0) &
        df["day_green"] &
        (df["rsi"] < 35)
    )

    WINDOWS = [
        ("2018-01-01", "2026-05-13", "ALL 8.5y"),
        ("2024-01-01", "2026-05-13", "2024-2026"),
        ("2022-01-01", "2022-12-31", "2022 BEAR"),
        ("2023-01-01", "2023-12-31", "2023 sideways"),
    ]

    for start, end, label in WINDOWS:
        win_df = df[(df["date"] >= start) & (df["date"] <= end)].copy()
        years = (pd.to_datetime(end) - pd.to_datetime(start)).days / 365.25

        print(f"\n═══ {label} ({start} → {end}) ═══")
        print(f"  {'Strategy':<46} {'n':>4} {'Win%':>6} {'Avg':>7} {'Sharpe':>7} {'PF':>5} {'AvgHold':>7}")

        # Baseline T+3, no SL — đây là baseline gốc backtest
        t3 = simulate_fixed_exit(win_df, "sig", 3, sl_close_pct=None)
        s = stats(t3, 3, years)
        print(f"  Fixed T+3 baseline (no SL — gốc)              "
              f"{s['n']:4d} {s['win']*100:5.1f}% {s['avg']*100:+5.2f}% "
              f"{s['sharpe']:+.2f} {s['pf']:.2f} {s['avg_hold']:6.1f}")

        # Fixed T+5 no SL
        t5 = simulate_fixed_exit(win_df, "sig", 5, sl_close_pct=None)
        s = stats(t5, 5, years)
        print(f"  Fixed T+5 (force hold, no SL)                 "
              f"{s['n']:4d} {s['win']*100:5.1f}% {s['avg']*100:+5.2f}% "
              f"{s['sharpe']:+.2f} {s['pf']:.2f} {s['avg_hold']:6.1f}")

        # Dynamic T+3 → T+5 với target, no SL
        for target in [0.02, 0.03, 0.05]:
            dyn = simulate_dynamic_exit(win_df, "sig", 3, 5, target, sl_close_pct=None)
            avg_h = dyn["exit_day"].mean() if len(dyn) > 0 else 4
            s = stats(dyn, avg_h, years)
            print(f"  Dynamic T+3→T+5 (target +{target*100:.0f}%, no SL)            "
                  f"{s['n']:4d} {s['win']*100:5.1f}% {s['avg']*100:+5.2f}% "
                  f"{s['sharpe']:+.2f} {s['pf']:.2f} {s['avg_hold']:6.1f}")

        # Dynamic + close-based SL -6%
        for target in [0.03, 0.05]:
            for sl in [0.06, 0.08]:
                dyn = simulate_dynamic_exit(win_df, "sig", 3, 5, target, sl_close_pct=sl)
                avg_h = dyn["exit_day"].mean() if len(dyn) > 0 else 4
                s = stats(dyn, avg_h, years)
                print(f"  Dynamic T+3→T+5 (target +{target*100:.0f}%, close-SL -{sl*100:.0f}%) "
                      f"{s['n']:4d} {s['win']*100:5.1f}% {s['avg']*100:+5.2f}% "
                      f"{s['sharpe']:+.2f} {s['pf']:.2f} {s['avg_hold']:6.1f}")


if __name__ == "__main__":
    main()
