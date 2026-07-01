const { test } = require("node:test");
const assert = require("node:assert");
const { describeState, computeSetupForwardReturn } = require("../verdict-core.js");

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

// describeState: mô tả khách quan (KHÔNG dự báo, KHÔNG bias%). Chỉ assert shape + tone hợp lý.
test("describeState uptrend → nhóm xu hướng tone pos, không có bias/khuyến nghị", () => {
  const r = {
    current: 100, ma200: 80, trendDir: "up", dayChange: 1.2,
    rsi: 58, macd: { hist: 0.5, macd: 1, signal: 0.5 },
    stoch: { k: 60, d: 55 }, bbPos: "middle-upper", posIn52w: 70,
    mfi: 60, foreignTrend: "buying", volRatio: 1.8,
    adx: { adx: 30, plusDI: 28, minusDI: 12 }, flags: {},
  };
  const s = describeState(r);
  assert.equal(s.groups.length, 4, "4 nhóm mô tả: trend/momentum/position/flow");
  const trend = s.groups.find((g) => g.key === "trend");
  assert.equal(trend.tone, "pos");
  assert.ok(/Uptrend/.test(trend.text));
  const flow = s.groups.find((g) => g.key === "flow");
  assert.ok(/mua ròng/.test(flow.text));
  // KHÔNG được có field dự báo/bias
  assert.equal(s.bias, undefined);
  assert.equal(s.label, undefined);
});

test("describeState downtrend + rủi ro → warns không rỗng, tone neg", () => {
  const r = {
    current: 50, ma200: 80, trendDir: "down", dayChange: -3,
    rsi: 38, macd: { hist: -0.5, macd: -1, signal: -0.5 },
    stoch: { k: 40, d: 50 }, bbPos: "middle-lower", posIn52w: 20,
    mfi: 45, foreignTrend: "selling", volRatio: 2.0,
    adx: { adx: 40, plusDI: 10, minusDI: 30 },
    flags: { sellPressure: true, deepDowntrend: true },
  };
  const s = describeState(r);
  const trend = s.groups.find((g) => g.key === "trend");
  assert.equal(trend.tone, "neg");
  assert.ok(s.warns.length >= 2, "có cảnh báo sellPressure + deepDowntrend");
  assert.ok(s.warns.some((w) => /Áp lực bán/.test(w)));
});

test("describeState không leak NaN khi posIn52w là NaN (dải 52w phẳng)", () => {
  const r = {
    current: 50, ma200: 48, trendDir: "up", dayChange: 0,
    rsi: 55, macd: null, stoch: null, bbPos: null,
    posIn52w: NaN, mfi: null, foreignTrend: null, volRatio: null, adx: null, flags: {},
  };
  const s = describeState(r);
  const pos = s.groups.find((g) => g.key === "position");
  assert.ok(!/NaN/.test(pos.text), `không được có NaN: "${pos.text}"`);
});

test("describeState null-safe khi thiếu adx/stoch/foreignTrend", () => {
  const r = {
    current: 50, ma200: null, trendDir: "neutral", dayChange: 0,
    rsi: null, macd: null, stoch: null, bbPos: null, posIn52w: null,
    mfi: null, foreignTrend: null, volRatio: null, adx: null, flags: null,
  };
  const s = describeState(r);
  assert.equal(s.groups.length, 4);
  assert.equal(s.warns.length, 0);
});
