"""V8.6 — TP bậc thang (laddered take profit) vs flat target.

So sánh:
- Flat T+3 close (baseline gốc)
- Flat dynamic T+3→T+5, target +3% close (strategy hiện tại)
- TP ladder: bán w1% tại tp1, w2% tại tp2, còn w3% force T+5

Ladder configs:
- 50/30/20 @ +3/+6/T+5
- 50/50    @ +3/+6 (no holdback)
- 33/33/34 @ +3/+6/T+5
- 70/30    @ +3/+6 (chốt sớm nhiều)

TP1 dùng close-based (auto-fire bằng lệnh điều kiện SSI).
TP2 dùng close-based (cùng cơ chế).
Force T+5: close.

SL close-based -8% (cắt toàn bộ position).
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from src.backtest import DEFAULT_COST_RT
from src.load_data import load_universe

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
    v = g["volume"].values

    g["vol_avg20"] = pd.Series(v).rolling(20).mean()
    g["vol_ratio"] = v / g["vol_avg20"]
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


def simulate_tp_ladder(
    df: pd.DataFrame,
    signal_col: str,
    ladder: list,  # [(weight, target_pct or None), ...] — None = force T+5
    min_hold: int = 3,
    max_hold: int = 5,
    sl_close_pct: float = 0.08,
    cost_buy: float = 0.0015,
    cost_sell: float = 0.0025,
) -> pd.DataFrame:
    """Mỗi pick chia thành N tranche. Mỗi tranche có target riêng.
    Tranche cuối (target=None) = force close T+max_hold.
    SL close-based -8% cắt TOÀN BỘ position còn lại.
    Cost mua riêng (paid once), cost bán riêng (paid per tranche).
    """
    assert abs(sum(w for w, _ in ladder) - 1.0) < 1e-6, "weights must sum to 1"

    df = df.sort_values(["symbol", "date"])
    trades = []
    for sym, group in df.groupby("symbol", sort=False):
        g = group.reset_index(drop=True)
        sig = g[signal_col].values
        for i in range(len(g) - 1 - max_hold):
            if not sig[i]:
                continue
            ep = g.iloc[i + 1]["open"]
            if pd.isna(ep) or ep <= 0:
                continue

            # Remaining tranches (by index in ladder list)
            remaining = list(range(len(ladder)))  # indexes
            tranche_exits = {}  # idx → (exit_price, exit_day, reason)
            sl_hit = False

            for h in range(1, max_hold + 1):
                day_idx = i + 1 + h
                if day_idx >= len(g):
                    break
                day_close = g.iloc[day_idx]["close"]
                if pd.isna(day_close):
                    continue

                # SL: cắt toàn bộ remaining
                if sl_close_pct and day_close <= ep * (1 - sl_close_pct):
                    for idx in remaining:
                        tranche_exits[idx] = (day_close, h, "sl")
                    remaining = []
                    sl_hit = True
                    break

                if h < min_hold:
                    continue  # chưa được bán

                ret = (day_close - ep) / ep
                # Check tranches có target hit
                to_remove = []
                for idx in remaining:
                    weight, tgt = ladder[idx]
                    if tgt is None:
                        continue  # force tranche, xử lý cuối
                    if ret >= tgt:
                        tranche_exits[idx] = (day_close, h, f"tp{idx+1}")
                        to_remove.append(idx)
                for idx in to_remove:
                    remaining.remove(idx)

                # Force exit T+max_hold cho remaining (kể cả force tranches)
                if h == max_hold:
                    for idx in remaining:
                        tranche_exits[idx] = (day_close, h, "force")
                    remaining = []

            if not tranche_exits:
                continue

            # Tổng PnL weighted
            net_ret = 0.0
            avg_hold = 0.0
            total_weight = 0.0
            entry_cost = ep * cost_buy
            for idx, (xp, hday, reason) in tranche_exits.items():
                weight, _ = ladder[idx]
                exit_net = xp * (1 - cost_sell)
                entry_net = ep + entry_cost
                tranche_ret = (exit_net - entry_net) / entry_net
                net_ret += weight * tranche_ret
                avg_hold += weight * hday
                total_weight += weight

            if total_weight < 0.999:
                continue  # incomplete (some tranche didn't get an exit)

            trades.append({
                "date": g.iloc[i]["date"],
                "symbol": sym,
                "net_ret": net_ret,
                "exit_day": avg_hold,
                "sl_hit": sl_hit,
            })
    return pd.DataFrame(trades)


def simulate_flat(
    df: pd.DataFrame,
    signal_col: str,
    min_hold=3, max_hold=5, target_pct=0.03,
    sl_close_pct: float = 0.08,
    cost: float = DEFAULT_COST_RT,
) -> pd.DataFrame:
    """Strategy hiện tại: flat target close-based."""
    df = df.sort_values(["symbol", "date"])
    trades = []
    for sym, group in df.groupby("symbol", sort=False):
        g = group.reset_index(drop=True)
        sig = g[signal_col].values
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


def stats(trades: pd.DataFrame, hold_avg: float) -> dict:
    if len(trades) == 0:
        return {"n": 0, "win": 0, "avg": 0, "sharpe": 0, "pf": 0, "avg_hold": 0}
    win = (trades["net_ret"] > 0).mean()
    avg = trades["net_ret"].mean()
    std = trades["net_ret"].std()
    sharpe = (avg / std * (252 / hold_avg) ** 0.5) if std > 0 and hold_avg > 0 else 0
    pos_sum = trades.loc[trades["net_ret"] > 0, "net_ret"].sum()
    neg_sum = abs(trades.loc[trades["net_ret"] < 0, "net_ret"].sum())
    pf = pos_sum / neg_sum if neg_sum > 0 else float("inf")
    avg_hold = trades.get("exit_day", pd.Series([hold_avg])).mean()
    return {"n": len(trades), "win": win, "avg": avg, "sharpe": sharpe,
            "pf": pf, "avg_hold": avg_hold}


def print_row(label: str, s: dict):
    print(f"  {label:<48} "
          f"{s['n']:4d} {s['win']*100:5.1f}% {s['avg']*100:+5.2f}% "
          f"{s['sharpe']:+.2f} {s['pf']:.2f} {s['avg_hold']:6.2f}")


def main():
    print("Load + filter Large+Mid…")
    universe = load_universe()
    filtered = filter_largemid(universe)
    print(f"  {filtered.symbol.nunique()} mã")

    parts = [enrich(g) for _, g in filtered.groupby("symbol", sort=False)]
    df = pd.concat(parts, ignore_index=True)

    df["sigA"] = (
        (df["ret_3d"] < -0.07) &
        (df["vol_ratio"] > 2.0) &
        df["day_green"] &
        (df["rsi"] < 35)
    )
    df["sigB"] = (
        (df["ret_3d"] < -0.05) &
        (df["vol_ratio"] > 2.0) &
        df["day_green"] &
        (df["rsi"] < 50)
    )

    LADDERS = [
        ("50/30/20 @ +3/+6/T5", [(0.5, 0.03), (0.3, 0.06), (0.2, None)]),
        ("50/50    @ +3/+6",    [(0.5, 0.03), (0.5, 0.06)]),
        ("33/33/34 @ +3/+6/T5", [(0.33, 0.03), (0.33, 0.06), (0.34, None)]),
        ("70/30    @ +3/+6",    [(0.7, 0.03), (0.3, 0.06)]),
        ("50/25/25 @ +3/+8/T5", [(0.5, 0.03), (0.25, 0.08), (0.25, None)]),
        ("40/40/20 @ +3/+6/T5", [(0.4, 0.03), (0.4, 0.06), (0.2, None)]),
    ]

    WINDOWS = [
        ("2018-01-01", "2026-05-13", "ALL 8.5y cross-val"),
        ("2024-01-01", "2026-05-13", "2024-2026 in-sample"),
        ("2018-01-01", "2023-12-31", "2018-2023 out-sample"),
    ]

    for sig_col, sig_label in [("sigA", "Tier A strict"), ("sigB", "Tier B relax")]:
        print(f"\n\n████ {sig_label} ████")
        for start, end, label in WINDOWS:
            win_df = df[(df["date"] >= start) & (df["date"] <= end)].copy()

            print(f"\n═══ {label} ({start} → {end}) ═══")
            print(f"  {'Strategy':<48} "
                  f"{'n':>4} {'Win%':>6} {'Avg':>7} {'Sharpe':>7} {'PF':>5} {'AvgHold':>7}")

            # Baseline flat target +3% (current)
            base = simulate_flat(win_df, sig_col, 3, 5, 0.03, sl_close_pct=0.08)
            avg_h = base["exit_day"].mean() if len(base) > 0 else 4
            print_row("Flat target +3% close (CURRENT)", stats(base, avg_h))

            # Flat target +6%
            f6 = simulate_flat(win_df, sig_col, 3, 5, 0.06, sl_close_pct=0.08)
            avg_h = f6["exit_day"].mean() if len(f6) > 0 else 4
            print_row("Flat target +6% close", stats(f6, avg_h))

            # Ladders
            for name, ladder in LADDERS:
                lad = simulate_tp_ladder(win_df, sig_col, ladder, sl_close_pct=0.08)
                avg_h = lad["exit_day"].mean() if len(lad) > 0 else 4
                print_row(f"Ladder {name}", stats(lad, avg_h))


if __name__ == "__main__":
    main()
