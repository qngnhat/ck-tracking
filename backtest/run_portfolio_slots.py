"""Sửa exit thì tài khoản được gì — sim mức portfolio, không phải per-trade.

Thống kê per-trade (`run_exit_vs_entry.py`) nói trailing hơn. Nhưng trailing giữ
20 phiên trong khi exit hiện tại giữ 5, mà tài khoản chỉ có 5 slot → số lệnh thực
nhận ít hơn nhiều. Script này mô hình đúng ràng buộc đó:

- K slot, mỗi lệnh vào bằng equity/K tại thời điểm vào
- T+2: không được bán trước khi giữ 2 phiên; tiền bán về sau 2 phiên
- cost 0.4% round-trip (0.2%/chiều)
- nhiều signal hơn slot trống -> ưu tiên vol_ratio lớn (đo luôn tần suất kẹt slot)
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from run_exit_vs_entry import ENTRIES, enrich
from run_climax_regime_filter import filter_largemid
from src.load_data import load_universe, load_vnindex
from src.portfolio import benchmark_buy_hold, compute_metrics, print_metrics_table

SLOTS = 5
COST_SIDE = 0.002
SETTLE_DAYS = 2

VOL_CLIMAX_UNIVERSE = __import__("run_market_health_gate").VOL_CLIMAX_UNIVERSE

EXIT_BOT = {"name": "BOT SL8/TP3 từ D+3/hold5", "sl": 0.08, "tp": 0.03,
            "tp_from": 3, "max_hold": 5, "trail": None}
EXIT_TRAIL = {"name": "TRAIL SL8/trail10%/hold20", "sl": 0.08, "tp": None,
              "tp_from": None, "max_hold": 20, "trail": 0.10}


RANKS = {   # nhiều signal hơn slot -> chọn ai. Kết quả phụ thuộc luật này nên phải đo cả 3.
    "vol_ratio↓": ("vol_ratio", False),
    "rsi↑": ("rsi", True),
    "ret_3d↑": ("ret_3d", True),
}


def simulate_portfolio(df, entry_cols, exit_cfg, slots=SLOTS, rank="vol_ratio↓"):
    """Event-driven, slot-limited. Trả về (equity series, stats)."""
    df = df.sort_values(["date", "symbol"])
    sig = df[entry_cols].any(axis=1) if len(entry_cols) > 1 else df[entry_cols[0]]
    df = df.assign(_sig=sig.fillna(False))

    rank_col, rank_asc = RANKS[rank]
    piv = {c: df.pivot_table(index="date", columns="symbol", values=c, aggfunc="first")
           for c in ("open", "high", "close", rank_col)}
    sig_piv = df.pivot_table(index="date", columns="symbol", values="_sig", aggfunc="first").fillna(False)
    dates = sig_piv.index

    cash, pending = 1.0, {}          # pending: {ngày tiền về: số tiền}
    positions, closed, equity, blocked = [], [], [], 0

    for i, d in enumerate(dates):
        cash += pending.pop(d, 0.0)

        still = []
        for p in positions:
            p["hold"] += 1
            c = piv["close"].at[d, p["sym"]]
            h = piv["high"].at[d, p["sym"]]
            if pd.notna(h):
                p["peak"] = max(p["peak"], h)
            if pd.isna(c):
                still.append(p)
                continue

            ep, out = p["entry"], None
            # T+2: không bán được trước 2 phiên, kể cả khi đã thủng SL.
            if p["hold"] >= SETTLE_DAYS:
                sl = ep * (1 - exit_cfg["sl"])
                if exit_cfg["trail"]:
                    sl = max(sl, p["peak"] * (1 - exit_cfg["trail"]))
                if c <= sl:
                    out = c
                elif exit_cfg["tp"] and p["hold"] >= exit_cfg["tp_from"] and c >= ep * (1 + exit_cfg["tp"]):
                    out = c
            if out is None and p["hold"] >= exit_cfg["max_hold"]:
                out = c

            if out is None:
                still.append(p)
            else:
                proceeds = p["alloc"] * (out / ep) * (1 - COST_SIDE) ** 2
                settle = dates[min(i + SETTLE_DAYS, len(dates) - 1)]
                pending[settle] = pending.get(settle, 0.0) + proceeds
                closed.append({"sym": p["sym"], "hold": p["hold"],
                               "net_ret": proceeds / p["alloc"] - 1})
        positions = still

        mark = sum(p["alloc"] * (piv["close"].at[d, p["sym"]] / p["entry"])
                   for p in positions if pd.notna(piv["close"].at[d, p["sym"]]))
        equity.append(cash + sum(pending.values()) + mark)

        if i + 1 >= len(dates):
            continue
        row = sig_piv.loc[d]
        cands = row[row].index.tolist()
        if not cands:
            continue
        free = slots - len(positions)
        if free <= 0:
            blocked += len(cands)
            continue
        if len(cands) > free:
            blocked += len(cands) - free
            cands = (piv[rank_col].loc[d, cands].sort_values(ascending=rank_asc)
                     .head(free).index.tolist())

        nd = dates[i + 1]
        for sym in cands:
            ep = piv["open"].at[nd, sym]
            if pd.isna(ep) or ep <= 0:
                continue
            alloc = (cash + sum(pending.values()) + mark) / slots
            if alloc > cash:
                blocked += 1
                continue
            cash -= alloc
            positions.append({"sym": sym, "entry": ep, "alloc": alloc,
                              "peak": ep, "hold": 0})

    eq = pd.Series(equity, index=dates)
    tr = pd.DataFrame(closed)
    stats = {
        "n_trades": len(tr),
        "win": (tr.net_ret > 0).mean() if len(tr) else 0,
        "avg_ret": tr.net_ret.mean() if len(tr) else 0,
        "avg_hold": tr.hold.mean() if len(tr) else 0,
        "signals_bỏ_lỡ": blocked,
        "ngày_có_vị_thế": float(np.mean([v > 0 for v in
                          [sum(1 for _ in range(1)) for _ in range(1)]])) if False else None,
    }
    return eq, stats


def main():
    uni = load_universe()
    vni = load_vnindex()
    vni["date"] = pd.to_datetime(vni["date"])

    SETS = {
        "185 mã thanh khoản": filter_largemid(uni),
        "35 mã bot scan": uni[uni.symbol.isin(VOL_CLIMAX_UNIVERSE)],
    }
    enriched = {}
    for name, sub in SETS.items():
        d = pd.concat([enrich(g) for _, g in sub.groupby("symbol", sort=False)], ignore_index=True)
        d["date"] = pd.to_datetime(d["date"])
        for e, fn in ENTRIES.items():
            d[e] = fn(d).fillna(False)
        enriched[name] = d

    CLIMAX = "climax Tier B (bot đang dùng)"
    STRENGTH = "Strength Continuation"
    HHHL = "HH/HL + uptrend"

    PLANS = [
        ("A. KHÔNG SỬA: climax + exit bot", "35 mã bot scan", [CLIMAX], EXIT_BOT),
        ("B. chỉ đổi exit: climax + trail", "35 mã bot scan", [CLIMAX], EXIT_TRAIL),
        ("C. B + mở universe 185 mã", "185 mã thanh khoản", [CLIMAX], EXIT_TRAIL),
        ("D. C + thêm Strength Cont.", "185 mã thanh khoản", [CLIMAX, STRENGTH], EXIT_TRAIL),
        ("E. HH/HL + trail (n lớn nhất)", "185 mã thanh khoản", [HHHL], EXIT_TRAIL),
    ]

    for wlab, start, end in [("2024-nay", "2024-01-01", "2026-10-16"),
                             ("2018-2023", "2018-01-01", "2023-12-31")]:
        print(f"\n\n████████ {wlab} ({start} → {end}), {SLOTS} slot, T+2, cost 0.4% ████████")
        metrics, extra = {}, {}
        for label, uni_key, entries, exit_cfg in PLANS:
            d = enriched[uni_key]
            w = d[(d.date >= start) & (d.date <= end)]
            eq, s = simulate_portfolio(w, entries, exit_cfg)
            metrics[label] = compute_metrics(eq.pct_change().dropna())
            extra[label] = s

        v = vni[(vni.date >= start) & (vni.date <= end)]
        metrics["VN-Index buy&hold"] = compute_metrics(benchmark_buy_hold(v))
        print_metrics_table(metrics)

        print(f"\n  {'kế hoạch':<36} {'lệnh':>6} {'Win%':>6} {'avg/lệnh':>9} {'hold':>6} {'signal bỏ lỡ':>13}")
        for label, s in extra.items():
            print(f"  {label:<36} {s['n_trades']:6d} {s['win']*100:5.1f}% "
                  f"{s['avg_ret']*100:+8.2f}% {s['avg_hold']:6.1f} {s['signals_bỏ_lỡ']:13d}")

        # C/D/E bị giới hạn slot nhiều -> kết quả có thể do luật chọn, không do strategy.
        print(f"\n  Độ nhạy với luật chọn khi thiếu slot (CAGR):")
        print(f"  {'kế hoạch':<36}" + "".join(f"{r:>12}" for r in RANKS))
        for label, uni_key, entries, exit_cfg in PLANS:
            d = enriched[uni_key]
            w = d[(d.date >= start) & (d.date <= end)]
            row = ""
            for r in RANKS:
                eq, _ = simulate_portfolio(w, entries, exit_cfg, rank=r)
                m = compute_metrics(eq.pct_change().dropna())
                row += f"{m['cagr']*100:+11.2f}%"
            print(f"  {label:<36}{row}")


if __name__ == "__main__":
    main()
