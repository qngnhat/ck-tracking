"""Phân tích 4 mã trong portfolio user: CDC, LPB, SHS, GEX.
Fetch OHLCV real-time + check pattern + đánh giá hold/cut."""

import requests
import time
import numpy as np
from datetime import datetime

VND_URL = "https://dchart-api.vndirect.com.vn/dchart/history"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9,vi;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Origin": "https://dchart.vndirect.com.vn",
    "Referer": "https://dchart.vndirect.com.vn/",
    "Connection": "keep-alive",
}

PORTFOLIO = [
    ("CDC", 400, 22.00),
    ("LPB", 200, 53.55),
    ("SHS", 200, 18.00),
    ("GEX",  50, 34.95),
]


def fetch(symbol, days=120):
    to = int(time.time())
    fr = to - days * 24 * 3600
    url = f"{VND_URL}?resolution=D&symbol={symbol}&from={fr}&to={to}"
    r = requests.get(url, headers=HEADERS, timeout=15)
    r.raise_for_status()
    data = r.json()
    if data.get("s") != "ok":
        raise RuntimeError(f"{symbol}: bad response")
    return {
        "t": data["t"],
        "o": np.array(data["o"], dtype=float),
        "h": np.array(data["h"], dtype=float),
        "l": np.array(data["l"], dtype=float),
        "c": np.array(data["c"], dtype=float),
        "v": np.array(data["v"], dtype=float),
    }


def rsi(closes, period=14):
    delta = np.diff(closes, prepend=closes[0])
    up = np.where(delta > 0, delta, 0)
    dn = np.where(delta < 0, -delta, 0)
    n = len(closes)
    if n < period: return None
    avg_up = np.mean(up[-period:])
    avg_dn = np.mean(dn[-period:])
    if avg_dn == 0: return 100
    rs = avg_up / avg_dn
    return 100 - 100 / (1 + rs)


def analyze(symbol, qty, cost):
    try:
        d = fetch(symbol)
    except Exception as e:
        return {"symbol": symbol, "error": str(e)}

    c = d["c"]
    o = d["o"]
    v = d["v"]
    h = d["h"]
    l = d["l"]
    times = d["t"]
    n = len(c)
    if n < 30:
        return {"symbol": symbol, "error": "not enough data"}

    cur = c[-1]
    cur_open = o[-1]
    cur_date = datetime.fromtimestamp(times[-1]).strftime("%Y-%m-%d")

    pnl_pct = (cur - cost) / cost * 100
    pnl_vnd = (cur - cost) * qty * 1000

    # Trend
    ma5 = np.mean(c[-5:])
    ma20 = np.mean(c[-20:])
    ma50 = np.mean(c[-50:]) if n >= 50 else None
    ret_5d = (cur - c[-6]) / c[-6] * 100
    ret_20d = (cur - c[-21]) / c[-21] * 100

    # Volume / momentum
    vol_avg20 = np.mean(v[-21:-1])
    vol_ratio = v[-1] / vol_avg20 if vol_avg20 > 0 else 0

    # Climax pattern check (last 5 phiên)
    climax_recent = None
    for i in range(n - 5, n):
        if i < 21: continue
        c_i = c[i]
        prev3 = c[i - 3]
        ret3d = (c_i - prev3) / prev3 * 100
        vol_avg = np.mean(v[i - 20:i])
        vr = v[i] / vol_avg if vol_avg > 0 else 0
        rsi_i = rsi(c[:i + 1])
        day_green = c_i > o[i]
        base = day_green and vr > 2.0
        tier_a = base and ret3d < -7 and rsi_i is not None and rsi_i < 35
        tier_b = base and ret3d < -5 and rsi_i is not None and rsi_i < 50
        if tier_a or tier_b:
            climax_recent = {
                "date": datetime.fromtimestamp(times[i]).strftime("%Y-%m-%d"),
                "tier": "A" if tier_a else "B",
                "ret3d": ret3d,
                "vol_ratio": vr,
                "rsi": rsi_i,
                "entry_price": c_i,
                "days_ago": n - 1 - i,
            }
            break

    rsi_now = rsi(c)

    # Distance to SL and target if entry was cost
    sl_minus8 = cost * 0.92
    target_plus3 = cost * 1.03
    pct_to_sl = (cur - sl_minus8) / sl_minus8 * 100
    pct_to_target = (target_plus3 - cur) / cur * 100

    # Verdict
    notes = []
    if pnl_pct < -8:
        verdict = "🔴 ĐÃ THỦNG SL -8% → bán cắt lỗ ATC hôm nay"
    elif climax_recent and climax_recent["days_ago"] <= 5:
        # In T+ window
        verdict = f"🟡 Climax pick (T+{climax_recent['days_ago']}) — hold theo rule"
        notes.append(f"  Climax detected {climax_recent['date']} (Tier {climax_recent['tier']})")
        notes.append(f"  Còn T+{5 - climax_recent['days_ago']} phiên nữa force exit")
    elif climax_recent:
        verdict = "⚠️ Quá T+5 — trade đã thất bại theo rule, nên thoát"
        notes.append(f"  Climax signal ngày {climax_recent['date']} đã {climax_recent['days_ago']} phiên trước (rule là ≤5)")
    else:
        # Not a climax pick — phân tích như swing
        if pnl_pct > 0:
            verdict = "✅ Đang lời — không cần fuss"
        elif ma20 and cur > ma20:
            verdict = "🟡 Trên MA20 → trend còn — có thể giữ"
        elif ma20 and cur < ma20 and ret_20d < -5:
            verdict = "🔴 Trend giảm + dưới MA20 — cân nhắc cắt"
        else:
            verdict = "⚠️ Trend yếu — không có lý do mạnh giữ"

    if rsi_now is not None and rsi_now < 30:
        notes.append(f"  RSI oversold {rsi_now:.0f} — có khả năng bật")
    elif rsi_now is not None and rsi_now > 70:
        notes.append(f"  RSI overbought {rsi_now:.0f} — coi chừng pullback")

    return {
        "symbol": symbol, "qty": qty, "cost": cost,
        "cur": cur, "cur_date": cur_date,
        "pnl_pct": pnl_pct, "pnl_vnd": pnl_vnd,
        "ma5": ma5, "ma20": ma20, "ma50": ma50,
        "ret_5d": ret_5d, "ret_20d": ret_20d,
        "vol_ratio": vol_ratio, "rsi": rsi_now,
        "climax_recent": climax_recent,
        "verdict": verdict, "notes": notes,
        "sl_minus8": sl_minus8, "target_plus3": target_plus3,
        "pct_to_sl": pct_to_sl, "pct_to_target": pct_to_target,
    }


def main():
    print("Phân tích portfolio (real-time fetch VNDirect)...\n")
    total_pnl_vnd = 0
    total_cost_vnd = 0
    for sym, qty, cost in PORTFOLIO:
        r = analyze(sym, qty, cost)
        if "error" in r:
            print(f"❌ {sym}: {r['error']}\n")
            continue

        print(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
        print(f"📊 {sym} · {qty} cp @ {cost:.2f} (vốn {cost * qty * 1000:,.0f} VND)")
        print(f"   Giá hiện: {r['cur']:.2f} ({r['cur_date']}) · PnL: {r['pnl_pct']:+.2f}% ({r['pnl_vnd']:+,.0f} VND)")
        print()
        print(f"   {r['verdict']}")
        for note in r['notes']:
            print(note)
        print()

        # Technical
        print(f"   Technical:")
        print(f"     MA5={r['ma5']:.2f} · MA20={r['ma20']:.2f}" + (f" · MA50={r['ma50']:.2f}" if r['ma50'] else ""))
        print(f"     Return 5p: {r['ret_5d']:+.2f}% · Return 20p: {r['ret_20d']:+.2f}%")
        print(f"     RSI(14): {r['rsi']:.0f}" if r['rsi'] else "     RSI: n/a")
        print(f"     Vol hôm nay: {r['vol_ratio']:.2f}× TB20")
        print()

        # Plan ref
        print(f"   Reference levels (từ giá vốn {cost:.2f}):")
        print(f"     SL -8%: {r['sl_minus8']:.2f} · cách hiện tại {r['pct_to_sl']:+.2f}%")
        print(f"     Target +3%: {r['target_plus3']:.2f} · cần thêm {r['pct_to_target']:+.2f}% để hoà + lãi")
        print()

        total_pnl_vnd += r['pnl_vnd']
        total_cost_vnd += cost * qty * 1000

    print(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"📈 TỔNG: vốn {total_cost_vnd:,.0f} VND · PnL {total_pnl_vnd:+,.0f} VND "
          f"({total_pnl_vnd / total_cost_vnd * 100:+.2f}%)")


if __name__ == "__main__":
    main()
