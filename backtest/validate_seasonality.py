"""Phase 1 — Validate seasonality hypothesis trước khi xây hệ thống.

User giả thuyết: "tháng 5 năm trước thị trường tăng, thì năm nay khả năng cũng tăng".
Test 3 góc:

1. VNI monthly return correlation YoY: cor(VNI ret tháng X năm Y, VNI ret tháng X năm Y-1)
2. Per-sector monthly return YoY correlation (14 sectors)
3. Per-stock monthly return YoY correlation (top 30 liquid)
4. Same-period 30d return correlation
5. "Direction match" hit rate: nếu tháng X năm trước +, năm nay cũng + không?

Output: report markdown. Decision gate cho phase 2.

Nếu correlation > 0.3 + direction match > 60% → ship seasonal features.
Nếu < 0.3 + direction match ~50% → seasonal là noise, skip per-stock layer.
"""

from __future__ import annotations
import numpy as np
import pandas as pd
from src.load_data import load_universe


def load_vnindex():
    df = pd.read_parquet("data/vnindex.parquet")
    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values("date").reset_index(drop=True)
    return df


def monthly_returns(df, price_col="close"):
    """Convert daily series to monthly returns."""
    df = df.copy()
    df["year"] = df["date"].dt.year
    df["month"] = df["date"].dt.month
    monthly = df.groupby(["year", "month"]).agg(
        first=(price_col, "first"),
        last=(price_col, "last"),
    ).reset_index()
    monthly["ret"] = (monthly["last"] - monthly["first"]) / monthly["first"]
    monthly["ym"] = pd.to_datetime(
        monthly["year"].astype(str) + "-" + monthly["month"].astype(str.zfill(2) if False else str).str.zfill(2) + "-01"
    )
    return monthly[["year", "month", "ym", "ret"]]


def yoy_correlation(monthly_df, label=""):
    """Tính correlation giữa cùng tháng các năm liền kề."""
    pairs = []
    for _, row in monthly_df.iterrows():
        ly = monthly_df[
            (monthly_df["year"] == row["year"] - 1) &
            (monthly_df["month"] == row["month"])
        ]
        if len(ly) > 0:
            pairs.append((ly.iloc[0]["ret"], row["ret"], row["year"], row["month"]))

    if len(pairs) < 5:
        return None

    a = np.array([p[0] for p in pairs])
    b = np.array([p[1] for p in pairs])
    cor = np.corrcoef(a, b)[0, 1] if len(a) > 1 else 0

    # Direction match: cùng dấu
    dir_match = np.mean(np.sign(a) == np.sign(b))

    # Magnitude similarity
    mag_diff = np.mean(np.abs(a - b))

    return {
        "label": label,
        "n_pairs": len(pairs),
        "correlation": cor,
        "direction_match": dir_match,
        "avg_magnitude_diff": mag_diff,
        "ly_avg": np.mean(a),
        "ty_avg": np.mean(b),
    }


def main():
    print("Load VNI + universe...")
    vni = load_vnindex()
    universe = load_universe()
    universe["date"] = pd.to_datetime(universe["date"])
    print(f"  VNI range: {vni['date'].min().date()} → {vni['date'].max().date()}")
    print(f"  Universe: {universe['symbol'].nunique()} mã\n")

    # ── 1. VNI monthly YoY correlation ──
    print("═══ 1. VNI Monthly Return YoY ═══")
    vni_monthly = monthly_returns(vni)
    print(f"  Total monthly bars: {len(vni_monthly)}")
    r = yoy_correlation(vni_monthly, "VNI all months")
    if r:
        print(f"  Pairs: {r['n_pairs']}")
        print(f"  Correlation: {r['correlation']:+.3f}")
        print(f"  Direction match: {r['direction_match']*100:.1f}%")
        print(f"  Avg magnitude diff: {r['avg_magnitude_diff']*100:.2f}%")

    # ── 2. Per-month correlation (e.g. May historical) ──
    print("\n═══ 2. Per-Month YoY Pairs (VNI) ═══")
    for m in range(1, 13):
        month_df = vni_monthly[vni_monthly["month"] == m]
        if len(month_df) >= 3:
            r = yoy_correlation(month_df, f"Month {m}")
            if r and r["n_pairs"] >= 3:
                print(f"  {m:02d}: corr={r['correlation']:+.3f} · dir_match={r['direction_match']*100:.0f}% · n={r['n_pairs']}")

    # ── 3. Per-stock YoY correlation (top 30 liquid) ──
    print("\n═══ 3. Per-Stock YoY Correlation (Top 30 liquid) ═══")
    # Top liquid bằng median turnover 2024-2025
    recent = universe[universe["date"] >= "2024-01-01"].copy()
    recent["turnover"] = recent["close"] * recent["volume"] * 1000
    liq = recent.groupby("symbol")["turnover"].median().sort_values(ascending=False)
    top30 = liq.head(30).index.tolist()

    correlations = []
    for sym in top30:
        s = universe[universe["symbol"] == sym][["date", "close"]].copy()
        if len(s) < 250:
            continue
        m = monthly_returns(s)
        r = yoy_correlation(m, sym)
        if r and r["n_pairs"] >= 5:
            correlations.append((sym, r))

    correlations.sort(key=lambda x: x[1]["correlation"], reverse=True)
    print(f"  {'Mã':<6} {'corr':>7} {'dir_match':>10} {'pairs':>6}")
    for sym, r in correlations:
        print(f"  {sym:<6} {r['correlation']:+.3f}   {r['direction_match']*100:5.1f}%      {r['n_pairs']:3d}")

    avg_cor = np.mean([r["correlation"] for _, r in correlations])
    avg_dir = np.mean([r["direction_match"] for _, r in correlations])
    print(f"\n  Avg correlation across top 30: {avg_cor:+.3f}")
    print(f"  Avg direction match: {avg_dir*100:.1f}%")

    # ── 4. Same-period 30-day return correlation ──
    print("\n═══ 4. VNI 30-day rolling return YoY ═══")
    vni = vni.sort_values("date").reset_index(drop=True)
    vni["ret_30d"] = vni["close"].pct_change(30)
    vni["ret_30d_ly"] = vni["ret_30d"].shift(252)  # ~ 1 year shift
    valid = vni.dropna(subset=["ret_30d", "ret_30d_ly"])
    if len(valid) > 30:
        cor = np.corrcoef(valid["ret_30d_ly"], valid["ret_30d"])[0, 1]
        dir_match = np.mean(np.sign(valid["ret_30d_ly"]) == np.sign(valid["ret_30d"]))
        print(f"  Pairs: {len(valid)}")
        print(f"  Correlation: {cor:+.3f}")
        print(f"  Direction match: {dir_match*100:.1f}%")

    # ── 5. Decision gate ──
    print("\n═══ DECISION GATE ═══")
    vni_overall = yoy_correlation(vni_monthly, "")
    if vni_overall is None:
        print("  Insufficient VNI data")
        return

    print(f"  VNI YoY correlation: {vni_overall['correlation']:+.3f}")
    print(f"  VNI dir match: {vni_overall['direction_match']*100:.1f}%")
    print(f"  Per-stock avg correlation: {avg_cor:+.3f}")
    print(f"  Per-stock avg dir match: {avg_dir*100:.1f}%")
    print()
    if vni_overall["correlation"] >= 0.3 and vni_overall["direction_match"] >= 0.6:
        print("  ✅ STRONG: Seasonal signal MẠNH. Build full system.")
    elif vni_overall["correlation"] >= 0.15 or vni_overall["direction_match"] >= 0.55:
        print("  🟡 WEAK: Seasonal có dấu vết nhưng yếu. Add as 1 feature thôi, không phải primary.")
    else:
        print("  ❌ NONE: Seasonal là NOISE. Skip per-stock layer. Pivot sang calendar events (Tết, earnings).")


if __name__ == "__main__":
    main()
