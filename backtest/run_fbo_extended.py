"""FBO extended verification — larger Test set để check sample n.

V1 signal: drop 3d<-5% + day green + RSI<50 + NN net 5d > 0.
Exit: T+5, target +3%, SL -8%.

Splits compared:
  A. Train 2024-2025 / Test 2026         (5 tháng Test — original, n=14)
  B. Train 2022-2024 / Test 2025-2026    (17 tháng Test — extended)
  C. Train 2022-2023 / Test 2024-2026    (28 tháng Test — longest)

Check: Sharpe & Win consistency across splits. Nếu B/C cho Sharpe gần 1.42 với
n>=30 → confidence cao. Nếu Sharpe drop nặng → suspect overfit/luck.
"""

from __future__ import annotations
import numpy as np
import pandas as pd
from src.backtest import DEFAULT_COST_RT
from src.load_data import load_universe

TURNOVER_MIN_BN = 5.0


def filter_universe(u):
    recent = u[u.date >= "2024-01-01"].copy()
    recent["turnover"] = recent["close"] * recent["volume"] * 1000
    liq = recent.groupby("symbol")["turnover"].median() / 1e9
    return u[u.symbol.isin(liq[liq >= TURNOVER_MIN_BN].index)].copy()


def enrich(group):
    g = group.copy().reset_index(drop=True)
    c, o, v = g["close"].values, g["open"].values, g["volume"].values
    cs = pd.Series(c)
    g["day_green"] = c > o
    g["ret_3d"] = cs.pct_change(3) * 100
    delta = np.diff(c, prepend=c[0])
    up = np.where(delta > 0, delta, 0)
    dn = np.where(delta < 0, -delta, 0)
    avg_up = pd.Series(up).rolling(14).mean()
    avg_dn = pd.Series(dn).rolling(14).mean()
    rs = avg_up / avg_dn.replace(0, np.nan)
    g["rsi"] = 100 - 100 / (1 + rs)
    if "net_val" in g.columns:
        g["nn_5d"] = g["net_val"].fillna(0).rolling(5).sum() / 1e9
    else:
        g["nn_5d"] = 0
    g["sig"] = (g["nn_5d"] > 0) & (g["ret_3d"] < -5) & g["day_green"] & (g["rsi"] < 50)
    return g


def simulate(df, max_hold=5, target_pct=0.03, sl_pct=0.08, cost=DEFAULT_COST_RT):
    df = df.sort_values(["symbol", "date"])
    trades = []
    for sym, group in df.groupby("symbol", sort=False):
        g = group.reset_index(drop=True)
        sig = g["sig"].values
        opens, closes = g["open"].values, g["close"].values
        for i in range(len(g) - 1 - max_hold):
            if not sig[i]:
                continue
            ep = opens[i + 1]
            if pd.isna(ep) or ep <= 0:
                continue
            ex, eh = None, None
            for h in range(1, max_hold + 1):
                di = i + 1 + h
                if di >= len(g):
                    break
                dc = closes[di]
                if pd.isna(dc):
                    continue
                if dc <= ep * (1 - sl_pct):
                    ex, eh = dc, h; break
                if h >= 3 and dc >= ep * (1 + target_pct):
                    ex, eh = dc, h; break
                if h == max_hold:
                    ex, eh = dc, h
            if ex is None:
                continue
            trades.append({"date": g.iloc[i]["date"], "exit_day": eh,
                          "net_ret": (ex - ep) / ep - cost})
    return pd.DataFrame(trades)


def stats(t):
    if len(t) < 5:
        return None
    win = (t["net_ret"] > 0).mean()
    avg = t["net_ret"].mean()
    std = t["net_ret"].std()
    h = t["exit_day"].mean() if len(t) > 0 else 4
    sh = (avg / std * (252 / h) ** 0.5) if std > 0 else 0
    pos = t.loc[t["net_ret"] > 0, "net_ret"].sum()
    neg = abs(t.loc[t["net_ret"] < 0, "net_ret"].sum())
    pf = pos / neg if neg > 0 else float("inf")
    # 95% CI for Win rate (Wilson)
    n = len(t)
    p = win
    z = 1.96
    denom = 1 + z**2/n
    p_center = (p + z**2/(2*n)) / denom
    p_margin = z * (p*(1-p)/n + z**2/(4*n**2))**0.5 / denom
    win_lo = max(0, p_center - p_margin)
    win_hi = min(1, p_center + p_margin)
    # Sharpe SE (approximate)
    sh_se = ((1 + sh**2/2) / n) ** 0.5
    sh_lo = sh - 1.96 * sh_se
    sh_hi = sh + 1.96 * sh_se
    return {
        "n": n, "win": win, "avg": avg, "sharpe": sh, "pf": pf,
        "win_ci": (win_lo, win_hi), "sh_ci": (sh_lo, sh_hi),
    }


def print_stats(label, s):
    if s is None:
        print(f"  {label}: (n < 5, insufficient)")
        return
    print(f"  {label}:")
    print(f"    n={s['n']}  Win={s['win']*100:.1f}%  avg={s['avg']*100:+.2f}%  Sharpe={s['sharpe']:+.2f}  PF={s['pf']:.2f}")
    print(f"    Win 95% CI: [{s['win_ci'][0]*100:.1f}%, {s['win_ci'][1]*100:.1f}%]")
    print(f"    Sharpe 95% CI: [{s['sh_ci'][0]:+.2f}, {s['sh_ci'][1]:+.2f}]")


def main():
    print("Load + enrich...")
    u = load_universe()
    f = filter_universe(u)
    parts = [enrich(g) for _, g in f.groupby("symbol", sort=False)]
    df = pd.concat(parts, ignore_index=True)
    print(f"  {f.symbol.nunique()} mã, {len(df):,} rows")

    splits = [
        ("A. Train 2024-25 / Test 2026 (original)",  "2024-01-01", "2025-12-31", "2026-01-01", None),
        ("B. Train 2022-24 / Test 2025-26 (extended)", "2022-01-01", "2024-12-31", "2025-01-01", None),
        ("C. Train 2022-23 / Test 2024-26 (longest)",  "2022-01-01", "2023-12-31", "2024-01-01", None),
    ]

    print("\n" + "═" * 70)
    print("FBO V1 verification across multiple Train/Test splits")
    print("═" * 70)

    for label, tr_start, tr_end, te_start, te_end in splits:
        print(f"\n{label}")
        print("-" * len(label))
        train = df[(df["date"] >= tr_start) & (df["date"] <= tr_end)]
        test = df[df["date"] >= te_start] if te_end is None else df[(df["date"] >= te_start) & (df["date"] <= te_end)]
        tr_trades = simulate(train)
        te_trades = simulate(test)
        s_tr = stats(tr_trades)
        s_te = stats(te_trades)
        print_stats("TRAIN", s_tr)
        print_stats("TEST", s_te)

        # Decision marker
        if s_te:
            if s_te["sharpe"] >= 0.5 and s_te["pf"] >= 1.3 and s_te["avg"] > 0 and s_te["n"] >= 30:
                print(f"  → 🟢 PASS robust (n≥30, Sharpe≥0.5, PF≥1.3)")
            elif s_te["sharpe"] >= 0.5 and s_te["pf"] >= 1.3 and s_te["avg"] > 0:
                print(f"  → 🟡 PASS criteria nhưng n<30 (statistical caveat)")
            else:
                print(f"  → ❌ FAIL")

    print("\n═══ Conclusion ═══")
    print("So sánh consistency across 3 splits:")
    print("  - Nếu cả 3 đều PASS với similar Sharpe → edge robust")
    print("  - Nếu chỉ A pass, B/C fail → A là luck với regime cụ thể")
    print("  - Nếu B/C pass với n>=30 → confidence cao hơn original A")


if __name__ == "__main__":
    main()
