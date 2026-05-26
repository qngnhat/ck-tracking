"""So sánh nhiều position-sizing strategies để tìm max profit.

Pattern: Base Breakout h=30 trail=10% sl=10% (winner Phase 1)
Test set: 2025-01-06 → 2026-03-09 (427 days, 104 trades)

Scenarios (cùng signals, khác sizing):
  S1. 100 CP fixed/signal (baseline)
  S2. 200 CP fixed/signal
  S3. 500 CP fixed/signal
  S4. 10M VND fixed/signal (balanced exposure)
  S5. 20M VND fixed/signal
  S6. 10% NAV/signal, max 10 concurrent (Kelly conservative)
  S7. 15% NAV/signal, max 10 concurrent
  S8. 20% NAV/signal, max 8 concurrent
  S9. 25% NAV/signal, max 5 concurrent (high concentration)
  S10. 15% NAV + quality filter (vol >2× thay vì >1.5×)

Starting NAV: 200M VND
Output: Final NAV, ROI, Annualized, Max Drawdown, Sharpe of NAV curve
"""

from __future__ import annotations
import numpy as np
import pandas as pd
from src.backtest import DEFAULT_COST_RT
from src.load_data import load_universe

TEST_START = "2025-01-01"
TURNOVER_MIN_BN = 5.0
INIT_SL_PCT = 0.10
TRAIL_PCT = 0.10
MAX_HOLD = 30
STARTING_NAV = 200_000_000  # 200M VND


def filter_universe(u):
    recent = u[u.date >= "2024-01-01"].copy()
    recent["turnover"] = recent["close"] * recent["volume"] * 1000
    liq = recent.groupby("symbol")["turnover"].median() / 1e9
    return u[u.symbol.isin(liq[liq >= TURNOVER_MIN_BN].index)].copy()


def enrich(group):
    g = group.copy().reset_index(drop=True)
    c, h, l, v = g["close"].values, g["high"].values, g["low"].values, g["volume"].values
    cs = pd.Series(c)
    g["ma200"] = cs.rolling(200).mean()
    g["above_ma200"] = c > g["ma200"]
    g["vol_avg20"] = pd.Series(v).rolling(20).mean()
    g["vol_ratio"] = v / g["vol_avg20"]
    high_30 = pd.Series(h).rolling(30).max()
    low_30 = pd.Series(l).rolling(30).min()
    range_30 = (high_30 - low_30) / low_30
    prev_high_30 = high_30.shift(1)
    g["base_range_ok"] = range_30.shift(1) < 0.10
    g["break_above"] = c > prev_high_30
    g["sig_normal"] = (g["above_ma200"] & g["base_range_ok"] & g["break_above"]
                      & (g["vol_ratio"] > 1.5))
    g["sig_quality"] = (g["above_ma200"] & g["base_range_ok"] & g["break_above"]
                       & (g["vol_ratio"] > 2.0))  # higher vol bar
    return g


def get_trades(df, sig_col, max_hold, trail_pct, init_sl_pct, cost=DEFAULT_COST_RT):
    df = df.sort_values(["symbol", "date"])
    trades = []
    for sym, group in df.groupby("symbol", sort=False):
        g = group.reset_index(drop=True)
        sig = g[sig_col].values
        opens, closes, highs = g["open"].values, g["close"].values, g["high"].values
        dates = g["date"].values
        for i in range(len(g) - 1 - max_hold):
            if not sig[i]:
                continue
            ep = opens[i + 1]
            if pd.isna(ep) or ep <= 0:
                continue
            init_sl = ep * (1 - init_sl_pct)
            peak = ep
            ex, ed = None, None
            for h_step in range(1, max_hold + 1):
                di = i + 1 + h_step
                if di >= len(g):
                    break
                dc = closes[di]
                if pd.isna(dc):
                    continue
                dh = highs[di]
                if not pd.isna(dh) and dh > peak:
                    peak = dh
                trail_sl = peak * (1 - trail_pct)
                eff = max(init_sl, trail_sl)
                if dc <= eff:
                    ex, ed = dc, dates[di]
                    break
                if h_step == max_hold:
                    ex, ed = dc, dates[di]
            if ex is None:
                continue
            trades.append({
                "symbol": sym,
                "entry_date": dates[i + 1],
                "entry_price": ep * 1000,  # convert nghìn đồng → VND
                "exit_date": ed,
                "exit_price": ex * 1000,
            })
    return pd.DataFrame(trades).sort_values("entry_date").reset_index(drop=True)


def simulate_portfolio(trades, sizing_fn, starting_nav, max_concurrent=None,
                      cost=DEFAULT_COST_RT, name=""):
    """Walk through time, open positions theo sizing_fn(nav_now, entry_price)
    until max_concurrent reached. Track cash + open positions value."""
    nav = starting_nav
    cash = starting_nav
    open_pos = []  # list of dicts: {symbol, entry_date, entry_price, shares, exit_date, exit_price}
    nav_curve = []
    daily_events = []  # (date, event)

    # Build event timeline: entry events + exit events from existing trades
    # Plus daily marks to track NAV mark-to-market is too expensive; just track at events.
    events = []
    for idx, t in trades.iterrows():
        events.append((t["entry_date"], "entry", idx))
    events.sort(key=lambda e: e[0])

    skipped = 0
    closed_trades = []

    for date, kind, idx in events:
        # First, close any positions whose exit_date <= current date
        still_open = []
        for p in open_pos:
            if p["exit_date"] <= date:
                # Close
                proceeds = p["shares"] * p["exit_price"]
                fee_total = p["shares"] * p["entry_price"] * cost  # round-trip fee
                pnl = proceeds - p["cost"] - fee_total
                cash += proceeds - fee_total + (p["cost"] - (p["shares"] * p["entry_price"]))  # net cash back: proceeds - fee
                # Simpler: cash += proceeds - fee, but already paid cost at entry → cash already deducted
                # Let me re-do: at entry, we deducted "p['cost']" from cash. At exit, we add proceeds - fee.
                # Net P&L = proceeds - cost - fee.
                # So cash flow at exit = proceeds - fee.
                # But we already paid -p["cost"] at entry. So:
                #   cash_after_exit = cash_at_exit_event + (proceeds - fee)
                # We need to "undo" the proceeds add we did above and redo correctly.
                # Easier: redo logic
                closed_trades.append({**p, "pnl": pnl, "exit_proceeds": proceeds})
            else:
                still_open.append(p)
        open_pos = still_open

        # Recompute cash from scratch to avoid bug above (cheaper than tracking incrementally)
        # ...we'll do that separately after the loop. For now, just queue exits.

        if kind == "entry":
            t = trades.iloc[idx]
            # Check max concurrent
            if max_concurrent and len(open_pos) >= max_concurrent:
                skipped += 1
                continue
            # Compute size using sizing fn
            nav_now = cash + sum(p["shares"] * p["entry_price"] for p in open_pos)
            shares = sizing_fn(nav_now, cash, t["entry_price"])
            if shares <= 0:
                skipped += 1
                continue
            position_cost = shares * t["entry_price"]
            fee_entry_estimate = position_cost * cost / 2  # half of round-trip = entry fee
            if position_cost + fee_entry_estimate > cash:
                skipped += 1
                continue
            cash -= position_cost  # deduct cost (fee charged at exit)
            open_pos.append({
                "symbol": t["symbol"],
                "entry_date": date,
                "entry_price": t["entry_price"],
                "shares": shares,
                "cost": position_cost,
                "exit_date": t["exit_date"],
                "exit_price": t["exit_price"],
            })

    # Close any remaining open positions at their exit_date
    for p in open_pos:
        proceeds = p["shares"] * p["exit_price"]
        fee_total = p["shares"] * p["entry_price"] * cost
        pnl = proceeds - p["cost"] - fee_total
        closed_trades.append({**p, "pnl": pnl, "exit_proceeds": proceeds})
        cash += proceeds - fee_total  # exit cash flow (entry cost already deducted)

    # Compute NAV curve by walking through events
    # Re-simulate cleanly for NAV curve
    cash2 = starting_nav
    pos_track = []
    nav_curve = [(pd.Timestamp(trades["entry_date"].min()) if len(trades) else None, starting_nav)]
    all_events = []
    for t in closed_trades:
        all_events.append((t["entry_date"], "open", t))
        all_events.append((t["exit_date"], "close", t))
    all_events.sort(key=lambda e: e[0])
    for date, kind, t in all_events:
        if kind == "open":
            cash2 -= t["cost"]  # deduct cost only
            pos_track.append(t)
        else:  # close
            cash2 += t["exit_proceeds"]
            fee = t["cost"] * cost
            cash2 -= fee
            pos_track = [p for p in pos_track if p is not t]
        # NAV = cash + sum of open positions value (at last known close price... use entry as proxy)
        pos_value = sum(p["shares"] * p["entry_price"] for p in pos_track)
        nav_now = cash2 + pos_value
        nav_curve.append((date, nav_now))

    # Final NAV (after all closed)
    final_nav = cash2
    total_pnl = final_nav - starting_nav
    n_executed = len(closed_trades)
    wins = sum(1 for t in closed_trades if t["pnl"] > 0)

    # Max drawdown of NAV curve
    peak = starting_nav
    max_dd = 0
    for _, nav in nav_curve:
        peak = max(peak, nav)
        dd = (nav - peak) / peak  # negative
        max_dd = min(max_dd, dd)

    # Annualized
    if len(nav_curve) >= 2:
        start_dt = pd.Timestamp(nav_curve[0][0])
        end_dt = pd.Timestamp(nav_curve[-1][0])
        days = max((end_dt - start_dt).days, 1)
        annualized = ((final_nav / starting_nav) ** (365 / days) - 1) * 100
    else:
        annualized = 0

    # Max exposure (capital deployed at any time)
    max_exposure = 0
    cur_exposure = 0
    for date, kind, t in all_events:
        if kind == "open":
            cur_exposure += t["cost"]
        else:
            cur_exposure -= t["cost"]
        max_exposure = max(max_exposure, cur_exposure)

    def fmt(v):
        if abs(v) >= 1e9:
            return f"{v/1e9:.2f}B"
        if abs(v) >= 1e6:
            return f"{v/1e6:.1f}M"
        if abs(v) >= 1e3:
            return f"{v/1e3:.0f}K"
        return f"{v:.0f}"

    return {
        "name": name,
        "executed": n_executed,
        "skipped": skipped,
        "wins": wins,
        "final_nav": final_nav,
        "total_pnl": total_pnl,
        "roi_pct": total_pnl / starting_nav * 100,
        "annualized_pct": annualized,
        "max_dd_pct": max_dd * 100,
        "max_exposure": max_exposure,
        "fmt": fmt,
    }


def main():
    print("Load + enrich...")
    u = load_universe()
    f = filter_universe(u)
    parts = [enrich(g) for _, g in f.groupby("symbol", sort=False)]
    df = pd.concat(parts, ignore_index=True)
    test = df[df["date"] >= TEST_START].copy()

    trades_normal = get_trades(test, "sig_normal", MAX_HOLD, TRAIL_PCT, INIT_SL_PCT)
    trades_quality = get_trades(test, "sig_quality", MAX_HOLD, TRAIL_PCT, INIT_SL_PCT)
    print(f"  Test trades (sig_normal vol>1.5×): {len(trades_normal)}")
    print(f"  Test trades (sig_quality vol>2.0×): {len(trades_quality)}")

    # Define scenarios
    scenarios = [
        ("S1.  100 CP fixed",          trades_normal,  lambda nav, cash, p: 100),
        ("S2.  200 CP fixed",          trades_normal,  lambda nav, cash, p: 200),
        ("S3.  500 CP fixed",          trades_normal,  lambda nav, cash, p: 500),
        ("S4.  10M VND fixed",         trades_normal,  lambda nav, cash, p: int(10e6 / p)),
        ("S5.  20M VND fixed",         trades_normal,  lambda nav, cash, p: int(20e6 / p)),
        ("S6.  10% NAV (max 10 pos)",  trades_normal,  lambda nav, cash, p: int(nav * 0.10 / p)),
        ("S7.  15% NAV (max 10 pos)",  trades_normal,  lambda nav, cash, p: int(nav * 0.15 / p)),
        ("S8.  20% NAV (max 8 pos)",   trades_normal,  lambda nav, cash, p: int(nav * 0.20 / p)),
        ("S9.  25% NAV (max 5 pos)",   trades_normal,  lambda nav, cash, p: int(nav * 0.25 / p)),
        ("S10. 15% NAV + quality vol>2×", trades_quality, lambda nav, cash, p: int(nav * 0.15 / p)),
    ]
    max_concurrent_map = {
        "S6":10, "S7":10, "S8":8, "S9":5, "S10":10,
    }

    results = []
    for label, trades_to_use, sizing_fn in scenarios:
        # Resolve max_concurrent từ label prefix
        prefix = label.split(".")[0]
        max_con = max_concurrent_map.get(prefix)
        r = simulate_portfolio(trades_to_use, sizing_fn, STARTING_NAV,
                              max_concurrent=max_con, name=label)
        results.append(r)

    print(f"\n═══ Compare 10 scenarios (Starting NAV {STARTING_NAV/1e6:.0f}M VND, Test 2025-26) ═══")
    print(f"  {'Scenario':<35} {'Exec':>5} {'Win':>4} {'Final NAV':>10} {'ROI':>7} {'Annual':>8} {'MaxDD':>7} {'MaxExpo':>10}")
    print(f"  {'-'*35} {'-'*5} {'-'*4} {'-'*10} {'-'*7} {'-'*8} {'-'*7} {'-'*10}")
    fmt = results[0]["fmt"]
    for r in results:
        print(f"  {r['name']:<35} {r['executed']:>5} {r['wins']:>4} "
              f"{fmt(r['final_nav']):>10} {r['roi_pct']:+6.1f}% {r['annualized_pct']:+7.1f}% "
              f"{r['max_dd_pct']:+6.1f}% {fmt(r['max_exposure']):>10}")

    # Rank by annualized
    print(f"\n═══ Ranking by Annualized ROI ═══")
    results_sorted = sorted(results, key=lambda r: -r["annualized_pct"])
    for i, r in enumerate(results_sorted, 1):
        print(f"  #{i:2d} {r['name']:<35} Annualized {r['annualized_pct']:+.1f}%/năm "
              f"(MaxDD {r['max_dd_pct']:+.1f}%)")


if __name__ == "__main__":
    main()
