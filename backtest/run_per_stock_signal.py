"""Per-stock signal: dùng surge fingerprint per stock làm threshold.

Approach: cho mỗi mã, compute surge RSI distribution lịch sử (median ± std).
Today's signal: nếu RSI trong stock's "surge zone" + drop + vol > 1 → fire.

Test: aggregate Win/Sharpe across all stocks.
"""

from __future__ import annotations
import numpy as np
import pandas as pd
from src.backtest import DEFAULT_COST_RT
from src.load_data import load_universe

TURNOVER_MIN_BN = 3.0
LOOKBACK_HISTORY = 252 * 3  # 3 năm để build fingerprint
SURGE_THRESHOLD = 0.05
SURGE_WINDOW = 5


def filter_largemid(universe):
    recent = universe[universe.date >= "2024-01-01"].copy()
    recent["turnover"] = recent["close"] * recent["volume"] * 1000
    liq = recent.groupby("symbol")["turnover"].median() / 1e9
    return liq[liq >= TURNOVER_MIN_BN].index.tolist()


def enrich(group):
    g = group.copy().reset_index(drop=True)
    c, o, v = g["close"].values, g["open"].values, g["volume"].values
    cs = pd.Series(c)
    g["ma20"] = cs.rolling(20).mean()
    g["vol_avg20"] = pd.Series(v).rolling(20).mean()
    g["vol_ratio"] = v / g["vol_avg20"]
    g["ret_3d"] = cs.pct_change(3)
    g["dist_ma20"] = (cs - g["ma20"]) / g["ma20"]
    g["day_green"] = c > o

    delta = np.diff(c, prepend=c[0])
    up = np.where(delta > 0, delta, 0)
    dn = np.where(delta < 0, -delta, 0)
    avg_up = pd.Series(up).rolling(14).mean()
    avg_dn = pd.Series(dn).rolling(14).mean()
    rs = avg_up / avg_dn.replace(0, np.nan)
    g["rsi"] = 100 - 100 / (1 + rs)

    # Forward return for fingerprint training
    g["fwd_max_close"] = cs.shift(-1).rolling(SURGE_WINDOW).max()
    g["fwd_max_ret"] = (g["fwd_max_close"] - cs) / cs
    g["is_surge"] = g["fwd_max_ret"] >= SURGE_THRESHOLD

    return g


def build_fingerprint(g_train):
    """From training portion, extract surge RSI distribution."""
    surges = g_train[g_train["is_surge"]]
    if len(surges) < 10:
        return None
    rsi_vals = surges["rsi"].dropna()
    if len(rsi_vals) < 5:
        return None
    return {
        "rsi_median": rsi_vals.median(),
        "rsi_p25": rsi_vals.quantile(0.25),
        "rsi_p75": rsi_vals.quantile(0.75),
        "rsi_std": rsi_vals.std(),
        "n_surges": len(surges),
    }


def simulate_with_fingerprint(df, train_cutoff_date, fp_dict, mode="rsi_only"):
    """Test period: dates > train_cutoff. Signal uses fingerprint."""
    df = df.sort_values(["symbol", "date"])
    trades = []
    for sym, group in df.groupby("symbol", sort=False):
        if sym not in fp_dict:
            continue
        fp = fp_dict[sym]
        g = group.reset_index(drop=True)
        test_mask = g["date"] > train_cutoff_date
        for i in range(len(g) - 6):
            if not test_mask.iloc[i]:
                continue
            row = g.iloc[i]
            if pd.isna(row["rsi"]) or pd.isna(row["ret_3d"]) or pd.isna(row["vol_ratio"]):
                continue

            # Signal: RSI within stock's surge zone (p25 ~ p75)
            if mode == "rsi_only":
                signal = (fp["rsi_p25"] <= row["rsi"] <= fp["rsi_p75"])
            elif mode == "rsi_drop":
                signal = (fp["rsi_p25"] <= row["rsi"] <= fp["rsi_p75"]) and (row["ret_3d"] < -0.03)
            elif mode == "rsi_drop_green":
                signal = (
                    fp["rsi_p25"] <= row["rsi"] <= fp["rsi_p75"] and
                    row["ret_3d"] < -0.03 and row["day_green"]
                )
            elif mode == "rsi_drop_vol":
                signal = (
                    fp["rsi_p25"] <= row["rsi"] <= fp["rsi_p75"] and
                    row["ret_3d"] < -0.03 and row["vol_ratio"] > 1.0 and
                    row["day_green"]
                )
            else:
                signal = False

            if not signal: continue
            ep = g.iloc[i + 1]["open"]
            if pd.isna(ep) or ep <= 0: continue

            # T+ simulate
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
                "symbol": sym, "date": row["date"],
                "net_ret": (exit_price - ep) / ep - DEFAULT_COST_RT,
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


def main():
    print("Load + enrich...")
    universe = load_universe()
    universe["date"] = pd.to_datetime(universe["date"])
    syms = filter_largemid(universe)
    parts = []
    for sym in syms:
        sdf = universe[universe["symbol"] == sym].sort_values("date").reset_index(drop=True)
        if len(sdf) < 300: continue
        parts.append(enrich(sdf))
    df = pd.concat(parts, ignore_index=True) if parts else None
    if df is None: return
    print(f"  {df.symbol.nunique()} mã, {len(df)} bars\n")

    # Cross-val: train fingerprint on 2018-2023, test 2024-2026
    train_cutoff = pd.to_datetime("2023-12-31")
    print(f"Train fingerprint on 2018→{train_cutoff.date()}")
    print(f"Test on {(train_cutoff + pd.Timedelta(days=1)).date()}→2026-05-13\n")

    fp_dict = {}
    for sym, g in df.groupby("symbol"):
        train_g = g[g["date"] <= train_cutoff]
        fp = build_fingerprint(train_g)
        if fp: fp_dict[sym] = fp
    print(f"Built fingerprint for {len(fp_dict)}/{df.symbol.nunique()} mã (others insufficient data)")

    print("\n═══ Per-stock signal backtest (TEST 2024-2026 OUT-OF-SAMPLE) ═══")
    print(f"  {'Mode':<35} {'n':>5}  {'/yr':<6} {'Win%':>6} {'Avg':>7} {'Sharpe':>7} {'PF':>5}")
    for mode in ["rsi_only", "rsi_drop", "rsi_drop_green", "rsi_drop_vol"]:
        tr = simulate_with_fingerprint(df, train_cutoff, fp_dict, mode=mode)
        s = stats(tr)
        yr = s['n'] / 2.4 if s['n'] > 0 else 0  # 2.4 năm test
        print(f"  {mode:<35} {s['n']:5d} ({yr:5.1f}/yr) {s['win']*100:5.1f}% {s['avg']*100:+5.2f}% {s['sharpe']:+.2f} {s['pf']:.2f}")

    # Also show fingerprint distribution for context
    print("\n═══ Fingerprint summary ═══")
    all_rsi_med = [fp["rsi_median"] for fp in fp_dict.values()]
    print(f"  RSI median across stocks: {np.median(all_rsi_med):.1f}, range {min(all_rsi_med):.1f}-{max(all_rsi_med):.1f}")
    print(f"  Sample 5 mã:")
    for i, (sym, fp) in enumerate(fp_dict.items()):
        if i >= 5: break
        print(f"    {sym}: surge RSI [{fp['rsi_p25']:.1f} - {fp['rsi_p75']:.1f}], median {fp['rsi_median']:.1f}, n_surge={fp['n_surges']}")


if __name__ == "__main__":
    main()
