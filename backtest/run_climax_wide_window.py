"""Verify: mở rộng exit window T+3..T+5 → T+3..T+10 có giữ edge không?

Logic (production behavior user mong muốn):
- Entry: open T+1 sau signal day
- Earliest sell: T+3 (VN T+ convention)
- TP hit: bất kỳ phiên T+3..T+max_hold mà close ≥ entry × 1.03 → bán ngay
- SL hit: close ≤ entry × 0.92 → bán ngay
- Không hit gì: force exit close T+max_hold

Test 3 variants Tier B (drop<-5%, vol>2×, rsi<50, no day_green per V1 vừa deploy):
  W5: max_hold=5 (current production)
  W7: max_hold=7
  W10: max_hold=10 (user request)

Cross-val Train 2022-2024 / Test 2025-2026 (loại covid).
Pass: Win ≥ 50%, Sharpe ≥ 0.3 cả 2 splits, edge không suy giảm khi mở rộng.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from src.backtest import DEFAULT_COST_RT
from src.load_data import load_universe

TRAIN_START = "2022-01-01"
TRAIN_END = "2024-12-31"
TEST_START = "2025-01-01"
TURNOVER_MIN_BN = 3.0
TARGET_PCT = 0.03
SL_PCT = 0.08


def filter_largemid(universe):
    recent = universe[universe.date >= "2024-01-01"].copy()
    recent["turnover"] = recent["close"] * recent["volume"] * 1000
    liq = recent.groupby("symbol")["turnover"].median() / 1e9
    keep = liq[liq >= TURNOVER_MIN_BN].index.tolist()
    return universe[universe.symbol.isin(keep)].copy()


def enrich(group):
    g = group.copy().reset_index(drop=True)
    c, o, v = g["close"].values, g["open"].values, g["volume"].values
    g["vol_avg20"] = pd.Series(v).rolling(20).mean()
    g["vol_ratio"] = v / g["vol_avg20"]
    delta = np.diff(c, prepend=c[0])
    up = np.where(delta > 0, delta, 0)
    dn = np.where(delta < 0, -delta, 0)
    avg_up = pd.Series(up).rolling(14).mean()
    avg_dn = pd.Series(dn).rolling(14).mean()
    rs = avg_up / avg_dn.replace(0, np.nan)
    g["rsi"] = 100 - 100 / (1 + rs)
    g["ret_3d"] = pd.Series(c).pct_change(3) * 100
    g["day_green"] = c > o
    return g


def simulate_dynamic(df, signal_col, min_hold, max_hold,
                    target_pct=TARGET_PCT, sl_pct=SL_PCT,
                    cost=DEFAULT_COST_RT):
    """TP-hit-first dynamic exit. Khớp logic production sẽ dùng."""
    df = df.sort_values(["symbol", "date"])
    trades = []
    for sym, group in df.groupby("symbol", sort=False):
        g = group.reset_index(drop=True)
        sig = g[signal_col].values
        opens = g["open"].values
        closes = g["close"].values
        for i in range(len(g) - 1 - max_hold):
            if not sig[i]:
                continue
            ep = opens[i + 1]
            if pd.isna(ep) or ep <= 0:
                continue
            exit_price, exit_day = None, None
            for h in range(1, max_hold + 1):
                day_idx = i + 1 + h
                if day_idx >= len(g):
                    break
                dc = closes[day_idx]
                if pd.isna(dc):
                    continue
                # SL first (priority over TP)
                if dc <= ep * (1 - sl_pct):
                    exit_price, exit_day = dc, h
                    break
                # TP only after min_hold
                if h >= min_hold:
                    if dc >= ep * (1 + target_pct):
                        exit_price, exit_day = dc, h
                        break
                # Force exit at max_hold
                if h == max_hold:
                    exit_price, exit_day = dc, h
            if exit_price is None:
                continue
            trades.append({
                "date": g.iloc[i]["date"],
                "symbol": sym,
                "exit_day": exit_day,
                "net_ret": (exit_price - ep) / ep - cost,
            })
    return pd.DataFrame(trades)


def stats(trades, max_hold):
    if len(trades) < 20:
        return None
    win = (trades["net_ret"] > 0).mean()
    avg = trades["net_ret"].mean()
    std = trades["net_ret"].std()
    avg_hold = trades["exit_day"].mean()
    sharpe = (avg / std * (252 / avg_hold) ** 0.5) if std > 0 else 0
    pos = trades.loc[trades["net_ret"] > 0, "net_ret"].sum()
    neg = abs(trades.loc[trades["net_ret"] < 0, "net_ret"].sum())
    pf = pos / neg if neg > 0 else float("inf")
    # TP/SL/force breakdown
    tp_hit = (trades["exit_day"] < max_hold).sum()
    return {
        "n": len(trades), "win": win, "avg": avg, "sharpe": sharpe, "pf": pf,
        "avg_hold": avg_hold, "tp_or_sl_pct": tp_hit / len(trades) * 100,
    }


def run_split(df, label):
    sig_col = (df["ret_3d"] < -5) & (df["vol_ratio"] > 2.0) & (df["rsi"] < 50)
    df = df.copy()
    df["sig"] = sig_col
    out = {}
    for max_hold in [5, 7, 10]:
        t = simulate_dynamic(df, "sig", min_hold=3, max_hold=max_hold)
        s = stats(t, max_hold)
        if s:
            out[max_hold] = s
    return out


def main():
    print("Load + enrich...")
    universe = load_universe()
    filtered = filter_largemid(universe)
    parts = [enrich(g) for _, g in filtered.groupby("symbol", sort=False)]
    df = pd.concat(parts, ignore_index=True)
    print(f"  {len(df):,} rows, {filtered.symbol.nunique()} mã")

    train = df[(df["date"] >= TRAIN_START) & (df["date"] <= TRAIN_END)].copy()
    test = df[df["date"] >= TEST_START].copy()
    print(f"  Train {len(train):,}, Test {len(test):,}")

    print("\nRun variants...")
    tr = run_split(train, "train")
    te = run_split(test, "test")

    print("\n═══ Tier B (-green) — Dynamic exit (TP+3% / SL-8% / force_max_hold) ═══")
    print(f"  {'max_hold':<10} {'TRAIN n  win   avg    sh   PF  hit% avgH':<50} {'TEST n  win   avg    sh   PF  hit% avgH':<50}")
    print(f"  {'-'*10} {'-'*50} {'-'*50}")
    for mh in [5, 7, 10]:
        if mh not in tr or mh not in te:
            continue
        t = tr[mh]
        e = te[mh]
        t_str = f"{t['n']:5d} {t['win']*100:5.1f}% {t['avg']*100:+5.2f}% {t['sharpe']:+.2f} {t['pf']:.2f} {t['tp_or_sl_pct']:4.0f}% {t['avg_hold']:.1f}"
        e_str = f"{e['n']:5d} {e['win']*100:5.1f}% {e['avg']*100:+5.2f}% {e['sharpe']:+.2f} {e['pf']:.2f} {e['tp_or_sl_pct']:4.0f}% {e['avg_hold']:.1f}"
        marker = "🟢" if e["win"] >= 0.5 and e["sharpe"] >= 0.3 else ""
        print(f"  {marker} T+{mh}      {t_str:<50} {e_str:<50}")

    print("\n═══ Comparison: T+5 (current) vs T+10 (user request) ═══")
    if 5 in te and 10 in te:
        e5, e10 = te[5], te[10]
        d_win = (e10["win"] - e5["win"]) * 100
        d_sharpe = e10["sharpe"] - e5["sharpe"]
        d_n = e10["n"] - e5["n"]
        d_avg = (e10["avg"] - e5["avg"]) * 100
        print(f"  Test set delta (T+10 - T+5):")
        print(f"    Win rate:   {d_win:+.1f}pp")
        print(f"    Sharpe:     {d_sharpe:+.2f}")
        print(f"    Avg ret:    {d_avg:+.2f}pp")
        print(f"    n trades:   {d_n:+d} ({d_n/e5['n']*100:+.0f}%)")
        verdict = "✅ T+10 OK" if (e10["win"] >= 0.5 and e10["sharpe"] >= e5["sharpe"] * 0.7) else "⚠️ T+10 yếu hơn"
        print(f"  Verdict: {verdict}")


if __name__ == "__main__":
    main()
