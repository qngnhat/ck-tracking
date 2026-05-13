"""V8.2 — Iterate S5 Vol Climax Bottom (signal khả thi nhất từ V8).

Hypothesis: Pattern "3 phiên giảm + volume cao + reversal" có edge. Test:
1. Variants với threshold khác nhau (drop %, vol multiplier, hold)
2. Add filters (RSI, trend context, market regime)
3. Sample size matters — cần >200 trades/năm để edge tin cậy
4. Equity curve simulation theo realistic trading
"""

from __future__ import annotations

from pathlib import Path
import numpy as np
import pandas as pd

from src.backtest import DEFAULT_COST_RT, summarize
from src.load_data import load_universe, load_vnindex

TEST_START = "2024-01-01"
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
    h = g["high"].values
    l = g["low"].values
    v = g["volume"].values

    g["vol_avg20"] = pd.Series(v).rolling(20).mean()
    g["vol_ratio"] = v / g["vol_avg20"]

    g["ma20"] = pd.Series(c).rolling(20).mean()
    g["ma50"] = pd.Series(c).rolling(50).mean()
    g["ma200"] = pd.Series(c).rolling(200).mean()

    delta = np.diff(c, prepend=c[0])
    up = np.where(delta > 0, delta, 0)
    dn = np.where(delta < 0, -delta, 0)
    avg_up = pd.Series(up).rolling(14).mean()
    avg_dn = pd.Series(dn).rolling(14).mean()
    rs = avg_up / avg_dn.replace(0, np.nan)
    g["rsi"] = 100 - 100 / (1 + rs)

    rng = h - l
    g["close_in_range"] = np.where(rng > 0, (c - l) / rng, 0.5)
    g["ret_2d"] = pd.Series(c).pct_change(2)
    g["ret_3d"] = pd.Series(c).pct_change(3)
    g["ret_5d"] = pd.Series(c).pct_change(5)
    g["day_green"] = c > o
    g["body_pct"] = (c - o) / o * 100

    return g


def simulate(df: pd.DataFrame, signal_col: str, hold: int, cost: float = DEFAULT_COST_RT) -> pd.DataFrame:
    df = df.sort_values(["symbol", "date"])
    trades = []
    for sym, group in df.groupby("symbol", sort=False):
        g = group.reset_index(drop=True)
        sig = g[signal_col].values
        for i in range(len(g) - 1 - hold):
            if not sig[i]:
                continue
            ep = g.iloc[i + 1]["open"]
            xp = g.iloc[i + 1 + hold]["close"]
            if pd.isna(ep) or pd.isna(xp) or ep <= 0:
                continue
            trades.append({"date": g.iloc[i]["date"], "symbol": sym,
                           "net_ret": (xp - ep) / ep - cost})
    return pd.DataFrame(trades)


def stats(trades: pd.DataFrame, hold: int) -> dict:
    if len(trades) < 30:
        return None
    win = (trades["net_ret"] > 0).mean()
    avg = trades["net_ret"].mean()
    std = trades["net_ret"].std()
    sharpe = (avg / std * (252 / hold) ** 0.5) if std > 0 else 0
    pos_sum = trades.loc[trades["net_ret"] > 0, "net_ret"].sum()
    neg_sum = abs(trades.loc[trades["net_ret"] < 0, "net_ret"].sum())
    pf = pos_sum / neg_sum if neg_sum > 0 else float("inf")
    return {"n": len(trades), "win": win, "avg": avg, "sharpe": sharpe, "pf": pf}


def main():
    print("Load + filter Large+Mid...")
    universe = load_universe()
    filtered = filter_largemid(universe)
    print(f"  {filtered.symbol.nunique()} mã")

    print("Enrich features...")
    parts = []
    for _, group in filtered.groupby("symbol", sort=False):
        parts.append(enrich(group))
    df = pd.concat(parts, ignore_index=True)
    df = df[df["date"] >= TEST_START].copy()
    print(f"  {len(df):,} rows")

    # ─── Variant tests: tune S5 thresholds ───
    print("\n═══ Tune S5 Vol Climax Bottom variants ═══")
    print(f"  {'Variant':<40} hold {'n':>5} {'Win%':>6} {'Avg':>6} {'Sh':>5} {'PF':>5}")

    variants = []
    for drop_n in [3, 5]:
        for drop_pct in [-0.04, -0.05, -0.07, -0.10]:
            for vol_mult in [1.5, 2.0, 2.5, 3.0]:
                ret_col = f"ret_{drop_n}d"
                df["sig"] = (
                    (df[ret_col] < drop_pct) &
                    (df["vol_ratio"] > vol_mult) &
                    df["day_green"]
                )
                for hold in [2, 3, 5]:
                    trades = simulate(df, "sig", hold)
                    s = stats(trades, hold)
                    if s and s["n"] >= 50:
                        label = f"drop{drop_n}d<{drop_pct:.0%} vol>{vol_mult}×"
                        marker = "🟢" if s["avg"] > 0 and s["win"] > 0.52 else ""
                        print(f"  {marker} {label:<38} {hold:3d}  {s['n']:5d} "
                              f"{s['win']*100:5.1f}% {s['avg']*100:+5.2f}% "
                              f"{s['sharpe']:+.2f} {s['pf']:.2f}")
                        variants.append((label, hold, s, drop_n, drop_pct, vol_mult))

    # Best variants
    winners = [v for v in variants if v[2]["avg"] > 0 and v[2]["win"] > 0.52 and v[2]["n"] >= 100]
    winners.sort(key=lambda x: -x[2]["sharpe"])
    print(f"\n═══ TOP WINNERS (avg>0, win>52%, n>=100) ═══")
    for v in winners[:10]:
        label, hold, s, *_ = v
        n_per_year = s["n"] / 2.3
        print(f"  hold={hold} {label:<38} n={s['n']} ({n_per_year:.0f}/năm) "
              f"win={s['win']*100:.1f}% avg={s['avg']*100:+.2f}% "
              f"sharpe={s['sharpe']:+.2f} pf={s['pf']:.2f}")

    # Test best variant + add RSI filter
    if winners:
        best_label, best_hold, best_stats, drop_n, drop_pct, vol_mult = winners[0]
        ret_col = f"ret_{drop_n}d"
        print(f"\n═══ Add RSI filter on best variant ({best_label}, hold={best_hold}) ═══")
        for rsi_max in [40, 35, 30, 25]:
            df["sig"] = (
                (df[ret_col] < drop_pct) &
                (df["vol_ratio"] > vol_mult) &
                df["day_green"] &
                (df["rsi"] < rsi_max)
            )
            trades = simulate(df, "sig", best_hold)
            s = stats(trades, best_hold)
            if s and s["n"] >= 30:
                print(f"  rsi<{rsi_max:2d}: n={s['n']:4d} win={s['win']*100:5.1f}% "
                      f"avg={s['avg']*100:+.2f}% sharpe={s['sharpe']:+.2f} pf={s['pf']:.2f}")

        # Add trend filter — only in uptrend (MA20 > MA50)
        print(f"\n═══ Add trend filter ===")
        for trend_label, trend_cond in [
            ("any trend", df.index >= 0),  # all
            ("uptrend MA20>MA50", df["ma20"] > df["ma50"]),
            ("strong uptrend MA50>MA200", df["ma50"] > df["ma200"]),
            ("downtrend MA20<MA50", df["ma20"] < df["ma50"]),
        ]:
            df["sig"] = (
                (df[ret_col] < drop_pct) &
                (df["vol_ratio"] > vol_mult) &
                df["day_green"] &
                trend_cond
            )
            trades = simulate(df, "sig", best_hold)
            s = stats(trades, best_hold)
            if s:
                print(f"  {trend_label:<28} n={s['n']:4d} win={s['win']*100:5.1f}% "
                      f"avg={s['avg']*100:+.2f}% sharpe={s['sharpe']:+.2f} pf={s['pf']:.2f}")


if __name__ == "__main__":
    main()
