// ═══════════════════════════════════════
// Technical indicators & signal detectors — pure math.
// RSI/MACD/ADX/Stoch/Ichimoku/Bollinger + pattern/trend/volume/S-R.
// Nhận OHLCV arrays → trả object {label, desc, sentiment,...}. Không đụng DOM/state.
// ═══════════════════════════════════════
window.__SSI_TA__ = (function () {
  "use strict";

  // Aggregate daily OHLCV → weekly bars (Monday-Friday grouped by ISO week)
  function aggregateToWeekly(daily) {
    if (!daily?.times?.length) return daily;
    const { times, opens, highs, lows, closes, volumes } = daily;
    const bars = [];
    let cur = null;
    for (let i = 0; i < times.length; i++) {
      const ts = times[i]; // unix seconds
      const d = new Date(ts * 1000);
      // Week start = Monday in local time
      const dayOfWeek = (d.getDay() + 6) % 7; // 0=Mon
      const monday = new Date(d);
      monday.setHours(0, 0, 0, 0);
      monday.setDate(monday.getDate() - dayOfWeek);
      const weekKey = Math.floor(monday.getTime() / 1000);
      if (!cur || cur.time !== weekKey) {
        if (cur) bars.push(cur);
        cur = { time: weekKey, open: opens[i], high: highs[i], low: lows[i], close: closes[i], volume: volumes[i] || 0 };
      } else {
        cur.high = Math.max(cur.high, highs[i]);
        cur.low = Math.min(cur.low, lows[i]);
        cur.close = closes[i];
        cur.volume += volumes[i] || 0;
      }
    }
    if (cur) bars.push(cur);
    return {
      times: bars.map((b) => b.time),
      opens: bars.map((b) => b.open),
      highs: bars.map((b) => b.high),
      lows: bars.map((b) => b.low),
      closes: bars.map((b) => b.close),
      volumes: bars.map((b) => b.volume),
      resolution: "W",
    };
  }

  function computeSMASeries(values, times, period) {
    const result = [];
    for (let i = 0; i < values.length; i++) {
      if (i < period - 1) {
        result.push({ time: times[i], value: null });
      } else {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += values[j];
        result.push({ time: times[i], value: sum / period });
      }
    }
    return result;
  }

  // Detect "đỉnh sóng / phân phối" — overbought stocks late in their rally.
  // Pain point from earlier: user bought CDC/LPB/GEX with RSI 65-85 + vol drying up,
  // result -3 to -6% short hold. App previously had no pre-trade warning.
  // Severity 'strong' = all 3 conditions, 'mild' = 2 of 3. No warning if <2.
  function detectOverboughtTopping(r) {
    const ret1m = r.performance?.["1th"];   // 1 tháng (~22 phiên) return %
    const rsi = r.rsi;
    const volRatio = r.volRatio;
    if (rsi == null || volRatio == null || ret1m == null) return null;

    const flags = [];
    let score = 0;
    if (rsi >= 80) { flags.push("rsi_strong"); score += 2; }
    else if (rsi >= 70) { flags.push("rsi_mild"); score += 1; }

    if (ret1m >= 25) { flags.push("rally_strong"); score += 2; }
    else if (ret1m >= 15) { flags.push("rally_mild"); score += 1; }

    if (volRatio <= 0.6) { flags.push("vol_dry_strong"); score += 2; }
    else if (volRatio <= 0.85) { flags.push("vol_dry_mild"); score += 1; }

    if (score < 3) return null;  // Need at least one strong or mix of mild

    const severity = score >= 5 ? "strong" : "mild";
    const reasons = [];
    if (rsi >= 70) reasons.push(`RSI <b>${rsi.toFixed(0)}</b> (${rsi >= 80 ? "CỰC " : ""}overbought, >${rsi >= 80 ? 80 : 70})`);
    if (ret1m >= 15) reasons.push(`Đã rally <b>+${ret1m.toFixed(1)}%</b> trong 1 tháng (đỉnh sóng)`);
    if (volRatio <= 0.85) reasons.push(`Vol hôm nay <b>${volRatio.toFixed(2)}×</b> TB20 (không có lực mua mới — phân phối)`);

    // MA20 = realistic pullback target
    const ma20 = r.ma20;
    const pullbackTarget = ma20 && ma20 < r.current ? ma20 : r.current * 0.92;

    return { severity, score, flags, reasons, pullbackTarget };
  }

  // Detect last bar candle pattern
  function detectCandlePattern(opens, highs, lows, closes, n) {
    if (n < 2) return null;
    const o = opens[n - 1], h = highs[n - 1], l = lows[n - 1], c = closes[n - 1];
    const prevO = opens[n - 2], prevC = closes[n - 2];
    const body = Math.abs(c - o);
    const range = h - l;
    if (range <= 0) return null;
    const upperShadow = h - Math.max(o, c);
    const lowerShadow = Math.min(o, c) - l;
    const bodyPct = body / range;

    // Marubozu — strong body, very small shadows
    if (bodyPct > 0.9) {
      return c > o
        ? { name: "Marubozu xanh", desc: "Nến tăng mạnh, không bóng → áp lực mua áp đảo", sentiment: "bullish" }
        : { name: "Marubozu đỏ", desc: "Nến giảm mạnh, không bóng → áp lực bán áp đảo", sentiment: "bearish" };
    }

    // Doji
    if (bodyPct < 0.1) {
      return { name: "Doji", desc: "Open ≈ Close → bên mua/bán cân bằng, có thể đảo chiều", sentiment: "neutral" };
    }

    // Hammer — lower shadow ≥ 2× body, small upper shadow, small body
    if (lowerShadow >= 2 * body && upperShadow < body && bodyPct < 0.4) {
      return { name: "Hammer (Búa)", desc: "Bóng dưới dài → mua mạnh từ đáy phiên, thường đảo chiều tăng", sentiment: "bullish" };
    }

    // Shooting Star — upper shadow ≥ 2× body, small lower
    if (upperShadow >= 2 * body && lowerShadow < body && bodyPct < 0.4) {
      return { name: "Shooting Star (Sao Băng)", desc: "Bóng trên dài → bán mạnh từ đỉnh phiên, thường đảo chiều giảm", sentiment: "bearish" };
    }

    // Engulfing patterns
    const prevBody = Math.abs(prevC - prevO);
    if (prevBody > 0) {
      if (c > o && prevC < prevO && c >= prevO && o <= prevC) {
        return { name: "Bullish Engulfing", desc: "Nến xanh nuốt trọn nến đỏ trước → đảo chiều tăng", sentiment: "bullish" };
      }
      if (c < o && prevC > prevO && c <= prevO && o >= prevC) {
        return { name: "Bearish Engulfing", desc: "Nến đỏ nuốt trọn nến xanh trước → đảo chiều giảm", sentiment: "bearish" };
      }
    }

    // Default: strong/weak body
    if (c > o) {
      return { name: "Nến xanh thường", desc: "Áp lực mua tốt nhưng không nổi bật", sentiment: bodyPct > 0.6 ? "bullish-mild" : "neutral" };
    }
    return { name: "Nến đỏ thường", desc: "Áp lực bán, chưa rõ đảo chiều", sentiment: bodyPct > 0.6 ? "bearish-mild" : "neutral" };
  }

  // Trend status from MA stack
  function detectTrendStatus(r) {
    const cur = r.current;
    const ma20 = r.ma20, ma50 = r.ma50, ma200 = r.ma200;
    if (!ma20 || !ma50 || !ma200) return { label: "?", desc: "Không đủ data MA", sentiment: "neutral" };
    if (cur > ma20 && ma20 > ma50 && ma50 > ma200) {
      return { label: "📈 Xu hướng tăng MẠNH", desc: "Cấu trúc MA stack hoàn hảo: close > MA20 > MA50 > MA200", sentiment: "bullish" };
    }
    if (cur > ma20 && ma20 > ma50) {
      return { label: "📈 Xu hướng tăng", desc: "close > MA20 > MA50, nhưng chưa vượt MA200 → uptrend ngắn-trung hạn", sentiment: "bullish-mild" };
    }
    if (cur < ma20 && ma20 < ma50 && ma50 < ma200) {
      return { label: "📉 Xu hướng giảm MẠNH", desc: "close < MA20 < MA50 < MA200 → tránh mua", sentiment: "bearish" };
    }
    if (cur < ma20 && ma20 < ma50) {
      return { label: "📉 Xu hướng giảm", desc: "close < MA20 < MA50 → yếu, đợi đáy hoặc tránh", sentiment: "bearish-mild" };
    }
    return { label: "➡️ Đi ngang / không rõ", desc: "MA cross nhau, sideways → đợi setup rõ ràng", sentiment: "neutral" };
  }

  // Volume analysis — current vs avg, accumulation/distribution
  function detectVolumeAnalysis(volumes, closes, n) {
    if (n < 20) return null;
    const cur = volumes[n - 1];
    const avgVol20 = volumes.slice(n - 21, n - 1).reduce((a, b) => a + b, 0) / 20;
    const ratio = avgVol20 > 0 ? cur / avgVol20 : 0;

    // Vol trend last 5 days
    const recentVol = volumes.slice(n - 5, n);
    const recentPrice = closes.slice(n - 5, n);
    const volSlope = (recentVol[recentVol.length - 1] - recentVol[0]) / recentVol[0];
    const priceSlope = (recentPrice[recentPrice.length - 1] - recentPrice[0]) / recentPrice[0];

    let signal, sentiment;
    if (ratio > 2.5) {
      signal = `🔥 Vol BÙNG NỔ ${ratio.toFixed(1)}× TB20`;
      sentiment = closes[n - 1] > closes[n - 2] ? "bullish" : "bearish";
    } else if (ratio > 1.5) {
      signal = `⬆️ Vol cao ${ratio.toFixed(1)}× TB20 — có lực`;
      sentiment = "bullish-mild";
    } else if (ratio < 0.5) {
      signal = `💤 Vol cạn ${ratio.toFixed(1)}× TB20 — thiếu lực`;
      sentiment = "neutral";
    } else {
      signal = `🟰 Vol bình thường ${ratio.toFixed(1)}× TB20`;
      sentiment = "neutral";
    }

    // Accumulation/Distribution interpretation
    let context;
    if (priceSlope > 0.02 && volSlope > 0.1) {
      context = "✅ Giá tăng + vol tăng = Accumulation (lực mua xác nhận)";
    } else if (priceSlope > 0.02 && volSlope < -0.1) {
      context = "⚠️ Giá tăng nhưng vol giảm = phân phối ngầm, cảnh báo đỉnh";
    } else if (priceSlope < -0.02 && volSlope > 0.1) {
      context = "⚠️ Giá giảm + vol tăng = Distribution (bán tháo)";
    } else if (priceSlope < -0.02 && volSlope < -0.1) {
      context = "💤 Giá giảm + vol giảm = hết áp lực bán, có thể đáy";
    } else {
      context = "Vol-price trung tính 5 phiên gần đây";
    }

    return { ratio, signal, context, sentiment };
  }

  // Support/Resistance — recent swing levels (last 30 bars)
  function detectSupportResistance(highs, lows, closes, n) {
    if (n < 30) return null;
    const cur = closes[n - 1];
    const window = 30;
    const recentHighs = highs.slice(n - window, n);
    const recentLows = lows.slice(n - window, n);
    const maxH = Math.max(...recentHighs);
    const minL = Math.min(...recentLows);

    // Find swing highs (local max) within window — simple peak detect
    const swings = [];
    for (let i = 2; i < window - 2; i++) {
      const ih = recentHighs[i];
      if (ih > recentHighs[i - 1] && ih > recentHighs[i - 2] &&
          ih > recentHighs[i + 1] && ih > recentHighs[i + 2]) {
        swings.push({ type: "R", price: ih });
      }
      const il = recentLows[i];
      if (il < recentLows[i - 1] && il < recentLows[i - 2] &&
          il < recentLows[i + 1] && il < recentLows[i + 2]) {
        swings.push({ type: "S", price: il });
      }
    }

    // Nearest resistance above cur, nearest support below cur
    const resists = swings.filter((s) => s.type === "R" && s.price > cur).map((s) => s.price);
    const supports = swings.filter((s) => s.type === "S" && s.price < cur).map((s) => s.price);
    const nearestR = resists.length ? Math.min(...resists) : maxH;
    const nearestS = supports.length ? Math.max(...supports) : minL;

    const distR = ((nearestR - cur) / cur) * 100;
    const distS = ((cur - nearestS) / cur) * 100;
    return { nearestR, nearestS, distR, distS, maxH, minL };
  }

  // RSI status + zone
  function detectRsiStatus(rsi) {
    if (rsi == null) return null;
    if (rsi >= 80) return { zone: "🔴 Cực overbought", desc: "RSI ≥ 80 → áp lực bán cao, cẩn thận đảo chiều", sentiment: "bearish" };
    if (rsi >= 70) return { zone: "🟠 Overbought", desc: "RSI 70-80 → quá mua, có thể điều chỉnh", sentiment: "bearish-mild" };
    if (rsi >= 50) return { zone: "🟢 Trên 50 (bullish bias)", desc: "RSI > 50 → bên mua đang chiếm ưu thế", sentiment: "bullish-mild" };
    if (rsi >= 30) return { zone: "🟡 Dưới 50 (bearish bias)", desc: "RSI 30-50 → bên bán chiếm ưu thế", sentiment: "bearish-mild" };
    if (rsi >= 20) return { zone: "🔵 Oversold", desc: "RSI 20-30 → quá bán, có thể hồi", sentiment: "bullish-mild" };
    return { zone: "💎 Cực oversold", desc: "RSI < 20 → cực kỳ oversold, capitulation, thường đảo chiều mạnh", sentiment: "bullish" };
  }

  // Final verdict — combine sentiments
  function buildTechnicalVerdict(signals) {
    let score = 0;
    let count = 0;
    const weight = { bullish: 2, "bullish-mild": 1, neutral: 0, "bearish-mild": -1, bearish: -2 };
    for (const s of signals) {
      if (s && s.sentiment != null) {
        score += weight[s.sentiment] ?? 0;
        count++;
      }
    }
    const avg = count > 0 ? score / count : 0;
    if (avg >= 1.0) return { label: "🟢 BULLISH MẠNH", desc: "Đa số tín hiệu tăng — context entry tốt", color: "strong-bull" };
    if (avg >= 0.4) return { label: "🟡 BULLISH NHẸ", desc: "Có tín hiệu tăng nhưng chưa rõ rệt — cẩn thận", color: "mild-bull" };
    if (avg <= -1.0) return { label: "🔴 BEARISH MẠNH", desc: "Đa số tín hiệu giảm — tránh mua", color: "strong-bear" };
    if (avg <= -0.4) return { label: "🟠 BEARISH NHẸ", desc: "Có cảnh báo, hold/wait", color: "mild-bear" };
    return { label: "⚪ NEUTRAL", desc: "Tín hiệu hỗn hợp — đợi setup rõ", color: "neutral" };
  }

  // Aggregate daily OHLCV → weekly (Monday-Friday groups)
  function aggregateWeekly(data) {
    const { times, opens, highs, lows, closes, volumes } = data;
    if (!times || !times.length) return data;
    const weeklyT = [], weeklyO = [], weeklyH = [], weeklyL = [], weeklyC = [], weeklyV = [];
    let curWeek = null;
    let weekStart = null, weekHigh = -Infinity, weekLow = Infinity, weekOpen = null, weekClose = null, weekVol = 0;
    for (let i = 0; i < times.length; i++) {
      const date = new Date(times[i] * 1000);
      // Week number = floor((days since epoch) / 7)
      const weekIndex = Math.floor(times[i] / 86400 / 7);
      if (curWeek === null || weekIndex !== curWeek) {
        // Flush prev week
        if (curWeek !== null) {
          weeklyT.push(weekStart);
          weeklyO.push(weekOpen);
          weeklyH.push(weekHigh);
          weeklyL.push(weekLow);
          weeklyC.push(weekClose);
          weeklyV.push(weekVol);
        }
        // Start new week
        curWeek = weekIndex;
        weekStart = times[i];
        weekOpen = opens[i];
        weekHigh = highs[i];
        weekLow = lows[i];
        weekClose = closes[i];
        weekVol = volumes[i];
      } else {
        weekHigh = Math.max(weekHigh, highs[i]);
        weekLow = Math.min(weekLow, lows[i]);
        weekClose = closes[i];
        weekVol += volumes[i];
      }
    }
    // Flush last week
    if (curWeek !== null) {
      weeklyT.push(weekStart);
      weeklyO.push(weekOpen);
      weeklyH.push(weekHigh);
      weeklyL.push(weekLow);
      weeklyC.push(weekClose);
      weeklyV.push(weekVol);
    }
    return { times: weeklyT, opens: weeklyO, highs: weeklyH, lows: weeklyL, closes: weeklyC, volumes: weeklyV };
  }

  // MACD interpretation
  function detectMacdStatus(macd) {
    if (!macd || macd.macd == null) return null;
    const m = macd.macd, sig = macd.signal, hist = macd.hist;
    let label, desc, sentiment;
    if (m > sig && hist > 0) {
      if (m > 0) {
        label = "🟢 MACD bullish — trên signal line + zero";
        sentiment = "bullish";
      } else {
        label = "🟡 MACD bullish crossover dưới zero";
        sentiment = "bullish-mild";
      }
      desc = `MACD ${m.toFixed(3)} > Signal ${sig.toFixed(3)}, histogram +${hist.toFixed(3)}`;
    } else if (m < sig && hist < 0) {
      if (m < 0) {
        label = "🔴 MACD bearish — dưới signal + zero";
        sentiment = "bearish";
      } else {
        label = "🟠 MACD bearish crossover trên zero";
        sentiment = "bearish-mild";
      }
      desc = `MACD ${m.toFixed(3)} < Signal ${sig.toFixed(3)}, histogram ${hist.toFixed(3)}`;
    } else {
      label = "⚪ MACD trung tính";
      desc = `MACD ${m.toFixed(3)}, Signal ${sig.toFixed(3)}`;
      sentiment = "neutral";
    }
    if (macd.histTurning) desc += " · ⚠️ Histogram vừa đảo chiều (cảnh báo turning point)";
    return { label, desc, sentiment };
  }

  // ADX interpretation — trend strength
  function detectAdxStatus(adx) {
    if (!adx || adx.adx == null) return null;
    const a = adx.adx, plusDI = adx.plusDI, minusDI = adx.minusDI;
    let label, desc, sentiment;
    if (a >= 40) {
      label = `🔥 Trend MẠNH (ADX ${a.toFixed(0)})`;
      sentiment = plusDI > minusDI ? "bullish" : "bearish";
      desc = plusDI > minusDI
        ? `+DI ${plusDI.toFixed(1)} > -DI ${minusDI.toFixed(1)} → uptrend mạnh, follow momentum`
        : `-DI ${minusDI.toFixed(1)} > +DI ${plusDI.toFixed(1)} → downtrend mạnh, tránh mua`;
    } else if (a >= 25) {
      label = `📈 Trending (ADX ${a.toFixed(0)})`;
      sentiment = plusDI > minusDI ? "bullish-mild" : "bearish-mild";
      desc = plusDI > minusDI
        ? `+DI > -DI → uptrend`
        : `-DI > +DI → downtrend`;
    } else if (a >= 20) {
      label = `🟡 Trend yếu (ADX ${a.toFixed(0)})`;
      desc = "Có trend nhưng yếu — đợi confirm";
      sentiment = "neutral";
    } else {
      label = `⚪ Sideways (ADX ${a.toFixed(0)})`;
      desc = "ADX < 20 → không có trend rõ, market sideways, tránh trend-following";
      sentiment = "neutral";
    }
    return { label, desc, sentiment };
  }

  // Stochastic %K/%D
  function detectStochStatus(stoch) {
    if (!stoch || stoch.k == null) return null;
    const k = stoch.k, d = stoch.d;
    let label, desc, sentiment;
    if (k > 80) {
      label = `🟠 Overbought %K=${k.toFixed(0)}`;
      desc = "Stochastic > 80 → ngắn hạn overbought";
      sentiment = "bearish-mild";
    } else if (k < 20) {
      label = `🟢 Oversold %K=${k.toFixed(0)}`;
      desc = "Stochastic < 20 → ngắn hạn oversold, có thể hồi";
      sentiment = "bullish-mild";
    } else {
      label = `⚪ Trung tính %K=${k.toFixed(0)} %D=${d.toFixed(0)}`;
      desc = "Stochastic trong vùng 20-80";
      sentiment = "neutral";
    }
    return { label, desc, sentiment };
  }

  // ── Ichimoku Kinko Hyo (mây Ichimoku) ──────────────────────
  // 5 lines: Tenkan-sen (9), Kijun-sen (26), Senkou A/B (cloud shifted +26),
  // Chikou Span (close shifted -26). Standard parameters.
  // Returns full series for chart overlay + current values for analysis.
  function computeIchimoku(highs, lows, closes) {
    const n = closes.length;
    if (n < 52) return null;

    const periodH = (period, idx) => {
      const start = Math.max(0, idx - period + 1);
      return Math.max(...highs.slice(start, idx + 1));
    };
    const periodL = (period, idx) => {
      const start = Math.max(0, idx - period + 1);
      return Math.min(...lows.slice(start, idx + 1));
    };

    // Compute series
    const tenkan = [], kijun = [], senkouA = [], senkouB = [];
    for (let i = 0; i < n; i++) {
      tenkan.push(i < 8 ? null : (periodH(9, i) + periodL(9, i)) / 2);
      kijun.push(i < 25 ? null : (periodH(26, i) + periodL(26, i)) / 2);
      senkouA.push(tenkan[i] != null && kijun[i] != null ? (tenkan[i] + kijun[i]) / 2 : null);
      senkouB.push(i < 51 ? null : (periodH(52, i) + periodL(52, i)) / 2);
    }

    // Current cloud values come from bar (n-1 - 26) — the value that was projected forward
    const cloudIdx = n - 1 - 26;
    const curSenkouA = cloudIdx >= 0 && senkouA[cloudIdx] != null ? senkouA[cloudIdx] : null;
    const curSenkouB = cloudIdx >= 0 && senkouB[cloudIdx] != null ? senkouB[cloudIdx] : null;

    return {
      tenkan: tenkan[n - 1],
      kijun: kijun[n - 1],
      tenkanPrev: tenkan[n - 2],
      kijunPrev: kijun[n - 2],
      senkouA: curSenkouA,
      senkouB: curSenkouB,
      chikou: closes[n - 1 - 26] != null ? closes[n - 1] : null,
      // Cloud projection (next 26 bars)
      futureSenkouA: senkouA[n - 1],
      futureSenkouB: senkouB[n - 1],
      // Full series cho chart overlay
      tenkanSeries: tenkan,
      kijunSeries: kijun,
      senkouASeries: senkouA,
      senkouBSeries: senkouB,
    };
  }

  function detectIchimokuStatus(ichimoku, cur, prevClose) {
    if (!ichimoku || ichimoku.tenkan == null || ichimoku.kijun == null) return null;
    const { tenkan, kijun, tenkanPrev, kijunPrev, senkouA, senkouB, futureSenkouA, futureSenkouB } = ichimoku;

    // Cloud position
    let cloudTop = null, cloudBot = null;
    if (senkouA != null && senkouB != null) {
      cloudTop = Math.max(senkouA, senkouB);
      cloudBot = Math.min(senkouA, senkouB);
    }

    // 1. Price vs Cloud
    let cloudSentiment = "neutral";
    let cloudLabel = "";
    if (cloudTop != null && cloudBot != null) {
      if (cur > cloudTop) {
        cloudSentiment = "bullish";
        cloudLabel = `🟢 Giá TRÊN Kumo (cloud ${cloudBot.toFixed(2)}-${cloudTop.toFixed(2)}k) → uptrend`;
      } else if (cur < cloudBot) {
        cloudSentiment = "bearish";
        cloudLabel = `🔴 Giá DƯỚI Kumo (cloud ${cloudBot.toFixed(2)}-${cloudTop.toFixed(2)}k) → downtrend`;
      } else {
        cloudSentiment = "neutral";
        cloudLabel = `🟡 Giá TRONG Kumo (cloud ${cloudBot.toFixed(2)}-${cloudTop.toFixed(2)}k) → consolidation, đợi break`;
      }
    }

    // 2. Tenkan/Kijun cross
    let tkCross = "";
    let tkSentiment = "neutral";
    if (tenkanPrev != null && kijunPrev != null) {
      if (tenkanPrev <= kijunPrev && tenkan > kijun) {
        tkCross = "🟢 TK Cross UP (Tenkan vừa cắt lên Kijun) → bullish momentum signal";
        tkSentiment = "bullish";
      } else if (tenkanPrev >= kijunPrev && tenkan < kijun) {
        tkCross = "🔴 TK Cross DOWN (Tenkan vừa cắt xuống Kijun) → bearish momentum signal";
        tkSentiment = "bearish";
      } else if (tenkan > kijun) {
        tkCross = `🟡 Tenkan ${tenkan.toFixed(2)}k > Kijun ${kijun.toFixed(2)}k → bullish bias`;
        tkSentiment = "bullish-mild";
      } else {
        tkCross = `🟠 Tenkan ${tenkan.toFixed(2)}k < Kijun ${kijun.toFixed(2)}k → bearish bias`;
        tkSentiment = "bearish-mild";
      }
    }

    // 3. Future Kumo color (bullish if A > B, bearish if A < B)
    let futureCloud = "";
    if (futureSenkouA != null && futureSenkouB != null) {
      if (futureSenkouA > futureSenkouB) {
        futureCloud = `🟢 Mây tương lai XANH (Senkou A ${futureSenkouA.toFixed(2)}k > B ${futureSenkouB.toFixed(2)}k) → trend tăng support`;
      } else {
        futureCloud = `🔴 Mây tương lai ĐỎ (Senkou A ${futureSenkouA.toFixed(2)}k < B ${futureSenkouB.toFixed(2)}k) → trend giảm pressure`;
      }
    }

    // Combine into final verdict
    const sentiments = [cloudSentiment, tkSentiment];
    let finalSentiment = "neutral";
    if (cloudSentiment === "bullish" && tkSentiment.startsWith("bullish")) finalSentiment = "bullish";
    else if (cloudSentiment === "bearish" && tkSentiment.startsWith("bearish")) finalSentiment = "bearish";
    else if (cloudSentiment.startsWith("bull") || tkSentiment.startsWith("bull")) finalSentiment = "bullish-mild";
    else if (cloudSentiment.startsWith("bear") || tkSentiment.startsWith("bear")) finalSentiment = "bearish-mild";

    let mainLabel;
    if (finalSentiment === "bullish") mainLabel = "🟢 Ichimoku BULLISH (price + TK align)";
    else if (finalSentiment === "bearish") mainLabel = "🔴 Ichimoku BEARISH (price + TK align)";
    else if (finalSentiment === "bullish-mild") mainLabel = "🟡 Ichimoku bullish nhẹ";
    else if (finalSentiment === "bearish-mild") mainLabel = "🟠 Ichimoku bearish nhẹ";
    else mainLabel = "⚪ Ichimoku mixed signals";

    return {
      label: mainLabel,
      cloudLabel,
      tkCross,
      futureCloud,
      sentiment: finalSentiment,
      tenkan, kijun,
      cloudTop, cloudBot,
    };
  }

  // Generate round numbers near current price (VN retail psychology levels)
  function generateRoundLevels(cur) {
    const tick = cur < 50 ? 5 : cur < 200 ? 10 : 20;
    const base = Math.floor(cur / tick) * tick;
    return [base, base + tick, base + 2 * tick].filter((p) => p > 0);
  }

  // Detect which levels are currently being "touched" (within 1.5% of price)
  function detectLevelTouch(r, closes, highs, lows, n) {
    const cur = closes[n - 1];
    const dayHigh = highs[n - 1];
    const dayLow = lows[n - 1];

    const levels = [];

    // Support / Resistance từ analysis (real swing)
    if (r.support && r.support > 0) {
      levels.push({ type: "S", source: "Swing Support", price: r.support });
    }
    if (r.resistance && r.resistance > 0) {
      levels.push({ type: "R", source: "Swing Resistance", price: r.resistance });
    }

    // MA20/50/200
    if (r.ma20) levels.push({ type: cur > r.ma20 ? "S" : "R", source: "MA20", price: r.ma20 });
    if (r.ma50) levels.push({ type: cur > r.ma50 ? "S" : "R", source: "MA50", price: r.ma50 });
    if (r.ma200) levels.push({ type: cur > r.ma200 ? "S" : "R", source: "MA200", price: r.ma200 });

    // 52-week High/Low
    if (r.w52High) levels.push({ type: "R", source: "52w High", price: r.w52High });
    if (r.w52Low) levels.push({ type: "S", source: "52w Low", price: r.w52Low });

    // Bollinger Bands
    if (r.bb && r.bb.upper) levels.push({ type: "R", source: "BB Upper", price: r.bb.upper });
    if (r.bb && r.bb.lower) levels.push({ type: "S", source: "BB Lower", price: r.bb.lower });
    if (r.bb && r.bb.middle) levels.push({ type: cur > r.bb.middle ? "S" : "R", source: "BB Middle", price: r.bb.middle });

    // Round numbers (VN psychology)
    const roundLevels = generateRoundLevels(cur);
    for (const rl of roundLevels) {
      const distPct = Math.abs(rl - cur) / cur * 100;
      if (distPct < 5) {
        levels.push({ type: rl > cur ? "R" : "S", source: "Round level", price: rl });
      }
    }

    // Compute distance + touch flag for each level
    const enriched = levels.map((lv) => {
      const distPct = ((lv.price - cur) / cur) * 100;
      // Touched: today's range overlaps level OR distance < 1.5%
      const touched = (lv.price >= dayLow && lv.price <= dayHigh) || Math.abs(distPct) < 1.5;
      return { ...lv, distPct, touched };
    });

    // Sort: touched first, then by absolute distance
    enriched.sort((a, b) => {
      if (a.touched !== b.touched) return a.touched ? -1 : 1;
      return Math.abs(a.distPct) - Math.abs(b.distPct);
    });

    return enriched;
  }

  // Confluence detection: cluster of 2+ levels within 1.5% of each other
  function detectConfluence(levels) {
    const clusters = [];
    const used = new Set();
    for (let i = 0; i < levels.length; i++) {
      if (used.has(i)) continue;
      const cluster = [levels[i]];
      const avgPrice = levels[i].price;
      for (let j = i + 1; j < levels.length; j++) {
        if (used.has(j)) continue;
        const distPct = Math.abs(levels[j].price - avgPrice) / avgPrice * 100;
        if (distPct < 1.5) {
          cluster.push(levels[j]);
          used.add(j);
        }
      }
      if (cluster.length >= 2) {
        const meanPrice = cluster.reduce((a, b) => a + b.price, 0) / cluster.length;
        clusters.push({
          price: meanPrice,
          sources: cluster.map((c) => c.source),
          count: cluster.length,
          type: cluster.filter((c) => c.type === "R").length >= cluster.length / 2 ? "R" : "S",
        });
        used.add(i);
      }
    }
    return clusters;
  }

  // Bollinger Bands detailed status
  function detectBollingerStatus(r, closes, n) {
    if (!r.bb || r.bb.upper == null) return null;
    const cur = closes[n - 1];
    const upper = r.bb.upper;
    const lower = r.bb.lower;
    const middle = r.bb.middle;
    const width = upper - lower;
    const widthPct = (width / middle) * 100;

    // Band width historical comparison (squeeze detection)
    // Compute width 20 phiên trước → so sánh
    let isSqueeze = false;
    if (n >= 40) {
      // Simple proxy: current width < 50% of recent avg
      // (better would be compare to historical width series)
      isSqueeze = widthPct < 8; // empirical threshold for VN stocks
    }

    let label, desc, sentiment;
    if (cur >= upper) {
      label = "🟠 Chạm/vượt BB upper";
      desc = `Giá ${cur.toFixed(2)}k ≥ BB upper ${upper.toFixed(2)}k → overbought ngắn hạn, có thể pullback về middle ${middle.toFixed(2)}k`;
      sentiment = "bearish-mild";
    } else if (cur <= lower) {
      label = "🟢 Chạm/dưới BB lower";
      desc = `Giá ${cur.toFixed(2)}k ≤ BB lower ${lower.toFixed(2)}k → oversold ngắn hạn, có thể rebound về middle`;
      sentiment = "bullish-mild";
    } else if (cur > middle) {
      label = "🟡 Trên BB middle";
      desc = `Giá trong nửa trên (${cur.toFixed(2)}k vs middle ${middle.toFixed(2)}k)`;
      sentiment = "bullish-mild";
    } else {
      label = "🟡 Dưới BB middle";
      desc = `Giá trong nửa dưới (${cur.toFixed(2)}k vs middle ${middle.toFixed(2)}k)`;
      sentiment = "bearish-mild";
    }
    if (isSqueeze) {
      desc += ` · ⚡ SQUEEZE width ${widthPct.toFixed(1)}% (band thắt) → breakout sắp đến, theo dõi hướng`;
    }
    return { label, desc, sentiment, widthPct, isSqueeze };
  }

  // ── Chart Patterns (multi-bar) ────────────────────────────
  // Find swing pivots (local max/min với N-bar lookback both sides)
  function findSwingPivots(highs, lows, lookback = 60, sensitivity = 3) {
    const start = Math.max(0, highs.length - lookback);
    const pivots = []; // { idx, type: 'H'|'L', price }
    for (let i = start + sensitivity; i < highs.length - sensitivity; i++) {
      // Swing high
      let isHigh = true;
      for (let k = 1; k <= sensitivity; k++) {
        if (highs[i] <= highs[i - k] || highs[i] <= highs[i + k]) { isHigh = false; break; }
      }
      if (isHigh) pivots.push({ idx: i, type: "H", price: highs[i] });
      // Swing low
      let isLow = true;
      for (let k = 1; k <= sensitivity; k++) {
        if (lows[i] >= lows[i - k] || lows[i] >= lows[i + k]) { isLow = false; break; }
      }
      if (isLow) pivots.push({ idx: i, type: "L", price: lows[i] });
    }
    return pivots.sort((a, b) => a.idx - b.idx);
  }

  // Linear regression slope (returns slope per bar)
  function linRegSlope(points) {
    if (points.length < 2) return null;
    const n = points.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (const p of points) {
      sumX += p.idx;
      sumY += p.price;
      sumXY += p.idx * p.price;
      sumXX += p.idx * p.idx;
    }
    const denom = n * sumXX - sumX * sumX;
    if (denom === 0) return null;
    return (n * sumXY - sumX * sumY) / denom;
  }

  // HH/HL trend structure analysis
  function detectHhHlStructure(pivots) {
    if (pivots.length < 4) return null;
    // Take last 4-6 swings
    const recent = pivots.slice(-6);
    const highs = recent.filter((p) => p.type === "H").map((p) => p.price);
    const lows = recent.filter((p) => p.type === "L").map((p) => p.price);
    if (highs.length < 2 || lows.length < 2) return null;

    const hhCount = highs.slice(1).filter((h, i) => h > highs[i]).length;
    const lhCount = highs.slice(1).filter((h, i) => h < highs[i]).length;
    const hlCount = lows.slice(1).filter((l, i) => l > lows[i]).length;
    const llCount = lows.slice(1).filter((l, i) => l < lows[i]).length;
    const totalH = highs.length - 1;
    const totalL = lows.length - 1;

    let label, desc, sentiment;
    if (hhCount === totalH && hlCount === totalL) {
      label = "🟢 HH + HL — Uptrend structure";
      desc = `Higher Highs (${hhCount}/${totalH}) + Higher Lows (${hlCount}/${totalL}) → cấu trúc tăng kinh điển, follow trend`;
      sentiment = "bullish";
    } else if (lhCount === totalH && llCount === totalL) {
      label = "🔴 LH + LL — Downtrend structure";
      desc = `Lower Highs (${lhCount}/${totalH}) + Lower Lows (${llCount}/${totalL}) → cấu trúc giảm, tránh mua`;
      sentiment = "bearish";
    } else if (hhCount > lhCount && hlCount > llCount) {
      label = "🟡 Mostly HH/HL — uptrend nhẹ";
      desc = `${hhCount}/${totalH} HH, ${hlCount}/${totalL} HL — xu hướng tăng nhưng có nhiễu`;
      sentiment = "bullish-mild";
    } else if (lhCount > hhCount && llCount > hlCount) {
      label = "🟠 Mostly LH/LL — downtrend nhẹ";
      desc = `${lhCount}/${totalH} LH, ${llCount}/${totalL} LL — xu hướng giảm có nhiễu`;
      sentiment = "bearish-mild";
    } else {
      label = "⚪ Cấu trúc hỗn hợp";
      desc = `HH/HL không rõ rệt → consolidation hoặc đảo chiều`;
      sentiment = "neutral";
    }
    return { label, desc, sentiment, hhCount, lhCount, hlCount, llCount };
  }

  // Triangle pattern detection — converging trendlines
  function detectTrianglePattern(pivots, closes, n) {
    if (pivots.length < 5) return null;
    const recent = pivots.slice(-10); // last 10 swings (~30-40 bars)
    const swingHighs = recent.filter((p) => p.type === "H");
    const swingLows = recent.filter((p) => p.type === "L");
    if (swingHighs.length < 2 || swingLows.length < 2) return null;

    const cur = closes[n - 1];
    const slopeH = linRegSlope(swingHighs);
    const slopeL = linRegSlope(swingLows);
    if (slopeH == null || slopeL == null) return null;

    // Normalize slope to %/bar (vs current price)
    const slopeH_pct = (slopeH / cur) * 100;
    const slopeL_pct = (slopeL / cur) * 100;

    // Range of highs + lows to check if "converging"
    const highMax = Math.max(...swingHighs.map((p) => p.price));
    const highMin = Math.min(...swingHighs.map((p) => p.price));
    const lowMax = Math.max(...swingLows.map((p) => p.price));
    const lowMin = Math.min(...swingLows.map((p) => p.price));
    const highRange = (highMax - highMin) / cur * 100;
    const lowRange = (lowMax - lowMin) / cur * 100;

    let pattern = null;
    // Ascending triangle: flat highs, rising lows
    if (Math.abs(slopeH_pct) < 0.05 && slopeL_pct > 0.05 && highRange < 3) {
      pattern = {
        name: "📐 Ascending Triangle",
        desc: `Đỉnh ngang quanh ${highMax.toFixed(2)}k, đáy tăng dần → bullish breakout setup (typical target +${(highRange + 5).toFixed(1)}% nếu break trên)`,
        sentiment: "bullish",
      };
    }
    // Descending triangle: falling highs, flat lows
    else if (slopeH_pct < -0.05 && Math.abs(slopeL_pct) < 0.05 && lowRange < 3) {
      pattern = {
        name: "📐 Descending Triangle",
        desc: `Đỉnh giảm dần, đáy ngang quanh ${lowMin.toFixed(2)}k → bearish breakdown setup`,
        sentiment: "bearish",
      };
    }
    // Symmetric triangle: converging slopes
    else if (slopeH_pct < -0.05 && slopeL_pct > 0.05) {
      pattern = {
        name: "📐 Symmetric Triangle",
        desc: `2 trendlines hội tụ → consolidation, breakout cả 2 chiều có thể xảy ra. Đợi confirm direction.`,
        sentiment: "neutral",
      };
    }
    // Channel up
    else if (slopeH_pct > 0.05 && slopeL_pct > 0.05 && Math.abs(slopeH_pct - slopeL_pct) < 0.1) {
      pattern = {
        name: "📈 Up Channel",
        desc: `2 trendlines song song, đều dốc lên → uptrend channel, mua đáy bán đỉnh trong channel`,
        sentiment: "bullish-mild",
      };
    }
    // Channel down
    else if (slopeH_pct < -0.05 && slopeL_pct < -0.05 && Math.abs(slopeH_pct - slopeL_pct) < 0.1) {
      pattern = {
        name: "📉 Down Channel",
        desc: `2 trendlines song song, đều dốc xuống → downtrend channel, không nên mua`,
        sentiment: "bearish-mild",
      };
    }
    return pattern;
  }

  // Double Top / Bottom detection — 2 peaks/troughs near same level
  function detectDoubleTopBottom(pivots, closes, n) {
    if (pivots.length < 4) return null;
    const recent = pivots.slice(-20); // last 20 swings
    const swingHighs = recent.filter((p) => p.type === "H");
    const swingLows = recent.filter((p) => p.type === "L");
    const cur = closes[n - 1];

    // Double Top: 2 highs near same level (within 3%) với valley between
    if (swingHighs.length >= 2) {
      const sortedH = [...swingHighs].sort((a, b) => b.price - a.price);
      const top1 = sortedH[0], top2 = sortedH[1];
      const diff = Math.abs(top1.price - top2.price) / top1.price * 100;
      if (diff < 3 && Math.abs(top1.idx - top2.idx) >= 10) {
        // Check valley between
        const lo = Math.min(top1.idx, top2.idx);
        const hi = Math.max(top1.idx, top2.idx);
        const valleyClose = Math.min(...closes.slice(lo, hi));
        const valleyDrop = ((top1.price - valleyClose) / top1.price) * 100;
        if (valleyDrop > 3) {
          const isRecent = Math.max(top1.idx, top2.idx) >= n - 5;
          return {
            name: "🔴 Double Top",
            desc: `2 đỉnh tại ${top1.price.toFixed(2)}k và ${top2.price.toFixed(2)}k (chênh ${diff.toFixed(1)}%), valley drop ${valleyDrop.toFixed(1)}% → bearish reversal pattern. ${isRecent ? "ĐANG hình thành — cảnh báo." : "Đã hoàn thành."}`,
            sentiment: "bearish",
          };
        }
      }
    }

    // Double Bottom: 2 lows near same level với rally between
    if (swingLows.length >= 2) {
      const sortedL = [...swingLows].sort((a, b) => a.price - b.price);
      const bot1 = sortedL[0], bot2 = sortedL[1];
      const diff = Math.abs(bot1.price - bot2.price) / bot1.price * 100;
      if (diff < 3 && Math.abs(bot1.idx - bot2.idx) >= 10) {
        const lo = Math.min(bot1.idx, bot2.idx);
        const hi = Math.max(bot1.idx, bot2.idx);
        const peakClose = Math.max(...closes.slice(lo, hi));
        const peakRise = ((peakClose - bot1.price) / bot1.price) * 100;
        if (peakRise > 3) {
          const isRecent = Math.max(bot1.idx, bot2.idx) >= n - 5;
          return {
            name: "🟢 Double Bottom",
            desc: `2 đáy tại ${bot1.price.toFixed(2)}k và ${bot2.price.toFixed(2)}k (chênh ${diff.toFixed(1)}%), peak rise ${peakRise.toFixed(1)}% → bullish reversal pattern. ${isRecent ? "ĐANG hình thành — entry opportunity." : "Đã hoàn thành."}`,
            sentiment: "bullish",
          };
        }
      }
    }
    return null;
  }

  // VN market-specific flags
  function detectVnFlags(closes, n) {
    const cur = closes[n - 1];
    const flags = [];
    // Penny stock warning (< 10k VND)
    if (cur < 10) {
      flags.push({
        type: "warn",
        text: `⚠️ Mã penny (${cur.toFixed(2)}k VND < 10k) — rủi ro pump-and-dump cao, tránh chase`,
      });
    } else if (cur < 15) {
      flags.push({
        type: "info",
        text: `ℹ️ Mid-cap thấp (${cur.toFixed(2)}k VND) — thanh khoản trung bình, watch volume`,
      });
    }
    // Distance to daily ceiling/floor (giả định HOSE ±7%)
    const prevClose = n >= 2 ? closes[n - 2] : cur;
    const ceiling = prevClose * 1.07;
    const floor = prevClose * 0.93;
    const distCeiling = ((ceiling - cur) / cur) * 100;
    const distFloor = ((cur - floor) / cur) * 100;
    if (distCeiling < 1) {
      flags.push({
        type: "info",
        text: `🚀 Sát trần (cách +${distCeiling.toFixed(1)}%, prev close ${prevClose.toFixed(2)}k) — momentum cao, chú ý FOMO`,
      });
    }
    if (distFloor < 1) {
      flags.push({
        type: "warn",
        text: `🔻 Sát sàn (cách -${distFloor.toFixed(1)}%) — panic selling, chờ stabilize trước khi vào`,
      });
    }
    return flags;
  }

  return { detectOverboughtTopping, detectCandlePattern, detectTrendStatus, detectVolumeAnalysis, detectSupportResistance, detectRsiStatus, buildTechnicalVerdict, aggregateWeekly, aggregateToWeekly, computeSMASeries, detectMacdStatus, detectAdxStatus, detectStochStatus, computeIchimoku, detectIchimokuStatus, generateRoundLevels, detectLevelTouch, detectConfluence, detectBollingerStatus, findSwingPivots, linRegSlope, detectHhHlStructure, detectTrianglePattern, detectDoubleTopBottom, detectVnFlags };
})();
