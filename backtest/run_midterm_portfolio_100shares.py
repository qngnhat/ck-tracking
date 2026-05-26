"""Portfolio simulation: mỗi signal Base Breakout vào 100 cổ phiếu.

Pattern winner Phase 1: A h=30 trail=10% sl=10%

Outputs:
- Total trades + win rate
- Total gross P&L
- Capital required (max concurrent exposure)
- Avg capital deployed
- ROI on capital deployed
- Drawdown curve
- Compare across Test 2025-2026 + Train 2022-2024

Assumes:
- 100 CP fixed lot per signal
- Cost 0.5% round-trip (DEFAULT_COST_RT — buy + sell + tax)
- Unlimited cash (measure pure edge first), no concurrent position cap
"""

from __future__ import annotations
import numpy as np
import pandas as pd
from src.backtest import DEFAULT_COST_RT
from src.load_data import load_universe

TRAIN_START, TRAIN_END, TEST_START = "2022-01-01", "2024-12-31", "2025-01-01"
TURNOVER_MIN_BN = 5.0
INIT_SL_PCT = 0.10
TRAIL_PCT = 0.10
MAX_HOLD = 30
SHARES_PER_TRADE = 100


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
    g["sig"] = (g["above_ma200"] & g["base_range_ok"] & g["break_above"]
               & (g["vol_ratio"] > 1.5))
    return g


def simulate_trades(df, max_hold, trail_pct, init_sl_pct, cost=DEFAULT_COST_RT):
    """Return list of trades with full info: entry_date, exit_date, entry_price, exit_price, symbol."""
    df = df.sort_values(["symbol", "date"])
    trades = []
    for sym, group in df.groupby("symbol", sort=False):
        g = group.reset_index(drop=True)
        sig = g["sig"].values
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
            ex, eh, ed = None, None, None
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
                    ex, eh, ed = dc, h_step, dates[di]
                    break
                if h_step == max_hold:
                    ex, eh, ed = dc, h_step, dates[di]
            if ex is None:
                continue
            trades.append({
                "symbol": sym,
                "signal_date": dates[i],
                "entry_date": dates[i + 1],
                "entry_price": ep,
                "exit_date": ed,
                "exit_price": ex,
                "exit_day": eh,
                "net_ret_pct": ((ex - ep) / ep - cost) * 100,
            })
    return pd.DataFrame(trades)


def simulate_portfolio_100shares(trades_df, label, cost=DEFAULT_COST_RT):
    """Simulate buying 100 shares per signal. Track exposure + cash flow."""
    if len(trades_df) == 0:
        print(f"  {label}: no trades")
        return None

    trades_df = trades_df.sort_values("signal_date").reset_index(drop=True)

    # Per-trade computation
    trades_df["entry_cost"] = SHARES_PER_TRADE * trades_df["entry_price"] * 1000  # VND (price in nghìn đồng)
    trades_df["exit_proceeds"] = SHARES_PER_TRADE * trades_df["exit_price"] * 1000
    trades_df["fee"] = trades_df["entry_cost"] * cost  # round-trip fee
    trades_df["net_pnl_vnd"] = trades_df["exit_proceeds"] - trades_df["entry_cost"] - trades_df["fee"]
    trades_df["roi_pct"] = trades_df["net_pnl_vnd"] / trades_df["entry_cost"] * 100

    # Compute concurrent exposure timeline
    events = []
    for _, t in trades_df.iterrows():
        events.append((t["entry_date"], +t["entry_cost"], "buy"))
        events.append((t["exit_date"], -t["entry_cost"], "sell"))
    events.sort(key=lambda e: e[0])
    cur_exposure = 0
    max_exposure = 0
    exposure_curve = []
    for date, delta, _ in events:
        cur_exposure += delta
        max_exposure = max(max_exposure, cur_exposure)
        exposure_curve.append((date, cur_exposure))

    # Cumulative P&L curve over time
    pnl_events = []
    for _, t in trades_df.iterrows():
        pnl_events.append((t["exit_date"], t["net_pnl_vnd"]))
    pnl_events.sort(key=lambda e: e[0])
    cum_pnl = 0
    cum_pnl_curve = []
    peak_pnl = 0
    max_drawdown = 0
    for date, pnl in pnl_events:
        cum_pnl += pnl
        peak_pnl = max(peak_pnl, cum_pnl)
        dd = cum_pnl - peak_pnl  # negative
        max_drawdown = min(max_drawdown, dd)
        cum_pnl_curve.append((date, cum_pnl))

    # Stats
    n = len(trades_df)
    wins = (trades_df["net_pnl_vnd"] > 0).sum()
    total_pnl = trades_df["net_pnl_vnd"].sum()
    total_cost_invested = trades_df["entry_cost"].sum()
    avg_cost = trades_df["entry_cost"].mean()
    avg_roi = trades_df["roi_pct"].mean()
    sum_period_days = (pd.to_datetime(trades_df["exit_date"].max()) -
                       pd.to_datetime(trades_df["entry_date"].min())).days

    # Annualized ROI based on max exposure (worst-case capital needed)
    if max_exposure > 0 and sum_period_days > 0:
        roi_on_max_exposure = total_pnl / max_exposure * 100
        annualized = roi_on_max_exposure / (sum_period_days / 365)
    else:
        roi_on_max_exposure = 0
        annualized = 0

    # Format VND
    def fmt(v):
        if abs(v) >= 1e9:
            return f"{v/1e9:.2f}B"
        if abs(v) >= 1e6:
            return f"{v/1e6:.2f}M"
        if abs(v) >= 1e3:
            return f"{v/1e3:.1f}K"
        return f"{v:.0f}"

    print(f"\n═══ {label} ═══")
    print(f"  Period:                {trades_df['entry_date'].min().date()} → {trades_df['exit_date'].max().date()} ({sum_period_days} days)")
    print(f"  Trades:                {n} ({wins} wins, {n - wins} losses, win rate {wins/n*100:.1f}%)")
    print(f"  Avg entry cost/trade:  {fmt(avg_cost)} VND  (100 CP × avg {avg_cost/100/1000:.2f}k đồng)")
    print(f"  Total cost invested:   {fmt(total_cost_invested)} VND (cumulative across all trades)")
    print(f"  Max concurrent expo:   {fmt(max_exposure)} VND  ← VỐN tối thiểu cần để theo full strategy")
    print(f"  Total net P&L:         {fmt(total_pnl)} VND  ({total_pnl > 0 and '+' or ''}{total_pnl/max_exposure*100:.1f}% on max exposure)")
    print(f"  Avg ROI per trade:     {avg_roi:+.2f}%")
    print(f"  Max drawdown:          {fmt(max_drawdown)} VND ({max_drawdown/max_exposure*100:.1f}% of max expo)")
    print(f"  Annualized ROI:        {annualized:+.1f}%/năm  (on max exposure)")

    # Best/worst trades
    best = trades_df.nlargest(3, "net_pnl_vnd")
    worst = trades_df.nsmallest(3, "net_pnl_vnd")
    print(f"\n  Top 3 winners:")
    for _, t in best.iterrows():
        print(f"    {t['symbol']:6} {pd.to_datetime(t['entry_date']).date()} → {pd.to_datetime(t['exit_date']).date()}: "
              f"entry {t['entry_price']:.2f} → exit {t['exit_price']:.2f}, "
              f"P&L {fmt(t['net_pnl_vnd'])} VND ({t['roi_pct']:+.1f}%)")
    print(f"  Top 3 losers:")
    for _, t in worst.iterrows():
        print(f"    {t['symbol']:6} {pd.to_datetime(t['entry_date']).date()} → {pd.to_datetime(t['exit_date']).date()}: "
              f"entry {t['entry_price']:.2f} → exit {t['exit_price']:.2f}, "
              f"P&L {fmt(t['net_pnl_vnd'])} VND ({t['roi_pct']:+.1f}%)")

    return {
        "n": n, "wins": wins, "total_pnl": total_pnl,
        "max_exposure": max_exposure, "avg_cost": avg_cost,
        "annualized": annualized, "max_dd": max_drawdown,
    }


def main():
    print("Load + enrich...")
    u = load_universe()
    f = filter_universe(u)
    parts = [enrich(g) for _, g in f.groupby("symbol", sort=False)]
    df = pd.concat(parts, ignore_index=True)
    print(f"  {f.symbol.nunique()} mã, {df['sig'].sum()} signal fires\n")

    train = df[(df["date"] >= TRAIN_START) & (df["date"] <= TRAIN_END)].copy()
    test = df[df["date"] >= TEST_START].copy()

    print("Simulate trades với trailing stop logic...")
    train_trades = simulate_trades(train, MAX_HOLD, TRAIL_PCT, INIT_SL_PCT)
    test_trades = simulate_trades(test, MAX_HOLD, TRAIL_PCT, INIT_SL_PCT)

    # Portfolio simulation 100 shares/trade
    simulate_portfolio_100shares(train_trades, "TRAIN 2022-2024 (in-sample)")
    simulate_portfolio_100shares(test_trades, "TEST 2025-2026 (out-of-sample)")


if __name__ == "__main__":
    main()
