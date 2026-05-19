"""Foreign flow analysis — test xem NN net buy có cải thiện edge không.

Approach:
1. Standalone foreign flow signal: net buy 3-5 phiên + price filter
2. Filter trên top Tier A/B/SC: only fire khi NN cũng net buy
3. Compare baseline vs combo

Universe: 58 mã có foreign flow data (CURATED, hầu hết VN30+blue chip).
"""

from __future__ import annotations
import numpy as np
import pandas as pd
from src.backtest import DEFAULT_COST_RT
from src.load_data import load_universe


def load_foreign_flow():
    ff = pd.read_parquet("data/foreign_flow.parquet")
    ff["date"] = pd.to_datetime(ff["date"])
    return ff


def filter_largemid(universe):
    recent = universe[universe.date >= "2024-01-01"].copy()
    recent["turnover"] = recent["close"] * recent["volume"] * 1000
    liq = recent.groupby("symbol")["turnover"].median() / 1e9
    return liq[liq >= 3.0].index.tolist()


def enrich(group):
    g = group.copy().reset_index(drop=True)
    c, o, v = g["close"].values, g["open"].values, g["volume"].values
    cs = pd.Series(c)
    g["ma5"] = cs.rolling(5).mean()
    g["ma20"] = cs.rolling(20).mean()
    g["ma50"] = cs.rolling(50).mean()
    g["ma200"] = cs.rolling(200).mean()
    g["vol_avg20"] = pd.Series(v).rolling(20).mean()
    g["vol_ratio"] = v / g["vol_avg20"]
    g["range_pct"] = (pd.Series(g["high"]) - pd.Series(g["low"])) / cs
    g["ret_3d"] = cs.pct_change(3)
    g["day_green"] = c > o

    delta = np.diff(c, prepend=c[0])
    up = np.where(delta > 0, delta, 0)
    dn = np.where(delta < 0, -delta, 0)
    avg_up = pd.Series(up).rolling(14).mean()
    avg_dn = pd.Series(dn).rolling(14).mean()
    rs = avg_up / avg_dn.replace(0, np.nan)
    g["rsi"] = 100 - 100 / (1 + rs)
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
    print(f"  {label:<54} {s['n']:5d} ({yr:5.1f}/yr) {s['win']*100:5.1f}% {s['avg']*100:+5.2f}% {s['sharpe']:+.2f} {s['pf']:.2f}")


def main():
    print("Load data...")
    universe = load_universe()
    universe["date"] = pd.to_datetime(universe["date"])
    ff = load_foreign_flow()
    print(f"  Foreign flow: {ff.symbol.nunique()} mã, {len(ff)} bars")
    print(f"  Universe overlap: {len(set(ff.symbol) & set(filter_largemid(universe)))} mã\n")

    # Compute foreign flow features
    ff = ff.sort_values(["symbol", "date"]).copy()
    ff["nn_net_5d"] = ff.groupby("symbol")["net_val"].transform(lambda x: x.rolling(5).sum())
    ff["nn_net_10d"] = ff.groupby("symbol")["net_val"].transform(lambda x: x.rolling(10).sum())
    ff["nn_net_20d"] = ff.groupby("symbol")["net_val"].transform(lambda x: x.rolling(20).sum())
    ff["nn_buy_only"] = ff["net_val"] > 0
    # Days of net buy in last 5
    ff["nn_buy_days_5d"] = ff.groupby("symbol")["nn_buy_only"].transform(lambda x: x.rolling(5).sum())

    # Merge into price universe
    # Filter ff symbols intersected with largemid
    syms = list(set(ff.symbol) & set(filter_largemid(universe)))
    df_parts = []
    for sym in syms:
        sdf = universe[universe["symbol"] == sym].sort_values("date").reset_index(drop=True)
        if len(sdf) < 250: continue
        sdf = enrich(sdf)
        sdf = sdf.merge(
            ff[ff.symbol == sym][["date", "net_val", "nn_net_5d", "nn_net_10d", "nn_net_20d", "nn_buy_days_5d"]],
            on="date", how="left"
        )
        df_parts.append(sdf)
    df = pd.concat(df_parts, ignore_index=True)
    df["date"] = pd.to_datetime(df["date"])
    print(f"Merged: {df.symbol.nunique()} mã, {len(df)} bars\n")

    # Base patterns
    df["tier_a"] = (df["ret_3d"] < -0.07) & (df["vol_ratio"] > 2.0) & df["day_green"] & (df["rsi"] < 35)
    df["tier_b"] = (df["ret_3d"] < -0.05) & (df["vol_ratio"] > 2.0) & df["day_green"] & (df["rsi"] < 50)
    df["sc"] = (
        (df["ma5"] > df["ma20"]) & (df["ma20"] > df["ma50"]) & (df["ma50"] > df["ma200"]) &
        (df["range_pct"] < 0.025) & (df["vol_ratio"] > 1.2) &
        df["day_green"] & (df["rsi"] > 50) & (df["rsi"] < 70)
    )

    # NN filters: net buy positive recent days
    df["nn_pos_5d"] = df["nn_net_5d"] > 0
    df["nn_pos_10d"] = df["nn_net_10d"] > 0
    df["nn_pos_20d"] = df["nn_net_20d"] > 0
    df["nn_strong_5d"] = df["nn_buy_days_5d"] >= 3  # ≥3/5 phiên mua ròng

    # Combined signals
    df["tier_a_nn"] = df["tier_a"] & df["nn_pos_5d"]
    df["tier_b_nn"] = df["tier_b"] & df["nn_pos_5d"]
    df["tier_a_nn_strong"] = df["tier_a"] & df["nn_strong_5d"]
    df["tier_b_nn_strong"] = df["tier_b"] & df["nn_strong_5d"]
    df["sc_nn"] = df["sc"] & df["nn_pos_5d"]
    df["sc_nn_strong"] = df["sc"] & df["nn_strong_5d"]

    # NN-only signals
    df["nn_buy_only"] = df["nn_strong_5d"] & (df["ret_3d"] < 0) & df["day_green"]
    df["nn_buy_oversold"] = df["nn_strong_5d"] & (df["ret_3d"] < -0.03) & df["day_green"]
    df["nn_buy_uptrend"] = df["nn_strong_5d"] & (df["ma5"] > df["ma20"]) & df["day_green"]

    VARIANTS = [
        ("Tier A baseline", "tier_a"),
        ("Tier B baseline", "tier_b"),
        ("SC baseline", "sc"),
        ("Tier A + NN net>0 5d", "tier_a_nn"),
        ("Tier B + NN net>0 5d", "tier_b_nn"),
        ("Tier A + NN strong (≥3/5 mua ròng)", "tier_a_nn_strong"),
        ("Tier B + NN strong", "tier_b_nn_strong"),
        ("SC + NN net>0 5d", "sc_nn"),
        ("SC + NN strong", "sc_nn_strong"),
        ("NN strong + drop + green (standalone)", "nn_buy_only"),
        ("NN strong + oversold (-3%) + green", "nn_buy_oversold"),
        ("NN strong + uptrend + green", "nn_buy_uptrend"),
    ]

    WINDOWS = [
        ("2019-01-01", "2026-05-13", "ALL 7.4y (since NN data starts)"),
        ("2024-01-01", "2026-05-13", "2024-2026 in-sample"),
        ("2019-01-01", "2023-12-31", "2019-2023 out-sample"),
    ]

    for s, e, l in WINDOWS:
        win_df = df[(df["date"] >= s) & (df["date"] <= e)].copy()
        print(f"\n═══ {l} ═══")
        print(f"  {'Variant':<54} {'n':>5}  {'/yr':<7} {'Win%':>6} {'Avg':>7} {'Sharpe':>7} {'PF':>5}")
        for vl, vc in VARIANTS:
            tr = simulate(win_df, vc)
            print_row(vl, stats(tr))


if __name__ == "__main__":
    main()
