// Walk-forward backtest — kiểm edge của computeBuyVerdict vs forward-20-phiên thực tế.
// No look-ahead: tại mỗi điểm i, chỉ truyền data[:i+1] vào indicator.
// foreignTrend/stoch/adx = null → verdict tự bỏ qua (an toàn, mọi nhánh guard null).

const { computeBuyVerdict, computeSetupForwardReturn } = require("../verdict-core.js");

const API = "https://dchart-api.vndirect.com.vn/dchart/history";
const SYMBOLS = ["FPT","VCB","HPG","MWG","SSI","VHM","MBB","VND","DGC","GAS"];

async function fetchAll(symbol, days = 1200) {
  const to = Math.floor(Date.now() / 1000);
  const from = to - days * 24 * 3600;
  const res = await fetch(`${API}?resolution=D&symbol=${symbol}&from=${from}&to=${to}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${symbol}`);
  const d = await res.json();
  if (d.s !== "ok" || !d.c?.length) throw new Error(`no data ${symbol}`);
  return { opens: d.o, highs: d.h, lows: d.l, closes: d.c, volumes: d.v };
}

// Tính đến index `end` chính xác, không đọc quá end
function rsiAt(c, end, p = 14) {
  if (end < p) return null;
  let g = 0, l = 0;
  for (let i = end - p + 1; i <= end; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  const aG = g / p, aL = l / p;
  return aL === 0 ? 100 : 100 - 100 / (1 + aG / aL);
}
function smaAt(a, end, p) { if (end < p - 1) return null; let s = 0; for (let i = end - p + 1; i <= end; i++) s += a[i]; return s / p; }
function macdAt(c, end) {
  if (end < 35) return null;
  // EMA xấp xỉ 2-pass từ điểm end - per*2 — chỉ cần dấu hist cho verdict
  const e = (per) => { const k = 2 / (per + 1); let v = c[end - per * 2]; for (let i = end - per * 2 + 1; i <= end; i++) v = c[i] * k + v * (1 - k); return v; };
  const macd = e(12) - e(26);
  return { hist: macd, macd, signal: macd * 0.8 };
}
function bbPosAt(c, end, p = 20) {
  const mid = smaAt(c, end, p); if (mid == null) return null;
  let v = 0; for (let i = end - p + 1; i <= end; i++) v += (c[i] - mid) ** 2;
  const sd = Math.sqrt(v / p), up = mid + 2 * sd, lo = mid - 2 * sd, x = c[end];
  return x > up ? "upper" : x < lo ? "lower" : x > mid ? "middle-upper" : "middle-lower";
}

function buildR(data, end) {
  const { closes: c, highs: h, lows: l, volumes: vol } = data;
  const cur = c[end], prev = c[end - 1];
  const ma20 = smaAt(c, end, 20), ma50 = smaAt(c, end, 50), ma200 = smaAt(c, end, 200);
  let trendDir = "neutral";
  if (ma20 && ma50) {
    if (ma20 > ma50 && cur > ma20) trendDir = "up";
    else if (ma20 < ma50 && cur < ma20) trendDir = "down";
    else if (ma20 > ma50) trendDir = "up-weak";
    else trendDir = "down-weak";
  }
  const win = c.slice(Math.max(0, end - 251), end + 1);
  const hi = Math.max(...win), loIn = Math.min(...win);
  const posIn52w = hi > loIn ? ((cur - loIn) / (hi - loIn)) * 100 : 50;
  const volSma = smaAt(vol, end, 20);
  return {
    current: cur, ma200, trendDir, dayChange: ((cur - prev) / prev) * 100,
    rsi: rsiAt(c, end), macd: macdAt(c, end), stoch: null,
    bbPos: bbPosAt(c, end), posIn52w, mfi: null, foreignTrend: null,
    volRatio: volSma ? vol[end] / volSma : 1, adx: null,
    flags: { deepDowntrend: !!(ma50 && cur < ma50 * 0.88) },
  };
}

function avg(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }

async function run() {
  const buckets = { low: [], mid: [], high: [] };
  const calib = [];

  for (const sym of SYMBOLS) {
    let data;
    try { data = await fetchAll(sym); } catch (e) { console.error("skip", sym, e.message); continue; }
    const n = data.closes.length;
    // Bước 5 phiên để nhẹ; cần i+20 bar tương lai → dừng ở n-21
    for (let i = 220; i <= n - 21; i += 5) {
      const sub = {
        closes: data.closes.slice(0, i + 1), highs: data.highs.slice(0, i + 1),
        lows: data.lows.slice(0, i + 1), volumes: data.volumes.slice(0, i + 1),
        opens: data.opens.slice(0, i + 1),
      };
      const r = buildR(sub, i);
      const v = computeBuyVerdict(r);
      const fwd20 = ((data.closes[i + 20] - data.closes[i]) / data.closes[i]) * 100;

      if (v.bias > 65) buckets.high.push(fwd20);
      else if (v.bias < 35) buckets.low.push(fwd20);
      else buckets.mid.push(fwd20);

      const fc = computeSetupForwardReturn(sub.closes, sub.highs, sub.lows, sub.volumes);
      if (fc && fc.method === "history" && fc.horizons.h20) {
        calib.push({ fc: fc.horizons.h20.median, real: fwd20 });
      }
    }
    console.error("done", sym, n, "bars");
  }

  console.log("\n=== Forward 20-phiên trung bình theo bias-bucket ===");
  console.log(`bias <35  (n=${buckets.low.length}):  ${avg(buckets.low)?.toFixed(2)}%`);
  console.log(`bias 35-65 (n=${buckets.mid.length}): ${avg(buckets.mid)?.toFixed(2)}%`);
  console.log(`bias >65  (n=${buckets.high.length}):  ${avg(buckets.high)?.toFixed(2)}%`);

  const hi = avg(buckets.high), lo = avg(buckets.low);
  const monotone = hi != null && lo != null && hi > lo;
  console.log(`\nMonotonicity (high > low forward): ${monotone ? "PASS ✓ có edge" : "FAIL ✗ KHÔNG edge"}`);

  const sameSign = calib.filter((x) => Math.sign(x.fc) === Math.sign(x.real)).length;
  console.log(`Calibration: forecast cùng dấu thực tế ${sameSign}/${calib.length} (${calib.length ? ((sameSign / calib.length) * 100).toFixed(0) : "--"}%)`);
}

run();
