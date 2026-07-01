// verdict-core.js — UMD: chạy được cả browser (window.__SSI_VERDICT__) lẫn node (require).
// 1 bản logic dùng chung cho app + test, tránh lặp code.
(function () {
  "use strict";

  // ── Indicator helpers (thuần, không phụ thuộc analysis.js) ──
  function rsiAt(closes, end, period) {
    if (period === undefined) period = 14;
    if (end < period) return null;
    var gains = 0, losses = 0;
    for (var i = end - period + 1; i <= end; i++) {
      var d = closes[i] - closes[i - 1];
      if (d > 0) gains += d; else losses -= d;
    }
    var avgG = gains / period, avgL = losses / period;
    if (avgL === 0) return 100;
    return 100 - 100 / (1 + avgG / avgL);
  }

  function smaAt(arr, end, period) {
    if (end < period - 1) return null;
    var s = 0;
    for (var i = end - period + 1; i <= end; i++) s += arr[i];
    return s / period;
  }

  function atrAt(highs, lows, closes, end, period) {
    if (period === undefined) period = 14;
    if (end < period) return null;
    var s = 0;
    for (var i = end - period + 1; i <= end; i++) {
      var tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      );
      s += tr;
    }
    return s / period;
  }

  function adxTierAt(highs, lows, closes, end, period) {
    if (period === undefined) period = 14;
    // Proxy trend strength qua ADX Wilder rút gọn — chỉ cần tier weak/forming/strong cho signature
    if (end < period * 2) return "weak";
    var trs = [], pdm = [], mdm = [];
    for (var i = end - period * 2 + 1; i <= end; i++) {
      var tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
      var up = highs[i] - highs[i - 1], dn = lows[i - 1] - lows[i];
      trs.push(tr); pdm.push(up > dn && up > 0 ? up : 0); mdm.push(dn > up && dn > 0 ? dn : 0);
    }
    var sTR = 0, sP = 0, sM = 0;
    for (var j = 0; j < period; j++) { sTR += trs[j]; sP += pdm[j]; sM += mdm[j]; }
    var dxs = [];
    for (var k = period; k < trs.length; k++) {
      sTR = sTR - sTR / period + trs[k];
      sP = sP - sP / period + pdm[k];
      sM = sM - sM / period + mdm[k];
      var pDI = sTR ? (100 * sP) / sTR : 0, mDI = sTR ? (100 * sM) / sTR : 0;
      var sum = pDI + mDI;
      dxs.push(sum ? (100 * Math.abs(pDI - mDI)) / sum : 0);
    }
    if (!dxs.length) return "weak";
    var adx = dxs.reduce(function (a, b) { return a + b; }, 0) / dxs.length;
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
    var ma50 = smaAt(closes, end, 50);
    var rsi = rsiAt(closes, end);
    var volSma = smaAt(volumes, end, 20);
    var vRatio = volSma ? volumes[end] / volSma : 1;
    return {
      maPos: ma50 == null ? "na" : closes[end] >= ma50 ? "above" : "below",
      rsiBucket: rsiBucketOf(rsi),
      adxTier: adxTierAt(highs, lows, closes, end),
      volTier: vRatio < 0.8 ? "low" : vRatio > 1.5 ? "high" : "normal",
    };
  }

  function matchScore(a, b) {
    var m = 0;
    if (a.maPos === b.maPos) m++;
    if (a.rsiBucket === b.rsiBucket) m++;
    if (a.adxTier === b.adxTier) m++;
    if (a.volTier === b.volTier) m++;
    return m;
  }

  function quantile(sorted, q) {
    if (!sorted.length) return null;
    var pos = (sorted.length - 1) * q;
    var lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  function statsOf(arr) {
    if (arr.length < 5) return null;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    return { median: quantile(s, 0.5), p25: quantile(s, 0.25), p75: quantile(s, 0.75), n: arr.length };
  }

  function computeSetupForwardReturn(closes, highs, lows, volumes) {
    var n = closes.length;
    if (n < 50) return null;
    var end = n - 1;
    var today = signatureAt(closes, highs, lows, volumes, end);

    var r5 = [], r10 = [], r20 = [];
    // Quét lịch sử, cần forward window 20 → dừng ở n-21. Bắt đầu sau khi đủ MA50.
    for (var i = 50; i <= n - 21; i++) {
      var sig = signatureAt(closes, highs, lows, volumes, i);
      if (matchScore(sig, today) < 3) continue;
      var base = closes[i];
      if (!base || base <= 0) continue;
      r5.push(((closes[i + 5] - base) / base) * 100);
      r10.push(((closes[i + 10] - base) / base) * 100);
      r20.push(((closes[i + 20] - base) / base) * 100);
    }

    var atr = atrAt(highs, lows, closes, end);
    // Guard giá=0 (mã hủy niêm yết) → tránh Infinity leak vào band ATR
    var atrPct = atr && closes[end] > 0 ? (atr / closes[end]) * 100 : null;
    var h5 = statsOf(r5), h10 = statsOf(r10), h20 = statsOf(r20);

    if (h5 && h10 && h20) {
      return { signature: today, horizons: { h5: h5, h10: h10, h20: h20 }, method: "history", atrPct: atrPct };
    }

    // Fallback: ATR-projection. Biên độ ±atrPct·√k, không lệch hướng (verdict layer lo bias).
    var proj = function (k) {
      if (atrPct == null) return null;
      var band = atrPct * Math.sqrt(k);
      return { median: 0, p25: -band, p75: band, n: (r5.length || 0) };
    };
    return {
      signature: today,
      horizons: { h5: proj(5), h10: proj(10), h20: proj(20) },
      method: "atr-fallback",
      atrPct: atrPct,
    };
  }

  // ── describeState: MÔ TẢ trạng thái kỹ thuật khách quan, KHÔNG dự báo/khuyến nghị ──
  // Lý do bỏ scoring: backtest (2026-06/07) chứng minh bias tổng hợp KHÔNG có edge —
  // thực tế còn đảo ngược (bias cao → forward thấp nhất). Cả pullback-detector cũng
  // fail vs baseline. Nên tab chỉ mô tả "đang ở trạng thái gì", không phán "nên mua".
  // Mỗi nhóm trả { label, tone } — tone: "pos"|"neg"|"neutral"|"warn" chỉ để tô màu mô tả.
  function describeState(r) {
    var groups = [];

    // Xu hướng — vị trí giá vs MA + độ mạnh trend
    var trendTxt, trendTone;
    if (r.trendDir === "up") { trendTxt = "Uptrend — giá trên MA20 > MA50"; trendTone = "pos"; }
    else if (r.trendDir === "up-weak") { trendTxt = "Uptrend yếu — MA20 > MA50 nhưng giá dưới MA20"; trendTone = "neutral"; }
    else if (r.trendDir === "down") { trendTxt = "Downtrend — giá dưới MA20 < MA50"; trendTone = "neg"; }
    else if (r.trendDir === "down-weak") { trendTxt = "Downtrend yếu"; trendTone = "neutral"; }
    else { trendTxt = "Đi ngang / trung tính"; trendTone = "neutral"; }
    if (r.ma200 != null) trendTxt += r.current > r.ma200 ? " · trên MA200 (dài hạn tăng)" : " · dưới MA200 (dài hạn giảm)";
    if (r.adx && r.adx.adx >= 25) trendTxt += " · ADX " + r.adx.adx.toFixed(0) + (r.adx.plusDI > r.adx.minusDI ? " (+DI mạnh)" : " (-DI mạnh)");
    groups.push({ key: "trend", label: "Xu hướng", text: trendTxt, tone: trendTone });

    // Động lượng — RSI/MACD/Stoch
    var momTxt, momTone = "neutral";
    if (r.rsi != null) {
      if (r.rsi < 30) { momTxt = "Quá bán — RSI " + r.rsi.toFixed(0); momTone = "warn"; }
      else if (r.rsi > 70) { momTxt = "Quá mua — RSI " + r.rsi.toFixed(0); momTone = "warn"; }
      else if (r.rsi < 45) { momTxt = "Nghiêng yếu — RSI " + r.rsi.toFixed(0); }
      else if (r.rsi > 55) { momTxt = "Nghiêng mạnh — RSI " + r.rsi.toFixed(0); }
      else { momTxt = "Trung tính — RSI " + r.rsi.toFixed(0); }
    } else { momTxt = "Không đủ dữ liệu RSI"; }
    if (r.macd && r.macd.hist > 0 && r.macd.macd > r.macd.signal) momTxt += " · MACD dương trên signal";
    else if (r.macd && r.macd.hist < 0) momTxt += " · MACD âm";
    if (r.stoch && r.stoch.k < 20) momTxt += " · Stochastic quá bán";
    else if (r.stoch && r.stoch.k > 80) momTxt += " · Stochastic quá mua";
    groups.push({ key: "momentum", label: "Động lượng", text: momTxt, tone: momTone });

    // Vị trí giá — trong dải 52w + BB
    var posTxt, posTone = "neutral";
    if (Number.isFinite(r.posIn52w)) {
      if (r.posIn52w > 85) { posTxt = "Gần đỉnh 52 tuần (" + r.posIn52w.toFixed(0) + "% dải)"; posTone = "warn"; }
      else if (r.posIn52w < 25) { posTxt = "Gần đáy 52 tuần (" + r.posIn52w.toFixed(0) + "% dải)"; posTone = "warn"; }
      else { posTxt = r.posIn52w.toFixed(0) + "% dải 52 tuần"; }
    } else { posTxt = "Không đủ dữ liệu 52 tuần"; }
    if (r.bbPos === "upper") posTxt += " · trên Bollinger trên";
    else if (r.bbPos === "lower") posTxt += " · dưới Bollinger dưới";
    groups.push({ key: "position", label: "Vị trí giá", text: posTxt, tone: posTone });

    // Dòng tiền — NN + volume + MFI
    var flowTxt, flowTone = "neutral";
    if (r.foreignTrend === "buying") { flowTxt = "Khối ngoại mua ròng"; flowTone = "pos"; }
    else if (r.foreignTrend === "selling") { flowTxt = "Khối ngoại bán ròng"; flowTone = "neg"; }
    else { flowTxt = "Khối ngoại trung tính / không có dữ liệu"; }
    if (r.mfi != null) { if (r.mfi < 20) flowTxt += " · MFI quá bán"; else if (r.mfi > 80) flowTxt += " · MFI quá mua"; }
    if (r.volRatio != null) flowTxt += " · volume " + r.volRatio.toFixed(1) + "x TB";
    groups.push({ key: "flow", label: "Dòng tiền", text: flowTxt, tone: flowTone });

    // Cảnh báo rủi ro — flags (chỉ hiện khi có)
    var warns = [];
    var f = r.flags || {};
    if (f.sellPressure) warns.push("Áp lực bán (vol cao + giảm mạnh)");
    if (f.deepDowntrend) warns.push("Downtrend sâu (giá << MA50)");
    if (f.bearTrap) warns.push("Bear trap (ADX cao, -DI > +DI)");
    if (f.lowVol) warns.push("Thanh khoản thấp");

    return { groups: groups, warns: warns };
  }

  var __api = { describeState: describeState, computeSetupForwardReturn: computeSetupForwardReturn };

  // Browser: gán global
  if (typeof window !== "undefined") window.__SSI_VERDICT__ = __api;
  // Node/CommonJS: export để test require được
  if (typeof module !== "undefined" && module.exports) module.exports = { describeState: describeState, computeSetupForwardReturn: computeSetupForwardReturn };
})();
