"""Base Breakout còn đúng ở regime 2024-nay không — và ở mức tài khoản thì được gì.

worker.js quảng cáo `Test 2025-26: Win 52%, Sharpe 1.13, PF 2.82, avg +6.95%/trade`
và `+29.8%/năm trên 200M vốn`. Hai số đó đến từ `run_midterm_phase1.py` (1 cửa sổ
duy nhất) và `run_midterm_portfolio_100shares.py` (KHÔNG giới hạn số lệnh mở cùng
lúc). Script này đo lại đúng config live của bot trên nhiều regime, rồi đo lại với
ràng buộc 5 slot + T+2 giống `run_portfolio_slots.py` đã dùng cho climax.
"""

from __future__ import annotations

import math

import pandas as pd

from run_exit_vs_entry import enrich as enrich_base
from run_midterm_phase1 import filter_universe, simulate_trailing, stats
from run_portfolio_slots import RANKS, SLOTS, simulate_portfolio
from src.load_data import load_universe, load_vnindex
from src.portfolio import benchmark_buy_hold, compute_metrics, print_metrics_table

# Đúng hằng số trong worker.js: BASE_BREAKOUT_{TRAIL,INIT_SL}_PCT / MAX_HOLD_TRADING.
LIVE = {"max_hold": 30, "trail": 0.10, "init_sl": 0.10}
EXIT_BB = {"name": "BB SL10/trail10%/hold30", "sl": 0.10, "tp": None,
           "tp_from": None, "max_hold": 30, "trail": 0.10}

END = None  # set từ data


def add_base_breakout(df):
    """Cột signal Base Breakout, mirror detectBaseBreakout() trong worker.js."""
    out = []
    for _, g in df.groupby("symbol", sort=False):
        g = g.reset_index(drop=True)
        c, h, l = g["close"], g["high"], g["low"]
        ma200 = c.rolling(200).mean()
        high_30, low_30 = h.rolling(30).max(), l.rolling(30).min()
        base_range = ((high_30 - low_30) / low_30).shift(1)
        g["sig_bb"] = ((c > ma200) & (base_range < 0.10) & (c > high_30.shift(1))
                       & (g["vol_ratio"] > 1.5)).fillna(False)
        out.append(g)
    return pd.concat(out, ignore_index=True)


def ttest(r):
    n = len(r)
    if n < 2 or r.std() == 0:
        return 0.0, 1.0
    t = r.mean() / (r.std() / math.sqrt(n))
    return t, math.erfc(abs(t) / math.sqrt(2))


def main():
    global END
    uni = load_universe()
    vni = load_vnindex()
    vni["date"] = pd.to_datetime(vni["date"])
    END = uni["date"].max().strftime("%Y-%m-%d")

    f = filter_universe(uni)
    print(f"Universe (median turnover 60d >= 5 tỷ): {f.symbol.nunique()} mã, data tới {END}")
    df = pd.concat([enrich_base(g) for _, g in f.groupby("symbol", sort=False)],
                   ignore_index=True)
    df = add_base_breakout(df)
    df["date"] = pd.to_datetime(df["date"])
    print(f"  {len(df):,} rows, {int(df.sig_bb.sum())} lần signal nổ (toàn kỳ)")

    WINDOWS = [
        ("2018-2023 out-sample", "2018-01-01", "2023-12-31"),
        ("2024-nay", "2024-01-01", END),
        ("2025-nay (cửa sổ bot quảng cáo)", "2025-01-01", END),
        ("toàn kỳ", "2018-01-01", END),
    ]

    print(f"\n████ PER-TRADE, đúng config live (hold {LIVE['max_hold']}, "
          f"trail {int(LIVE['trail']*100)}%, SL {int(LIVE['init_sl']*100)}%) ████")
    print(f"  {'cửa sổ':<34}{'n':>5}{'Win%':>8}{'avg':>9}{'p':>8}{'hold':>7}"
          f"{'Sharpe':>8}{'PF':>7}")
    for lab, start, end in WINDOWS:
        w = df[(df.date >= start) & (df.date <= end)]
        t = simulate_trailing(w, "sig_bb", LIVE["max_hold"], LIVE["trail"], LIVE["init_sl"])
        s = stats(t)
        if s is None:
            print(f"  {lab:<34}{len(t):>5}  n < 20, không kết luận")
            continue
        _, p = ttest(t["net_ret"])
        print(f"  {lab:<34}{s['n']:>5}{s['win']*100:>7.1f}%{s['avg']*100:>+8.2f}%"
              f"{p:>8.3f}{s['avg_h']:>7.1f}{s['sharpe']:>+8.2f}{s['pf']:>7.2f}")

    print(f"\n████ MỨC TÀI KHOẢN: {SLOTS} slot, T+2, cost 0.4% ████")
    for lab, start, end in WINDOWS[:2]:
        w = df[(df.date >= start) & (df.date <= end)]
        eq, s = simulate_portfolio(w, ["sig_bb"], EXIT_BB)
        v = vni[(vni.date >= start) & (vni.date <= end)]
        print(f"\n  ── {lab} ({start} → {end}) ──")
        print_metrics_table({"Base Breakout 5 slot": compute_metrics(eq.pct_change().dropna()),
                             "VN-Index buy&hold": compute_metrics(benchmark_buy_hold(v))})
        print(f"  lệnh thực nhận {s['n_trades']}, Win {s['win']*100:.1f}%, "
              f"avg {s['avg_ret']*100:+.2f}%, hold {s['avg_hold']:.1f} phiên, "
              f"signal bỏ lỡ vì hết slot {s['signals_bỏ_lỡ']}")
        row = ""
        for r in RANKS:
            e2, _ = simulate_portfolio(w, ["sig_bb"], EXIT_BB, rank=r)
            row += f"{compute_metrics(e2.pct_change().dropna())['cagr']*100:+11.2f}%"
        print(f"  CAGR theo luật chọn khi thiếu slot: "
              + "".join(f"{r:>12}" for r in RANKS) + f"\n{'':38}{row}")


if __name__ == "__main__":
    main()
