"""V8 — Test signals KHÁC cho T+ siêu ngắn (hold 2-3 phiên).

Hypothesis: Strong Leaders formula (RS/momentum) cần 15-20 phiên để materialize.
Cho hold 2-3 phiên thì cần signals khác — intraday momentum, gap+hold, oversold bounce.

Signals tested:
  S1. Strong close + vol spike: close > 80% of day range + vol > 1.5× avg20
  S2. Gap up + hold: open > prev_close × 1.02 + close > open (gap không fade)
  S3. Oversold reversal: RSI < 30 + 3 phiên giảm + close > open today
  S4. Range expansion: ATR today > 1.5× avg10 ATR + close in top 20% range
  S5. Volume climax bottom: 3 phiên giảm + vol↑↑ + close > intraday open
  S6. Hammer pattern: lower shadow > 2× body + close in top 30% range
  S7. Pullback in uptrend: MA20 > MA50 + close > MA20 + dip-buy in last 3 phiên

Hold: 2, 3 phiên. Buy @ open T+1, sell @ close T+1+hold.
Universe: Large+Mid 199 mã (turnover ≥ 3 tỷ/ngày).
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


def add_short_signals(group: pd.DataFrame) -> pd.DataFrame:
    """Tính signals per symbol (group đã sort by date)."""
    g = group.copy().reset_index(drop=True)
    c = g["close"].values
    o = g["open"].values
    h = g["high"].values
    l = g["low"].values
    v = g["volume"].values
    n = len(g)

    # Rolling features
    g["vol_avg20"] = pd.Series(v).rolling(20).mean()
    g["vol_ratio"] = v / g["vol_avg20"]

    # ATR(14)
    tr = np.maximum(h[1:] - l[1:], np.maximum(abs(h[1:] - c[:-1]), abs(l[1:] - c[:-1])))
    atr = pd.Series(tr).rolling(14).mean()
    g["atr"] = np.concatenate([[np.nan], atr.values])
    g["range_today"] = h - l

    # MA20, MA50
    g["ma20"] = pd.Series(c).rolling(20).mean()
    g["ma50"] = pd.Series(c).rolling(50).mean()

    # RSI(14)
    delta = np.diff(c, prepend=c[0])
    up = np.where(delta > 0, delta, 0)
    dn = np.where(delta < 0, -delta, 0)
    avg_up = pd.Series(up).rolling(14).mean()
    avg_dn = pd.Series(dn).rolling(14).mean()
    rs = avg_up / avg_dn.replace(0, np.nan)
    g["rsi"] = 100 - 100 / (1 + rs)

    # Position in today's range (0 = at low, 1 = at high)
    rng = h - l
    g["close_in_range"] = np.where(rng > 0, (c - l) / rng, 0.5)

    # Day return
    g["day_change"] = np.concatenate([[np.nan], (c[1:] - c[:-1]) / c[:-1]])

    # Body & shadows
    body = abs(c - o)
    upper_shadow = h - np.maximum(c, o)
    lower_shadow = np.minimum(c, o) - l
    g["lower_shadow_ratio"] = np.where(body > 0, lower_shadow / body, 0)

    # 3-day cumulative return (= momentum 3p)
    g["ret_3d"] = pd.Series(c).pct_change(3)

    # 20d high break check
    g["prev_high_20"] = pd.Series(h).shift(1).rolling(20).max()

    # ─── SIGNALS ───
    g["S1_strong_close_vol"] = (
        (g["close_in_range"] > 0.80) &
        (g["vol_ratio"] > 1.5) &
        (g["day_change"] > 0)
    )

    g["S2_gap_hold"] = (
        (pd.Series(o).shift(0).values > pd.Series(c).shift(1).values * 1.02) &
        (c > o) &
        (g["vol_ratio"] > 1.0)
    )

    g["S3_oversold_reversal"] = (
        (g["rsi"] < 35) &
        (g["ret_3d"] < -0.05) &
        (c > o) &
        (g["close_in_range"] > 0.5)
    )

    g["S4_range_expansion"] = (
        (g["range_today"] > 1.5 * g["atr"]) &
        (g["close_in_range"] > 0.80) &
        (c > o)
    )

    g["S5_vol_climax_bottom"] = (
        (g["ret_3d"] < -0.05) &
        (g["vol_ratio"] > 2.0) &
        (c > o)
    )

    g["S6_hammer"] = (
        (g["lower_shadow_ratio"] > 2.0) &
        (g["close_in_range"] > 0.60) &
        (g["vol_ratio"] > 1.0)
    )

    # Pullback in uptrend: trend up but recent dip
    g["S7_pullback_uptrend"] = (
        (g["ma20"] > g["ma50"]) &
        (c < g["ma20"]) &
        (c > g["ma50"]) &
        (g["ret_3d"] < -0.02) &
        (c > o)
    )

    # Combo signals
    g["S8_S1_or_S2"] = g["S1_strong_close_vol"] | g["S2_gap_hold"]
    g["S9_S3_or_S6"] = g["S3_oversold_reversal"] | g["S6_hammer"]

    return g


def simulate_signal(
    universe: pd.DataFrame,
    signal_col: str,
    hold: int,
    cost: float = DEFAULT_COST_RT,
) -> pd.DataFrame:
    """Mỗi signal=True trên phiên T → buy open(T+1), sell close(T+1+hold)."""
    universe = universe.sort_values(["symbol", "date"])
    trades = []
    for sym, group in universe.groupby("symbol", sort=False):
        g = group.reset_index(drop=True)
        for i in range(len(g) - 1 - hold):
            if not g.iloc[i].get(signal_col, False):
                continue
            ep = g.iloc[i + 1]["open"]
            xp = g.iloc[i + 1 + hold]["close"]
            if pd.isna(ep) or pd.isna(xp) or ep <= 0:
                continue
            trades.append({
                "date": g.iloc[i]["date"],
                "symbol": sym,
                "entry": ep,
                "exit": xp,
                "net_ret": (xp - ep) / ep - cost,
            })
    return pd.DataFrame(trades)


def report_signal(label: str, trades: pd.DataFrame, hold: int):
    if len(trades) < 50:
        print(f"  [{label}] only {len(trades)} trades — skip")
        return None
    win = (trades["net_ret"] > 0).mean()
    avg = trades["net_ret"].mean()
    med = trades["net_ret"].median()
    std = trades["net_ret"].std()
    sharpe = (avg / std * (252 / hold) ** 0.5) if std > 0 else 0
    pos_sum = trades.loc[trades["net_ret"] > 0, "net_ret"].sum()
    neg_sum = abs(trades.loc[trades["net_ret"] < 0, "net_ret"].sum())
    pf = pos_sum / neg_sum if neg_sum > 0 else float("inf")

    marker = "🟢" if avg > 0 and win > 0.50 else "⚠️" if avg > 0 else "🔴"
    print(f"  {marker} {label:<30} n={len(trades):5d} win={win*100:5.1f}% "
          f"avg={avg*100:+5.2f}% med={med*100:+5.2f}% sharpe={sharpe:+.2f} pf={pf:.2f}")
    return {"label": label, "n": len(trades), "win": win, "avg": avg,
            "med": med, "sharpe": sharpe, "pf": pf, "hold": hold}


def main():
    print("Load + filter Large+Mid (199 mã)...")
    universe = load_universe()
    filtered = filter_largemid(universe)
    print(f"  {filtered.symbol.nunique()} mã, {len(filtered):,} rows")

    print("\nCompute short-term signals per symbol...")
    parts = []
    for _, group in filtered.groupby("symbol", sort=False):
        parts.append(add_short_signals(group))
    enriched = pd.concat(parts, ignore_index=True)

    test_df = enriched[enriched["date"] >= TEST_START].copy()
    print(f"  Test window: {test_df['date'].min()} → {test_df['date'].max()}, {len(test_df):,} rows")

    SIGNALS = [
        ("S1 Strong close + vol", "S1_strong_close_vol"),
        ("S2 Gap up + hold", "S2_gap_hold"),
        ("S3 Oversold reversal", "S3_oversold_reversal"),
        ("S4 Range expansion", "S4_range_expansion"),
        ("S5 Vol climax bottom", "S5_vol_climax_bottom"),
        ("S6 Hammer pattern", "S6_hammer"),
        ("S7 Pullback uptrend", "S7_pullback_uptrend"),
        ("S8 S1+S2 (momentum)", "S8_S1_or_S2"),
        ("S9 S3+S6 (reversal)", "S9_S3_or_S6"),
    ]

    all_results = []
    for hold in [2, 3, 5]:
        print(f"\n═══ HOLD = {hold} phiên (T+{hold+0.5}) ═══")
        print(f"  {'Signal':<32} {'n':>6} {'Win%':>6} {'Avg':>7} {'Med':>7} {'Sharpe':>7} {'PF':>5}")
        for label, col in SIGNALS:
            trades = simulate_signal(test_df, col, hold)
            r = report_signal(label, trades, hold)
            if r:
                all_results.append(r)

    # Summary: winners only (win > 50% and avg > 0)
    print("\n\n═══ WINNERS (avg > 0 AND win > 50%) ═══")
    winners = [r for r in all_results if r["avg"] > 0 and r["win"] > 0.50]
    if winners:
        winners.sort(key=lambda x: -x["sharpe"])
        for w in winners[:10]:
            print(f"  hold={w['hold']}  {w['label']:<30} n={w['n']:5d} "
                  f"win={w['win']*100:5.1f}% avg={w['avg']*100:+5.2f}% "
                  f"sharpe={w['sharpe']:+.2f} pf={w['pf']:.2f}")
    else:
        print("  KHÔNG có signal nào net positive trên backtest hiện tại.")


if __name__ == "__main__":
    main()
