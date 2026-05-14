"""V9.1 — Pattern 3 (Strength Continuation) exit variants.

Mục tiêu: tìm exit logic phù hợp cho momentum pattern trong bull regime.
Pattern T+3-T+5 không match momentum continuation — cần hold lâu hơn,
target cao hơn, hoặc trailing stop.

Exit variants:
A. Baseline: target +3% / SL -8% / T+3→T+5 close (current)
B. target +5% / SL -8% / T+3→T+10
C. target +7% / SL -10% / T+3→T+10
D. target +5% / SL -8% / T+5→T+15 (longer min hold)
E. No target, hold T+10 fixed, SL -8%
F. No target, hold T+15 fixed, SL -10%
G. Trailing stop 5% from peak / no max hold (max 30 phiên)
H. Trailing stop 7% from peak / no max hold (max 30 phiên)
I. Target +5% bậc thang: bán 50% @ +3%, 50% @ +5% / SL -8%
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from src.backtest import DEFAULT_COST_RT
from src.load_data import load_universe

TURNOVER_MIN_BN = 3.0


def load_vnindex():
    df = pd.read_parquet("data/vnindex.parquet")
    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values("date").reset_index(drop=True)
    df["vni_ret20"] = df["close"].pct_change(20)
    return df[["date", "vni_ret20"]]


def filter_largemid(universe):
    recent = universe[universe.date >= "2024-01-01"].copy()
    recent["turnover"] = recent["close"] * recent["volume"] * 1000
    liq = recent.groupby("symbol")["turnover"].median() / 1e9
    keep = liq[liq >= TURNOVER_MIN_BN].index.tolist()
    return universe[universe.symbol.isin(keep)].copy()


def enrich(group):
    g = group.copy().reset_index(drop=True)
    c = g["close"].values
    o = g["open"].values
    h = g["high"].values
    l = g["low"].values
    v = g["volume"].values

    cs = pd.Series(c)
    g["ma5"] = cs.rolling(5).mean()
    g["ma20"] = cs.rolling(20).mean()
    g["ma50"] = cs.rolling(50).mean()
    g["ma200"] = cs.rolling(200).mean()
    g["ret_1d"] = cs.pct_change(1)
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
    return g


def simulate_v2(df, sig_col, exit_type, params, cost=DEFAULT_COST_RT):
    """Universal simulator supporting multiple exit types.
    exit_type:
      - 'fixed_target': target_pct close-based, min_hold, max_hold, sl_pct
      - 'fixed_hold': hold N phiên, sl_pct (no target)
      - 'trailing': trail_pct from peak, max_hold, sl_pct (initial)
      - 'ladder': tp1 weight + tp1_pct, tp2 weight + tp2_pct, max_hold, sl_pct
    """
    df = df.sort_values(["symbol", "date"])
    trades = []
    for sym, group in df.groupby("symbol", sort=False):
        g = group.reset_index(drop=True)
        sig = g[sig_col].values
        max_hold = params.get("max_hold", 20)
        for i in range(len(g) - 1 - max_hold):
            if not sig[i]:
                continue
            ep = g.iloc[i + 1]["open"]
            if pd.isna(ep) or ep <= 0:
                continue

            exit_price = None
            exit_day = None

            if exit_type == "fixed_target":
                min_hold = params["min_hold"]
                tgt = params["target_pct"]
                sl = params.get("sl_pct")
                for h in range(1, max_hold + 1):
                    idx = i + 1 + h
                    if idx >= len(g): break
                    dc = g.iloc[idx]["close"]
                    if pd.isna(dc): continue
                    if sl and dc <= ep * (1 - sl):
                        exit_price, exit_day = dc, h
                        break
                    if h >= min_hold:
                        ret = (dc - ep) / ep
                        if ret >= tgt:
                            exit_price, exit_day = dc, h
                            break
                    if h == max_hold:
                        exit_price, exit_day = dc, h

            elif exit_type == "fixed_hold":
                hold = params["hold"]
                sl = params.get("sl_pct")
                for h in range(1, hold + 1):
                    idx = i + 1 + h
                    if idx >= len(g): break
                    dc = g.iloc[idx]["close"]
                    if pd.isna(dc): continue
                    if sl and dc <= ep * (1 - sl):
                        exit_price, exit_day = dc, h
                        break
                    if h == hold:
                        exit_price, exit_day = dc, h

            elif exit_type == "trailing":
                trail = params["trail_pct"]
                sl_init = params.get("sl_pct", trail)
                peak = ep
                for h in range(1, max_hold + 1):
                    idx = i + 1 + h
                    if idx >= len(g): break
                    dh = g.iloc[idx]["high"]
                    dc = g.iloc[idx]["close"]
                    if pd.isna(dc): continue
                    peak = max(peak, dh)
                    trail_sl = peak * (1 - trail)
                    init_sl = ep * (1 - sl_init)
                    active_sl = max(trail_sl, init_sl)
                    if dc <= active_sl:
                        exit_price, exit_day = dc, h
                        break
                    if h == max_hold:
                        exit_price, exit_day = dc, h

            elif exit_type == "ladder":
                tp1 = params["tp1_pct"]
                w1 = params["w1"]
                tp2 = params["tp2_pct"]
                w2 = params["w2"]
                sl = params.get("sl_pct")
                w_done = 0
                ret_weighted = 0
                hold_weighted = 0
                for h in range(1, max_hold + 1):
                    idx = i + 1 + h
                    if idx >= len(g): break
                    dc = g.iloc[idx]["close"]
                    if pd.isna(dc): continue
                    if sl and dc <= ep * (1 - sl):
                        # Cut all remaining
                        rem = 1 - w_done
                        ret_weighted += rem * ((dc - ep) / ep)
                        hold_weighted += rem * h
                        w_done = 1
                        break
                    if h >= params.get("min_hold", 3):
                        ret = (dc - ep) / ep
                        if w_done < w1 and ret >= tp1:
                            ret_weighted += w1 * ret
                            hold_weighted += w1 * h
                            w_done += w1
                        if w_done < w1 + w2 and ret >= tp2:
                            ret_weighted += w2 * ret
                            hold_weighted += w2 * h
                            w_done += w2
                    if h == max_hold and w_done < 1:
                        rem = 1 - w_done
                        ret_weighted += rem * ((dc - ep) / ep)
                        hold_weighted += rem * h
                        w_done = 1
                        break
                if w_done >= 0.999:
                    exit_price = ep * (1 + ret_weighted)
                    exit_day = hold_weighted

            if exit_price is None:
                continue
            trades.append({
                "date": g.iloc[i]["date"],
                "symbol": sym,
                "net_ret": (exit_price - ep) / ep - cost,
                "exit_day": exit_day,
            })
    return pd.DataFrame(trades)


def stats(trades, hold_avg=5):
    if len(trades) == 0:
        return {"n": 0, "win": 0, "avg": 0, "sharpe": 0, "pf": 0, "avg_hold": 0}
    win = (trades["net_ret"] > 0).mean()
    avg = trades["net_ret"].mean()
    std = trades["net_ret"].std()
    sharpe = (avg / std * (252 / hold_avg) ** 0.5) if std > 0 and hold_avg > 0 else 0
    pos = trades.loc[trades["net_ret"] > 0, "net_ret"].sum()
    neg = abs(trades.loc[trades["net_ret"] < 0, "net_ret"].sum())
    pf = pos / neg if neg > 0 else float("inf")
    avg_hold = trades["exit_day"].mean()
    return {"n": len(trades), "win": win, "avg": avg, "sharpe": sharpe, "pf": pf, "avg_hold": avg_hold}


def print_row(label, s):
    print(f"  {label:<48} "
          f"{s['n']:5d} {s['win']*100:5.1f}% {s['avg']*100:+5.2f}% "
          f"{s['sharpe']:+.2f} {s['pf']:.2f} {s['avg_hold']:6.1f}")


def main():
    print("Load...")
    vni = load_vnindex()
    universe = load_universe()
    filtered = filter_largemid(universe)
    parts = [enrich(g) for _, g in filtered.groupby("symbol", sort=False)]
    df = pd.concat(parts, ignore_index=True)
    df["date"] = pd.to_datetime(df["date"])
    df = df.merge(vni, on="date", how="left")
    df["regime_bull"] = df["vni_ret20"] >= 0.03
    df["regime_non_correction"] = df["vni_ret20"] >= -0.05

    # Pattern 3: Strength continuation
    df["pat"] = (
        df["uptrend_strong"] &
        (df["range_pct"] < 0.025) &
        (df["vol_ratio"] > 1.5) &
        df["day_green"] &
        (df["rsi"] > 50) & (df["rsi"] < 70)
    )
    df["sig_bull"] = df["pat"] & df["regime_bull"].fillna(False)
    df["sig_non_correction"] = df["pat"] & df["regime_non_correction"].fillna(False)

    VARIANTS = [
        ("A. baseline T+3-5, +3%, SL -8%",
         "fixed_target", {"min_hold": 3, "max_hold": 5, "target_pct": 0.03, "sl_pct": 0.08}),
        ("B. T+3-10, +5%, SL -8%",
         "fixed_target", {"min_hold": 3, "max_hold": 10, "target_pct": 0.05, "sl_pct": 0.08}),
        ("C. T+3-10, +7%, SL -10%",
         "fixed_target", {"min_hold": 3, "max_hold": 10, "target_pct": 0.07, "sl_pct": 0.10}),
        ("D. T+5-15, +5%, SL -8%",
         "fixed_target", {"min_hold": 5, "max_hold": 15, "target_pct": 0.05, "sl_pct": 0.08}),
        ("E. Fixed hold T+10, SL -8%",
         "fixed_hold", {"hold": 10, "sl_pct": 0.08, "max_hold": 10}),
        ("F. Fixed hold T+15, SL -10%",
         "fixed_hold", {"hold": 15, "sl_pct": 0.10, "max_hold": 15}),
        ("G. Trailing 5% from peak, max T+30",
         "trailing", {"trail_pct": 0.05, "sl_pct": 0.08, "max_hold": 30}),
        ("H. Trailing 7% from peak, max T+30",
         "trailing", {"trail_pct": 0.07, "sl_pct": 0.10, "max_hold": 30}),
        ("I. Ladder 50/50 @ +3/+5, SL -8%, T+3-10",
         "ladder", {"min_hold": 3, "max_hold": 10, "tp1_pct": 0.03, "w1": 0.5, "tp2_pct": 0.05, "w2": 0.5, "sl_pct": 0.08}),
    ]

    WINDOWS = [
        ("2018-01-01", "2026-05-13", "ALL 8.5y cross-val"),
        ("2024-01-01", "2026-05-13", "2024-2026 in-sample"),
        ("2018-01-01", "2023-12-31", "2018-2023 out-sample"),
    ]

    for sig_col, sig_label in [("sig_bull", "Bull regime only (VNI ret20≥+3%)"),
                                 ("sig_non_correction", "Bull + Neutral (VNI ret20≥-5%)")]:
        print(f"\n\n████ {sig_label} ████")
        for start, end, win_label in WINDOWS:
            win_df = df[(df["date"] >= start) & (df["date"] <= end)].copy()
            n_sig = win_df[sig_col].sum()
            print(f"\n═══ {win_label} (raw {n_sig} signals) ═══")
            print(f"  {'Exit variant':<48} "
                  f"{'n':>5} {'Win%':>6} {'Avg':>7} {'Sharpe':>7} {'PF':>5} {'AvgH':>6}")
            for label, etype, params in VARIANTS:
                tr = simulate_v2(win_df, sig_col, etype, params)
                ah = tr["exit_day"].mean() if len(tr) > 0 else 5
                s = stats(tr, ah)
                print_row(label, s)


if __name__ == "__main__":
    main()
