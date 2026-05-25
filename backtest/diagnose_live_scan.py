"""Diagnose live: tại sao app không sinh signal nào trong ~1 tháng qua?

Replicate production worker logic (Tier A/B/Premium + ATR adaptive + Foreign
flow filter) trên data 30 phiên gần nhất → xem:
1. Có mã nào match không?
2. Nếu KHÔNG match → near-miss analysis: mã nào thiếu chỉ 1 condition
3. Distribution của từng condition fail → biết knob nào strict nhất

Goal: phân biệt "production logic OK nhưng market quiet" vs "logic quá strict".
"""

import requests
import time
import numpy as np
import pandas as pd
from datetime import datetime
from collections import Counter

VND_URL = "https://dchart-api.vndirect.com.vn/dchart/history"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Origin": "https://dchart.vndirect.com.vn",
    "Referer": "https://dchart.vndirect.com.vn/",
}

# Same universe as verify_algo_vs_reality
LARGE_MID = [
    "HPG", "FPT", "SSI", "MWG", "STB", "VHM", "SHB", "VIX", "MSN", "VPB",
    "MBB", "TCB", "VND", "DIG", "VNM", "SHS", "CTG", "ACB", "DGC", "GEX",
    "HCM", "DXG", "VRE", "VCI", "GEL", "PDR", "HDB", "NVL", "EIB", "DBC",
    "TPB", "CEO", "KBC", "CII", "PVS", "VCB", "VCG", "VIC", "TCH", "PVD",
    "HAG", "DCM", "BID", "NKG", "GVR", "VIB", "KDH", "HAH", "GMD", "HSG",
    "LPB", "HDG", "MBS", "FTS", "HHV", "MSB", "DGW", "CTD", "IDC", "FRT",
    "DPM", "HDC", "GAS", "PLX", "VTP", "VHC", "PVT", "TCM", "PNJ", "SZC",
    "CTR", "ORS", "VGC", "REE", "HVN", "SAB", "SSB", "CTS", "CSV",
    "BCM", "KHG", "PAN", "HUT", "TNG", "KSB", "DPG", "ANV", "KDC",
    "BSI", "BCG", "CMG", "BVH", "OCB", "VDS", "IJC", "PET",
    "NTL", "SIP", "LCG", "DPR", "SBT", "VGS", "BMP", "GEE",
    "PHR", "AAA", "BVS", "BFC", "NAB", "AGR", "TIG", "SCR", "DXS",
    "SCS", "FCN", "ELC", "KOS", "LAS", "MCH", "NTP", "HQC", "PVC",
    "DCL", "DRC", "MST", "NHA", "GEG", "HAX",
    "GIL", "AGG", "DHC", "TLG", "BWE", "HPX", "PLC", "VCS",
    "PTB", "MSH", "ASM", "CTF", "SMC", "CSM", "SHI", "LDG",
    "TNH", "HTN", "LHG", "PAC", "VAB", "VPG", "MIG", "VTO",
    "TDC", "ITC", "DBD", "BMI", "TDP", "SGR", "CDC",
    "APH", "APG", "FIT", "PPC",
]

LOOKBACK_DAYS = 30


def fetch_history(symbol, days=600):
    to = int(time.time())
    fr = to - days * 24 * 3600
    url = f"{VND_URL}?resolution=D&symbol={symbol}&from={fr}&to={to}"
    try:
        r = requests.get(url, headers=HEADERS, timeout=10)
        r.raise_for_status()
        data = r.json()
        if data.get("s") != "ok":
            return None
        return {
            "t": np.array(data["t"]),
            "o": np.array(data["o"], dtype=float),
            "h": np.array(data["h"], dtype=float),
            "l": np.array(data["l"], dtype=float),
            "c": np.array(data["c"], dtype=float),
            "v": np.array(data["v"], dtype=float),
        }
    except Exception:
        return None


def calc_rsi(closes, idx, period=14):
    if idx < period:
        return None
    sl = closes[max(0, idx - 100):idx + 1]
    delta = np.diff(sl, prepend=sl[0])
    up = np.where(delta > 0, delta, 0)
    dn = np.where(delta < 0, -delta, 0)
    avg_up = np.mean(up[-period:])
    avg_dn = np.mean(dn[-period:])
    if avg_dn == 0:
        return 100.0
    return 100 - 100 / (1 + avg_up / avg_dn)


def calc_atr_pct(highs, lows, closes, idx, period=14):
    if idx < period:
        return None
    trs = []
    for i in range(idx - period + 1, idx + 1):
        tr = max(
            highs[i] - lows[i],
            abs(highs[i] - closes[i - 1]),
            abs(lows[i] - closes[i - 1]),
        )
        trs.append(tr)
    atr = np.mean(trs)
    return atr / closes[idx] * 100 if closes[idx] > 0 else None


def diagnose_one(d, idx):
    """Replicate detectVolClimaxBounce() từ worker.js. Returns dict per-condition."""
    c, o, h, l, v = d["c"], d["o"], d["h"], d["l"], d["v"]
    if idx < 25:
        return None

    # Turnover filter (median 20 phiên ≥ 3 tỷ)
    turnovers = c[idx - 21:idx - 1] * v[idx - 21:idx - 1] * 1000
    med_turn = np.median(turnovers)

    cur = c[idx]
    cur_open = o[idx]
    cur_vol = v[idx]
    prev3 = c[idx - 3]
    ret3d = (cur - prev3) / prev3 * 100
    vol_slice = v[idx - 21:idx - 1]
    vol_avg20 = np.mean(vol_slice)
    vol_ratio = cur_vol / vol_avg20 if vol_avg20 > 0 else 0
    day_green = cur > cur_open
    rsi = calc_rsi(c, idx, 14)
    atr_pct = calc_atr_pct(h, l, c, idx, 14)
    if rsi is None or atr_pct is None:
        return None

    drop_thresh_a = -3.0 * atr_pct  # K=3.0 from worker
    drop_thresh_b = -5.0

    # Tier A conditions
    cond_turn = med_turn >= 3e9
    cond_green = day_green
    cond_vol = vol_ratio > 2.0
    cond_tier_a_drop = ret3d < drop_thresh_a
    cond_tier_a_rsi = rsi < 35
    cond_tier_b_drop = ret3d < drop_thresh_b
    cond_tier_b_rsi = rsi < 50

    tier_a = cond_turn and cond_green and cond_vol and cond_tier_a_drop and cond_tier_a_rsi
    tier_b = cond_turn and cond_green and cond_vol and cond_tier_b_drop and cond_tier_b_rsi

    return {
        "cur": cur,
        "ret3d": ret3d,
        "vol_ratio": vol_ratio,
        "rsi": rsi,
        "atr_pct": atr_pct,
        "med_turn_bn": med_turn / 1e9,
        "day_green": day_green,
        "drop_thresh_a": drop_thresh_a,
        "tier_a": tier_a,
        "tier_b": tier_b,
        "cond": {
            "turn>=3B": cond_turn,
            "day_green": cond_green,
            "vol>2x": cond_vol,
            "drop<-K*ATR(A)": cond_tier_a_drop,
            "rsi<35(A)": cond_tier_a_rsi,
            "drop<-5%(B)": cond_tier_b_drop,
            "rsi<50(B)": cond_tier_b_rsi,
        },
    }


def main():
    print(f"Fetching {len(LARGE_MID)} mã...")
    histories = {}
    for sym in LARGE_MID:
        h = fetch_history(sym)
        if h is not None and len(h["c"]) >= 200:
            histories[sym] = h
    print(f"  {len(histories)} OK")

    ref = list(histories.values())[0]
    ref_dates = [datetime.fromtimestamp(t).date() for t in ref["t"]]
    test_dates = ref_dates[-LOOKBACK_DAYS:]
    print(f"Test {len(test_dates)} phiên: {test_dates[0]} → {test_dates[-1]}\n")

    # Per-day fire count
    daily_fires = {}
    # Tier B near-miss: pass all conds except 1
    near_miss_b = []
    # Cond fail distribution per day
    cond_fail_counter = Counter()

    for tgt_date in test_dates:
        a_count, b_count = 0, 0
        for sym, d in histories.items():
            dates = [datetime.fromtimestamp(t).date() for t in d["t"]]
            try:
                idx = dates.index(tgt_date)
            except ValueError:
                continue
            r = diagnose_one(d, idx)
            if r is None:
                continue
            if r["tier_a"]:
                a_count += 1
            if r["tier_b"]:
                b_count += 1

            # Tier B near-miss: pass turn + green + drop_b + rsi_b but miss vol
            #                   hoặc pass all except 1 of those
            conds_b = [
                r["cond"]["turn>=3B"],
                r["cond"]["day_green"],
                r["cond"]["vol>2x"],
                r["cond"]["drop<-5%(B)"],
                r["cond"]["rsi<50(B)"],
            ]
            n_pass = sum(conds_b)
            if n_pass == 4:  # Near-miss
                # Identify missed condition
                names = ["turn", "green", "vol", "drop", "rsi"]
                missed = next(names[i] for i, v in enumerate(conds_b) if not v)
                near_miss_b.append({
                    "date": str(tgt_date), "sym": sym, "missed": missed,
                    "ret3d": r["ret3d"], "vol_ratio": r["vol_ratio"],
                    "rsi": r["rsi"], "med_turn_bn": r["med_turn_bn"],
                    "day_green": r["day_green"],
                })
                cond_fail_counter[missed] += 1

        daily_fires[str(tgt_date)] = {"A": a_count, "B": b_count}

    print("═══ Daily fire count (Tier A / Tier B) trong 30 phiên ═══")
    total_a, total_b = 0, 0
    for date, counts in daily_fires.items():
        total_a += counts["A"]
        total_b += counts["B"]
        if counts["A"] + counts["B"] > 0:
            print(f"  {date}: A={counts['A']} B={counts['B']}")
    print(f"\n  Total fires: A={total_a}, B={total_b}")
    print(f"  Days với 0 fire: {sum(1 for c in daily_fires.values() if c['A']+c['B']==0)}/{len(daily_fires)}")

    print(f"\n═══ Tier B Near-Miss (n={len(near_miss_b)}, thiếu chỉ 1 condition) ═══")
    print(f"  Distribution của condition bị thiếu:")
    for cond, n in cond_fail_counter.most_common():
        pct = n / len(near_miss_b) * 100 if near_miss_b else 0
        print(f"    {cond:<10} {n:4d} ({pct:.0f}%)")

    print(f"\n  Top 15 near-miss recent (3-condition pass + close):")
    if near_miss_b:
        df = pd.DataFrame(near_miss_b)
        df = df.sort_values("date", ascending=False)
        print(df.head(15).to_string(index=False))


if __name__ == "__main__":
    main()
