"""Audit Tier Momentum filter — đo cái nào kill nhiều mã nhất.

Pattern Strength Continuation cần TẤT CẢ:
1. n ≥ 200 daily bars (history dài)
2. median turnover ≥ 3 tỷ/ngày
3. MA5 > MA20 > MA50 > MA200 (perfect uptrend stack)
4. range_pct hôm nay < 2.5%
5. vol_ratio > 1.5×
6. close > open (green)
7. RSI 50-70

Audit: bao nhiêu mã pass mỗi điều kiện đơn lẻ, và pass cumulative.
"""

import requests
import time
import numpy as np
import pandas as pd
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

VND_URL = "https://dchart-api.vndirect.com.vn/dchart/history"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9,vi;q=0.8",
    "Origin": "https://dchart.vndirect.com.vn",
    "Referer": "https://dchart.vndirect.com.vn/",
}

def fetch(symbol, days=300):
    to = int(time.time())
    fr = to - days * 24 * 3600
    url = f"{VND_URL}?resolution=D&symbol={symbol}&from={fr}&to={to}"
    r = requests.get(url, headers=HEADERS, timeout=10)
    r.raise_for_status()
    data = r.json()
    if data.get("s") != "ok":
        return None
    return {
        "o": np.array(data["o"], dtype=float),
        "h": np.array(data["h"], dtype=float),
        "l": np.array(data["l"], dtype=float),
        "c": np.array(data["c"], dtype=float),
        "v": np.array(data["v"], dtype=float),
    }


def calc_rsi(closes, period=14):
    delta = np.diff(closes, prepend=closes[0])
    up = np.where(delta > 0, delta, 0)
    dn = np.where(delta < 0, -delta, 0)
    avg_up = np.mean(up[-period:])
    avg_dn = np.mean(dn[-period:])
    if avg_dn == 0:
        return 100.0
    return 100 - 100 / (1 + avg_up / avg_dn)


def audit(symbol):
    """Trả về dict với từng condition + giá trị."""
    try:
        d = fetch(symbol)
    except Exception as e:
        return None
    if d is None or len(d["c"]) < 200:
        return {"symbol": symbol, "fail_history": True}

    c, o, h, l, v = d["c"], d["o"], d["h"], d["l"], d["v"]
    n = len(c)
    cur, cur_open, cur_high, cur_low, cur_vol = c[-1], o[-1], h[-1], l[-1], v[-1]

    # Turnover
    turnovers = c[-21:-1] * v[-21:-1] * 1000
    median_turnover = np.median(turnovers)

    # MAs
    ma5 = np.mean(c[-5:])
    ma20 = np.mean(c[-20:])
    ma50 = np.mean(c[-50:])
    ma200 = np.mean(c[-200:])

    range_pct = (cur_high - cur_low) / cur

    vol_avg20 = np.mean(v[-21:-1])
    vol_ratio = cur_vol / vol_avg20 if vol_avg20 > 0 else 0
    green = cur > cur_open
    rsi = calc_rsi(c, 14)

    cond = {
        "symbol": symbol,
        "cur": cur,
        "history_ok": True,
        "turnover_ok": median_turnover >= 3e9,
        "median_turnover_bn": median_turnover / 1e9,
        "ma_stack_ok": ma5 > ma20 > ma50 > ma200,
        "ma5": ma5, "ma20": ma20, "ma50": ma50, "ma200": ma200,
        "range_ok": range_pct < 0.025,
        "range_pct": range_pct * 100,
        "vol_ok": vol_ratio > 1.5,
        "vol_ratio": vol_ratio,
        "green_ok": green,
        "rsi_ok": 50 < rsi < 70,
        "rsi": rsi,
    }
    return cond


def main():
    # Load FULL_UNIVERSE (1411 mã) — đọc từ worker hoặc cache
    # Quick: dùng top 200 mã liquid để audit nhanh, kết luận generalize
    SAMPLE = [
        # VN30
        "ACB", "BCM", "BID", "BVH", "CTG", "FPT", "GAS", "GVR", "HDB", "HPG",
        "MBB", "MSN", "MWG", "NVL", "PLX", "POW", "SAB", "SHB", "SSB", "SSI",
        "STB", "TCB", "TPB", "VCB", "VHM", "VIC", "VIB", "VJC", "VNM", "VPB", "VRE",
        # Mid-cap liquid
        "DGC", "DCM", "DPM", "DXG", "DIG", "GEX", "HAH", "HSG", "KBC", "KDH",
        "NLG", "PVD", "PVS", "REE", "VCG", "VCI", "VND", "VIX", "VPI", "HCM",
        "CTR", "EIB", "GMD", "HHV", "HT1", "IDC", "LPB", "MSB", "NKG", "OCB",
        "PDR", "PNJ", "SBT", "SHS", "TLG", "VPG", "BCG", "BSI", "BVB", "CCL",
        "CTD", "CTI", "DBC", "DGW", "DHG", "EVF", "FCN", "FRT", "GEG", "HAG",
        "HDC", "HUT", "ITA", "KSB", "LCG", "LDG", "NTL", "PC1", "PVT", "QCG",
        "SAM", "SIP", "SZC", "TCH", "TCM", "TIP", "TNH", "VOS", "VPS", "ANV",
    ]

    print(f"Audit {len(SAMPLE)} mã Large+Mid cap...\n")

    results = []
    for sym in SAMPLE:
        r = audit(sym)
        if r is not None:
            results.append(r)

    df = pd.DataFrame(results)
    print(f"Tổng fetch ok: {len(df)} mã\n")

    # Counts cho mỗi condition
    print("═══ Per-condition pass rate ═══")
    conds = ["turnover_ok", "ma_stack_ok", "range_ok", "vol_ok", "green_ok", "rsi_ok"]
    for c in conds:
        if c in df.columns:
            pass_n = df[c].sum()
            print(f"  {c:<18} {pass_n}/{len(df)} ({pass_n/len(df)*100:.1f}%)")

    # Cumulative
    print("\n═══ Cumulative pass (AND) ═══")
    cum = df.copy()
    cum["c1"] = cum["turnover_ok"]
    cum["c2"] = cum["c1"] & cum["ma_stack_ok"]
    cum["c3"] = cum["c2"] & cum["range_ok"]
    cum["c4"] = cum["c3"] & cum["vol_ok"]
    cum["c5"] = cum["c4"] & cum["green_ok"]
    cum["c6"] = cum["c5"] & cum["rsi_ok"]
    for i, label in enumerate([
        "+ turnover",
        "+ MA5>MA20>MA50>MA200",
        "+ range < 2.5%",
        "+ vol > 1.5×",
        "+ green (close>open)",
        "+ RSI 50-70 (FINAL)",
    ], start=1):
        col = f"c{i}"
        n = cum[col].sum()
        print(f"  {label:<35} {n}/{len(df)} ({n/len(df)*100:.1f}%)")

    # Mã pass MA stack nhưng fail downstream — show
    print("\n═══ Mã có MA stack (uptrend perfect) ═══")
    uptrend = df[df["ma_stack_ok"]].copy()
    print(f"  Total uptrend stocks: {len(uptrend)}")
    if len(uptrend) > 0:
        print(f"\n  Distribution sau MA stack:")
        for c in ["range_ok", "vol_ok", "green_ok", "rsi_ok"]:
            pct = uptrend[c].mean() * 100
            print(f"    {c}: {pct:.1f}% pass")

        print(f"\n  Top 20 uptrend stocks (sorted by vol_ratio):")
        cols = ["symbol", "cur", "ma5", "ma20", "ma50", "range_pct", "vol_ratio", "rsi"]
        existing = [c for c in cols if c in uptrend.columns]
        top = uptrend.sort_values("vol_ratio", ascending=False).head(20)[existing]
        print(top.to_string(index=False))

    # Mã FAIL CHỈ RSI (vì uptrend mạnh → RSI > 70)
    rsi_fail = uptrend[~uptrend["rsi_ok"]]
    print(f"\n═══ Uptrend mã fail vì RSI ({len(rsi_fail)}/{len(uptrend)}) ═══")
    if len(rsi_fail) > 0:
        print(f"  RSI distribution:")
        print(f"    < 50: {(rsi_fail['rsi'] < 50).sum()} (trend nhưng momentum yếu)")
        print(f"    50-70: {((rsi_fail['rsi'] >= 50) & (rsi_fail['rsi'] < 70)).sum()}")
        print(f"    >= 70: {(rsi_fail['rsi'] >= 70).sum()} (overbought)")
        cols2 = ["symbol", "rsi", "vol_ratio", "range_pct"]
        existing2 = [c for c in cols2 if c in rsi_fail.columns]
        print(rsi_fail.sort_values("rsi", ascending=False).head(15)[existing2].to_string(index=False))


if __name__ == "__main__":
    main()
