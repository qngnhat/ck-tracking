// Backtest riêng mẫu hình "pullback-in-uptrend" TRƯỚC khi wire UI.
// Ý tưởng (theo user): mã trong uptrend, chỉnh nhẹ vài phiên rồi đi tiếp.
// Bắt điểm CHỈNH (không phải lúc mọi chỉ báo đã đẹp — cái đó backtest cũ đã fail).
// No look-ahead: mọi indicator tính đến index i, forward đo i+k.

const API = "https://dchart-api.vndirect.com.vn/dchart/history";
const SYMBOLS = ["FPT","VCB","HPG","MWG","SSI","VHM","MBB","VND","DGC","GAS","ACB","TCB","VPB","STB","GVR","POW","PNJ","REE","DHG","VNM"];

async function fetchAll(symbol, days = 1400) {
  const to = Math.floor(Date.now() / 1000);
  const from = to - days * 24 * 3600;
  const res = await fetch(`${API}?resolution=D&symbol=${symbol}&from=${from}&to=${to}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${symbol}`);
  const d = await res.json();
  if (d.s !== "ok" || !d.c?.length) throw new Error(`no data ${symbol}`);
  return { highs: d.h, lows: d.l, closes: d.c, volumes: d.v };
}

function smaAt(a, end, p) { if (end < p - 1) return null; let s = 0; for (let i = end - p + 1; i <= end; i++) s += a[i]; return s / p; }
function rsiAt(c, end, p = 14) {
  if (end < p) return null;
  let g = 0, l = 0;
  for (let i = end - p + 1; i <= end; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  const aG = g / p, aL = l / p;
  return aL === 0 ? 100 : 100 - 100 / (1 + aG / aL);
}

// ── Detector pullback-in-uptrend tại phiên `end` ──
// Trả {hit:bool, confluence:int} — confluence = số điều kiện "chỉnh lành" thoả (để chấm mạnh/yếu).
function detectPullback(c, h, l, vol, end) {
  const cur = c[end];
  const ma20 = smaAt(c, end, 20), ma50 = smaAt(c, end, 50), ma200 = smaAt(c, end, 200);
  if (!ma20 || !ma50 || !ma200) return { hit: false };

  // 1. Uptrend nền: giá trên MA50, MA50 trên MA200
  const uptrend = cur > ma50 && ma50 > ma200;
  if (!uptrend) return { hit: false };

  // 3. Chỉnh nông — chưa gãy: vẫn trên MA50 (đã đảm bảo ở trên)

  // 2. Đang trong nhịp chỉnh — cần ÍT NHẤT 1 dấu hiệu:
  const win = c.slice(end - 14, end + 1);          // 15 phiên gần
  const recentHigh = Math.max(...win);
  const dropFromHigh = ((recentHigh - cur) / recentHigh) * 100;
  const nearMa20 = Math.abs((cur - ma20) / ma20) * 100 <= 2;   // chạm MA20 ±2%
  const rsi = rsiAt(c, end);
  const rsiCooled = rsi != null && rsi >= 40 && rsi <= 55;      // hạ nhiệt chưa gãy
  const pulled = dropFromHigh >= 3;                            // giảm ≥3% từ đỉnh gần

  const inPullback = pulled || nearMa20 || rsiCooled;
  if (!inPullback) return { hit: false };

  // Điều kiện phụ (confluence, không bắt buộc): chỉnh LÀNH = vol cạn khi chỉnh
  let confluence = 0;
  if (pulled) confluence++;
  if (nearMa20) confluence++;
  if (rsiCooled) confluence++;
  const volSma = smaAt(vol, end, 20);
  const volLow = volSma && vol[end] < volSma * 0.9;            // vol phiên chỉnh cạn
  if (volLow) confluence++;

  return { hit: true, confluence, volLow };
}

function avg(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function winRate(a) { return a.length ? (a.filter((x) => x > 0).length / a.length) * 100 : null; }

async function run() {
  // Nhóm forward-20p: mã dính pullback vs baseline (mọi phiên đủ điều kiện tính)
  const hitFwd = [], baseFwd = [];
  const hitFwd5 = [], hitFwd10 = [];
  // Theo confluence để xem "chỉnh lành" có ăn hơn không
  const byConf = { 1: [], 2: [], 3: [], 4: [] };
  const perSymbol = {};

  for (const sym of SYMBOLS) {
    let data;
    try { data = await fetchAll(sym); } catch (e) { console.error("skip", sym, e.message); continue; }
    const { closes: c, highs: h, lows: l, volumes: vol } = data;
    const n = c.length;
    let hits = 0, symHit = [];
    for (let i = 210; i <= n - 21; i++) {
      const base = c[i];
      const f20 = ((c[i + 20] - base) / base) * 100;
      baseFwd.push(f20);
      const d = detectPullback(c, h, l, vol, i);
      if (d.hit) {
        hits++;
        hitFwd.push(f20); symHit.push(f20);
        hitFwd5.push(((c[i + 5] - base) / base) * 100);
        hitFwd10.push(((c[i + 10] - base) / base) * 100);
        if (byConf[d.confluence]) byConf[d.confluence].push(f20);
      }
    }
    perSymbol[sym] = { hits, avg: avg(symHit), win: winRate(symHit) };
    console.error("done", sym, n, "bars,", hits, "pullback hits");
  }

  console.log("\n=== Pullback-in-uptrend backtest (forward 20 phiên) ===");
  console.log(`Baseline (mọi phiên, n=${baseFwd.length}): avg ${avg(baseFwd)?.toFixed(2)}% | winrate ${winRate(baseFwd)?.toFixed(0)}%`);
  console.log(`Pullback HIT (n=${hitFwd.length}):          avg ${avg(hitFwd)?.toFixed(2)}% | winrate ${winRate(hitFwd)?.toFixed(0)}%`);
  console.log(`  forward 5p:  avg ${avg(hitFwd5)?.toFixed(2)}% | winrate ${winRate(hitFwd5)?.toFixed(0)}%`);
  console.log(`  forward 10p: avg ${avg(hitFwd10)?.toFixed(2)}% | winrate ${winRate(hitFwd10)?.toFixed(0)}%`);

  const edge = (avg(hitFwd) ?? 0) - (avg(baseFwd) ?? 0);
  console.log(`\nEdge vs baseline (fwd20): ${edge >= 0 ? "+" : ""}${edge.toFixed(2)} pp`);
  console.log(`Verdict: ${edge > 0.5 && winRate(hitFwd) > winRate(baseFwd) ? "PASS ✓ pullback có edge" : "FAIL ✗ không hơn baseline"}`);

  console.log("\n=== Theo confluence (chỉnh lành = vol cạn + nhiều dấu hiệu) ===");
  for (const k of [1, 2, 3, 4]) {
    const a = byConf[k];
    if (a.length) console.log(`  confluence ${k} (n=${a.length}): avg ${avg(a).toFixed(2)}% | winrate ${winRate(a).toFixed(0)}%`);
  }

  console.log("\n=== Per-symbol (mã nào ăn pattern này) ===");
  for (const [s, v] of Object.entries(perSymbol)) {
    if (v.hits >= 8) console.log(`  ${s}: n=${v.hits} avg ${v.avg?.toFixed(2)}% win ${v.win?.toFixed(0)}%`);
  }
}
run();
