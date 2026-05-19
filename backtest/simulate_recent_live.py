"""Mô phỏng scan các phiên 14-18/05 (data live, không có trong cache).

Fetch live VND cho 199 mã LARGE_MID universe, đếm signal per day.
"""

import requests
import time
import numpy as np
import pandas as pd
from datetime import datetime, date

VND_URL = "https://dchart-api.vndirect.com.vn/dchart/history"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9,vi;q=0.8",
    "Origin": "https://dchart.vndirect.com.vn",
    "Referer": "https://dchart.vndirect.com.vn/",
}

LARGE_MID_UNIVERSE = [
    "HPG", "FPT", "SSI", "MWG", "STB", "VHM", "SHB", "VIX", "MSN", "VPB",
    "MBB", "TCB", "VND", "DIG", "VNM", "SHS", "CTG", "ACB", "DGC", "GEX",
    "HCM", "DXG", "VRE", "VCI", "GEL", "PDR", "HDB", "NVL", "EIB", "DBC",
    "TPB", "CEO", "KBC", "CII", "PVS", "VCB", "VCG", "VIC", "TCH", "PVD",
    "HAG", "DCM", "BID", "NKG", "GVR", "VIB", "KDH", "HAH", "GMD", "HSG",
    "TCX", "VCK", "VJC", "VPI", "POW", "VSC", "NLG", "EVF", "BAF", "BSR",
    "LPB", "HDG", "MBS", "FTS", "HHV", "MSB", "DGW", "CTD", "IDC", "FRT",
    "DPM", "HDC", "GAS", "PLX", "VTP", "VHC", "PVT", "TCM", "PNJ", "SZC",
    "CTR", "ORS", "VGC", "REE", "VPL", "HVN", "SAB", "SSB", "CTS", "CSV",
    "VPX", "BCM", "KHG", "PAN", "HUT", "TNG", "KSB", "DPG", "ANV", "KDC",
    "BSI", "BCG", "CMG", "BVH", "OCB", "VDS", "IJC", "VOS", "HHS", "PET",
    "NTL", "SIP", "LCG", "DPR", "SBT", "VTZ", "VGS", "BMP", "YEG", "GEE",
    "PHR", "AAA", "BVS", "BFC", "VFS", "NAB", "AGR", "TIG", "SCR", "DXS",
    "SCS", "FCN", "ELC", "KOS", "LAS", "MCH", "NTP", "HQC", "PVC", "DTD",
    "CTI", "DCL", "DRC", "MST", "NHA", "GEG", "QCG", "HAX", "EVG", "DSE",
    "GIL", "AGG", "DHC", "TLG", "BWE", "HPX", "PLC", "NAF", "IDI", "VCS",
    "PTB", "MSH", "ASM", "CTF", "SMC", "CSM", "PVB", "SHI", "TTA", "LDG",
    "TNH", "IDJ", "HTN", "LHG", "PAC", "VAB", "VPG", "PVP", "MIG", "VTO",
    "TDC", "ITC", "TRC", "DBD", "HPA", "BMI", "KSV", "TDP", "SGR", "CDC",
    "APH", "APG", "FIT", "PPC", "NAG", "NRC", "APS", "DLG", "AAV",
]


def fetch_history(symbol, days=300):
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


def calc_rsi_at(closes, idx, period=14):
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


def detect_at(d, idx):
    """Compute features for bar idx, return dict for both Climax and Momentum."""
    c, o, h, l, v = d["c"], d["o"], d["h"], d["l"], d["v"]
    if idx < 200:
        return None

    cur = c[idx]; cur_open = o[idx]; cur_high = h[idx]; cur_low = l[idx]; cur_vol = v[idx]

    # Turnover
    turnovers = c[idx-21:idx-1] * v[idx-21:idx-1] * 1000
    median_turnover = np.median(turnovers)
    if median_turnover < 3e9:
        return None

    ma5 = np.mean(c[idx-4:idx+1])
    ma20 = np.mean(c[idx-19:idx+1])
    ma50 = np.mean(c[idx-49:idx+1])
    ma200 = np.mean(c[idx-199:idx+1])
    rsi = calc_rsi_at(c, idx)
    if rsi is None: return None

    vol_avg20 = np.mean(v[idx-21:idx-1])
    vol_ratio = cur_vol / vol_avg20 if vol_avg20 > 0 else 0
    range_pct = (cur_high - cur_low) / cur if cur > 0 else 0
    day_green = cur > cur_open
    prev3 = c[idx-3]
    ret3d = (cur - prev3) / prev3

    # Climax detection
    base_clx = day_green and vol_ratio > 2.0
    tier_a = base_clx and ret3d < -0.07 and rsi < 35
    tier_b = base_clx and ret3d < -0.05 and rsi < 50

    # Momentum variants
    uptrend = ma5 > ma20 > ma50 > ma200
    uptrend_mid = c[idx] > ma20 and ma20 > ma50  # softer (no MA200)
    mom_15 = uptrend and range_pct < 0.025 and vol_ratio > 1.5 and day_green and 50 < rsi < 70
    mom_12 = uptrend and range_pct < 0.025 and vol_ratio > 1.2 and day_green and 50 < rsi < 70
    mom_10 = uptrend and range_pct < 0.025 and vol_ratio > 1.0 and day_green and 50 < rsi < 70
    # Variant v7: dropped MA200, range 3.5%, vol 1.2, RSI<75
    mom_v7 = uptrend_mid and range_pct < 0.035 and vol_ratio > 1.2 and day_green and 50 < rsi < 75
    # Even more aggressive: just uptrend_mid + green + RSI 50-75
    mom_loose = uptrend_mid and day_green and 50 < rsi < 75

    return {
        "tier_a": tier_a, "tier_b": tier_b,
        "mom_15": mom_15, "mom_12": mom_12, "mom_10": mom_10,
        "mom_v7": mom_v7, "mom_loose": mom_loose,
        "uptrend": uptrend, "uptrend_mid": uptrend_mid,
        "ret3d_pct": ret3d * 100,
        "vol_ratio": vol_ratio, "rsi": rsi, "range_pct": range_pct * 100,
        "ma5": ma5, "ma20": ma20, "ma50": ma50, "ma200": ma200,
        "cur": cur, "day_green": day_green,
    }


def main():
    print(f"Fetching {len(LARGE_MID_UNIVERSE)} mã (live VND, ~3-4 phút)...\n")

    histories = {}
    for i, sym in enumerate(LARGE_MID_UNIVERSE):
        h = fetch_history(sym)
        if h is not None and len(h["c"]) >= 200:
            histories[sym] = h
        if (i + 1) % 30 == 0:
            print(f"  {i+1}/{len(LARGE_MID_UNIVERSE)} ({len(histories)} ok)")
    print(f"  Total fetched ok: {len(histories)}\n")

    # Find last 10 trading days available across symbols (take from FPT as reference)
    ref = histories.get("FPT")
    if ref is None:
        print("Cannot get reference dates")
        return
    ref_dates = [datetime.fromtimestamp(t).date() for t in ref["t"]]
    last_10 = ref_dates[-10:]
    print(f"Test {len(last_10)} phiên gần nhất: {last_10[0]} → {last_10[-1]}\n")

    print(f"{'Date':<12} {'TierA':>5} {'TierB':>5} {'M1.5':>5} {'M1.2':>5} {'M1.0':>5} {'v7':>5} {'loose':>5} {'UT':>4} {'UTmid':>5}")
    print("-" * 75)

    matches_log = {}
    for tgt_date in last_10:
        cnt = {k: 0 for k in ["tier_a","tier_b","mom_15","mom_12","mom_10","mom_v7","mom_loose","uptrend","uptrend_mid"]}
        day_matches = {k: [] for k in ["tier_a","tier_b","mom_15","mom_12","mom_v7","mom_loose"]}
        for sym, d in histories.items():
            dates = [datetime.fromtimestamp(t).date() for t in d["t"]]
            try:
                idx = dates.index(tgt_date)
            except ValueError:
                continue
            r = detect_at(d, idx)
            if r is None:
                continue
            for k in cnt:
                if r.get(k): cnt[k] += 1
            for k in day_matches:
                if r.get(k): day_matches[k].append((sym, r))
        matches_log[tgt_date] = day_matches
        print(f"{str(tgt_date):<12} {cnt['tier_a']:>5} {cnt['tier_b']:>5} {cnt['mom_15']:>5} {cnt['mom_12']:>5} {cnt['mom_10']:>5} {cnt['mom_v7']:>5} {cnt['mom_loose']:>5} {cnt['uptrend']:>4} {cnt['uptrend_mid']:>5}")

    # Detail last 3 days với matches
    print("\n=== Chi tiết picks 3 phiên cuối ===")
    for tgt_date in last_10[-3:]:
        print(f"\n--- {tgt_date} ---")
        dm = matches_log[tgt_date]
        for label, key in [("Climax Tier A", "tier_a"), ("Climax Tier B", "tier_b"),
                            ("Mom v1.5 (old)", "mom_15"), ("Mom v1.2 (NEW)", "mom_12"),
                            ("Mom v7 relax (vol>1.2, range<3.5, mid uptrend, RSI<75)", "mom_v7"),
                            ("Mom loose (uptrend_mid + green + RSI 50-75)", "mom_loose")]:
            if dm[key]:
                print(f"  {label}: {len(dm[key])} mã")
                for sym, r in dm[key][:10]:
                    print(f"    {sym}: close={r['cur']:.2f} · vol={r['vol_ratio']:.2f}× · RSI={r['rsi']:.0f} · range={r['range_pct']:.1f}% · ret3={r['ret3d_pct']:.1f}%")


if __name__ == "__main__":
    main()
