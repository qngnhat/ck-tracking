// ── SSI ETF Helper — Stock Analysis Module ──
// Technical analysis using free public APIs (VNDirect)

window.__SSI_ANALYSIS__ = (function () {
  "use strict";

  const API_BASE = "https://dchart-api.vndirect.com.vn/dchart";

  // Indices (không phân tích được)
  const INDEX_SYMBOLS = new Set([
    "VNINDEX", "VN30", "HNX30", "VNXALL", "HNXIndex", "HNXUpcomIndex",
    "HNXINDEX", "UPCOM", "HNX", "VN100",
  ]);

  // ── Validate symbol ──
  function isValidSymbol(symbol) {
    if (!symbol) return false;
    if (INDEX_SYMBOLS.has(symbol.toUpperCase())) return false;
    // Vietnamese stocks: 3 uppercase letters. ETFs: 6-8 chars (E1VFVN30, FUEVFVND)
    return /^[A-Z][A-Z0-9]{2,9}$/.test(symbol);
  }

  // ── Fetch history (VNDirect dchart API, TradingView format) ──
  // resolution: "W" | "D" | "60" | "15" | "5" | "1"
  async function fetchHistory(symbol, resolution = "D", days = 250) {
    const to = Math.floor(Date.now() / 1000);
    const from = to - days * 24 * 3600;
    const url = `${API_BASE}/history?resolution=${resolution}&symbol=${symbol}&from=${from}&to=${to}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    if (data.s !== "ok" || !data.c || data.c.length === 0) {
      throw new Error("Không có dữ liệu lịch sử");
    }

    return {
      times: data.t,
      opens: data.o,
      highs: data.h,
      lows: data.l,
      closes: data.c,
      volumes: data.v,
      resolution,
    };
  }

  // ── RSI (Wilder's smoothing, default 14) ──
  function calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return null;

    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff;
      else losses -= diff;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? -diff : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  // ── Simple Moving Average (latest N points) ──
  function calculateSMA(values, period) {
    if (values.length < period) return null;
    const slice = values.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
  }

  // ── Support & Resistance (pivot-based from recent N days) ──
  function findSupportResistance(highs, lows, closes, lookback = 60) {
    const recentHighs = highs.slice(-lookback);
    const recentLows = lows.slice(-lookback);
    const current = closes[closes.length - 1];

    // Recent swing highs/lows
    const sortedHighs = [...recentHighs].sort((a, b) => b - a);
    const sortedLowsAsc = [...recentLows].sort((a, b) => a - b);

    // Resistance = nearest high above current
    const resistance = sortedHighs.find(h => h > current) || sortedHighs[0];
    // Support = nearest swing low BELOW current. Có thể null nếu giá vừa rơi
    // xuyên qua tất cả swing low gần đây (case crash mạnh).
    const supportRaw = [...sortedLowsAsc].reverse().find(l => l < current);
    const support = supportRaw ?? null;
    // effectiveSupport: anchor cho SL/buy-zone math, luôn < current.
    // Khi support null → fallback current * 0.93 (xấp xỉ -7%) hoặc lowest low (cái nào thấp hơn).
    const effectiveSupport = supportRaw ?? Math.min(current * 0.93, sortedLowsAsc[0]);

    return { support, resistance, effectiveSupport };
  }

  // ── 52-week high/low ──
  function find52Week(highs, lows) {
    // Approximate: last 250 trading days
    const period = Math.min(250, highs.length);
    return {
      high: Math.max(...highs.slice(-period)),
      low: Math.min(...lows.slice(-period)),
    };
  }

  // ── Average volume (last 20 days) ──
  function avgVolume(volumes, period = 20) {
    return calculateSMA(volumes, period);
  }

  // ── EMA series ──
  function calculateEMA(values, period) {
    if (values.length < period) return [];
    const k = 2 / (period + 1);
    const result = [];
    let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    result.push(ema);
    for (let i = period; i < values.length; i++) {
      ema = values[i] * k + ema * (1 - k);
      result.push(ema);
    }
    return result;
  }

  // ── MACD (12, 26, 9) ──
  function calculateMACD(closes, fast = 12, slow = 26, signal = 9) {
    if (closes.length < slow + signal) return null;
    const emaFast = calculateEMA(closes, fast);
    const emaSlow = calculateEMA(closes, slow);
    const offset = slow - fast;
    const macdLine = [];
    for (let i = 0; i < emaSlow.length; i++) {
      macdLine.push(emaFast[i + offset] - emaSlow[i]);
    }
    const signalLine = calculateEMA(macdLine, signal);
    const macd = macdLine[macdLine.length - 1];
    const sig = signalLine[signalLine.length - 1];
    const hist = macd - sig;
    const prevHist = macdLine[macdLine.length - 2] - signalLine[signalLine.length - 2];
    return { macd, signal: sig, hist, histTurning: Math.sign(hist) !== Math.sign(prevHist) };
  }

  // ── Bollinger Bands (20, 2) ──
  function calculateBB(closes, period = 20, stdMult = 2) {
    if (closes.length < period) return null;
    const slice = closes.slice(-period);
    const middle = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((sum, x) => sum + (x - middle) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    const upper = middle + std * stdMult;
    const lower = middle - std * stdMult;
    return {
      upper,
      middle,
      lower,
      widthPct: ((upper - lower) / middle) * 100,
    };
  }

  // ── Performance over periods ──
  function calculatePerformance(closes) {
    const current = closes[closes.length - 1];
    const periods = { "1t": 5, "1th": 21, "3th": 63, "6th": 126, "1n": 252 };
    const perf = {};
    for (const [label, days] of Object.entries(periods)) {
      if (closes.length > days) {
        const past = closes[closes.length - 1 - days];
        perf[label] = ((current - past) / past) * 100;
      } else {
        perf[label] = null;
      }
    }
    return perf;
  }

  // ── Distance from MA (percentage) ──
  function distanceFromMA(current, ma) {
    if (!ma) return null;
    return ((current - ma) / ma) * 100;
  }

  // ── True Range ──
  function trueRange(h, l, prevClose) {
    return Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
  }

  // ── ATR (Average True Range, Wilder's smoothing) ──
  function calculateATR(highs, lows, closes, period = 14) {
    if (highs.length < period + 1) return null;
    const trList = [];
    for (let i = 1; i < highs.length; i++) {
      trList.push(trueRange(highs[i], lows[i], closes[i - 1]));
    }
    let atr = trList.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < trList.length; i++) {
      atr = (atr * (period - 1) + trList[i]) / period;
    }
    return atr;
  }

  // ── ADX (Average Directional Index) ──
  function calculateADX(highs, lows, closes, period = 14) {
    if (highs.length < period * 2 + 1) return null;

    const trs = [], plusDMs = [], minusDMs = [];
    for (let i = 1; i < highs.length; i++) {
      const tr = trueRange(highs[i], lows[i], closes[i - 1]);
      const upMove = highs[i] - highs[i - 1];
      const downMove = lows[i - 1] - lows[i];
      const plusDM = upMove > downMove && upMove > 0 ? upMove : 0;
      const minusDM = downMove > upMove && downMove > 0 ? downMove : 0;
      trs.push(tr);
      plusDMs.push(plusDM);
      minusDMs.push(minusDM);
    }

    // Wilder smoothing for TR/+DM/-DM
    let sTR = trs.slice(0, period).reduce((a, b) => a + b, 0);
    let sPlusDM = plusDMs.slice(0, period).reduce((a, b) => a + b, 0);
    let sMinusDM = minusDMs.slice(0, period).reduce((a, b) => a + b, 0);

    const dxs = [];
    for (let i = period; i < trs.length; i++) {
      sTR = sTR - sTR / period + trs[i];
      sPlusDM = sPlusDM - sPlusDM / period + plusDMs[i];
      sMinusDM = sMinusDM - sMinusDM / period + minusDMs[i];
      const plusDI = sTR === 0 ? 0 : (100 * sPlusDM) / sTR;
      const minusDI = sTR === 0 ? 0 : (100 * sMinusDM) / sTR;
      const diSum = plusDI + minusDI;
      const dx = diSum === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / diSum;
      dxs.push({ plusDI, minusDI, dx });
    }

    if (dxs.length < period) return null;

    let adx = dxs.slice(0, period).reduce((a, b) => a + b.dx, 0) / period;
    for (let i = period; i < dxs.length; i++) {
      adx = (adx * (period - 1) + dxs[i].dx) / period;
    }

    const last = dxs[dxs.length - 1];
    return { adx, plusDI: last.plusDI, minusDI: last.minusDI };
  }

  // ── Stochastic Oscillator (%K, %D) ──
  function calculateStochastic(highs, lows, closes, kPeriod = 14, dPeriod = 3) {
    if (closes.length < kPeriod + dPeriod) return null;
    const ks = [];
    for (let i = kPeriod - 1; i < closes.length; i++) {
      const highN = Math.max(...highs.slice(i - kPeriod + 1, i + 1));
      const lowN = Math.min(...lows.slice(i - kPeriod + 1, i + 1));
      const k = highN === lowN ? 50 : (100 * (closes[i] - lowN)) / (highN - lowN);
      ks.push(k);
    }
    const lastK = ks[ks.length - 1];
    const lastD = ks.slice(-dPeriod).reduce((a, b) => a + b, 0) / dPeriod;
    return { k: lastK, d: lastD };
  }

  // ── MFI (Money Flow Index) ──
  function calculateMFI(highs, lows, closes, volumes, period = 14) {
    if (closes.length < period + 1) return null;
    const tps = closes.map((c, i) => (highs[i] + lows[i] + closes[i]) / 3);
    let posFlow = 0, negFlow = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
      const rmf = tps[i] * volumes[i];
      if (tps[i] > tps[i - 1]) posFlow += rmf;
      else if (tps[i] < tps[i - 1]) negFlow += rmf;
    }
    if (negFlow === 0) return 100;
    const ratio = posFlow / negFlow;
    return 100 - 100 / (1 + ratio);
  }

  // ── Fetch full stock list (for autocomplete) ──
  async function fetchStockList() {
    const url = "https://api-finfo.vndirect.com.vn/v4/stocks?q=status:LISTED&size=3000&sort=code";
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.data) return [];

    // Keep only STOCK and ETF types (skip indices, futures, warrants...)
    return json.data
      .filter((s) => s.type === "STOCK" || s.type === "ETF")
      .map((s) => ({
        code: s.code,
        name: s.companyNameVi || s.companyName || "",
        floor: s.floor || "",
        type: s.type || "STOCK",
      }));
  }

  // ── Fetch fundamentals (VNDirect) ──
  async function fetchFundamentals(symbol) {
    try {
      const url = `https://api-finfo.vndirect.com.vn/v4/ratios/latest?filter=code:${symbol}&size=50`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const json = await res.json();
      if (!json.data || json.data.length === 0) return null;

      // Map itemCode -> field name (VNDirect's schema)
      const MAP = {
        "51003": "pe",     // P/E
        "51006": "pb",     // P/B
        "53001": "eps",    // EPS
        "53004": "bvps",   // Book value per share
        "57001": "roa",    // ROA
        "57003": "roe",    // ROE
        "52001": "marketCap",
      };

      const result = {};
      for (const item of json.data) {
        const key = MAP[item.itemCode];
        if (key && item.value !== null && item.value !== undefined) {
          result[key] = item.value;
        }
      }
      return Object.keys(result).length > 0 ? result : null;
    } catch (e) {
      return null;
    }
  }

  // ── Fetch foreign trading flow (VNDirect) ──
  async function fetchForeignFlow(symbol) {
    try {
      const toDate = new Date().toISOString().split("T")[0];
      const fromDate = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().split("T")[0];
      const url = `https://api-finfo.vndirect.com.vn/v4/foreign_trade_summary?q=code:${symbol}~tradingDate:gte:${fromDate}~tradingDate:lte:${toDate}&size=30&sort=tradingDate:desc`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const json = await res.json();
      if (!json.data || json.data.length === 0) return null;

      const rows = json.data;
      const today = rows[0];
      const sum5 = rows.slice(0, 5).reduce((a, b) => a + (b.netVal || 0), 0);
      const sum10 = rows.slice(0, 10).reduce((a, b) => a + (b.netVal || 0), 0);
      const sum20 = rows.slice(0, 20).reduce((a, b) => a + (b.netVal || 0), 0);

      // Count positive vs negative days in last 10
      const last10 = rows.slice(0, 10);
      const positiveDays = last10.filter(r => (r.netVal || 0) > 0).length;
      const negativeDays = last10.filter(r => (r.netVal || 0) < 0).length;

      return {
        todayNet: today.netVal || 0,
        todayBuyVol: today.buyForeignQuantity || today.buyVol || 0,
        todaySellVol: today.sellForeignQuantity || today.sellVol || 0,
        sum5, sum10, sum20,
        positiveDays, negativeDays,
        days: rows.length,
      };
    } catch (e) {
      return null;
    }
  }

  // ── Main analyze function ──
  function analyze(symbol, data, extras = {}) {
    const { highs, lows, closes, volumes } = data;
    const current = closes[closes.length - 1];
    const prevClose = closes[closes.length - 2];
    const dayChange = ((current - prevClose) / prevClose) * 100;

    const rsi = calculateRSI(closes);
    const ma20 = calculateSMA(closes, 20);
    const ma50 = calculateSMA(closes, 50);
    const ma200 = calculateSMA(closes, 200);
    const distMA20 = distanceFromMA(current, ma20);
    const distMA50 = distanceFromMA(current, ma50);
    const distMA200 = distanceFromMA(current, ma200);
    const macd = calculateMACD(closes);
    const bb = calculateBB(closes);
    const performance = calculatePerformance(closes);
    const { support, resistance, effectiveSupport } = findSupportResistance(highs, lows, closes);
    const w52 = find52Week(highs, lows);
    const avgVol = avgVolume(volumes);
    const currentVol = volumes[volumes.length - 1];
    const volRatio = avgVol ? currentVol / avgVol : 1;

    // New indicators
    const atr = calculateATR(highs, lows, closes);
    const atrPct = atr ? (atr / current) * 100 : null;
    const adx = calculateADX(highs, lows, closes);
    const stoch = calculateStochastic(highs, lows, closes);
    const mfi = calculateMFI(highs, lows, closes, volumes);
    const fundamentals = extras.fundamentals || null;
    const foreignFlow = extras.foreignFlow || null;

    // ── Trend signal ──
    let trend = "Trung tính";
    let trendDir = "neutral";
    if (ma20 && ma50) {
      if (ma20 > ma50 && current > ma20) {
        trend = "Tăng (MA20 > MA50, giá trên MA20)";
        trendDir = "up";
      } else if (ma20 < ma50 && current < ma20) {
        trend = "Giảm (MA20 < MA50, giá dưới MA20)";
        trendDir = "down";
      } else if (ma20 > ma50) {
        trend = "Tăng yếu (MA20 > MA50 nhưng giá dưới MA20)";
        trendDir = "up-weak";
      } else {
        trend = "Giảm yếu";
        trendDir = "down-weak";
      }
    }

    // ── RSI signal ──
    let rsiSignal = "Trung tính";
    if (rsi !== null) {
      if (rsi < 30) rsiSignal = "Quá bán (có thể mua)";
      else if (rsi > 70) rsiSignal = "Quá mua (tránh mua)";
      else if (rsi < 45) rsiSignal = "Gần quá bán";
      else if (rsi > 55) rsiSignal = "Gần quá mua";
    }

    // ── Position in 52w range ──
    const posIn52w = ((current - w52.low) / (w52.high - w52.low)) * 100;

    // ── Recommendation logic (confluence of signals) ──
    let score = 0;
    const reasons = [];

    // RSI: bumped <25 weight per Phase 1.3 backtest (Sharpe 0.68 — strongest signal)
    if (rsi !== null) {
      if (rsi < 25) { score += 3; reasons.push("RSI<25 quá bán mạnh"); }
      else if (rsi < 30) { score += 2; reasons.push("RSI<30 quá bán"); }
      else if (rsi < 45) { score += 1; reasons.push("RSI gần quá bán"); }
      else if (rsi > 75) { score -= 3; reasons.push("RSI>75 quá mua mạnh"); }
      else if (rsi > 70) { score -= 2; reasons.push("RSI>70 quá mua"); }
      else if (rsi > 55) { score -= 1; reasons.push("RSI gần quá mua"); }
    }

    if (trendDir === "up") { score += 2; reasons.push("Xu hướng tăng"); }
    else if (trendDir === "up-weak") { score += 1; }
    else if (trendDir === "down") { score -= 2; reasons.push("Xu hướng giảm"); }
    else if (trendDir === "down-weak") { score -= 1; }

    if (posIn52w < 30) { score += 1; reasons.push("Giá gần đáy 52w"); }
    else if (posIn52w > 85) { score -= 1; reasons.push("Giá gần đỉnh 52w"); }

    // Distance to support/resistance
    const distToSupport = ((current - support) / current) * 100;
    const distToResistance = ((resistance - current) / current) * 100;
    if (distToSupport < 3 && distToSupport > 0) {
      score += 1;
      reasons.push(`Giá gần hỗ trợ (${support.toFixed(0)})`);
    }
    if (distToResistance < 3 && distToResistance > 0) {
      score -= 1;
      reasons.push(`Giá gần kháng cự (${resistance.toFixed(0)})`);
    }

    // MACD: weight dropped per Phase 1.3 backtest (no edge vs random in test set)
    // MACD value still computed and displayed in indicators panel for context,
    // but NOT contributing to recommendation score.

    // Bollinger Bands
    let bbPos = null; // "upper" | "middle-upper" | "middle-lower" | "lower"
    if (bb) {
      if (current > bb.upper) {
        bbPos = "upper";
        score -= 1;
        reasons.push("Giá vượt Bollinger trên");
      } else if (current < bb.lower) {
        bbPos = "lower";
        score += 1;
        reasons.push("Giá dưới Bollinger dưới");
      } else if (current > bb.middle) {
        bbPos = "middle-upper";
      } else {
        bbPos = "middle-lower";
      }
    }

    // MA200 (long-term)
    if (ma200) {
      if (current > ma200) {
        score += 1;
        // Only push reason if not already redundant
        if (trendDir !== "up") reasons.push("Giá trên MA200 (xu hướng dài hạn tăng)");
      } else {
        score -= 1;
        if (trendDir !== "down") reasons.push("Giá dưới MA200 (xu hướng dài hạn giảm)");
      }
    }

    // ADX — trend strength. Only count +DI/-DI signal when ADX >= 25 (real trend)
    let adxStrength = "Đi ngang";
    if (adx) {
      if (adx.adx < 20) adxStrength = "Yếu / đi ngang (ADX < 20)";
      else if (adx.adx < 25) adxStrength = "Trend đang hình thành";
      else if (adx.adx < 50) adxStrength = "Trend mạnh";
      else adxStrength = "Trend rất mạnh";

      if (adx.adx >= 25) {
        if (adx.plusDI > adx.minusDI) {
          score += 1;
          reasons.push(`ADX ${adx.adx.toFixed(0)} (+DI > -DI) — trend tăng mạnh`);
        } else {
          score -= 1;
          reasons.push(`ADX ${adx.adx.toFixed(0)} (+DI < -DI) — trend giảm mạnh`);
        }
      }
    }

    // Stochastic — similar to RSI but more sensitive
    if (stoch) {
      if (stoch.k < 20 && stoch.k > stoch.d) {
        score += 1;
        reasons.push("Stochastic quá bán + K cắt lên D");
      } else if (stoch.k > 80 && stoch.k < stoch.d) {
        score -= 1;
        reasons.push("Stochastic quá mua + K cắt xuống D");
      }
    }

    // MFI — money flow
    if (mfi !== null) {
      if (mfi < 20) { score += 1; reasons.push("MFI quá bán"); }
      else if (mfi > 80) { score -= 1; reasons.push("MFI quá mua"); }
    }

    // Foreign flow — smart money in VN market
    let foreignTrend = null;
    if (foreignFlow) {
      if (foreignFlow.sum10 > 0 && foreignFlow.positiveDays >= 6) {
        foreignTrend = "buying";
        score += 2;
        reasons.push(`Khối ngoại mua ròng ${foreignFlow.positiveDays}/10 phiên`);
      } else if (foreignFlow.sum10 < 0 && foreignFlow.negativeDays >= 6) {
        foreignTrend = "selling";
        score -= 2;
        reasons.push(`Khối ngoại bán ròng ${foreignFlow.negativeDays}/10 phiên`);
      } else {
        foreignTrend = "neutral";
      }
    }

    // Fundamental valuation (for stocks only, not ETFs)
    let valuation = null;
    if (fundamentals && fundamentals.pe) {
      if (fundamentals.pe < 10 && fundamentals.pe > 0) {
        valuation = "cheap";
        score += 1;
        reasons.push(`P/E ${fundamentals.pe.toFixed(1)} thấp (định giá hấp dẫn)`);
      } else if (fundamentals.pe > 25) {
        valuation = "expensive";
        score -= 1;
        reasons.push(`P/E ${fundamentals.pe.toFixed(1)} cao (định giá đắt)`);
      } else {
        valuation = "fair";
      }
    }

    // Volume surge
    if (volRatio > 2) {
      reasons.push(`Volume cao bất thường (${volRatio.toFixed(1)}x trung bình)`);
    } else if (volRatio < 0.5) {
      reasons.push(`Volume thấp (${volRatio.toFixed(1)}x trung bình)`);
    }

    // ── Recommendation labels ──
    // NOTE: Phase 1.4 backtest cho thấy combined scoring system underperform
    // buy-and-hold cả universe. Vì vậy labels được đổi thành "Setup" thay vì
    // "MUA/BÁN" để tránh tạo cảm giác đây là tín hiệu giao dịch chắc chắn.
    // Đây là chỉ báo CHẤT LƯỢNG SETUP KỸ THUẬT, không phải lệnh mua/bán.
    let recommendation, recLevel, recColor;
    if (score >= 4) {
      recommendation = "Setup tốt";
      recLevel = "strong-buy";
      recColor = "#4CAF50";
    } else if (score >= 2) {
      recommendation = "Setup khá";
      recLevel = "buy";
      recColor = "#8BC34A";
    } else if (score >= -1) {
      recommendation = "Trung tính";
      recLevel = "hold";
      recColor = "#FF9800";
    } else if (score >= -3) {
      recommendation = "Setup yếu";
      recLevel = "avoid";
      recColor = "#FF5722";
    } else {
      recommendation = "Cảnh báo rủi ro";
      recLevel = "sell";
      recColor = "#ff4444";
    }

    // ── Suggested buy price ──
    // Hai nhánh: bình thường (support+MA20 đều DƯỚI current → DCA pullback)
    // vs crashed (không có anchor dưới → vùng quan sát hẹp đối xứng)
    let buyZoneLow, buyZoneHigh;
    if (score >= 2) {
      const ma20Below = ma20 && ma20 < current ? ma20 : null;
      const supBelow = support && support < current ? support : null;
      if (supBelow && ma20Below) {
        // Normal pullback: anchor giữa support thật và MA20
        buyZoneLow = Math.max(supBelow, current * 0.95);
        buyZoneHigh = Math.min(ma20Below, current * 1.00);
      } else {
        // Crashed / không có anchor: zone hẹp đối xứng quanh current
        buyZoneLow = current * 0.97;
        buyZoneHigh = current * 1.02;
      }
    }

    // Stop loss: dùng effectiveSupport (luôn < current) thay vì support raw
    // Clamp ATR < current để tránh edge case ATR quá nhỏ
    const slAnchor = effectiveSupport ?? current * 0.93;
    const stopLossATR = atr ? current - 2 * atr : null;
    const stopLossSupport = slAnchor * 0.97;
    const stopLoss = stopLossATR && stopLossATR > 0 && stopLossATR < current
      ? Math.max(stopLossATR, stopLossSupport) // tighter (closer to current)
      : stopLossSupport;

    // ── Risk flags (cho verdict layer + UI chips) ──
    // Tách thành flags object thay vì grep reasons string — dễ scale/test
    const sessionTurnover = current * currentVol * 1000; // price k-VND × vol → VND
    const flags = {
      bearTrap: !!(adx && adx.adx > 45 && adx.minusDI > adx.plusDI),
      lowVol: volRatio > 0 && volRatio < 0.8,
      deepDowntrend: !!(ma50 && current < ma50 * 0.88),
      lowSessionLiq: sessionTurnover < 2e9,
    };

    const result = {
      symbol,
      current,
      dayChange,
      rsi,
      rsiSignal,
      ma20,
      ma50,
      ma200,
      distMA20,
      distMA50,
      distMA200,
      macd,
      bb,
      bbPos,
      atr,
      atrPct,
      adx,
      adxStrength,
      stoch,
      mfi,
      fundamentals,
      foreignFlow,
      foreignTrend,
      valuation,
      performance,
      trend,
      trendDir,
      support,
      resistance,
      w52High: w52.high,
      w52Low: w52.low,
      posIn52w,
      avgVol,
      currentVol,
      volRatio,
      score,
      reasons,
      recommendation,
      recLevel,
      recColor,
      buyZoneLow,
      buyZoneHigh,
      stopLoss,
      flags,
    };

    result.textAnalysis = generateTextAnalysis(result);
    return result;
  }

  // ── Format price helper for text ──
  function fp(n) {
    if (n === null || n === undefined || isNaN(n)) return "--";
    return n.toLocaleString("vi-VN", { maximumFractionDigits: 2 });
  }

  // ── Text analysis generator ──
  function generateTextAnalysis(r) {
    const parts = [];

    // ─ Part 1: Current context + position in 52w ─
    const changeDesc =
      r.dayChange > 3 ? "tăng mạnh"
      : r.dayChange > 0.5 ? "tăng"
      : r.dayChange > -0.5 ? "gần như đi ngang"
      : r.dayChange > -3 ? "giảm"
      : "giảm mạnh";
    const posDesc =
      r.posIn52w < 25 ? "vùng đáy"
      : r.posIn52w < 45 ? "nửa dưới"
      : r.posIn52w < 55 ? "vùng giữa"
      : r.posIn52w < 75 ? "nửa trên"
      : "vùng đỉnh";
    parts.push(
      `<b>${r.symbol}</b> đang giao dịch tại <b>${fp(r.current)}</b>, ${changeDesc} ${Math.abs(r.dayChange).toFixed(2)}% so với phiên trước. ` +
      `Cổ phiếu đang ở <b>${posDesc}</b> của dải 52 tuần (${fp(r.w52Low)} – ${fp(r.w52High)}), tương đương ${r.posIn52w.toFixed(0)}% range.`
    );

    // ─ Part 2: RSI & momentum ─
    let rsiSent = "";
    if (r.rsi === null) {
      rsiSent = "Không đủ dữ liệu để tính RSI.";
    } else if (r.rsi < 30) {
      rsiSent = `<b>RSI ở ${r.rsi.toFixed(1)}</b> — vùng quá bán, thường là vùng mà bên bán đã kiệt sức và có thể xuất hiện nhịp hồi kỹ thuật.`;
    } else if (r.rsi > 70) {
      rsiSent = `<b>RSI ở ${r.rsi.toFixed(1)}</b> — vùng quá mua, cổ phiếu đã tăng nóng và rủi ro điều chỉnh cao.`;
    } else if (r.rsi < 45) {
      rsiSent = `<b>RSI ở ${r.rsi.toFixed(1)}</b> — nghiêng về yếu, gần ngưỡng quá bán nhưng chưa tới.`;
    } else if (r.rsi > 55) {
      rsiSent = `<b>RSI ở ${r.rsi.toFixed(1)}</b> — nghiêng về mạnh, cần theo dõi nếu tiếp tục tăng có thể vào quá mua.`;
    } else {
      rsiSent = `<b>RSI ở ${r.rsi.toFixed(1)}</b> — đang ở vùng trung tính, không cho tín hiệu mua/bán rõ rệt.`;
    }
    parts.push(rsiSent);

    // ─ Part 3: MACD ─
    if (r.macd) {
      if (r.macd.hist > 0 && r.macd.macd > r.macd.signal) {
        const turning = r.macd.histTurning ? " và mới đảo chiều từ âm sang dương — tín hiệu mua kỹ thuật đáng chú ý" : "";
        parts.push(`<b>MACD dương</b> (${r.macd.macd.toFixed(2)}) trên đường tín hiệu (${r.macd.signal.toFixed(2)}), histogram ${r.macd.hist.toFixed(2)} — động lực tăng${turning}.`);
      } else if (r.macd.hist < 0 && r.macd.macd < r.macd.signal) {
        const turning = r.macd.histTurning ? " và mới đảo chiều từ dương sang âm — cảnh báo đảo chiều giảm" : "";
        parts.push(`<b>MACD âm</b> (${r.macd.macd.toFixed(2)}) dưới đường tín hiệu, histogram ${r.macd.hist.toFixed(2)} — động lực giảm${turning}.`);
      } else {
        parts.push(`MACD (${r.macd.macd.toFixed(2)}) và đường tín hiệu đang giao nhau — tín hiệu không rõ.`);
      }
    }

    // ─ Part 4: Trend via MA ─
    let maSent = `Về xu hướng dài hơn: ${r.trend.toLowerCase()}`;
    if (r.ma200) {
      if (r.current > r.ma200) {
        maSent += `, và giá đang trên MA200 (${fp(r.ma200)}) — khung dài hạn vẫn tăng.`;
      } else {
        maSent += `, và giá đang dưới MA200 (${fp(r.ma200)}) — khung dài hạn đang giảm, cần thận trọng khi bắt đáy.`;
      }
    } else {
      maSent += ".";
    }
    parts.push(maSent);

    // ─ Part 5: Bollinger Bands ─
    if (r.bb) {
      let bbSent = "";
      if (r.bbPos === "upper") {
        bbSent = `Giá đang <b>vượt dải Bollinger trên</b> (${fp(r.bb.upper)}) — có thể đã tăng quá đà, rủi ro điều chỉnh về đường giữa (${fp(r.bb.middle)}).`;
      } else if (r.bbPos === "lower") {
        bbSent = `Giá đang <b>dưới dải Bollinger dưới</b> (${fp(r.bb.lower)}) — bị bán quá mức, khả năng có nhịp hồi về đường giữa (${fp(r.bb.middle)}).`;
      } else {
        bbSent = `Giá nằm trong dải Bollinger (${fp(r.bb.lower)} – ${fp(r.bb.upper)}), độ rộng ${r.bb.widthPct.toFixed(1)}% cho thấy ${r.bb.widthPct < 8 ? "biến động thấp (có thể sắp có breakout)" : r.bb.widthPct > 15 ? "biến động cao" : "biến động bình thường"}.`;
      }
      parts.push(bbSent);
    }

    // ─ Part 5b: ADX — trend strength ─
    if (r.adx) {
      if (r.adx.adx < 20) {
        parts.push(`<b>ADX ${r.adx.adx.toFixed(1)}</b> — thị trường đang đi ngang, trend yếu, các tín hiệu MA có thể kém tin cậy. Phù hợp trade theo range hơn là theo trend.`);
      } else if (r.adx.adx >= 25) {
        const dominantDI = r.adx.plusDI > r.adx.minusDI ? "+DI" : "-DI";
        const direction = r.adx.plusDI > r.adx.minusDI ? "tăng" : "giảm";
        parts.push(`<b>ADX ${r.adx.adx.toFixed(1)}</b> cho thấy trend <b>${direction} đang mạnh</b> (${dominantDI} chiếm ưu thế), có thể tin cậy vào xu hướng hiện tại.`);
      } else {
        parts.push(`ADX ${r.adx.adx.toFixed(1)} — trend đang hình thành nhưng chưa đủ mạnh để xác nhận.`);
      }
    }

    // ─ Part 5c: Stochastic + MFI cross-check ─
    const oscSignals = [];
    if (r.stoch) {
      if (r.stoch.k < 20) oscSignals.push(`Stochastic quá bán (%K=${r.stoch.k.toFixed(0)})`);
      else if (r.stoch.k > 80) oscSignals.push(`Stochastic quá mua (%K=${r.stoch.k.toFixed(0)})`);
    }
    if (r.mfi !== null) {
      if (r.mfi < 20) oscSignals.push(`MFI ${r.mfi.toFixed(0)} quá bán`);
      else if (r.mfi > 80) oscSignals.push(`MFI ${r.mfi.toFixed(0)} quá mua`);
    }
    if (oscSignals.length > 0) {
      parts.push(`Các chỉ báo phụ: ${oscSignals.join(", ")} — ${oscSignals.some(s => s.includes("quá bán")) ? "củng cố khả năng hồi phục ngắn hạn" : "củng cố rủi ro điều chỉnh"}.`);
    }

    // ─ Part 6: Volume ─
    if (r.volRatio > 2) {
      parts.push(`Thanh khoản hôm nay <b>${r.volRatio.toFixed(1)}x</b> trung bình 20 phiên — có sự tham gia bất thường, thường đi kèm tin tức hoặc thay đổi kỳ vọng.`);
    } else if (r.volRatio < 0.5) {
      parts.push(`Thanh khoản hôm nay chỉ ${r.volRatio.toFixed(1)}x trung bình — thấp, cho thấy thiếu sự quan tâm, các tín hiệu kỹ thuật có thể kém tin cậy.`);
    } else {
      parts.push(`Thanh khoản ${r.volRatio.toFixed(1)}x trung bình — mức bình thường.`);
    }

    // ─ Part 7: Performance ─
    if (r.performance["1th"] !== null || r.performance["3th"] !== null) {
      const perfParts = [];
      if (r.performance["1th"] !== null) perfParts.push(`1 tháng ${r.performance["1th"] >= 0 ? "+" : ""}${r.performance["1th"].toFixed(1)}%`);
      if (r.performance["3th"] !== null) perfParts.push(`3 tháng ${r.performance["3th"] >= 0 ? "+" : ""}${r.performance["3th"].toFixed(1)}%`);
      if (r.performance["1n"] !== null) perfParts.push(`1 năm ${r.performance["1n"] >= 0 ? "+" : ""}${r.performance["1n"].toFixed(1)}%`);
      parts.push(`Hiệu suất gần đây: ${perfParts.join(", ")}.`);
    }

    // ─ Part 7b: Foreign flow (NN) — smart money trong TTCK VN ─
    if (r.foreignFlow) {
      const f = r.foreignFlow;
      const fmtBil = (v) => (v / 1e9).toFixed(1);
      if (f.sum10 > 0 && f.positiveDays >= 6) {
        parts.push(`<b>Khối ngoại đang mua ròng</b> (${f.positiveDays}/10 phiên mua, tổng ${fmtBil(f.sum10)} tỷ 10 phiên gần nhất) — tín hiệu tích cực, smart money đang gom.`);
      } else if (f.sum10 < 0 && f.negativeDays >= 6) {
        parts.push(`<b>Khối ngoại đang bán ròng</b> (${f.negativeDays}/10 phiên bán, tổng ${fmtBil(f.sum10)} tỷ 10 phiên gần nhất) — tín hiệu cảnh báo, cần thận trọng.`);
      } else {
        parts.push(`Khối ngoại giao dịch đan xen (mua ${f.positiveDays}/10, bán ${f.negativeDays}/10 phiên gần nhất, net ${fmtBil(f.sum10)} tỷ) — chưa có tín hiệu rõ từ smart money.`);
      }
    }

    // ─ Part 7c: Fundamentals ─
    if (r.fundamentals) {
      const fund = r.fundamentals;
      const parts2 = [];
      if (fund.pe) parts2.push(`P/E ${fund.pe.toFixed(1)}`);
      if (fund.pb) parts2.push(`P/B ${fund.pb.toFixed(1)}`);
      if (fund.roe) parts2.push(`ROE ${(fund.roe * 100).toFixed(1)}%`);
      if (fund.eps) parts2.push(`EPS ${fund.eps.toLocaleString("vi-VN")}`);

      if (parts2.length > 0) {
        let valSent = `Về định giá: ${parts2.join(", ")}.`;
        if (fund.pe) {
          if (fund.pe < 10 && fund.pe > 0) valSent += ` P/E thấp cho thấy cổ phiếu đang <b>được định giá rẻ</b>, có thể phù hợp cho đầu tư giá trị.`;
          else if (fund.pe > 25) valSent += ` P/E cao cho thấy cổ phiếu đang <b>được định giá đắt</b>, kỳ vọng tăng trưởng phải rất cao để biện minh.`;
          else valSent += ` P/E ở mức hợp lý cho TTCK VN.`;
        }
        if (fund.roe && fund.roe > 0.15) valSent += ` ROE ${(fund.roe * 100).toFixed(1)}% tốt — doanh nghiệp sinh lời hiệu quả trên vốn chủ.`;
        parts.push(valSent);
      }
    }

    // ─ Part 8: Conclusion (NEUTRAL framing — describe situation, not give orders) ─
    let conclusion = "";
    if (r.score >= 4) {
      conclusion = `<b>Tổng hợp:</b> Setup kỹ thuật tốt (điểm ${r.score}) — confluence của nhiều tín hiệu đang nghiêng về phía tích cực. Nếu mã đã trong watchlist, vùng giá đáng chú ý: <b>${fp(r.buyZoneLow)} – ${fp(r.buyZoneHigh)}</b>. Stop loss tham khảo <b>${fp(r.stopLoss)}</b>. Kháng cự gần ở <b>${fp(r.resistance)}</b> (+${(((r.resistance - r.current) / r.current) * 100).toFixed(1)}%). <b>Lưu ý:</b> backtest cho thấy hệ scoring tổng hợp underperform buy-and-hold — đây là chỉ báo chất lượng setup, không phải lệnh mua.`;
    } else if (r.score >= 2) {
      conclusion = `<b>Tổng hợp:</b> Setup kỹ thuật khá (điểm ${r.score}) — một số tín hiệu tích cực nhưng chưa đủ confluence rõ. Vùng giá đáng quan sát: <b>${fp(r.buyZoneLow)} – ${fp(r.buyZoneHigh)}</b>; kháng cự ${fp(r.resistance)}, hỗ trợ ${fp(r.support)}.`;
    } else if (r.score >= -1) {
      conclusion = `<b>Tổng hợp:</b> Tín hiệu trung tính (điểm ${r.score}) — chưa có hướng rõ. Nếu breakout lên trên <b>${fp(r.resistance)}</b> với volume thì momentum tích cực hơn; nếu phá xuống dưới <b>${fp(r.support)}</b> thì đà giảm có thể tiếp diễn.`;
    } else if (r.score >= -3) {
      conclusion = `<b>Tổng hợp:</b> Setup yếu (điểm ${r.score}) — nhiều tín hiệu kỹ thuật tiêu cực. Mã đang giữ cần theo dõi vùng hỗ trợ <b>${fp(r.support)}</b>; nếu phá xuống có thể đà giảm tiếp diễn.`;
    } else {
      conclusion = `<b>Tổng hợp:</b> Tín hiệu kỹ thuật tiêu cực rõ ràng (điểm ${r.score}) — momentum giảm + nhiều chỉ báo cảnh báo. Cần dấu hiệu đảo chiều (RSI phục hồi từ quá bán + volume xác nhận) trước khi xét lại.`;
    }
    parts.push(conclusion);

    return parts.join(" ");
  }

  // ── Public API ──
  return {
    isValidSymbol,
    fetchHistory,
    fetchFundamentals,
    fetchForeignFlow,
    fetchStockList,
    analyze,
    INDEX_SYMBOLS,
  };
})();
