"""Verify: R:R ratio nào có edge thực với dynamic exit TP/SL?

Backtest grid (Tier B -green, drop<-5%, vol>2×, rsi<50):
- TP: 3%, 5%, 7%
- SL: 5%, 6%, 8%
- Hold: T+5, T+10

Cross-val Train 2022-2024 / Test 2025-2026.
Pass: Test Win ≥ 50% + Sharpe ≥ 0.3 + avg ≥ +0.5%.
"""

from __future__ import annotations
import numpy as np
import pandas as pd
from src.backtest import DEFAULT_COST_RT
from src.load_data import load_universe

TRAIN_START, TRAIN_END, TEST_START = "2022-01-01", "2024-12-31", "2025-01-01"
TURNOVER_MIN_BN = 3.0


def filter_largemid(u):
    recent = u[u.date >= "2024-01-01"].copy()
    recent["turnover"] = recent["close"] * recent["volume"] * 1000
    liq = recent.groupby("symbol")["turnover"].median() / 1e9
    return u[u.symbol.isin(liq[liq >= TURNOVER_MIN_BN].index)].copy()


def enrich(group):
    g = group.copy().reset_index(drop=True)
    c, v = g["close"].values, g["volume"].values
    g["vol_avg20"] = pd.Series(v).rolling(20).mean()
    g["vol_ratio"] = v / g["vol_avg20"]
    delta = np.diff(c, prepend=c[0])
    up = np.where(delta > 0, delta, 0); dn = np.where(delta < 0, -delta, 0)
    avg_up = pd.Series(up).rolling(14).mean(); avg_dn = pd.Series(dn).rolling(14).mean()
    rs = avg_up / avg_dn.replace(0, np.nan)
    g["rsi"] = 100 - 100 / (1 + rs)
    g["ret_3d"] = pd.Series(c).pct_change(3) * 100
    return g


def simulate(df, sig, min_h, max_h, tp, sl, cost=DEFAULT_COST_RT):
    df = df.sort_values(["symbol", "date"])
    trades = []
    for sym, group in df.groupby("symbol", sort=False):
        g = group.reset_index(drop=True)
        s = g[sig].values
        opens, closes = g["open"].values, g["close"].values
        for i in range(len(g) - 1 - max_h):
            if not s[i]: continue
            ep = opens[i + 1]
            if pd.isna(ep) or ep <= 0: continue
            ex, eh = None, None
            for h in range(1, max_h + 1):
                di = i + 1 + h
                if di >= len(g): break
                dc = closes[di]
                if pd.isna(dc): continue
                if dc <= ep * (1 - sl):
                    ex, eh = dc, h; break
                if h >= min_h and dc >= ep * (1 + tp):
                    ex, eh = dc, h; break
                if h == max_h:
                    ex, eh = dc, h
            if ex is None: continue
            trades.append({"date": g.iloc[i]["date"], "exit_day": eh,
                          "net_ret": (ex - ep) / ep - cost})
    return pd.DataFrame(trades)


def stats(t):
    if len(t) < 20: return None
    win = (t["net_ret"] > 0).mean()
    avg = t["net_ret"].mean()
    std = t["net_ret"].std()
    avg_h = t["exit_day"].mean()
    sh = (avg / std * (252 / avg_h) ** 0.5) if std > 0 else 0
    pos = t.loc[t["net_ret"] > 0, "net_ret"].sum()
    neg = abs(t.loc[t["net_ret"] < 0, "net_ret"].sum())
    pf = pos / neg if neg > 0 else float("inf")
    return {"n": len(t), "win": win, "avg": avg, "sharpe": sh, "pf": pf, "avg_h": avg_h}


def main():
    print("Load + enrich...")
    u = load_universe()
    f = filter_largemid(u)
    parts = [enrich(g) for _, g in f.groupby("symbol", sort=False)]
    df = pd.concat(parts, ignore_index=True)
    df["sig"] = (df["ret_3d"] < -5) & (df["vol_ratio"] > 2.0) & (df["rsi"] < 50)
    print(f"  {len(df):,} rows, {f.symbol.nunique()} mã")

    train = df[(df["date"] >= TRAIN_START) & (df["date"] <= TRAIN_END)].copy()
    test = df[df["date"] >= TEST_START].copy()
    print(f"  Train {len(train):,}, Test {len(test):,}\n")

    TPs = [0.03, 0.05, 0.07]
    SLs = [0.05, 0.06, 0.08]
    HOLDS = [5, 10]

    rows = []
    for tp in TPs:
        for sl in SLs:
            for max_h in HOLDS:
                t_tr = simulate(train, "sig", 3, max_h, tp, sl)
                t_te = simulate(test, "sig", 3, max_h, tp, sl)
                s_tr = stats(t_tr); s_te = stats(t_te)
                if s_tr and s_te:
                    rows.append({
                        "tp": tp, "sl": sl, "max_h": max_h,
                        "tr_n": s_tr["n"], "tr_win": s_tr["win"],
                        "tr_avg": s_tr["avg"], "tr_sh": s_tr["sharpe"],
                        "te_n": s_te["n"], "te_win": s_te["win"],
                        "te_avg": s_te["avg"], "te_sh": s_te["sharpe"],
                        "te_pf": s_te["pf"], "te_avg_h": s_te["avg_h"],
                    })

    res = pd.DataFrame(rows)
    print("═══ R:R Grid — Tier B (-green) Dynamic Exit ═══")
    print(f"  {'TP':>5} {'SL':>5} {'H':>3} | {'TRAIN n  win   avg    sh':<30} | {'TEST n  win   avg    sh    PF':<35}")
    print(f"  {'-'*5} {'-'*5} {'-'*3}-+-{'-'*30}-+-{'-'*35}")
    for _, r in res.iterrows():
        tr = f"{int(r['tr_n']):4d} {r['tr_win']*100:5.1f}% {r['tr_avg']*100:+5.2f}% {r['tr_sh']:+.2f}"
        te = f"{int(r['te_n']):4d} {r['te_win']*100:5.1f}% {r['te_avg']*100:+5.2f}% {r['te_sh']:+.2f}  {r['te_pf']:.2f}"
        marker = ""
        if r["te_win"] >= 0.5 and r["te_sh"] >= 0.3 and r["te_avg"] >= 0.005:
            marker = "🟢"
        elif r["te_avg"] > 0:
            marker = "🟡"
        print(f"  {marker} TP{r['tp']*100:.0f}% SL{r['sl']*100:.0f}% T+{int(r['max_h'])} | {tr:<30} | {te:<35}")

    print("\n═══ Pass criteria: Test Win≥50%, Sharpe≥0.3, avg≥+0.5% ═══")
    passed = res[(res["te_win"] >= 0.5) & (res["te_sh"] >= 0.3) & (res["te_avg"] >= 0.005)]
    if len(passed) == 0:
        print("  ❌ KHÔNG variant nào pass — pattern Climax Tier B không có edge thực sau cost ở 2025-26.")
        # Show best by Sharpe for inspection
        best = res.sort_values("te_sh", ascending=False).head(3)
        print("\n  Top 3 by Test Sharpe (inspect — failed criteria):")
        for _, r in best.iterrows():
            print(f"    TP{r['tp']*100:.0f}% SL{r['sl']*100:.0f}% T+{int(r['max_h'])}: "
                  f"Test Win {r['te_win']*100:.1f}% avg {r['te_avg']*100:+.2f}% Sh {r['te_sh']:+.2f}")
    else:
        print(f"  ✅ {len(passed)} variants pass:")
        passed = passed.sort_values("te_sh", ascending=False)
        for _, r in passed.iterrows():
            print(f"    🟢 TP{r['tp']*100:.0f}% SL{r['sl']*100:.0f}% T+{int(r['max_h'])}: "
                  f"Train Win {r['tr_win']*100:.1f}% Sh {r['tr_sh']:+.2f} | "
                  f"Test Win {r['te_win']*100:.1f}% avg {r['te_avg']*100:+.2f}% Sh {r['te_sh']:+.2f} "
                  f"(avg hold {r['te_avg_h']:.1f}d)")


if __name__ == "__main__":
    main()
