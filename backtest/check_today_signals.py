"""Check live: VN30 hôm nay mỗi mã pass/fail conditions cho từng signal.

Cho user thấy CONCRETE lý do tại sao 0 signal:
- Đang test conditions của Climax Tier A/B + Momentum + Watch
- Per-stock breakdown
"""

import requests
import time
import numpy as np

VND = "https://dchart-api.vndirect.com.vn/dchart/history"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9,vi;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Origin": "https://dchart.vndirect.com.vn",
    "Referer": "https://dchart.vndirect.com.vn/",
    "Connection": "keep-alive",
}

# VN30 + top mid liquid
TOP_LIQUID = [
    "VCB", "BID", "CTG", "MBB", "VPB", "TCB", "ACB", "STB", "TPB", "HDB",
    "VIC", "VHM", "VRE", "MSN", "MWG", "FPT", "GAS", "PLX", "VNM", "SAB",
    "HPG", "HSG", "NKG", "DGC", "DCM", "DPM",
    "SSI", "VND", "VCI", "HCM",
    "DIG", "DXG", "KBC", "KDH", "NVL", "PDR", "GEX", "VPL", "VPI",
]


def fetch(sym):
    to = int(time.time())
    fr = to - 400 * 24 * 3600
    r = requests.get(f"{VND}?resolution=D&symbol={sym}&from={fr}&to={to}",
                     headers=HEADERS, timeout=15)
    r.raise_for_status()
    d = r.json()
    if d.get("s") != "ok":
        return None
    return {
        "o": np.array(d["o"], dtype=float),
        "h": np.array(d["h"], dtype=float),
        "l": np.array(d["l"], dtype=float),
        "c": np.array(d["c"], dtype=float),
        "v": np.array(d["v"], dtype=float),
        "t": d["t"],
    }


def rsi(c, period=14):
    delta = np.diff(c, prepend=c[0])
    up = np.where(delta > 0, delta, 0)
    dn = np.where(delta < 0, -delta, 0)
    sl = slice(-period, None)
    avg_up = np.mean(up[sl])
    avg_dn = np.mean(dn[sl])
    if avg_dn == 0: return 100.0
    return 100 - 100 / (1 + avg_up / avg_dn)


def atr_pct(d, n=14):
    h, l, c = d["h"], d["l"], d["c"]
    trs = []
    for i in range(len(c) - n, len(c)):
        tr = max(h[i] - l[i],
                 abs(h[i] - c[i-1]) if i > 0 else 0,
                 abs(l[i] - c[i-1]) if i > 0 else 0)
        trs.append(tr)
    return np.mean(trs) / c[-1] * 100


def analyze(sym):
    d = fetch(sym)
    if d is None or len(d["c"]) < 200:
        return None
    c, o, v = d["c"], d["o"], d["v"]
    n = len(c)
    cur, cur_open, cur_vol = c[-1], o[-1], v[-1]
    prev_close = c[-2]
    prev3 = c[-4]

    ret_1d = (cur - prev_close) / prev_close * 100
    ret_3d = (cur - prev3) / prev3 * 100
    ret_5d = (cur - c[-6]) / c[-6] * 100
    ma5 = np.mean(c[-5:])
    ma20 = np.mean(c[-20:])
    ma50 = np.mean(c[-50:])
    ma200 = np.mean(c[-200:])
    vol_avg = np.mean(v[-21:-1])
    vol_ratio = cur_vol / vol_avg if vol_avg > 0 else 0
    range_pct = (d["h"][-1] - d["l"][-1]) / cur * 100
    day_green = cur > cur_open
    r = rsi(c)
    a_pct = atr_pct(d)

    # Check conditions
    is_climaxA = (ret_3d < -3.0 * a_pct) and (vol_ratio > 2.0) and day_green and (r < 35)
    is_climaxB = (ret_3d < -5) and (vol_ratio > 2.0) and day_green and (r < 50)
    is_momentum = (ma5 > ma20 > ma50 > ma200) and (range_pct < 2.5) and (vol_ratio > 1.2) and day_green and (50 < r < 70)
    is_watch_drop = ret_3d < -2 and ret_3d > -10
    is_watch_vol = vol_ratio > 1.0
    is_watch_green = day_green
    is_watch_rsi = r < 60
    watch_met = sum([is_watch_drop, is_watch_vol, is_watch_green, is_watch_rsi])

    return {
        "sym": sym, "cur": cur,
        "ret_1d": ret_1d, "ret_3d": ret_3d, "ret_5d": ret_5d,
        "vol_ratio": vol_ratio, "rsi": r, "range_pct": range_pct,
        "day_green": day_green, "atr_pct": a_pct,
        "ma_stack": ma5 > ma20 > ma50 > ma200,
        "above_ma20": cur > ma20,
        "is_climaxA": is_climaxA, "is_climaxB": is_climaxB,
        "is_momentum": is_momentum, "watch_met": watch_met,
    }


def main():
    print(f"Checking {len(TOP_LIQUID)} mã top liquid...\n")
    results = []
    for sym in TOP_LIQUID:
        try:
            r = analyze(sym)
            if r:
                results.append(r)
            else:
                print(f"  Skipped {sym}: insufficient data")
        except Exception as e:
            print(f"  Error {sym}: {e}")

    print(f"Analyzed {len(results)} mã\n")

    # Sort by today's gain
    by_gain = sorted(results, key=lambda x: x["ret_1d"], reverse=True)

    print("═══ TOP 15 mã tăng nhất hôm nay ═══")
    print(f"{'sym':<6} {'ret1d':>7} {'ret3d':>7} {'ret5d':>7} {'vol':>5} {'RSI':>4} {'range':>6} {'green':>5} {'uptrend':>7} {'climaxA':>7} {'climaxB':>7} {'mom':>5} {'watch':>5}")
    for r in by_gain[:15]:
        print(f"{r['sym']:<6} {r['ret_1d']:+6.2f}% {r['ret_3d']:+6.2f}% {r['ret_5d']:+6.2f}% {r['vol_ratio']:4.1f}× {r['rsi']:4.0f} {r['range_pct']:5.2f}% "
              f"{'Y' if r['day_green'] else 'N':>5} {'Y' if r['ma_stack'] else 'N':>7} "
              f"{'✓' if r['is_climaxA'] else '✗':>7} "
              f"{'✓' if r['is_climaxB'] else '✗':>7} "
              f"{'✓' if r['is_momentum'] else '✗':>5} "
              f"{r['watch_met']}/4")

    # Aggregate stats
    n_green = sum(1 for r in results if r["day_green"])
    n_uptrend = sum(1 for r in results if r["ma_stack"])
    n_above_ma20 = sum(1 for r in results if r["above_ma20"])
    n_climaxA = sum(1 for r in results if r["is_climaxA"])
    n_climaxB = sum(1 for r in results if r["is_climaxB"])
    n_mom = sum(1 for r in results if r["is_momentum"])
    n_watch3 = sum(1 for r in results if r["watch_met"] >= 3)

    print(f"\n═══ AGGREGATE (n={len(results)} mã) ═══")
    print(f"  Hôm nay xanh (close > open): {n_green}/{len(results)} ({n_green/len(results)*100:.0f}%)")
    print(f"  Uptrend MA5>MA20>MA50>MA200: {n_uptrend}/{len(results)} ({n_uptrend/len(results)*100:.0f}%)")
    print(f"  Trên MA20: {n_above_ma20}/{len(results)} ({n_above_ma20/len(results)*100:.0f}%)")
    print()
    print(f"  Climax Tier A match: {n_climaxA}")
    print(f"  Climax Tier B match: {n_climaxB}")
    print(f"  Strength Continuation match: {n_mom}")
    print(f"  Watch tier (3/4): {n_watch3}")

    # What's missing for Momentum?
    print(f"\n═══ Lý do mã uptrend KHÔNG fire Momentum ═══")
    uptrend_stocks = [r for r in results if r["ma_stack"]]
    print(f"  Total uptrend stocks: {len(uptrend_stocks)}")
    if uptrend_stocks:
        fail_range = sum(1 for r in uptrend_stocks if r["range_pct"] >= 2.5)
        fail_vol = sum(1 for r in uptrend_stocks if r["vol_ratio"] <= 1.2)
        fail_green = sum(1 for r in uptrend_stocks if not r["day_green"])
        fail_rsi = sum(1 for r in uptrend_stocks if not (50 < r["rsi"] < 70))
        print(f"    Fail range < 2.5%: {fail_range}/{len(uptrend_stocks)}")
        print(f"    Fail vol > 1.2×: {fail_vol}/{len(uptrend_stocks)}")
        print(f"    Fail green: {fail_green}/{len(uptrend_stocks)}")
        print(f"    Fail RSI 50-70: {fail_rsi}/{len(uptrend_stocks)}")
        for r in uptrend_stocks:
            fails = []
            if r["range_pct"] >= 2.5: fails.append(f"range {r['range_pct']:.1f}%")
            if r["vol_ratio"] <= 1.2: fails.append(f"vol {r['vol_ratio']:.1f}×")
            if not r["day_green"]: fails.append("đỏ")
            if not (50 < r["rsi"] < 70): fails.append(f"RSI {r['rsi']:.0f}")
            print(f"    {r['sym']:<6}: ret1d {r['ret_1d']:+.2f}% — fail: {', '.join(fails) if fails else 'NONE (should fire!)'}")


if __name__ == "__main__":
    main()
