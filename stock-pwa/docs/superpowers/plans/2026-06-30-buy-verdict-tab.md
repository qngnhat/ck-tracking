# Buy Verdict Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm tab thứ 3 "Nên mua?" vào màn phân tích từng mã — tổng hợp chart/giá/vol/khối ngoại thành thiên hướng % + dự báo biên độ giá tương lai gần (setup-based forward-return tự tính mới).

**Architecture:** Tab thuần presentation trên object `r = ANALYSIS.analyze()` đã có sẵn (KHÔNG fetch thêm). 1 hàm verdict gom 4 trụ → điểm thiên hướng 0–100; 1 hàm forward-return mới quét lịch sử giá (`currentData`) theo setup signature 4 chiều; 1 hàm render. Sửa duy nhất `app.js` (tabs render trong JS innerHTML, không đụng index.html). Thêm vài class nhỏ vào `style.css`.

**Tech Stack:** Vanilla JS (IIFE module `window.__SSI_PORTFOLIO__` trong app.js), không framework, không build step. Test thủ công qua PWA + `node --check`.

## Global Constraints

- KHÔNG fetch network mới — chỉ đọc `r` (lastAnalysisResult) + `currentData` (module-level OHLCV).
- KHÔNG kế thừa sản phẩm backtest cũ: `r.score`, `r.reasons`, `r.recommendation/recLevel/recColor`, `r.forwardStats`, `r.stockProfile.multipliers`, `r.buyZoneLow/High`. Chỉ đọc chỉ số thô.
- KHÔNG phán "MUA/BÁN" cứng — dùng nhãn thiên hướng ("Nghiêng mua N%" / "Trung tính" / "Nghiêng tránh N%").
- Comment ngắn, giải thích WHY/FLOW (theo CLAUDE.md). Code/identifier tiếng Anh, copy UI tiếng Việt.
- Mỗi task kết thúc bằng `node --check app.js` PASS. KHÔNG tự `git commit` — để working tree cho user review (theo feedback "không bao giờ tự commit"). Step "Commit" trong plan = user tự bấm, agent dừng lại báo cáo diff.

---

### Task 1: Hàm `computeSetupForwardReturn` — dự báo setup-based (logic thuần, test được độc lập)

**Files:**
- Modify: `app.js` — thêm hàm trong IIFE, đặt ngay trước `function renderAnalysis` (~line 550).
- Test: `tests/verdict.test.mjs` (mới — node test thuần, không cần DOM).

**Interfaces:**
- Consumes: mảng `closes, highs, lows, volumes` (number[]), độ dài cùng nhau.
- Produces:
  ```
  computeSetupForwardReturn(closes, highs, lows, volumes) -> null | {
    signature: { maPos, rsiBucket, adxTier, volTier },  // string mỗi field
    horizons: {                                          // mỗi mốc:
      h5:  { median, p25, p75, n } | null,
      h10: { median, p25, p75, n } | null,
      h20: { median, p25, p75, n } | null,
    },
    method: "history" | "atr-fallback",
    atrPct,                                              // dùng cho fallback + hiển thị
  }
  ```
  - Trả `null` nếu `closes.length < 50`.
  - `method="atr-fallback"` khi tổng mẫu match < 5 → median/p25/p75 ước lượng từ ATR.

Hàm chỉ tính toán, KHÔNG đọc `r`. Helper RSI/ATR/SMA tính inline trong hàm (không import analysis.js để giữ test thuần node).

- [ ] **Step 1: Viết test fail trước**

Tạo `tests/verdict.test.mjs`:
```js
import assert from "node:assert";
import { test } from "node:test";
import { computeSetupForwardReturn, computeBuyVerdict } from "../verdict-core.mjs";

// Dữ liệu < 50 nến → null
test("forward-return null khi thiếu dữ liệu", () => {
  const c = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.equal(computeSetupForwardReturn(c, c, c, c.map(() => 1000)), null);
});

// Uptrend đều: signature ổn định, có mẫu lịch sử, median 5 phiên > 0
test("forward-return uptrend cho median dương", () => {
  const n = 200;
  const closes = Array.from({ length: n }, (_, i) => 100 * Math.pow(1.004, i)); // +0.4%/phiên
  const highs = closes.map((c) => c * 1.01);
  const lows = closes.map((c) => c * 0.99);
  const vols = closes.map(() => 1_000_000);
  const out = computeSetupForwardReturn(closes, highs, lows, vols);
  assert.ok(out, "phải trả object");
  assert.equal(out.method, "history");
  assert.ok(out.horizons.h5.n >= 5, "đủ mẫu");
  assert.ok(out.horizons.h5.median > 0, "uptrend → forward dương");
});

// Ít mẫu → fallback ATR (chuỗi random không lặp setup)
test("forward-return fallback ATR khi ít mẫu", () => {
  const n = 60; // vừa đủ >50 nhưng setup hiếm
  let p = 100;
  const closes = [], highs = [], lows = [], vols = [];
  for (let i = 0; i < n; i++) {
    p = p * (1 + (i % 7 === 0 ? 0.08 : -0.01)); // nhịp gãy → setup ít lặp
    closes.push(p); highs.push(p * 1.02); lows.push(p * 0.98); vols.push(1000 + i);
  }
  const out = computeSetupForwardReturn(closes, highs, lows, vols);
  assert.ok(out);
  assert.equal(out.method, "atr-fallback");
  assert.ok(out.horizons.h20.median !== null);
});
```

Tạo `verdict-core.mjs` (file tách để test thuần node — xem Step 3) — chưa tạo, để test FAIL.

- [ ] **Step 2: Chạy test, xác nhận FAIL**

Run: `cd stock-pwa && node --test tests/verdict.test.mjs`
Expected: FAIL — `Cannot find module '../verdict-core.mjs'`.

- [ ] **Step 3: Viết `verdict-core.mjs` (nguồn logic thuần, export ESM)**

Tạo `stock-pwa/verdict-core.mjs`. Đây là single source of truth cho 2 hàm core, export cho test. app.js sẽ inline cùng logic (Task 2/3) — KHÔNG load file này trong browser (PWA không bundle ESM); test dùng nó để khoá hành vi.

```js
// verdict-core.mjs — logic thuần cho Buy Verdict tab, export để node test.
// CẢNH BÁO: giữ ĐỒNG BỘ với bản inline trong app.js (cùng công thức).

// ── Indicator helpers (thuần, không phụ thuộc analysis.js) ──
function rsiAt(closes, end, period = 14) {
  if (end < period) return null;
  let gains = 0, losses = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const avgG = gains / period, avgL = losses / period;
  if (avgL === 0) return 100;
  return 100 - 100 / (1 + avgG / avgL);
}

function smaAt(arr, end, period) {
  if (end < period - 1) return null;
  let s = 0;
  for (let i = end - period + 1; i <= end; i++) s += arr[i];
  return s / period;
}

function atrAt(highs, lows, closes, end, period = 14) {
  if (end < period) return null;
  let s = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    s += tr;
  }
  return s / period;
}

function adxTierAt(highs, lows, closes, end, period = 14) {
  // Rút gọn: dùng độ dốc |return| chuẩn hoá làm proxy trend strength khi không đủ chuỗi DX.
  // Mục đích chỉ phân tier weak/forming/strong cho signature, không cần ADX chính xác.
  if (end < period * 2) return "weak";
  // ADX Wilder rút gọn
  const trs = [], pdm = [], mdm = [];
  for (let i = end - period * 2 + 1; i <= end; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    const up = highs[i] - highs[i - 1], dn = lows[i - 1] - lows[i];
    trs.push(tr); pdm.push(up > dn && up > 0 ? up : 0); mdm.push(dn > up && dn > 0 ? dn : 0);
  }
  let sTR = 0, sP = 0, sM = 0;
  for (let i = 0; i < period; i++) { sTR += trs[i]; sP += pdm[i]; sM += mdm[i]; }
  const dxs = [];
  for (let i = period; i < trs.length; i++) {
    sTR = sTR - sTR / period + trs[i];
    sP = sP - sP / period + pdm[i];
    sM = sM - sM / period + mdm[i];
    const pDI = sTR ? (100 * sP) / sTR : 0, mDI = sTR ? (100 * sM) / sTR : 0;
    const sum = pDI + mDI;
    dxs.push(sum ? (100 * Math.abs(pDI - mDI)) / sum : 0);
  }
  if (!dxs.length) return "weak";
  const adx = dxs.reduce((a, b) => a + b, 0) / dxs.length;
  return adx < 20 ? "weak" : adx < 25 ? "forming" : "strong";
}

function rsiBucketOf(rsi) {
  if (rsi == null) return "na";
  if (rsi < 30) return "<30";
  if (rsi < 45) return "30-45";
  if (rsi < 55) return "45-55";
  if (rsi < 70) return "55-70";
  return ">70";
}

function signatureAt(closes, highs, lows, volumes, end) {
  const ma50 = smaAt(closes, end, 50);
  const rsi = rsiAt(closes, end);
  const volSma = smaAt(volumes, end, 20);
  const vRatio = volSma ? volumes[end] / volSma : 1;
  return {
    maPos: ma50 == null ? "na" : closes[end] >= ma50 ? "above" : "below",
    rsiBucket: rsiBucketOf(rsi),
    adxTier: adxTierAt(highs, lows, closes, end),
    volTier: vRatio < 0.8 ? "low" : vRatio > 1.5 ? "high" : "normal",
  };
}

function matchScore(a, b) {
  let m = 0;
  if (a.maPos === b.maPos) m++;
  if (a.rsiBucket === b.rsiBucket) m++;
  if (a.adxTier === b.adxTier) m++;
  if (a.volTier === b.volTier) m++;
  return m;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function statsOf(arr) {
  if (arr.length < 5) return null;
  const s = [...arr].sort((a, b) => a - b);
  return { median: quantile(s, 0.5), p25: quantile(s, 0.25), p75: quantile(s, 0.75), n: arr.length };
}

export function computeSetupForwardReturn(closes, highs, lows, volumes) {
  const n = closes.length;
  if (n < 50) return null;
  const end = n - 1;
  const today = signatureAt(closes, highs, lows, volumes, end);

  const r5 = [], r10 = [], r20 = [];
  // Quét lịch sử, cần forward window 20 → dừng ở n-21. Bắt đầu sau khi đủ MA50.
  for (let i = 50; i <= n - 21; i++) {
    const sig = signatureAt(closes, highs, lows, volumes, i);
    if (matchScore(sig, today) < 3) continue;
    const base = closes[i];
    if (!base || base <= 0) continue;
    r5.push(((closes[i + 5] - base) / base) * 100);
    r10.push(((closes[i + 10] - base) / base) * 100);
    r20.push(((closes[i + 20] - base) / base) * 100);
  }

  const atr = atrAt(highs, lows, closes, end);
  const atrPct = atr ? (atr / closes[end]) * 100 : null;
  const h5 = statsOf(r5), h10 = statsOf(r10), h20 = statsOf(r20);

  if (h5 && h10 && h20) {
    return { signature: today, horizons: { h5, h10, h20 }, method: "history", atrPct };
  }

  // Fallback: ATR-projection. Biên độ ±atrPct·√k, không lệch hướng (verdict layer lo bias).
  const proj = (k) => {
    if (atrPct == null) return null;
    const band = atrPct * Math.sqrt(k);
    return { median: 0, p25: -band, p75: band, n: (r5.length || 0) };
  };
  return {
    signature: today,
    horizons: { h5: proj(5), h10: proj(10), h20: proj(20) },
    method: "atr-fallback",
    atrPct,
  };
}

// ── Verdict: gom 4 trụ từ r (chỉ số thô) → thiên hướng 0..100 ──
export function computeBuyVerdict(r) {
  const pillars = [];
  const reasons = [];
  let score = 0; // raw, sẽ map sang 0..100

  // Trụ 1: Xu hướng (chart) — vị trí MA + ADX
  let p1 = 0;
  if (r.trendDir === "up") { p1 += 2; reasons.push("Xu hướng tăng (giá > MA20 > MA50)"); }
  else if (r.trendDir === "up-weak") { p1 += 1; }
  else if (r.trendDir === "down") { p1 -= 2; reasons.push("Xu hướng giảm"); }
  else if (r.trendDir === "down-weak") { p1 -= 1; }
  if (r.ma200 != null && r.current > r.ma200) p1 += 1;
  else if (r.ma200 != null) p1 -= 1;
  if (r.adx && r.adx.adx >= 25) {
    if (r.adx.plusDI > r.adx.minusDI) { p1 += 1; reasons.push(`ADX ${r.adx.adx.toFixed(0)} — trend tăng mạnh`); }
    else { p1 -= 1; reasons.push(`ADX ${r.adx.adx.toFixed(0)} — trend giảm mạnh`); }
  }
  pillars.push({ key: "trend", label: "Xu hướng", score: p1 });
  score += p1;

  // Trụ 2: Động lượng giá — RSI/Stoch/MACD/BB/vị trí 52w
  let p2 = 0;
  if (r.rsi != null) {
    if (r.rsi < 30) { p2 += 2; reasons.push("RSI < 30 (quá bán)"); }
    else if (r.rsi < 45) { p2 += 1; }
    else if (r.rsi > 70) { p2 -= 2; reasons.push("RSI > 70 (quá mua)"); }
    else if (r.rsi > 55) { p2 -= 1; }
  }
  if (r.macd && r.macd.hist > 0 && r.macd.macd > r.macd.signal) { p2 += 1; reasons.push("MACD dương trên signal"); }
  else if (r.macd && r.macd.hist < 0) { p2 -= 1; }
  if (r.stoch && r.stoch.k < 20 && r.stoch.k > r.stoch.d) { p2 += 1; reasons.push("Stochastic quá bán + cắt lên"); }
  else if (r.stoch && r.stoch.k > 80 && r.stoch.k < r.stoch.d) { p2 -= 1; }
  if (r.bbPos === "lower") { p2 += 1; }
  else if (r.bbPos === "upper") { p2 -= 1; }
  if (r.posIn52w != null && r.posIn52w > 85) { p2 -= 1; reasons.push("Giá gần đỉnh 52w"); }
  else if (r.posIn52w != null && r.posIn52w < 25) { p2 += 1; reasons.push("Giá gần đáy 52w"); }
  pillars.push({ key: "momentum", label: "Động lượng", score: p2 });
  score += p2;

  // Trụ 3: Dòng tiền — volume + MFI + khối ngoại
  let p3 = 0;
  if (r.mfi != null) {
    if (r.mfi < 20) { p3 += 1; reasons.push("MFI quá bán"); }
    else if (r.mfi > 80) { p3 -= 1; reasons.push("MFI quá mua"); }
  }
  if (r.foreignTrend === "buying") { p3 += 2; reasons.push("Khối ngoại mua ròng"); }
  else if (r.foreignTrend === "selling") { p3 -= 2; reasons.push("Khối ngoại bán ròng"); }
  if (r.volRatio != null && r.volRatio > 1.5 && r.dayChange > 0) { p3 += 1; reasons.push("Volume cao + giá tăng"); }
  pillars.push({ key: "flow", label: "Dòng tiền", score: p3 });
  score += p3;

  // Trụ 4: Rủi ro (trừ điểm) — flags
  let p4 = 0;
  const f = r.flags || {};
  if (f.sellPressure) { p4 -= 2; reasons.push("⚠ Áp lực bán (vol cao + giảm mạnh)"); }
  if (f.deepDowntrend) { p4 -= 2; reasons.push("⚠ Downtrend sâu (giá << MA50)"); }
  if (f.bearTrap) { p4 -= 1; reasons.push("⚠ Bear trap (ADX cao, -DI > +DI)"); }
  if (f.lowVol) { p4 -= 1; reasons.push("⚠ Thanh khoản thấp"); }
  pillars.push({ key: "risk", label: "Rủi ro", score: p4 });
  score += p4;

  // Map raw score (~[-9..+9]) → bias 0..100 quanh 50.
  const bias = Math.max(0, Math.min(100, Math.round(50 + score * 5.5)));
  let label, level;
  if (bias >= 65) { label = `Nghiêng mua ${bias}%`; level = "mild-bull"; }
  else if (bias >= 80) { label = `Nghiêng mua mạnh ${bias}%`; level = "strong-bull"; }
  else if (bias <= 35) { label = `Nghiêng tránh ${100 - bias}%`; level = "mild-bear"; }
  else if (bias <= 20) { label = `Nghiêng tránh mạnh ${100 - bias}%`; level = "strong-bear"; }
  else { label = "Trung tính"; level = "neutral"; }
  // (lưu ý thứ tự if: kiểm tra mạnh trước — sửa ở Step thực thi nếu cần)

  return { bias, level, label, score, pillars, reasons };
}
```

LƯU Ý thứ tự if-bias ở trên SAI (>=65 nuốt >=80). Khi viết bản thật, sắp lại: `>=80 strong-bull` trước `>=65 mild-bull`; `<=20 strong-bear` trước `<=35 mild-bear`.

- [ ] **Step 4: Sửa thứ tự if-bias trong `computeBuyVerdict`**

Trong `verdict-core.mjs`, thay block map bias bằng thứ tự đúng:
```js
  let label, level;
  if (bias >= 80) { label = `Nghiêng mua mạnh ${bias}%`; level = "strong-bull"; }
  else if (bias >= 65) { label = `Nghiêng mua ${bias}%`; level = "mild-bull"; }
  else if (bias <= 20) { label = `Nghiêng tránh mạnh ${100 - bias}%`; level = "strong-bear"; }
  else if (bias <= 35) { label = `Nghiêng tránh ${100 - bias}%`; level = "mild-bear"; }
  else { label = "Trung tính"; level = "neutral"; }
```

- [ ] **Step 5: Thêm test cho `computeBuyVerdict`**

Append vào `tests/verdict.test.mjs`:
```js
test("verdict uptrend mạnh → nghiêng mua", () => {
  const r = {
    current: 100, ma200: 80, trendDir: "up", dayChange: 1.2,
    rsi: 58, macd: { hist: 0.5, macd: 1, signal: 0.5 },
    stoch: { k: 60, d: 55 }, bbPos: "middle-upper", posIn52w: 70,
    mfi: 60, foreignTrend: "buying", volRatio: 1.8,
    adx: { adx: 30, plusDI: 28, minusDI: 12 }, flags: {},
  };
  const v = computeBuyVerdict(r);
  assert.ok(v.bias > 55, `bias ${v.bias} phải > 55`);
  assert.ok(["mild-bull", "strong-bull"].includes(v.level));
  assert.equal(v.pillars.length, 4);
});

test("verdict downtrend + rủi ro → nghiêng tránh", () => {
  const r = {
    current: 50, ma200: 80, trendDir: "down", dayChange: -3,
    rsi: 38, macd: { hist: -0.5, macd: -1, signal: -0.5 },
    stoch: { k: 40, d: 50 }, bbPos: "middle-lower", posIn52w: 20,
    mfi: 45, foreignTrend: "selling", volRatio: 2.0,
    adx: { adx: 40, plusDI: 10, minusDI: 30 },
    flags: { sellPressure: true, deepDowntrend: true },
  };
  const v = computeBuyVerdict(r);
  assert.ok(v.bias < 45, `bias ${v.bias} phải < 45`);
});
```

- [ ] **Step 6: Chạy test, xác nhận PASS**

Run: `cd stock-pwa && node --test tests/verdict.test.mjs`
Expected: PASS — 5 test (3 forward-return + 2 verdict).

- [ ] **Step 7: Báo cáo (KHÔNG tự commit)**

Dừng, báo: "Task 1 xong, 5 test pass. `verdict-core.mjs` + `tests/verdict.test.mjs`. Review trước khi tao port vào app.js."

---

### Task 2: Inline 2 hàm core + render vào tab "Nên mua?" trong app.js

**Files:**
- Modify: `app.js` — thêm 2 hàm (`computeSetupForwardReturn`, `computeBuyVerdict`) inline trong IIFE ngay trước `renderAnalysis` (~line 550); thêm `renderVerdictTabContent(r)`; sửa `getAnalysisTabDefault`, `setAnalysisTab`, `renderAnalysis`.

**Interfaces:**
- Consumes: `r` (lastAnalysisResult) + module-level `currentData` (OHLCV). Helper sẵn có: `$`, `fp`, `signedPct`, `fmtFlow` (đã có trong IIFE).
- Produces: tab `data-mode="verdict"` render được.

- [ ] **Step 1: Inline 2 hàm core vào app.js**

Copy NGUYÊN VĂN thân `computeSetupForwardReturn` và `computeBuyVerdict` (gồm các helper `rsiAt/smaAt/atrAt/adxTierAt/rsiBucketOf/signatureAt/matchScore/quantile/statsOf`) từ `verdict-core.mjs` (bản đã sửa thứ tự if ở Task 1 Step 4) vào trong IIFE app.js, ngay trước `function renderAnalysis`. Bỏ `export` keyword (trong IIFE không export). Đổi tên helper nếu trùng tên đã tồn tại trong app.js — kiểm tra bằng:
```
grep -nE "function (rsiAt|smaAt|atrAt|adxTierAt|signatureAt|matchScore|quantile|statsOf)\b" app.js
```
Nếu có trùng → đổi suffix `V` (vd `statsOfV`). Mặc định không trùng (app.js dùng tên khác).

- [ ] **Step 2: Thêm `verdict` vào tab whitelist**

Sửa `getAnalysisTabDefault` (app.js ~529):
```js
  function getAnalysisTabDefault() {
    const persisted = localStorage.getItem(ANALYSIS_TAB_KEY);
    if (["overview", "technical", "verdict"].includes(persisted)) return persisted;
    return "overview";
  }
```
Sửa `setAnalysisTab` (app.js ~535) dòng whitelist:
```js
    if (!["overview", "technical", "verdict"].includes(mode)) mode = "overview";
```

- [ ] **Step 3: Thêm nút tab + content div + lazy render trong `renderAnalysis`**

Sửa block `root.innerHTML` trong `renderAnalysis` (~554): thêm nút và div verdict:
```js
    root.innerHTML = `
      <div class="analysis-tabs" role="tablist">
        <button class="analysis-tab" data-mode="overview" type="button" role="tab">📊 Tổng quan</button>
        <button class="analysis-tab" data-mode="technical" type="button" role="tab">🔍 Kỹ thuật</button>
        <button class="analysis-tab" data-mode="verdict" type="button" role="tab">💡 Nên mua?</button>
      </div>
      <div class="analysis-tab-content" data-mode="overview" id="analysis-tab-overview"></div>
      <div class="analysis-tab-content" data-mode="technical" id="analysis-tab-technical" style="display:none"></div>
      <div class="analysis-tab-content" data-mode="verdict" id="analysis-tab-verdict" style="display:none"></div>
    `;
```
Ngay sau dòng `$("analysis-tab-technical").innerHTML = renderTechnicalTabContent(r);` (~566) thêm:
```js
    // Verdict tab — build ngay (rẻ, thuần tính toán trên r + currentData)
    $("analysis-tab-verdict").innerHTML = renderVerdictTabContent(r);
```

- [ ] **Step 4: Viết `renderVerdictTabContent(r)`**

Thêm hàm ngay sau `renderAnalysis` (hoặc cạnh renderTechnicalTabContent). Tái dùng `.an-card/.an-title`, `.ta-verdict*`, `.chip`:
```js
  function renderVerdictTabContent(r) {
    const v = computeBuyVerdict(r);
    const fwd = currentData
      ? computeSetupForwardReturn(currentData.closes, currentData.highs, currentData.lows, currentData.volumes)
      : null;

    // Header badge — màu theo level (tái dùng .ta-verdict.ta-<level>)
    const head = `
      <div class="ta-verdict ta-${v.level}">
        <div class="ta-verdict-label">${v.label}</div>
        <div class="ta-verdict-desc">Điểm thiên hướng ${v.bias}/100 — tổng hợp xu hướng, động lượng, dòng tiền, rủi ro.</div>
      </div>`;

    // 4 trụ — mỗi trụ 1 dòng score
    const pillarRow = (p) => {
      const sign = p.score > 0 ? "up" : p.score < 0 ? "down" : "flat";
      const txt = p.score > 0 ? `+${p.score}` : `${p.score}`;
      return `<div class="vd-pillar vd-${sign}"><span>${p.label}</span><b>${txt}</b></div>`;
    };
    const pillars = `
      <div class="an-card">
        <div class="an-title">Bốn trụ đánh giá</div>
        <div class="vd-pillars">${v.pillars.map(pillarRow).join("")}</div>
      </div>`;

    // Lý do — chip
    const reasons = v.reasons.length
      ? `<div class="an-card"><div class="an-title">Lý do</div>
           <div class="vd-reasons">${v.reasons.map((x) => `<span class="chip">${x}</span>`).join("")}</div></div>`
      : "";

    // Dự báo forward-return
    let forecast;
    if (!fwd) {
      forecast = `<div class="an-card"><div class="an-title">Dự báo biên độ</div>
        <div class="an-reasons">Không đủ dữ liệu lịch sử (cần ≥ 50 phiên).</div></div>`;
    } else {
      const note = fwd.method === "atr-fallback"
        ? `<div class="an-reasons">Ít mẫu lịch sử khớp setup — dùng ước lượng biến động (ATR ${fwd.atrPct ? fwd.atrPct.toFixed(2) : "--"}%/phiên).</div>`
        : `<div class="an-reasons">Dựa trên các phiên quá khứ có setup tương tự (vị trí MA50 · RSI · ADX · volume).</div>`;
      const hRow = (lbl, h) => h
        ? `<div class="vd-fc-row"><span>${lbl}</span>
             <b class="${h.median >= 0 ? "up" : "down"}">${h.median >= 0 ? "+" : ""}${h.median.toFixed(1)}%</b>
             <small>dải ${h.p25.toFixed(1)}% … ${h.p75.toFixed(1)}%${h.n ? ` · n=${h.n}` : ""}</small></div>`
        : `<div class="vd-fc-row"><span>${lbl}</span><small>—</small></div>`;
      forecast = `<div class="an-card"><div class="an-title">Dự báo biên độ (tương lai gần)</div>
        ${hRow("5 phiên", fwd.horizons.h5)}
        ${hRow("10 phiên", fwd.horizons.h10)}
        ${hRow("20 phiên", fwd.horizons.h20)}
        ${note}</div>`;
    }

    // Vùng hành động — target = kháng cự, stop = support (đã có trong r)
    const pct = (to) => r.current ? ((to - r.current) / r.current) * 100 : 0;
    const action = `<div class="an-card"><div class="an-title">Vùng tham chiếu</div>
      ${r.resistance ? `<div class="vd-fc-row"><span>Mục tiêu (kháng cự)</span><b>${fp(r.resistance)}</b><small>${pct(r.resistance) >= 0 ? "+" : ""}${pct(r.resistance).toFixed(1)}%</small></div>` : ""}
      ${r.support ? `<div class="vd-fc-row"><span>Hỗ trợ gần</span><b>${fp(r.support)}</b><small>${pct(r.support).toFixed(1)}%</small></div>` : ""}
      ${r.stopLoss ? `<div class="vd-fc-row"><span>Gợi ý stop-loss</span><b>${fp(r.stopLoss)}</b><small>${pct(r.stopLoss).toFixed(1)}%</small></div>` : ""}
    </div>`;

    const disclaimer = `<div class="an-reasons" style="margin-top:10px;font-style:italic">
      Đây là tổng hợp chỉ báo kỹ thuật + thống kê lịch sử, KHÔNG phải khuyến nghị mua/bán.
      Dự báo dựa trên phân phối quá khứ, không đảm bảo kết quả tương lai.</div>`;

    return head + forecast + pillars + reasons + action + disclaimer;
  }
```

- [ ] **Step 5: `node --check` app.js**

Run: `cd stock-pwa && node --check app.js`
Expected: không output (PASS).

- [ ] **Step 6: Đồng bộ test — verify bản inline khớp verdict-core**

Run lại: `cd stock-pwa && node --test tests/verdict.test.mjs`
Expected: vẫn PASS (verdict-core.mjs là nguồn test, không đổi). Đây là cổng chống lệch logic.

- [ ] **Step 7: Báo cáo (KHÔNG tự commit)**

Dừng, báo diff app.js. Đề nghị user mở PWA bấm thử tab "Nên mua?" trên vài mã.

---

### Task 3: CSS cho tab verdict + kiểm thử thủ công

**Files:**
- Modify: `style.css` — thêm `.vd-pillars/.vd-pillar/.vd-fc-row` (cuối file, cạnh `.ta-verdict`).

**Interfaces:**
- Consumes: class names do Task 2 render (`vd-pillars`, `vd-pillar`, `vd-up/down/flat`, `vd-fc-row`).
- Produces: tab hiển thị gọn trên mobile.

- [ ] **Step 1: Thêm CSS**

Append vào `style.css`:
```css
/* ── Buy Verdict tab ── */
.vd-pillars { display: flex; flex-direction: column; gap: 6px; }
.vd-pillar {
  display: flex; justify-content: space-between; align-items: center;
  padding: 6px 10px; border-radius: 4px; font-size: 13px;
  background: rgba(255,255,255,0.02); border-left: 2px solid #888;
}
.vd-pillar.vd-up   { border-left-color: #66bb6a; }
.vd-pillar.vd-down { border-left-color: #ef5350; }
.vd-pillar.vd-flat { border-left-color: #888; }
.vd-pillar b { font-size: 14px; }
.vd-pillar.vd-up b   { color: #66bb6a; }
.vd-pillar.vd-down b { color: #ef5350; }
.vd-reasons { display: flex; flex-wrap: wrap; gap: 6px; }
.vd-fc-row {
  display: flex; align-items: baseline; gap: 8px;
  padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.05);
}
.vd-fc-row span { flex: 1; font-size: 13px; color: #ccc; }
.vd-fc-row b { font-size: 15px; font-weight: 700; }
.vd-fc-row b.up   { color: #66bb6a; }
.vd-fc-row b.down { color: #ef5350; }
.vd-fc-row small { color: #888; font-size: 11px; }
```

- [ ] **Step 2: Kiểm thử thủ công qua PWA**

Mở PWA (serve thư mục stock-pwa hoặc mở index.html), phân tích lần lượt:
- 1 mã uptrend mạnh (vd `FPT`) → tab "Nên mua?": badge nghiêng mua, forecast 5/10/20 có số, 4 trụ hiện điểm, không vỡ layout.
- 1 mã đang giảm → badge nghiêng tránh, trụ Rủi ro âm, chip cảnh báo ⚠.
- 1 mã ít dữ liệu / mới niêm yết (nếu có) → block dự báo hiện "không đủ dữ liệu" hoặc fallback ATR, không lỗi console.
Check DevTools Console: không error.

- [ ] **Step 3: `node --check` toàn bộ JS**

Run: `cd stock-pwa && for f in app.js analysis.js ranking.js portfolio.js auth.js; do node --check "$f" && echo "$f OK"; done`
Expected: tất cả OK (bỏ qua file không tồn tại).

- [ ] **Step 4: Báo cáo + chốt (KHÔNG tự commit)**

Dừng, tổng kết: file đã đổi (`app.js`, `style.css`, `tests/verdict.test.mjs`, `verdict-core.mjs`), kết quả test + kiểm thử thủ công. Để user review diff và tự commit.

---

### Task 4: Walk-forward backtest — kiểm chứng verdict CÓ edge không

**Files:**
- Create: `tests/verdict-backtest.mjs` (node script, tự fetch VNDirect, no-DOM).

**Interfaces:**
- Consumes: `computeBuyVerdict`, `computeSetupForwardReturn` từ `../verdict-core.mjs` (Task 1).
  CHÚ Ý: `computeBuyVerdict` nhận object `r` đầy đủ. Backtest KHÔNG có `ANALYSIS.analyze`,
  nên phải tự dựng `r` tối thiểu từ OHLCV (chỉ các trường verdict đọc — xem Step 2).
- Produces: bảng in ra stdout — forward return trung bình theo bias-bucket + calibration forecast.

**Mục tiêu kiểm chứng (pass/fail rõ ràng):**
- **Monotonicity:** bucket bias cao (>65) có forward-return-20p trung bình **> bucket trung tính > bucket thấp (<35)**. Nếu đảo ngược / phẳng → verdict KHÔNG có edge.
- **Calibration:** median forecast (history method) vs forward thực tế cùng dấu phần lớn thời gian.

- [ ] **Step 1: Helper dựng `r` tối thiểu từ OHLCV (tránh look-ahead)**

Tạo `tests/verdict-backtest.mjs`. Đầu file — fetch + indicator tối thiểu để build `r` mà `computeBuyVerdict` cần (`current, ma200, trendDir, dayChange, rsi, macd, stoch, bbPos, posIn52w, mfi, foreignTrend, volRatio, adx, flags`). Foreign flow KHÔNG có trong dchart-api → set `foreignTrend = null` (verdict tự bỏ qua trụ đó, chấp nhận: backtest đo edge của phần kỹ thuật, không phải NN).

```js
import assert from "node:assert";
import { computeBuyVerdict, computeSetupForwardReturn } from "../verdict-core.mjs";

const API = "https://dchart-api.vndirect.com.vn/dchart/history";
const SYMBOLS = ["FPT","VCB","HPG","MWG","SSI","VHM","MBB","VND","DGC","GAS"]; // mẫu VN30

async function fetchAll(symbol, days = 1200) {
  const to = Math.floor(Date.now() / 1000);
  const from = to - days * 24 * 3600;
  const res = await fetch(`${API}?resolution=D&symbol=${symbol}&from=${from}&to=${to}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${symbol}`);
  const d = await res.json();
  if (d.s !== "ok" || !d.c?.length) throw new Error(`no data ${symbol}`);
  return { opens: d.o, highs: d.h, lows: d.l, closes: d.c, volumes: d.v };
}

// Indicator tối thiểu tính ĐẾN index `end` (data ≤ end → no look-ahead)
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
  const e = (per) => { const k = 2 / (per + 1); let v = c[end - per * 2]; for (let i = end - per * 2 + 1; i <= end; i++) v = c[i] * k + v * (1 - k); return v; };
  const macd = e(12) - e(26);
  return { hist: macd, macd, signal: macd * 0.8 }; // xấp xỉ — chỉ cần dấu cho verdict
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
```

- [ ] **Step 2: Vòng walk-forward + gom bucket**

Append:
```js
function avg(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }

async function run() {
  const buckets = { low: [], mid: [], high: [] };      // forward-20p theo bias
  const calib = [];                                     // {fc, real} cho history method
  for (const sym of SYMBOLS) {
    let data;
    try { data = await fetchAll(sym); } catch (e) { console.error("skip", sym, e.message); continue; }
    const n = data.closes.length;
    // Sub-history ≤ i: chỉ truyền slice để no look-ahead
    for (let i = 220; i <= n - 21; i += 5) {            // bước 5 phiên cho nhẹ
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
      if (fc && fc.method === "history" && fc.horizons.h20) calib.push({ fc: fc.horizons.h20.median, real: fwd20 });
    }
    console.error("done", sym, n, "bars");
  }

  console.log("\n=== Forward 20-phiên trung bình theo bias-bucket ===");
  console.log(`bias <35 (n=${buckets.low.length}):  ${avg(buckets.low)?.toFixed(2)}%`);
  console.log(`bias 35-65 (n=${buckets.mid.length}): ${avg(buckets.mid)?.toFixed(2)}%`);
  console.log(`bias >65 (n=${buckets.high.length}):  ${avg(buckets.high)?.toFixed(2)}%`);

  const hi = avg(buckets.high), lo = avg(buckets.low);
  const monotone = hi != null && lo != null && hi > lo;
  console.log(`\nMonotonicity (high > low forward): ${monotone ? "PASS ✓ có edge" : "FAIL ✗ KHÔNG edge"}`);

  const sameSign = calib.filter((x) => Math.sign(x.fc) === Math.sign(x.real)).length;
  console.log(`Calibration: forecast cùng dấu thực tế ${sameSign}/${calib.length} (${calib.length ? ((sameSign / calib.length) * 100).toFixed(0) : "--"}%)`);
}
run();
```

- [ ] **Step 3: Chạy backtest**

Run: `cd stock-pwa && node tests/verdict-backtest.mjs`
Expected: in 3 dòng bucket + dòng Monotonicity + Calibration. Cần mạng (fetch VNDirect). Nếu fetch fail toàn bộ (CORS/blocked từ node) → ghi nhận, fallback dùng data mock hoặc báo user chạy ở môi trường có mạng.

- [ ] **Step 4: Diễn giải kết quả + quyết định**

- **Nếu Monotonicity PASS** (bias>65 forward > bias<35 forward, chênh ≥ ~1%): verdict có edge yếu → giữ UI badge %, OK.
- **Nếu FAIL hoặc phẳng** (chênh < 0.5% hoặc đảo): verdict KHÔNG đủ tin → **hạ tông UI**: bỏ con số "Nghiêng mua N%", đổi badge thành nhãn định tính ("Tín hiệu tích cực/tiêu cực") + giữ 4 trụ và forward-stat như thông tin tham khảo, KHÔNG tuyên bố xác suất. Ghi kết luận vào cuối plan.
- Forward-return (`computeSetupForwardReturn`) là thống kê lịch sử thật → giữ nguyên bất kể kết quả, chỉ chỉnh cách diễn giải.

- [ ] **Step 5: Báo cáo (KHÔNG tự commit)**

Dừng, dán output backtest + kết luận edge/no-edge + đề xuất chỉnh UI nếu cần. Chờ user quyết.

---

## Self-Review (đã chạy)

- **Spec coverage:** tab thứ 3 "Nên mua?" (T2/T3), verdict 4 trụ không phán MUA/BÁN (T1/T2 `computeBuyVerdict`), forward-return setup-based mới + fallback ATR (T1 `computeSetupForwardReturn`), bỏ dữ liệu backtest cũ (Global Constraints + chỉ đọc trường thô), không fetch thêm (đọc `currentData`/`r`), disclaimer + xử lý null (T2 Step 4). Vùng tham chiếu dùng support/resistance/stopLoss thô, KHÔNG dùng buyZone cũ. ✓
- **Placeholder scan:** không có TBD/TODO; mọi step có code thật. ✓
- **Type consistency:** `computeBuyVerdict` trả `{bias, level, label, score, pillars[], reasons[]}` — render dùng `v.level/v.label/v.bias/v.pillars/v.reasons` khớp. `computeSetupForwardReturn` trả `{horizons:{h5,h10,h20}, method, atrPct}` — render dùng `fwd.horizons.h5/.method/.atrPct` + `h.median/p25/p75/n` khớp. ✓
- **Lỗi đã sửa inline:** thứ tự if-bias (strong trước mild) — Task 1 Step 4 sửa rõ. ✓
- **Backtest (Task 4):** walk-forward no-look-ahead trên 10 mã VN30, gom bias-bucket vs forward-20p, kiểm monotonicity + calibration. Có nhánh quyết định hạ tông UI nếu no-edge. `computeBuyVerdict` đọc được `r` tối thiểu (foreignTrend/stoch/adx=null → tự bỏ qua, an toàn vì mọi nhánh đều guard null). ✓
