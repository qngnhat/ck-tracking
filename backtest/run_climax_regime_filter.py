"""V8.7 — Vol Climax + VN-Index regime filter.

Hypothesis: mean-reversion bounce thất bại khi cả thị trường đang dump
(cascade selling). Filter signals theo trend của VN-Index.

So sánh:
- Baseline (no regime filter) — current strategy
- + VN-Index close > MA20 (slight uptrend)
- + VN-Index close > MA50 (bull regime)
- + VN-Index close > MA200 (long-term bull)
- + VN-Index close > MA50 AND VN-Index return 20d > 0 (confirmed)

Test trên 8.5y cross-val (2018-2026) + 2 sub-windows.
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
    df["ma20"] = df["close"].rolling(20).mean()
    df["ma50"] = df["close"].rolling(50).mean()
    df["ma200"] = df["close"].rolling(200).mean()
    df["ret_20d"] = df["close"].pct_change(20)
    return df


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


def simulate(df: pd.DataFrame, sig_col: str,
             min_hold=3, max_hold=5, target_pct=0.03,
             sl_close_pct=0.08, cost=DEFAULT_COST_RT) -> pd.DataFrame:
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
                "date": g.iloc[i]["date"],
                "symbol": sym,
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
    pos_sum = trades.loc[trades["net_ret"] > 0, "net_ret"].sum()
    neg_sum = abs(trades.loc[trades["net_ret"] < 0, "net_ret"].sum())
    pf = pos_sum / neg_sum if neg_sum > 0 else float("inf")
    avg_hold = trades.get("exit_day", pd.Series([hold_avg])).mean()
    return {"n": len(trades), "win": win, "avg": avg, "sharpe": sharpe,
            "pf": pf, "avg_hold": avg_hold}


def print_row(label, s):
    print(f"  {label:<48} "
          f"{s['n']:4d} {s['win']*100:5.1f}% {s['avg']*100:+5.2f}% "
          f"{s['sharpe']:+.2f} {s['pf']:.2f}")


def main():
    print("Load VN-Index + universe...")
    vni = load_vnindex()
    print(f"  VN-Index: {len(vni)} bars, {vni['date'].min().date()} → {vni['date'].max().date()}")

    universe = load_universe()
    filtered = filter_largemid(universe)
    print(f"  Universe: {filtered.symbol.nunique()} mã")

    parts = [enrich(g) for _, g in filtered.groupby("symbol", sort=False)]
    df = pd.concat(parts, ignore_index=True)
    df["date"] = pd.to_datetime(df["date"])

    # Merge VN-Index regime flags — rename rõ ràng để tránh collision với stock indicators
    vni_slim = vni[["date", "close", "ma20", "ma50", "ma200", "ret_20d"]].rename(
        columns={
            "close": "vni_close",
            "ma20": "vni_ma20",
            "ma50": "vni_ma50",
            "ma200": "vni_ma200",
            "ret_20d": "vni_ret20",
        }
    )
    df = df.merge(vni_slim, on="date", how="left")

    # Define regime flags
    df["vni_above_ma20"] = df["vni_close"] > df["vni_ma20"]
    df["vni_above_ma50"] = df["vni_close"] > df["vni_ma50"]
    df["vni_above_ma200"] = df["vni_close"] > df["vni_ma200"]
    df["vni_uptrend"] = (df["vni_close"] > df["vni_ma50"]) & (df["vni_ret20"] > 0)

    # Base patterns
    df["base_A"] = (
        (df["ret_3d"] < -0.07) & (df["vol_ratio"] > 2.0) &
        df["day_green"] & (df["rsi"] < 35)
    )
    df["base_B"] = (
        (df["ret_3d"] < -0.05) & (df["vol_ratio"] > 2.0) &
        df["day_green"] & (df["rsi"] < 50)
    )

    # Inverse regime (capitulation regime)
    df["vni_below_ma20"] = ~df["vni_above_ma20"]
    df["vni_below_ma50"] = ~df["vni_above_ma50"]
    df["vni_panic"] = (df["vni_close"] < df["vni_ma50"]) & (df["vni_ret20"] < -0.03)
    df["vni_correction"] = df["vni_ret20"] < -0.05

    # Filtered variants
    FILTERS = [
        ("baseline (no regime)", None),
        ("+ VNI > MA50 (bull, INVERSE pattern)", "vni_above_ma50"),
        ("+ VNI < MA20 (capitulation)", "vni_below_ma20"),
        ("+ VNI < MA50 (bearish regime)", "vni_below_ma50"),
        ("+ VNI panic (<MA50 & ret20<-3%)", "vni_panic"),
        ("+ VNI correction (ret20<-5%)", "vni_correction"),
    ]

    WINDOWS = [
        ("2018-01-01", "2026-05-13", "ALL 8.5y cross-val"),
        ("2024-01-01", "2026-05-13", "2024-2026 in-sample"),
        ("2018-01-01", "2023-12-31", "2018-2023 out-sample"),
    ]

    for tier, base_col in [("A", "base_A"), ("B", "base_B")]:
        print(f"\n\n████ Tier {tier} ({base_col}) ████")
        for start, end, label in WINDOWS:
            win_df = df[
                (df["date"] >= start) & (df["date"] <= end)
            ].copy()

            print(f"\n═══ {label} ({start} → {end}) ═══")
            print(f"  {'Strategy':<48} "
                  f"{'n':>4} {'Win%':>6} {'Avg':>7} {'Sharpe':>7} {'PF':>5}")

            for filter_label, filter_col in FILTERS:
                if filter_col:
                    win_df[f"sig_{filter_col}"] = win_df[base_col] & win_df[filter_col].fillna(False)
                    sig = f"sig_{filter_col}"
                else:
                    sig = base_col

                tr = simulate(win_df, sig)
                avg_h = tr["exit_day"].mean() if len(tr) > 0 else 4
                s = stats(tr, avg_h)
                print_row(filter_label, s)


if __name__ == "__main__":
    main()
