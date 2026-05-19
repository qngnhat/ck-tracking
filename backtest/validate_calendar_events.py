"""Phase 1A — Test calendar events có statistical effect không.

Test:
1. Tết effect: 2 tuần trước Tết → 2 tuần sau (cycle Jan-Feb biến đổi mỗi năm)
2. Earnings season: Apr, Jul, Oct, Jan có VNI behavior khác bình thường không?
3. Day-of-week effect: thứ 2 vs thứ 6
4. End-of-month vs start-of-month
5. Vol pattern theo tháng (vol cuối năm tăng?)

Output: identify event nào có effect rõ ràng → dùng làm feature.
"""

from __future__ import annotations
import numpy as np
import pandas as pd
from src.load_data import load_universe

# Tết dates by year (Vietnamese Lunar New Year, ngày mùng 1)
# Source: https://en.wikipedia.org/wiki/Lunar_New_Year
TET_DATES = {
    2018: "2018-02-16",
    2019: "2019-02-05",
    2020: "2020-01-25",
    2021: "2021-02-12",
    2022: "2022-02-01",
    2023: "2023-01-22",
    2024: "2024-02-10",
    2025: "2025-01-29",
    2026: "2026-02-17",
}

EARNINGS_MONTHS = [1, 4, 7, 10]  # Q4 prev year reports in Jan, then Q1/Q2/Q3


def load_vnindex():
    df = pd.read_parquet("data/vnindex.parquet")
    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values("date").reset_index(drop=True)
    df["ret_1d"] = df["close"].pct_change(1)
    df["ret_5d"] = df["close"].pct_change(5)
    df["dow"] = df["date"].dt.dayofweek
    df["month"] = df["date"].dt.month
    df["year"] = df["date"].dt.year
    df["day_of_month"] = df["date"].dt.day
    return df


def main():
    print("Load VNI + universe...")
    vni = load_vnindex()
    universe = load_universe()
    universe["date"] = pd.to_datetime(universe["date"])

    # ── 1. Tết effect ──
    print("\n═══ 1. Tết effect ═══")
    print("  Phân tích: 10 phiên trước Tết → 10 phiên sau\n")
    pre_tet_rets = []
    post_tet_rets = []
    pre_tet_dates = []
    post_tet_dates = []
    for year, tet_str in TET_DATES.items():
        tet = pd.to_datetime(tet_str)
        pre_start = tet - pd.Timedelta(days=20)
        pre_end = tet - pd.Timedelta(days=1)
        post_start = tet + pd.Timedelta(days=1)
        post_end = tet + pd.Timedelta(days=20)

        pre = vni[(vni["date"] >= pre_start) & (vni["date"] < pre_end)]
        post = vni[(vni["date"] > post_start) & (vni["date"] <= post_end)]

        if len(pre) > 0 and len(post) > 0:
            pre_ret = (pre["close"].iloc[-1] - pre["close"].iloc[0]) / pre["close"].iloc[0]
            post_ret = (post["close"].iloc[-1] - post["close"].iloc[0]) / post["close"].iloc[0]
            pre_tet_rets.append(pre_ret)
            post_tet_rets.append(post_ret)
            pre_tet_dates.append(year)
            post_tet_dates.append(year)
            print(f"  {year} Tết {tet_str}: pre={pre_ret*100:+.2f}% · post={post_ret*100:+.2f}%")

    print(f"\n  Avg pre-Tết (~10 phiên trước): {np.mean(pre_tet_rets)*100:+.2f}%")
    print(f"  Avg post-Tết (~10 phiên sau): {np.mean(post_tet_rets)*100:+.2f}%")
    print(f"  Pre-Tết +ve rate: {np.mean([r > 0 for r in pre_tet_rets])*100:.0f}%")
    print(f"  Post-Tết +ve rate: {np.mean([r > 0 for r in post_tet_rets])*100:.0f}%")

    # ── 2. Monthly mean returns ──
    print("\n═══ 2. Monthly VNI Return Stats (2018-2026) ═══")
    print(f"  {'Month':<6} {'avg ret':>9} {'+ve rate':>10} {'std':>7} {'samples':>9}")
    for m in range(1, 13):
        month_rets = []
        for year in range(2018, 2027):
            month_df = vni[(vni["year"] == year) & (vni["month"] == m)]
            if len(month_df) > 0:
                start = month_df["close"].iloc[0]
                end = month_df["close"].iloc[-1]
                ret = (end - start) / start
                month_rets.append(ret)
        if month_rets:
            avg = np.mean(month_rets)
            pos_rate = np.mean([r > 0 for r in month_rets])
            std = np.std(month_rets)
            event = ""
            if m in EARNINGS_MONTHS:
                event = " ← earnings"
            if m in [1, 2]:
                event += " ← Tết"
            print(f"  {m:02d}      {avg*100:+6.2f}%      {pos_rate*100:5.1f}%    {std*100:5.2f}%       {len(month_rets):2d}{event}")

    # ── 3. Day of week ──
    print("\n═══ 3. Day of Week (VNI daily return) ═══")
    print(f"  {'DOW':<8} {'avg ret':>9} {'+ve rate':>10} {'samples':>9}")
    dow_names = ["Mon", "Tue", "Wed", "Thu", "Fri"]
    for d in range(5):
        day_df = vni[vni["dow"] == d].dropna(subset=["ret_1d"])
        if len(day_df) > 0:
            avg = day_df["ret_1d"].mean()
            pos = (day_df["ret_1d"] > 0).mean()
            print(f"  {dow_names[d]:<8} {avg*100:+6.3f}%      {pos*100:5.1f}%       {len(day_df):4d}")

    # ── 4. Earnings months drill-down ──
    print("\n═══ 4. Earnings season (M1, M4, M7, M10) vs others ═══")
    vni_clean = vni.dropna(subset=["ret_5d"])
    is_earn = vni_clean["month"].isin(EARNINGS_MONTHS)
    earn_ret = vni_clean.loc[is_earn, "ret_5d"]
    non_earn_ret = vni_clean.loc[~is_earn, "ret_5d"]
    print(f"  Earnings months 5d return: avg {earn_ret.mean()*100:+.3f}%, std {earn_ret.std()*100:.2f}%, +ve {(earn_ret>0).mean()*100:.1f}%, n={len(earn_ret)}")
    print(f"  Other months 5d return: avg {non_earn_ret.mean()*100:+.3f}%, std {non_earn_ret.std()*100:.2f}%, +ve {(non_earn_ret>0).mean()*100:.1f}%, n={len(non_earn_ret)}")

    # ── 5. Day of month ──
    print("\n═══ 5. Day of Month buckets (1-7, 8-14, 15-21, 22-31) ═══")
    for lo, hi, label in [(1,7,"Start"), (8,14,"Mid-early"), (15,21,"Mid-late"), (22,31,"End")]:
        bucket = vni.loc[(vni["day_of_month"] >= lo) & (vni["day_of_month"] <= hi)].dropna(subset=["ret_1d"])
        if len(bucket) > 0:
            avg = bucket["ret_1d"].mean()
            pos = (bucket["ret_1d"] > 0).mean()
            print(f"  {label:<12} ({lo:>2}-{hi:>2}): avg {avg*100:+.3f}% · +ve {pos*100:.1f}% · n={len(bucket)}")

    # ── 6. Effect significance test ──
    print("\n═══ DECISION GATE ═══")
    print("  Effect mạnh nếu:")
    print("    - Diff trung bình between groups > 0.3% AND")
    print("    - +ve rate diff > 5 percentage points")
    print()

    # Tết
    pre_pos = np.mean([r > 0 for r in pre_tet_rets]) * 100
    post_pos = np.mean([r > 0 for r in post_tet_rets]) * 100
    print(f"  TẾT pre vs post:")
    print(f"    Pre-Tết: {np.mean(pre_tet_rets)*100:+.2f}% avg, {pre_pos:.0f}% positive")
    print(f"    Post-Tết: {np.mean(post_tet_rets)*100:+.2f}% avg, {post_pos:.0f}% positive")
    print(f"    → {'STRONG' if abs(np.mean(post_tet_rets) - np.mean(pre_tet_rets)) > 0.03 else 'WEAK'}")


if __name__ == "__main__":
    main()
