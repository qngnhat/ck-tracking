"""Phase A — Stock-specific ATR adaptive drop threshold.

Hypothesis: mỗi mã có ATR% riêng. Drop -7% có ý nghĩa khác cho mã ATR 1.5% vs 4%.
Replace fixed drop threshold bằng K × ATR_pct adaptive.

- Volatile stocks (HAH ATR 4%): drop -7% là 1.75 ATR (mild) → cần drop bigger
- Stable stocks (VCB ATR 1.5%): drop -7% là 4.7 ATR (extreme) → drop -5% đã đủ

Test K = 2.0, 2.5, 3.0, 3.5 (multiplier ATR cho drop threshold).
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

    g["vol_avg20"] = pd.Series(v).rolling(20).mean()
    g["vol_ratio"] = v / g["vol_avg20"]
    g["ret_3d"] = cs.pct_change(3)
    g["day_green"] = c > o

    # ATR(14) and ATR_pct
    hi = pd.Series(h); lo = pd.Series(l); cl_prev = cs.shift(1)
    tr1 = hi - lo
    tr2 = (hi - cl_prev).abs()
    tr3 = (lo - cl_prev).abs()
    tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
    g["atr14"] = tr.rolling(14).mean()
    g["atr_pct"] = g["atr14"] / cs

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
    print(f"  {label:<55} {s['n']:5d} ({yr:5.1f}/yr) {s['win']*100:5.1f}% {s['avg']*100:+5.2f}% {s['sharpe']:+.2f} {s['pf']:.2f}")


def main():
    print("Load + filter Large+Mid...")
    universe = load_universe()
    filtered = filter_largemid(universe)
    print(f"  {filtered.symbol.nunique()} mã\n")

    parts = [enrich(g) for _, g in filtered.groupby("symbol", sort=False)]
    df = pd.concat(parts, ignore_index=True)
    df["date"] = pd.to_datetime(df["date"])

    # Show ATR distribution
    print("=== ATR% distribution across stocks ===")
    atr_med = df.groupby("symbol")["atr_pct"].median().dropna() * 100
    print(f"  Median ATR%: {atr_med.median():.2f}% (range {atr_med.min():.2f}% - {atr_med.max():.2f}%)")
    print(f"  Quartiles: Q25={atr_med.quantile(0.25):.2f}% · Q50={atr_med.quantile(0.50):.2f}% · Q75={atr_med.quantile(0.75):.2f}%")
    print(f"  Stable mã (ATR < 2%): {(atr_med < 2).sum()} mã")
    print(f"  Volatile mã (ATR > 3.5%): {(atr_med > 3.5).sum()} mã\n")

    # Tier A baseline: drop < -7%, vol > 2, green, RSI < 35
    df["tier_a"] = (df["ret_3d"] < -0.07) & (df["vol_ratio"] > 2.0) & df["day_green"] & (df["rsi"] < 35)
    df["tier_b"] = (df["ret_3d"] < -0.05) & (df["vol_ratio"] > 2.0) & df["day_green"] & (df["rsi"] < 50)

    # ATR-adaptive variants for Tier A (RSI < 35)
    for K in [2.0, 2.5, 3.0, 3.5, 4.0]:
        col = f"tier_a_atr_K{K}"
        df[col] = (df["ret_3d"] < -K * df["atr_pct"]) & (df["vol_ratio"] > 2.0) & df["day_green"] & (df["rsi"] < 35)

    # Same for Tier B (RSI < 50)
    for K in [1.5, 2.0, 2.5, 3.0]:
        col = f"tier_b_atr_K{K}"
        df[col] = (df["ret_3d"] < -K * df["atr_pct"]) & (df["vol_ratio"] > 2.0) & df["day_green"] & (df["rsi"] < 50)

    VARIANTS_A = [
        ("Tier A baseline (fixed drop -7%)", "tier_a"),
        ("Tier A ATR adaptive K=2.0", "tier_a_atr_K2.0"),
        ("Tier A ATR adaptive K=2.5", "tier_a_atr_K2.5"),
        ("Tier A ATR adaptive K=3.0", "tier_a_atr_K3.0"),
        ("Tier A ATR adaptive K=3.5", "tier_a_atr_K3.5"),
        ("Tier A ATR adaptive K=4.0", "tier_a_atr_K4.0"),
    ]
    VARIANTS_B = [
        ("Tier B baseline (fixed drop -5%)", "tier_b"),
        ("Tier B ATR adaptive K=1.5", "tier_b_atr_K1.5"),
        ("Tier B ATR adaptive K=2.0", "tier_b_atr_K2.0"),
        ("Tier B ATR adaptive K=2.5", "tier_b_atr_K2.5"),
        ("Tier B ATR adaptive K=3.0", "tier_b_atr_K3.0"),
    ]

    WINDOWS = [
        ("2018-01-01", "2026-05-13", "ALL 8.5y"),
        ("2024-01-01", "2026-05-13", "2024-2026 in-sample"),
        ("2018-01-01", "2023-12-31", "2018-2023 out-sample"),
    ]

    for s, e, l in WINDOWS:
        win_df = df[(df["date"] >= s) & (df["date"] <= e)].copy()
        print(f"\n═══ {l} ═══")
        print(f"  {'Variant':<55} {'n':>5}  {'/yr':<7} {'Win%':>6} {'Avg':>7} {'Sharpe':>7} {'PF':>5}")
        for vl, vc in VARIANTS_A:
            print_row(vl, stats(simulate(win_df, vc)))
        print()
        for vl, vc in VARIANTS_B:
            print_row(vl, stats(simulate(win_df, vc)))


if __name__ == "__main__":
    main()
