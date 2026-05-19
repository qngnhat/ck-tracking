"""Đối chiếu thuật toán với thực tế thị trường.

Phương pháp:
1. Fetch live VND cho 199 mã LARGE_MID
2. Tìm "actual winners" trong 20 phiên gần nhất:
   - Mỗi mã, mỗi phiên T, check return T+1 → T+4 (3 phiên hold)
   - Mã nào gained >= 5% trong 3 phiên = winner
3. Check: tại phiên T, thuật toán nào trong (Tier A/B/Mom) signal mã đó?
4. False negative analysis: mã winner mà KHÔNG signal — chúng có pattern gì chung?
5. True positive: mã signal MÀ winner thật → success rate
6. False positive: mã signal nhưng lose → fail rate

Output: precision + recall của thuật toán vs reality.
"""

import requests
import time
import numpy as np
import pandas as pd
from datetime import datetime
from collections import defaultdict

VND_URL = "https://dchart-api.vndirect.com.vn/dchart/history"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
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

# T+ convention VN: signal day = T+0, entry mua open T+1, sớm nhất bán T+3.
# Winner định nghĩa: tại bất kỳ phiên T+3/T+4/T+5 close >= entry × (1 + threshold)
# → user có thể chốt lời theo plan (GTD limit order target).
WIN_THRESHOLD = 0.03  # close ≥ entry × 1.03 = +3% gross = production target
MIN_HOLD = 3          # T+3 = ngày sớm nhất bán
MAX_HOLD = 5          # T+5 = force exit theo plan
LOOKBACK_DAYS = 20    # Test 20 phiên gần nhất


def fetch_history(symbol, days=600):  # need 200+ bars history + 20 lookback + 5 forward
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
    if idx < period: return None
    sl = closes[max(0, idx - 100):idx + 1]
    delta = np.diff(sl, prepend=sl[0])
    up = np.where(delta > 0, delta, 0)
    dn = np.where(delta < 0, -delta, 0)
    avg_up = np.mean(up[-period:])
    avg_dn = np.mean(dn[-period:])
    if avg_dn == 0: return 100.0
    return 100 - 100 / (1 + avg_up / avg_dn)


def detect_signals(d, idx):
    """Return dict of signals at bar idx."""
    c, o, h, l, v = d["c"], d["o"], d["h"], d["l"], d["v"]
    if idx < 200: return None

    cur, cur_open, cur_high, cur_low, cur_vol = c[idx], o[idx], h[idx], l[idx], v[idx]
    turnovers = c[idx-21:idx-1] * v[idx-21:idx-1] * 1000
    median_turnover = np.median(turnovers)
    if median_turnover < 3e9: return None

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
    ret5d = (cur - c[idx-5]) / c[idx-5] if idx >= 5 else 0

    base_clx = day_green and vol_ratio > 2.0
    tier_a = base_clx and ret3d < -0.07 and rsi < 35
    tier_b = base_clx and ret3d < -0.05 and rsi < 50
    uptrend = ma5 > ma20 > ma50 > ma200
    mom_12 = uptrend and range_pct < 0.025 and vol_ratio > 1.2 and day_green and 50 < rsi < 70

    return {
        "tier_a": tier_a, "tier_b": tier_b, "mom_12": mom_12,
        "any_signal": tier_a or tier_b or mom_12,
        # Features cho phân tích false negative
        "uptrend": uptrend, "ret3d": ret3d, "ret5d": ret5d,
        "vol_ratio": vol_ratio, "rsi": rsi, "range_pct": range_pct,
        "day_green": day_green, "cur": cur,
        "ma5": ma5, "ma20": ma20, "ma50": ma50,
    }


def main():
    print(f"Fetching {len(LARGE_MID_UNIVERSE)} mã...")
    histories = {}
    for sym in LARGE_MID_UNIVERSE:
        h = fetch_history(sym)
        if h is not None and len(h["c"]) >= 200:
            histories[sym] = h
    print(f"  {len(histories)} OK\n")

    # Reference date list (FPT)
    ref = histories.get("FPT")
    ref_dates = [datetime.fromtimestamp(t).date() for t in ref["t"]]
    test_dates = ref_dates[-(LOOKBACK_DAYS + MAX_HOLD + 1):-(MAX_HOLD + 1)]  # Cần MAX_HOLD bars sau

    print(f"Test {len(test_dates)} phiên: {test_dates[0]} → {test_dates[-1]}")
    print(f"  Winner = max(close T+{MIN_HOLD}..T+{MAX_HOLD}) / open T+1 >= 1+{WIN_THRESHOLD*100:.0f}%")
    print(f"  (mã có thể chốt lời theo plan GTD limit order)\n")

    # Per signal type: counts
    stats = defaultdict(lambda: {"signals": 0, "wins": 0})  # by sig_type
    confusion = {"TP": 0, "FP": 0, "FN": 0, "TN": 0}  # signal any × winner
    fn_features = []  # mã winner mà NO signal

    for tgt_date in test_dates:
        for sym, d in histories.items():
            dates = [datetime.fromtimestamp(t).date() for t in d["t"]]
            try:
                idx = dates.index(tgt_date)
            except ValueError:
                continue
            if idx + MAX_HOLD + 1 >= len(d["c"]): continue
            r = detect_signals(d, idx)
            if r is None: continue

            # T+ convention: entry open T+1 (= idx+1), check close T+3..T+5
            entry_price = d["o"][idx + 1]
            if entry_price <= 0: continue
            # Best close trong window T+3 → T+5 (sớm nhất bán → force exit)
            window_closes = d["c"][idx + 1 + MIN_HOLD : idx + 1 + MAX_HOLD + 1]
            if len(window_closes) == 0: continue
            best_close = window_closes.max()
            best_close_day_offset = MIN_HOLD + int(np.argmax(window_closes))  # 3, 4, or 5
            actual_ret = (best_close - entry_price) / entry_price
            winner = actual_ret >= WIN_THRESHOLD
            # Cũng track close cuối kỳ (force exit T+5) cho "realistic exit"
            t5_close = d["c"][idx + 1 + MAX_HOLD]
            realistic_ret = (t5_close - entry_price) / entry_price

            # Per-signal accuracy
            for sig_type in ["tier_a", "tier_b", "mom_12"]:
                if r[sig_type]:
                    stats[sig_type]["signals"] += 1
                    if winner: stats[sig_type]["wins"] += 1

            # Confusion matrix
            if r["any_signal"] and winner:
                confusion["TP"] += 1
            elif r["any_signal"] and not winner:
                confusion["FP"] += 1
            elif not r["any_signal"] and winner:
                confusion["FN"] += 1
                fn_features.append({
                    "symbol": sym, "date": str(tgt_date),
                    "best_ret": actual_ret * 100,
                    "best_day": f"T+{best_close_day_offset}",
                    "t5_ret": realistic_ret * 100,
                    "vol_ratio": r["vol_ratio"], "rsi": r["rsi"],
                    "ret3d": r["ret3d"] * 100, "ret5d": r["ret5d"] * 100,
                    "range_pct": r["range_pct"] * 100,
                    "uptrend": r["uptrend"], "day_green": r["day_green"],
                })
            else:
                confusion["TN"] += 1

    # ── Report ──
    print("═══ Confusion Matrix (any signal × actual winner ≥5% in 3 phiên) ═══")
    total = sum(confusion.values())
    print(f"  TP (signal + winner):  {confusion['TP']}")
    print(f"  FP (signal + loser):   {confusion['FP']}")
    print(f"  FN (NO signal + winner): {confusion['FN']}")
    print(f"  TN (NO signal + non-winner): {confusion['TN']}")
    print(f"  Total bars checked: {total}")

    precision = confusion["TP"] / (confusion["TP"] + confusion["FP"]) if (confusion["TP"] + confusion["FP"]) > 0 else 0
    recall = confusion["TP"] / (confusion["TP"] + confusion["FN"]) if (confusion["TP"] + confusion["FN"]) > 0 else 0
    print(f"\n  Precision (% signal đúng): {precision*100:.1f}% — {confusion['TP']}/{confusion['TP']+confusion['FP']}")
    print(f"  Recall (% winner mà ta catch): {recall*100:.1f}% — {confusion['TP']}/{confusion['TP']+confusion['FN']}")

    # Per-signal accuracy
    print("\n═══ Per-signal hit rate (signal → winner ≥5%) ═══")
    for sig_type, s in stats.items():
        if s["signals"] > 0:
            rate = s["wins"] / s["signals"] * 100
            print(f"  {sig_type:<12} {s['signals']} signals, {s['wins']} wins ({rate:.1f}%)")
        else:
            print(f"  {sig_type:<12} 0 signals")

    # False negative analysis
    if fn_features:
        df = pd.DataFrame(fn_features)
        df_sorted = df.sort_values("best_ret", ascending=False)
        print(f"\n═══ Top 20 MISSED winners (algo không signal — best close T+3..T+5) ═══")
        print(df_sorted.head(20).to_string(index=False))

        print(f"\n═══ Đặc điểm missed winners (n={len(df)}) ═══")
        print(f"  Uptrend stack: {df['uptrend'].mean()*100:.1f}%")
        print(f"  Day green: {df['day_green'].mean()*100:.1f}%")
        print(f"  Avg vol_ratio: {df['vol_ratio'].mean():.2f}× (median {df['vol_ratio'].median():.2f})")
        print(f"  Avg RSI: {df['rsi'].mean():.1f} (median {df['rsi'].median():.1f})")
        print(f"  Avg ret3d: {df['ret3d'].mean():.2f}%")
        print(f"  Avg ret5d: {df['ret5d'].mean():.2f}%")
        print(f"  Avg range: {df['range_pct'].mean():.2f}%")
        print(f"  Avg best_ret T+3..T+5: {df['best_ret'].mean():.2f}%")
        print(f"  Avg t5_ret (force exit T+5): {df['t5_ret'].mean():.2f}%")
        print(f"  Best day distribution:")
        print(df["best_day"].value_counts().to_string())
        print(f"\n  Vol distribution của missed winners:")
        for thresh in [0.5, 1.0, 1.2, 1.5, 2.0]:
            pct = (df['vol_ratio'] > thresh).mean() * 100
            print(f"    vol > {thresh}: {pct:.1f}%")


if __name__ == "__main__":
    main()
