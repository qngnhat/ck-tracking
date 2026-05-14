"""V8.5 — Vol Climax Bounce với exit at PEAK (mô phỏng user canh chart).

So sánh:
- Fixed T+3 close (baseline gốc)
- Fixed T+5 close
- Dynamic T+3→T+5 target +3% close-based (current strategy)
- Peak exit T+3→T+5: bán tại MAX(high T+3..T+5) × discount
  + discount = 1.00 (idealistic, no slippage)
  + discount = 0.99 (catch đỉnh, 1% slippage)
  + discount = 0.98 (react chậm, 2% slippage)
  + discount = 0.97 (react rất chậm, 3% slippage)
- Peak exit + close-based SL -8% (cắt trước nếu thủng)

Đánh giá: peak exit có capture được upside mà cap +3% miss không.
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


def simulate_peak_exit(
    df: pd.DataFrame,
    signal_col: str,
    min_hold: int = 3,
    max_hold: int = 5,
    peak_discount: float = 0.99,
    sl_close_pct: float = None,
    cost: float = DEFAULT_COST_RT,
) -> pd.DataFrame:
    """Peak exit: từ T+min_hold tới T+max_hold, exit tại MAX(high) × discount.
    Modelt user canh chart, bắt được đỉnh ngày với slippage.
    Close-based SL: nếu close <= entry × (1-sl_close_pct) trong period → exit close.
    """
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
            exit_reason = None

            # Track peak từ T+min_hold trở đi. Trước đó (T+1, T+2) chỉ check SL.
            # Logic: ngày nào có new peak, ghi nhận. Nếu sau đó giá giảm dưới
            # peak × discount → exit (mô phỏng user react).
            running_peak = -np.inf
            peak_day = None

            for h in range(1, max_hold + 1):
                day_idx = i + 1 + h
                if day_idx >= len(g):
                    break
                day_open  = g.iloc[day_idx]["open"]
                day_high  = g.iloc[day_idx]["high"]
                day_low   = g.iloc[day_idx]["low"]
                day_close = g.iloc[day_idx]["close"]
                if pd.isna(day_close):
                    continue

                # Close-based SL trước tiên (mọi ngày)
                if sl_close_pct and day_close <= ep * (1 - sl_close_pct):
                    exit_price = day_close
                    exit_day = h
                    exit_reason = "sl"
                    break

                # Từ T+min_hold mới được bán
                if h >= min_hold:
                    if day_high > running_peak:
                        running_peak = day_high
                        peak_day = h

                    if h == max_hold:
                        # Hết hạn: bán tại MAX peak × discount, hoặc close nếu peak < close
                        candidate = running_peak * peak_discount if running_peak > 0 else day_close
                        exit_price = max(candidate, day_close * peak_discount)  # fallback
                        # Realistic: nếu peak xảy ra ngày trước T+max, mày đã bán rồi.
                        # Vì backtest assume bán-tại-peak-ngày-xảy-ra:
                        exit_price = running_peak * peak_discount if running_peak > 0 else day_close
                        exit_day = peak_day if peak_day else h
                        exit_reason = "peak"
                        break

            if exit_price is None:
                continue
            trades.append({
                "date": g.iloc[i]["date"],
                "symbol": sym,
                "exit_day": exit_day,
                "reason": exit_reason,
                "net_ret": (exit_price - ep) / ep - cost,
            })
    return pd.DataFrame(trades)


def simulate_fixed_exit(
    df: pd.DataFrame, signal_col: str, hold: int,
    sl_close_pct: float = None, cost: float = DEFAULT_COST_RT,
) -> pd.DataFrame:
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
                "exit_day": exit_day,
                "net_ret": (exit_price - ep) / ep - cost,
            })
    return pd.DataFrame(trades)


def simulate_dynamic_close_target(
    df: pd.DataFrame, signal_col: str,
    min_hold=3, max_hold=5, target_pct=0.03,
    sl_close_pct: float = None, cost: float = DEFAULT_COST_RT,
) -> pd.DataFrame:
    """Strategy hiện tại: dynamic close-based target."""
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
                "date": g.iloc[i]["date"],
                "symbol": sym,
                "exit_day": exit_day,
                "net_ret": (exit_price - ep) / ep - cost,
            })
    return pd.DataFrame(trades)


def stats(trades: pd.DataFrame, hold_avg: float) -> dict:
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


def print_row(label: str, s: dict):
    print(f"  {label:<52} "
          f"{s['n']:4d} {s['win']*100:5.1f}% {s['avg']*100:+5.2f}% "
          f"{s['sharpe']:+.2f} {s['pf']:.2f} {s['avg_hold']:6.2f}")


def main():
    print("Load + filter Large+Mid…")
    universe = load_universe()
    filtered = filter_largemid(universe)
    print(f"  {filtered.symbol.nunique()} mã sau filter turnover ≥ {TURNOVER_MIN_BN} tỷ/ngày")

    parts = [enrich(g) for _, g in filtered.groupby("symbol", sort=False)]
    df = pd.concat(parts, ignore_index=True)

    # Tier A pattern: drop3d<-7% + vol>2× + green + RSI<35
    df["sigA"] = (
        (df["ret_3d"] < -0.07) &
        (df["vol_ratio"] > 2.0) &
        df["day_green"] &
        (df["rsi"] < 35)
    )
    # Tier B pattern: drop3d<-5% + vol>2× + green + RSI<50
    df["sigB"] = (
        (df["ret_3d"] < -0.05) &
        (df["vol_ratio"] > 2.0) &
        df["day_green"] &
        (df["rsi"] < 50)
    )

    WINDOWS = [
        ("2018-01-01", "2026-05-13", "ALL 8.5y cross-val"),
        ("2024-01-01", "2026-05-13", "2024-2026 in-sample"),
    ]

    for sig_col, sig_label in [("sigA", "Tier A strict"), ("sigB", "Tier B relax")]:
        print(f"\n\n████ {sig_label} ████")
        for start, end, label in WINDOWS:
            win_df = df[(df["date"] >= start) & (df["date"] <= end)].copy()

            print(f"\n═══ {label} ({start} → {end}) ═══")
            print(f"  {'Strategy':<52} "
                  f"{'n':>4} {'Win%':>6} {'Avg':>7} {'Sharpe':>7} {'PF':>5} {'AvgHold':>7}")

            # Baselines
            t3 = simulate_fixed_exit(win_df, sig_col, 3)
            print_row("Fixed T+3 close (baseline gốc)", stats(t3, 3))

            t5 = simulate_fixed_exit(win_df, sig_col, 5)
            print_row("Fixed T+5 close (force hold)", stats(t5, 5))

            # Current strategy: dynamic close target +3%
            for tgt in [0.03, 0.05]:
                dyn = simulate_dynamic_close_target(win_df, sig_col, 3, 5, tgt)
                avg_h = dyn["exit_day"].mean() if len(dyn) > 0 else 4
                print_row(f"Dynamic T+3→T+5 close-target +{int(tgt*100)}%", stats(dyn, avg_h))

            # Peak exit với các discount khác nhau
            for disc in [1.00, 0.99, 0.98, 0.97]:
                peak = simulate_peak_exit(win_df, sig_col, 3, 5, peak_discount=disc)
                avg_h = peak["exit_day"].mean() if len(peak) > 0 else 4
                print_row(f"Peak exit T+3→T+5 (discount {disc:.2f})", stats(peak, avg_h))

            # Peak exit + close-SL -8%
            for disc in [0.99, 0.97]:
                peak = simulate_peak_exit(win_df, sig_col, 3, 5,
                                          peak_discount=disc, sl_close_pct=0.08)
                avg_h = peak["exit_day"].mean() if len(peak) > 0 else 4
                print_row(f"Peak exit (disc {disc:.2f}) + close-SL -8%", stats(peak, avg_h))


if __name__ == "__main__":
    main()
