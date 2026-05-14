"""V9.0 — Bull regime patterns hunt.

Vol Climax pattern thua trong bull market (Win 28-35%). Tìm pattern
nào có edge khi VNI ret20 ≥ 0 (neutral/bull regime), để app/bot
luôn có signal phù hợp regime.

Candidates:
1. Pullback to MA20: uptrend stock + pullback gần MA20 + vol dry-up
2. Breakout retest: vừa break đỉnh 60p + retest gần break level + low vol
3. Strength continuation: MA5>MA20>MA50 + small range + vol >1.5×
4. Gap up follow-through: gap up ≥2% + close>open + vol >1.5×
5. Volume + price thrust: vol >2× + close>open + ret1d >3% + uptrend

Mỗi pattern test trên 8.5y, filter VNI regime, đo Win/Sharpe/PF.
Goal: tìm 1-2 pattern có Win >55% + Sharpe >0.8 trong bull regime.
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
    df["vni_ma50"] = df["close"].rolling(50).mean()
    df["vni_ret20"] = df["close"].pct_change(20)
    return df[["date", "close", "vni_ma50", "vni_ret20"]].rename(
        columns={"close": "vni_close"}
    )


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
    h = g["high"].values
    v = g["volume"].values

    cs = pd.Series(c)
    g["ma5"] = cs.rolling(5).mean()
    g["ma20"] = cs.rolling(20).mean()
    g["ma50"] = cs.rolling(50).mean()
    g["ma200"] = cs.rolling(200).mean()
    g["ret_1d"] = cs.pct_change(1)
    g["ret_3d"] = cs.pct_change(3)
    g["ret_5d"] = cs.pct_change(5)
    g["ret_20d"] = cs.pct_change(20)
    g["vol_avg20"] = pd.Series(v).rolling(20).mean()
    g["vol_ratio"] = v / g["vol_avg20"]
    g["high_60"] = pd.Series(h).rolling(60).max()
    g["range_pct"] = (pd.Series(h) - pd.Series(g["low"].values)) / cs

    # RSI 14
    delta = np.diff(c, prepend=c[0])
    up = np.where(delta > 0, delta, 0)
    dn = np.where(delta < 0, -delta, 0)
    avg_up = pd.Series(up).rolling(14).mean()
    avg_dn = pd.Series(dn).rolling(14).mean()
    rs = avg_up / avg_dn.replace(0, np.nan)
    g["rsi"] = 100 - 100 / (1 + rs)

    # Gap up: open today vs close yesterday
    prev_close = cs.shift(1)
    g["gap_pct"] = (pd.Series(o) - prev_close) / prev_close * 100
    g["day_green"] = c > o

    # MA20 proximity
    g["near_ma20"] = (cs >= g["ma20"]) & ((cs - g["ma20"]) / g["ma20"] < 0.025)

    # Uptrend flags
    g["uptrend_mid"] = (cs > g["ma20"]) & (g["ma20"] > g["ma50"])
    g["uptrend_strong"] = (g["ma5"] > g["ma20"]) & (g["ma20"] > g["ma50"]) & (g["ma50"] > g["ma200"])

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
                "date": g.iloc[i]["date"],
                "symbol": sym,
                "net_ret": (exit_price - ep) / ep - cost,
                "exit_day": exit_day,
            })
    return pd.DataFrame(trades)


def stats(trades, hold_avg=4):
    if len(trades) == 0:
        return {"n": 0, "win": 0, "avg": 0, "sharpe": 0, "pf": 0}
    win = (trades["net_ret"] > 0).mean()
    avg = trades["net_ret"].mean()
    std = trades["net_ret"].std()
    sharpe = (avg / std * (252 / hold_avg) ** 0.5) if std > 0 and hold_avg > 0 else 0
    pos = trades.loc[trades["net_ret"] > 0, "net_ret"].sum()
    neg = abs(trades.loc[trades["net_ret"] < 0, "net_ret"].sum())
    pf = pos / neg if neg > 0 else float("inf")
    return {"n": len(trades), "win": win, "avg": avg, "sharpe": sharpe, "pf": pf}


def print_row(label, s):
    print(f"  {label:<48} "
          f"{s['n']:5d} {s['win']*100:5.1f}% {s['avg']*100:+5.2f}% "
          f"{s['sharpe']:+.2f} {s['pf']:.2f}")


def main():
    print("Load data...")
    vni = load_vnindex()
    universe = load_universe()
    filtered = filter_largemid(universe)
    print(f"  {filtered.symbol.nunique()} mã")

    parts = [enrich(g) for _, g in filtered.groupby("symbol", sort=False)]
    df = pd.concat(parts, ignore_index=True)
    df["date"] = pd.to_datetime(df["date"])
    df = df.merge(vni, on="date", how="left")

    # Regime flags
    df["regime_bull"] = df["vni_ret20"] >= 0.03
    df["regime_neutral"] = (df["vni_ret20"] >= -0.05) & (df["vni_ret20"] < 0.03)
    df["regime_correction"] = df["vni_ret20"] < -0.05
    df["regime_non_correction"] = df["vni_ret20"] >= -0.05  # bull + neutral

    # ── Pattern candidates ──

    # 1. Pullback to MA20 (uptrend + pullback + vol dry-up)
    df["pat_pullback_ma20"] = (
        df["uptrend_mid"] &
        df["near_ma20"] &
        (df["vol_ratio"] < 0.8) &
        (df["rsi"] > 40) & (df["rsi"] < 65)
    )

    # 2. Breakout retest (broke 60p high last 5 phiên + now retesting)
    df["new_high_recent"] = df.groupby("symbol")["close"].transform(
        lambda x: (x >= x.shift(1).rolling(60).max()).rolling(5).max()
    ).astype(bool)
    df["pat_breakout_retest"] = (
        df["new_high_recent"] &
        df["near_ma20"] &
        (df["vol_ratio"] < 0.8) &
        df["uptrend_mid"]
    )

    # 3. Strength continuation (strong uptrend + small range + vol >1.5×)
    df["pat_strength"] = (
        df["uptrend_strong"] &
        (df["range_pct"] < 0.025) &
        (df["vol_ratio"] > 1.5) &
        df["day_green"] &
        (df["rsi"] > 50) & (df["rsi"] < 70)
    )

    # 4. Gap up follow-through (gap ≥2% + close>open + vol >1.5×)
    df["pat_gap_up"] = (
        (df["gap_pct"] >= 2) &
        df["day_green"] &
        (df["vol_ratio"] > 1.5) &
        df["uptrend_mid"]
    )

    # 5. Volume + price thrust (vol >2× + close>open + ret1d >3%)
    df["pat_thrust"] = (
        (df["vol_ratio"] > 2.0) &
        df["day_green"] &
        (df["ret_1d"] > 0.03) &
        df["uptrend_mid"] &
        (df["rsi"] < 75)
    )

    PATTERNS = [
        ("1. Pullback MA20 + dry-up", "pat_pullback_ma20"),
        ("2. Breakout retest", "pat_breakout_retest"),
        ("3. Strength continuation", "pat_strength"),
        ("4. Gap up follow-through", "pat_gap_up"),
        ("5. Vol+price thrust", "pat_thrust"),
    ]

    WINDOWS = [
        ("2018-01-01", "2026-05-13", "ALL 8.5y cross-val"),
        ("2024-01-01", "2026-05-13", "2024-2026 in-sample"),
        ("2018-01-01", "2023-12-31", "2018-2023 out-sample"),
    ]

    REGIMES = [
        ("ALL regime", None),
        ("Bull + Neutral (ret20≥-5%)", "regime_non_correction"),
        ("Bull only (ret20≥+3%)", "regime_bull"),
        ("Neutral only (-5%≤ret20<+3%)", "regime_neutral"),
        ("Correction (ret20<-5%)", "regime_correction"),
    ]

    for pattern_label, pat_col in PATTERNS:
        print(f"\n\n████ Pattern {pattern_label} ({pat_col}) ████")
        for start, end, win_label in WINDOWS:
            win_df = df[(df["date"] >= start) & (df["date"] <= end)].copy()

            print(f"\n═══ {win_label} ═══")
            print(f"  {'Regime':<48} "
                  f"{'n':>5} {'Win%':>6} {'Avg':>7} {'Sharpe':>7} {'PF':>5}")

            for reg_label, reg_col in REGIMES:
                if reg_col:
                    win_df[f"sig_{pat_col}_{reg_col}"] = win_df[pat_col] & win_df[reg_col].fillna(False)
                    sig = f"sig_{pat_col}_{reg_col}"
                else:
                    sig = pat_col
                tr = simulate(win_df, sig)
                s = stats(tr)
                print_row(reg_label, s)


if __name__ == "__main__":
    main()
