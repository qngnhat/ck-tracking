"""Backtest cổng market-health của worker (computeMarketHealth).

Cổng này được thêm vào bot sau đợt backtest cuối (06/2026) nên chưa từng đi qua
framework này. Hiện nó chỉ in banner cảnh báo chứ KHÔNG chặn pick. Hai câu hỏi:

  1. Nếu chặn hẳn pick lúc `weak` (hoặc cả `caution`) thì kết quả tốt lên hay xấu đi?
  2. Hai ngưỡng cứng 0.5 / 0.6 có đứng vững không, hay chỉ là số bịa?

Port 1-1 từ worker.js:
  breadthRatio = up / max(down, 1)   — up/down đếm close vs close phiên trước,
                                        trên đúng 35 mã của VOL_CLIMAX_UNIVERSE
  fail-open khi < 50 bar VNI hoặc up+down < 5
  weak    = VNI < MA50  VÀ  breadth < 0.5
  caution = VNI < MA20  HOẶC breadth < 0.6

Health tính trên phiên signal (bot chạy EOD 14:50), vào lệnh mở cửa phiên sau —
khớp đúng cách simulate() của run_climax_regime_filter vào lệnh.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from run_climax_regime_filter import enrich, load_vnindex, simulate, stats
from src.load_data import load_universe

# worker.js:2489 — universe bot scan climax, cũng là mẫu để đếm breadth.
VOL_CLIMAX_UNIVERSE = [
    "HPG", "FPT", "SSI", "MWG", "STB", "VHM", "SHB", "VIX", "MSN", "VPB",
    "MBB", "TCB", "VND", "DIG", "VNM", "SHS", "CTG", "ACB", "DGC", "GEX",
    "HCM", "DXG", "VRE", "VCI", "GEL", "PDR", "HDB", "NVL", "EIB", "DBC",
    "TPB", "CEO", "KBC", "CII", "PVS",
]

WEAK_BREADTH = 0.5
CAUTION_BREADTH = 0.6
MIN_VNI_BARS = 50
MIN_BREADTH_SAMPLE = 5


def breadth_by_date(df: pd.DataFrame) -> pd.DataFrame:
    """up/down mỗi phiên trên universe scan — giống worker đếm changePct > 0 / < 0."""
    d = df[df.symbol.isin(VOL_CLIMAX_UNIVERSE)].sort_values(["symbol", "date"]).copy()
    d["chg"] = d.groupby("symbol")["close"].pct_change()
    d = d.dropna(subset=["chg"])
    g = d.groupby("date")["chg"]
    out = pd.DataFrame({"up": g.apply(lambda s: int((s > 0).sum())),
                        "down": g.apply(lambda s: int((s < 0).sum()))}).reset_index()
    out["breadth_ratio"] = out["up"] / out["down"].clip(lower=1)
    return out


def health_by_date(vni: pd.DataFrame, breadth: pd.DataFrame,
                   weak_th=WEAK_BREADTH, caution_th=CAUTION_BREADTH) -> pd.DataFrame:
    m = vni.merge(breadth, on="date", how="left")
    m["up"] = m["up"].fillna(0)
    m["down"] = m["down"].fillna(0)
    br = m["breadth_ratio"].fillna(0.0)

    # Fail-open y như worker: thiếu bar VNI hoặc mẫu breadth quá nhỏ -> coi như ok.
    enough = (np.arange(len(m)) >= MIN_VNI_BARS - 1) & (m["up"] + m["down"] >= MIN_BREADTH_SAMPLE)
    above20 = m["close"] >= m["ma20"]
    above50 = m["close"] >= m["ma50"]
    weak = (~above50) & (br < weak_th)
    caution = (~above20) | (br < caution_th)

    m["health"] = np.where(~enough, "ok",
                           np.where(weak, "weak", np.where(caution, "caution", "ok")))
    return m[["date", "health", "breadth_ratio", "up", "down"]]


def run_variants(df: pd.DataFrame, base_col: str, windows, variants, title: str):
    print(f"\n\n████ {title} ████")
    for start, end, label in windows:
        w = df[(df["date"] >= start) & (df["date"] <= end)].copy()
        print(f"\n═══ {label} ({start} → {end}) ═══")
        print(f"  {'Biến thể':<42} {'n':>4} {'Win%':>6} {'Avg':>7} {'Sharpe':>7} {'PF':>5}")
        base_n = None
        for vlabel, mask_fn in variants:
            w["_sig"] = w[base_col] & (mask_fn(w) if mask_fn else True)
            tr = simulate(w, "_sig")
            avg_h = tr["exit_day"].mean() if len(tr) > 0 else 4
            s = stats(tr, avg_h)
            if base_n is None:
                base_n = s["n"]
            keep = f"{s['n']/base_n*100:3.0f}% lệnh" if base_n else ""
            print(f"  {vlabel:<42} {s['n']:4d} {s['win']*100:5.1f}% {s['avg']*100:+5.2f}% "
                  f"{s['sharpe']:+.2f} {s['pf']:5.2f}  {keep}")


def main():
    print("Load VN-Index + universe…")
    vni = load_vnindex()
    universe = load_universe()
    df = universe[universe.symbol.isin(VOL_CLIMAX_UNIVERSE)].copy()
    df["date"] = pd.to_datetime(df["date"])
    print(f"  VN-Index: {len(vni)} bar, {vni.date.min().date()} → {vni.date.max().date()}")
    print(f"  Universe: {df.symbol.nunique()} mã (đúng bộ bot scan)")

    breadth = breadth_by_date(df)
    health = health_by_date(vni, breadth)
    dist = health["health"].value_counts(normalize=True) * 100
    print("  Phân bố health trên toàn kỳ: " +
          " · ".join(f"{k} {dist.get(k, 0):.1f}%" for k in ("ok", "caution", "weak")))

    parts = [enrich(g) for _, g in df.groupby("symbol", sort=False)]
    df = pd.concat(parts, ignore_index=True)
    df["date"] = pd.to_datetime(df["date"])
    df = df.merge(health, on="date", how="left")
    df["health"] = df["health"].fillna("ok")

    df["base_A"] = ((df["ret_3d"] < -0.07) & (df["vol_ratio"] > 2.0) &
                    df["day_green"] & (df["rsi"] < 35))
    df["base_B"] = ((df["ret_3d"] < -0.05) & (df["vol_ratio"] > 2.0) &
                    df["day_green"] & (df["rsi"] < 50))

    VARIANTS = [
        ("baseline — không chặn gì (bot hiện tại)", None),
        ("chặn weak", lambda w: w["health"] != "weak"),
        ("chặn weak + caution (chỉ vào lúc ok)", lambda w: w["health"] == "ok"),
        ("ĐẢO: CHỈ vào lúc weak", lambda w: w["health"] == "weak"),
        ("ĐẢO: CHỈ vào lúc weak/caution", lambda w: w["health"] != "ok"),
    ]
    END = df["date"].max().strftime("%Y-%m-%d")
    WINDOWS = [
        ("2018-01-01", END, "ALL"),
        ("2018-01-01", "2023-12-31", "2018-2023 out-sample"),
        ("2024-01-01", END, "2024-nay gần đây"),
        # Đoạn bot chạy live, chưa có trong data lúc đo lần đầu (2026-05-13).
        ("2026-05-14", END, "2026-05→nay (live, n nhỏ)"),
    ]

    for tier, col in [("A", "base_A"), ("B", "base_B")]:
        run_variants(df, col, WINDOWS, VARIANTS, f"Tier {tier} ({col})")

    # Ngưỡng 0.5 có phải số đúng không, hay chỉ là số đầu tiên nghĩ ra.
    print("\n\n████ Quét ngưỡng breadth của luật weak (Tier B, toàn kỳ) ████")
    print(f"  {'ngưỡng weak':<42} {'n':>4} {'Win%':>6} {'Avg':>7} {'Sharpe':>7} {'PF':>5}")
    base = df[(df["date"] >= "2018-01-01")].copy()
    for th in (0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0):
        h = health_by_date(vni, breadth, weak_th=th)
        w = base.drop(columns=["health"]).merge(h[["date", "health"]], on="date", how="left")
        w["health"] = w["health"].fillna("ok")
        w["_sig"] = w["base_B"] & (w["health"] != "weak")
        tr = simulate(w, "_sig")
        avg_h = tr["exit_day"].mean() if len(tr) > 0 else 4
        s = stats(tr, avg_h)
        mark = "  <- đang dùng" if th == WEAK_BREADTH else ""
        print(f"  chặn khi breadth < {th:<24.1f} {s['n']:4d} {s['win']*100:5.1f}% "
              f"{s['avg']*100:+5.2f}% {s['sharpe']:+.2f} {s['pf']:5.2f}{mark}")


if __name__ == "__main__":
    main()
