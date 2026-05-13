"""V8.3 — Cross-validate Vol Climax Bounce pattern out-of-sample.

In-sample: 2024-01 → 2026-05 (đã test, sharpe 2.83)
Out-of-sample: 2020-01 → 2023-12 (COVID + 2021 bull + 2022 bear + 2023 recovery)

Pattern: drop_3d < -7% AND vol > 2× TB20 AND close > open AND MA20 > MA50
Hold: 3 phiên (T+3.5)

Test multiple windows separately để detect regime-specific edge / overfit.
"""

from __future__ import annotations

from pathlib import Path
import numpy as np
import pandas as pd

from src.backtest import DEFAULT_COST_RT
from src.load_data import load_universe, load_vnindex

TURNOVER_MIN_BN = 3.0


def filter_largemid(universe: pd.DataFrame) -> pd.DataFrame:
    # Use 2024+ window để xác định liquid mã (giống cách test gốc)
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
    g["ma20"] = pd.Series(c).rolling(20).mean()
    g["ma50"] = pd.Series(c).rolling(50).mean()
    g["ma200"] = pd.Series(c).rolling(200).mean()
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
            trades.append({
                "date": g.iloc[i]["date"],
                "symbol": sym,
                "entry": ep, "exit": xp,
                "net_ret": (xp - ep) / ep - cost,
            })
    return pd.DataFrame(trades)


def stats(trades: pd.DataFrame, hold: int, window_years: float) -> dict:
    if len(trades) == 0:
        return {"n": 0, "win": 0, "avg": 0, "sharpe": 0, "pf": 0, "n_year": 0}
    win = (trades["net_ret"] > 0).mean()
    avg = trades["net_ret"].mean()
    std = trades["net_ret"].std()
    sharpe = (avg / std * (252 / hold) ** 0.5) if std > 0 else 0
    pos_sum = trades.loc[trades["net_ret"] > 0, "net_ret"].sum()
    neg_sum = abs(trades.loc[trades["net_ret"] < 0, "net_ret"].sum())
    pf = pos_sum / neg_sum if neg_sum > 0 else float("inf")
    return {"n": len(trades), "win": win, "avg": avg, "sharpe": sharpe, "pf": pf,
            "n_year": len(trades) / window_years if window_years > 0 else 0}


def test_window(df: pd.DataFrame, start: str, end: str, label: str, hold: int = 3):
    win_df = df[(df["date"] >= start) & (df["date"] <= end)].copy()
    if len(win_df) == 0:
        print(f"  [{label}] no data")
        return
    years = (pd.to_datetime(end) - pd.to_datetime(start)).days / 365.25

    # Pattern: drop 3d < -7% + vol > 2× + close > open + MA20 > MA50
    win_df["sig_base"] = (
        (win_df["ret_3d"] < -0.07) &
        (win_df["vol_ratio"] > 2.0) &
        win_df["day_green"]
    )
    win_df["sig_uptrend"] = win_df["sig_base"] & (win_df["ma20"] > win_df["ma50"])
    win_df["sig_strong_ut"] = win_df["sig_uptrend"] & (win_df["ma50"] > win_df["ma200"])
    win_df["sig_rsi35"] = win_df["sig_base"] & (win_df["rsi"] < 35)

    print(f"\n═══ {label} ({start} → {end}, {years:.1f} năm) ═══")

    for sig_label, col in [
        ("Base (no filter)", "sig_base"),
        ("+ Uptrend (MA20>MA50)", "sig_uptrend"),
        ("+ Strong Uptrend (MA50>MA200)", "sig_strong_ut"),
        ("+ RSI<35", "sig_rsi35"),
    ]:
        trades = simulate(win_df, col, hold)
        s = stats(trades, hold, years)
        marker = "🟢" if s["avg"] > 0 and s["win"] > 0.50 else "🔴"
        print(f"  {marker} {sig_label:<30} n={s['n']:4d} ({s['n_year']:5.0f}/năm) "
              f"win={s['win']*100:5.1f}% avg={s['avg']*100:+6.2f}% "
              f"sharpe={s['sharpe']:+.2f} pf={s['pf']:.2f}")


def main():
    print("Load + filter Large+Mid universe...")
    universe = load_universe()
    filtered = filter_largemid(universe)
    print(f"  {filtered.symbol.nunique()} mã, {len(filtered):,} rows total")
    print(f"  Date range: {filtered['date'].min()} → {filtered['date'].max()}")

    print("Enrich features...")
    parts = []
    for _, group in filtered.groupby("symbol", sort=False):
        parts.append(enrich(group))
    df = pd.concat(parts, ignore_index=True)

    # Test windows
    WINDOWS = [
        ("2018-01-01", "2019-12-31", "WIN-1: 2018-2019 (pre-COVID)"),
        ("2020-01-01", "2020-12-31", "WIN-2: 2020 (COVID crash + recovery)"),
        ("2021-01-01", "2021-12-31", "WIN-3: 2021 (massive BULL)"),
        ("2022-01-01", "2022-12-31", "WIN-4: 2022 (BEAR -30%)"),
        ("2023-01-01", "2023-12-31", "WIN-5: 2023 (sideways recovery)"),
        ("2024-01-01", "2026-05-31", "IN-SAMPLE: 2024-2026"),
        ("2020-01-01", "2023-12-31", "OUT-SAMPLE COMBINED: 2020-2023"),
        ("2018-01-01", "2026-05-31", "ALL 8.5 YEARS"),
    ]

    for start, end, label in WINDOWS:
        test_window(df, start, end, label)


if __name__ == "__main__":
    main()
