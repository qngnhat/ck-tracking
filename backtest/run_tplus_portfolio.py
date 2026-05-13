"""Portfolio backtest: top 5 mã mỗi ngày, hold 2-3 phiên (T+2.5), equal weight.

Mô phỏng cách user trade thực tế:
- Mỗi phiên close, app gợi ý top 5 mã (score >= min)
- Buy ATO sáng T+1, equal weight 1/5 mỗi mã
- Bán close T+3 (= T+2.5, hold đúng 2 phiên)

Stats:
- Per-trade win rate (mỗi mã 1 trade)
- Per-day portfolio return (chia đều 5 mã)
- Per-day win rate (portfolio > 0%)
- Cumulative equity curve nếu trade liên tục
- Max drawdown
"""

from __future__ import annotations

from pathlib import Path
import numpy as np
import pandas as pd

from src.backtest import DEFAULT_COST_RT, summarize
from src.load_data import load_universe, load_vnindex
from run_strong_leaders_ablation import add_scores_modular

TEST_START = "2024-01-01"
TURNOVER_MIN_BN = 3.0
OUT_DIR = Path(__file__).parent / "results"


def filter_largemid(universe: pd.DataFrame) -> pd.DataFrame:
    recent = universe[universe.date >= "2024-01-01"].copy()
    recent["turnover"] = recent["close"] * recent["volume"] * 1000
    liq = recent.groupby("symbol")["turnover"].median() / 1e9
    keep = liq[liq >= TURNOVER_MIN_BN].index.tolist()
    return universe[universe.symbol.isin(keep)].copy()


def simulate_portfolio(
    df: pd.DataFrame,
    top_n: int,
    hold: int,
    min_score: float,
    cost: float = DEFAULT_COST_RT,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """
    Returns:
        trades_df: per-trade results (1 row per stock per day)
        portfolio_df: per-day portfolio returns (avg of N picks per day)
    """
    df["date"] = pd.to_datetime(df["date"])
    open_pv = df.pivot_table(index="date", columns="symbol", values="open", aggfunc="first")
    close_pv = df.pivot_table(index="date", columns="symbol", values="close", aggfunc="first")
    score_pv = df.pivot_table(index="date", columns="symbol", values="strong_score", aggfunc="first")
    dates = score_pv.index

    trades = []
    daily_rows = []

    for i, d in enumerate(dates):
        s = score_pv.loc[d].dropna()
        valid = s[s >= min_score]
        if len(valid) == 0 or i + 1 >= len(dates) or i + 1 + hold >= len(dates):
            continue
        top = valid.sort_values(ascending=False).head(top_n)
        e_date = dates[i + 1]
        x_date = dates[i + 1 + hold]

        day_rets = []
        for sym in top.index:
            ep = open_pv.loc[e_date, sym] if sym in open_pv.columns else np.nan
            xp = close_pv.loc[x_date, sym] if sym in close_pv.columns else np.nan
            if pd.isna(ep) or pd.isna(xp) or ep <= 0:
                continue
            net = (xp - ep) / ep - cost
            trades.append({"date": d, "symbol": sym, "net_ret": net, "score": s[sym]})
            day_rets.append(net)

        if day_rets:
            daily_rows.append({
                "date": d,
                "n_picks": len(day_rets),
                "port_ret": np.mean(day_rets),
                "best": max(day_rets),
                "worst": min(day_rets),
            })

    return pd.DataFrame(trades), pd.DataFrame(daily_rows)


def compute_equity_curve(daily_df: pd.DataFrame, hold_days: int) -> dict:
    """Giả lập trade liên tục: mỗi phiên mở 1 portfolio mới, hold N phiên.

    Tại bất kỳ thời điểm nào trong steady state có ~hold_days portfolios đồng thời chạy.
    Capital chia đều cho `hold_days` slots → mỗi slot dùng 1/hold_days NAV.
    """
    if len(daily_df) == 0:
        return {}
    daily_df = daily_df.sort_values("date").reset_index(drop=True)
    rets = daily_df["port_ret"].values

    # Sequential mode: 1 lệnh tại 1 thời điểm, vào lại sau khi exit
    # → tổng số lệnh = floor(n_days / hold_days)
    equity = [1.0]
    seq_rets = []
    for i in range(0, len(rets), hold_days):
        equity.append(equity[-1] * (1 + rets[i]))
        seq_rets.append(rets[i])

    seq_final = equity[-1]
    seq_max = max(equity)
    peak = 1.0
    max_dd = 0.0
    for e in equity:
        peak = max(peak, e)
        dd = (e - peak) / peak
        max_dd = min(max_dd, dd)

    # Parallel mode: vào lệnh mỗi phiên, có hold_days portfolios chạy đồng thời
    # Avg daily portfolio return = (1/hold_days) × per-portfolio return
    # NAV growth rate ≈ avg(port_ret) / hold_days mỗi phiên
    daily_nav_ret = rets / hold_days
    par_equity = np.cumprod(1 + daily_nav_ret)
    par_peak = np.maximum.accumulate(par_equity)
    par_dd = (par_equity - par_peak) / par_peak
    par_max_dd = par_dd.min() if len(par_dd) > 0 else 0.0

    n_days = len(rets)
    years = n_days / 252

    return {
        "n_days": n_days,
        "years": years,
        "sequential_final": seq_final,
        "sequential_max_dd": max_dd,
        "sequential_n_trades": len(seq_rets),
        "sequential_cagr": seq_final ** (1 / years) - 1 if years > 0 and seq_final > 0 else 0,
        "parallel_final": par_equity[-1] if len(par_equity) > 0 else 1.0,
        "parallel_max_dd": par_max_dd,
        "parallel_cagr": par_equity[-1] ** (1 / years) - 1 if years > 0 and len(par_equity) > 0 and par_equity[-1] > 0 else 0,
    }


def report(label: str, trades: pd.DataFrame, daily: pd.DataFrame, hold: int):
    if len(trades) == 0:
        print(f"\n[{label}] no trades")
        return
    print(f"\n═══ {label} ═══")
    n_trades = len(trades)
    n_days = len(daily)
    win_trade = (trades["net_ret"] > 0).mean()
    avg_trade = trades["net_ret"].mean()
    win_day = (daily["port_ret"] > 0).mean()
    avg_day = daily["port_ret"].mean()
    median_day = daily["port_ret"].median()
    best_day = daily["port_ret"].max()
    worst_day = daily["port_ret"].min()

    print(f"Trades: {n_trades:,}  |  Days: {n_days:,}")
    print(f"\nPer-trade (mỗi mã 1 trade):")
    print(f"  Win rate: {win_trade*100:.1f}%")
    print(f"  Avg ret: {avg_trade*100:+.2f}%")

    print(f"\nPer-day portfolio (5 mã chia đều mỗi ngày):")
    print(f"  Win rate (portfolio > 0%): {win_day*100:.1f}%")
    print(f"  Avg port ret: {avg_day*100:+.2f}%")
    print(f"  Median port ret: {median_day*100:+.2f}%")
    print(f"  Best day: {best_day*100:+.2f}%  /  Worst day: {worst_day*100:+.2f}%")

    # Distribution
    print(f"\nPortfolio return distribution:")
    for q, label_q in [(0.10, "p10"), (0.25, "p25"), (0.50, "p50"), (0.75, "p75"), (0.90, "p90")]:
        v = daily["port_ret"].quantile(q)
        print(f"  {label_q}: {v*100:+.2f}%")

    eq = compute_equity_curve(daily, hold)
    print(f"\nEquity curve simulation ({eq['years']:.1f} năm, {eq['n_days']} phiên signal):")
    print(f"  Sequential mode (1 lệnh tại 1 thời điểm, vào lại sau exit):")
    print(f"    NAV cuối: {eq['sequential_final']:.3f}×  |  CAGR: {eq['sequential_cagr']*100:+.1f}%/năm")
    print(f"    Max drawdown: {eq['sequential_max_dd']*100:.1f}%  |  Tổng trades: {eq['sequential_n_trades']}")
    print(f"  Parallel mode (vào lệnh mỗi phiên, {hold} portfolios song song):")
    print(f"    NAV cuối: {eq['parallel_final']:.3f}×  |  CAGR: {eq['parallel_cagr']*100:+.1f}%/năm")
    print(f"    Max drawdown: {eq['parallel_max_dd']*100:.1f}%")


def main():
    print("Load + filter Large+Mid universe (turnover >= 3 tỷ/ngày)...")
    universe = load_universe()
    filtered = filter_largemid(universe)
    print(f"  {filtered.symbol.nunique()} mã")
    vni = load_vnindex()

    # Optimal config V7: drop Breakout (B)
    enabled = {"A": True, "B": False, "C": True, "D": True, "E": True, "F": True, "G": True}
    scored = add_scores_modular(filtered, vni, enabled)
    test_df = scored[scored["date"] >= TEST_START].copy()

    # T+2.5 → hold = 2 phiên (mua open T+1, bán close T+3 = sau 2 phiên hold)
    # T+3 = hold 3 phiên, T+2 = hold 2 phiên
    HOLD_CONFIGS = [
        ("T+2 (hold 2 phiên)", 2),
        ("T+3 (hold 3 phiên)", 3),
        ("T+4 (hold 4 phiên)", 4),
        ("T+5 (hold 5 phiên)", 5),
    ]

    TOP_N = 5

    for label, hold in HOLD_CONFIGS:
        for min_score in [3.0, 4.0, 5.0]:
            trades, daily = simulate_portfolio(test_df, TOP_N, hold, min_score)
            report(f"{label}  top={TOP_N}  min_score={min_score}", trades, daily, hold)


if __name__ == "__main__":
    main()
