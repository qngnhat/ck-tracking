"""Cùng một bộ entry, đổi exit — xem cái nào mới là nguồn của P&L.

Cả 5 đợt đo 2026-10-16 (climax, strong leaders, momentum ×4) đều cho cùng một
dấu hiệu: hold ngắn + target +3% thì âm, hold dài + trailing thì dương, bất kể
entry là pattern gì. Script này tách hẳn hai biến ra để kiểm chứng trực tiếp:
3 entry × 2 exit, cùng universe, cùng window, cùng cost.

Exit "bot" = CLASSICAL_EXIT đang chạy prod (worker.js): SL 8% close, TP 3% từ D+3,
max hold 5.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

from run_climax_regime_filter import filter_largemid, simulate
from run_momentum_trailing import simulate_trailing
from src.load_data import load_universe

p2 = lambda t: math.erfc(abs(t) / math.sqrt(2))


def enrich(group: pd.DataFrame) -> pd.DataFrame:
    g = group.copy().reset_index(drop=True)
    c, o = g["close"].values, g["open"].values
    cs, hs, ls = pd.Series(c), pd.Series(g["high"].values), pd.Series(g["low"].values)
    v = pd.Series(g["volume"].values)

    for n in (5, 20, 50, 200):
        g[f"ma{n}"] = cs.rolling(n).mean()
    g["vol_ratio"] = v / v.rolling(20).mean()
    g["ret_3d"] = cs.pct_change(3)
    g["day_green"] = c > o
    g["range_pct"] = (hs - ls) / cs * 100

    delta = np.diff(c, prepend=c[0])
    up = pd.Series(np.where(delta > 0, delta, 0)).rolling(14).mean()
    dn = pd.Series(np.where(delta < 0, -delta, 0)).rolling(14).mean()
    g["rsi"] = 100 - 100 / (1 + up / dn.replace(0, np.nan))

    g["hh_3"] = (hs > hs.shift(1)) & (hs.shift(1) > hs.shift(2)) & (hs.shift(2) > hs.shift(3))
    g["hl_3"] = (ls > ls.shift(1)) & (ls.shift(1) > ls.shift(2)) & (ls.shift(2) > ls.shift(3))
    g["uptrend"] = (g["ma20"] > g["ma50"]) & (cs > g["ma50"])
    g["ma_stack"] = (g["ma5"] > g["ma20"]) & (g["ma20"] > g["ma50"]) & (g["ma50"] > g["ma200"])
    return g


ENTRIES = {
    "climax Tier B (bot đang dùng)":
        lambda d: (d.ret_3d < -0.05) & (d.vol_ratio > 2.0) & d.day_green & (d.rsi < 50),
    "HH/HL + uptrend":
        lambda d: d.hh_3 & d.hl_3 & d.day_green & d.uptrend,
    "Strength Continuation":
        lambda d: (d.ma_stack & (d.range_pct < 2.5) & (d.vol_ratio > 1.5)
                   & d.day_green & d.rsi.between(50, 70)),
}

EXITS = {
    "exit BOT (SL8/TP3 từ D+3/hold 5)": lambda d, col: simulate(d, col),
    "exit TRAIL (SL8/trail 10%/hold 20)":
        lambda d, col: simulate_trailing(d, col, max_hold=20, trail_pct=0.10, init_sl_pct=0.08),
}

WINDOWS = [("2018-2023", "2018-01-01", "2023-12-31"), ("2024-nay", "2024-01-01", "2026-10-16")]


def main():
    print("Load + enrich (universe thanh khoản ≥3tỷ)…")
    df = pd.concat([enrich(g) for _, g in filter_largemid(load_universe()).groupby("symbol", sort=False)],
                   ignore_index=True)
    df["date"] = pd.to_datetime(df["date"])
    for name, fn in ENTRIES.items():
        df[name] = fn(df).fillna(False)
    print(f"  {df.symbol.nunique()} mã, {len(df)} bar\n")

    for lab, start, end in WINDOWS:
        w = df[(df.date >= start) & (df.date <= end)]
        print(f"═══ {lab} ═══")
        print(f"  {'entry':<30} {'exit':<36} {'n':>5} {'Win%':>6} {'Avg':>7} {'t':>6} {'p':>6}"
              f" {'hold':>5} {'%/ngày':>7} {'Sharpe':>6}")
        for entry in ENTRIES:
            for ex_lab, ex_fn in EXITS.items():
                tr = ex_fn(w, entry)
                r, hold = tr.net_ret, tr.exit_day.mean()
                se = r.std() / math.sqrt(len(r)) if len(r) else float("nan")
                t = r.mean() / se if len(r) else float("nan")
                # Trailing giữ vốn lâu hơn 4x -> avg/lệnh không so trực tiếp được.
                sharpe = r.mean() / r.std() * math.sqrt(252 / hold)
                print(f"  {entry:<30} {ex_lab:<36} {len(r):5d} {(r>0).mean()*100:5.1f}% "
                      f"{r.mean()*100:+6.2f}% {t:+6.2f} {p2(t):6.3f} {hold:5.1f} "
                      f"{r.mean()/hold*100:+6.3f}% {sharpe:+6.2f}")
        print()


if __name__ == "__main__":
    main()
