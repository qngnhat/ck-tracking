// ═══════════════════════════════════════
// DCA Ranking — port của backtest/src/dca_score.py + rebalance.py
// ═══════════════════════════════════════

window.__SSI_RANKING__ = (function () {
  "use strict";

  const ANALYSIS = window.__SSI_ANALYSIS__;

  // ─────────────────────────────────────────────────────────
  // Universe — chia 2 tier (Option C, manual quarterly update)
  //
  // Last reviewed: 2026-04-27 (sau VN30 rebalance Q1)
  // Next review: ~2026-07-27 (khi VN30 rebalance Q2)
  //
  // Tier 1 (CORE 30): VN30 actual constituents — fetched via
  //   GET /v4/stocks?q=indexCode:VN30
  // Tier 2 (EXTENDED ~28): mid/large-cap diversifiers theo ngành
  //   để đảm bảo có signal khi VN30 yếu.
  //
  // Update workflow khi rebalance:
  //   curl 'https://api-finfo.vndirect.com.vn/v4/stocks?q=indexCode:VN30&size=50' \
  //     -H 'User-Agent: Mozilla/5.0' | jq '[.data[].code] | sort'
  // → so với CORE list dưới, sửa diff.
  // ─────────────────────────────────────────────────────────

  const CORE_VN30 = [
    // Banks (14)
    { code: "VCB", sector: "bank" }, { code: "BID", sector: "bank" },
    { code: "CTG", sector: "bank" }, { code: "TCB", sector: "bank" },
    { code: "VPB", sector: "bank" }, { code: "MBB", sector: "bank" },
    { code: "ACB", sector: "bank" }, { code: "HDB", sector: "bank" },
    { code: "STB", sector: "bank" }, { code: "SHB", sector: "bank" },
    { code: "TPB", sector: "bank" }, { code: "LPB", sector: "bank" },
    { code: "VIB", sector: "bank" }, { code: "SSB", sector: "bank" },
    // Real estate (3)
    { code: "VHM", sector: "realestate" }, { code: "VIC", sector: "realestate" },
    { code: "VRE", sector: "realestate" },
    // Consumer / Tourism (5)
    { code: "MSN", sector: "consumer" }, { code: "VNM", sector: "consumer" },
    { code: "SAB", sector: "consumer" }, { code: "VJC", sector: "consumer" },
    { code: "VPL", sector: "consumer" },
    // Retail (1)
    { code: "MWG", sector: "retail" },
    // Industrial / Materials (3)
    { code: "HPG", sector: "industrial" }, { code: "GVR", sector: "industrial" },
    { code: "DGC", sector: "industrial" },
    // Energy (2)
    { code: "GAS", sector: "energy" }, { code: "PLX", sector: "energy" },
    // Tech (1)
    { code: "FPT", sector: "tech" },
    // Broker (1)
    { code: "SSI", sector: "broker" },
  ];

  const EXTENDED = [
    // Bank (1)
    { code: "EIB", sector: "bank" },
    // Real estate mid-tier (8)
    { code: "NVL", sector: "realestate" }, { code: "BCM", sector: "realestate" },
    { code: "KDH", sector: "realestate" }, { code: "DXG", sector: "realestate" },
    { code: "KBC", sector: "realestate" }, { code: "DIG", sector: "realestate" },
    { code: "NLG", sector: "realestate" }, { code: "PDR", sector: "realestate" },
    // Consumer / Retail mid (3)
    { code: "PNJ", sector: "retail" },
    { code: "DGW", sector: "retail" }, { code: "FRT", sector: "retail" },
    // Industrial mid (5)
    { code: "HSG", sector: "industrial" }, { code: "NKG", sector: "industrial" },
    { code: "DCM", sector: "industrial" }, { code: "DPM", sector: "industrial" },
    { code: "PC1", sector: "industrial" },
    // Energy mid (1)
    { code: "BSR", sector: "energy" },
    // Utility (3)
    { code: "POW", sector: "utility" }, { code: "REE", sector: "utility" },
    { code: "NT2", sector: "utility" },
    // Tech mid (1)
    { code: "CMG", sector: "tech" },
    // Broker mid (3)
    { code: "VCI", sector: "broker" }, { code: "VND", sector: "broker" },
    { code: "HCM", sector: "broker" },
    // Pharma (3)
    { code: "DHG", sector: "pharma" }, { code: "IMP", sector: "pharma" },
    { code: "DBD", sector: "pharma" },
  ];

  const UNIVERSE = [...CORE_VN30, ...EXTENDED];

  // Sector lookup từ universe — fallback "other" cho mã ngoài
  const SECTOR_MAP = Object.fromEntries(UNIVERSE.map((u) => [u.code, u.sector]));
  function getSector(code) {
    return SECTOR_MAP[code] || "other";
  }

  // ── Full T+ Universe (HOSE + HNX listed STOCK) ─────
  // T+ quét toàn bộ HOSE + HNX (skip UPCOM penny). ~700 mã.
  // Hard filters trong T+ score (illiquid < 5 tỷ/ngày, crash > 50%/6m)
  // tự loại noise. Cache 7 ngày — list mã ít đổi.
  const TPLUS_UNIVERSE_KEY = "tplus_universe_full_v2";
  const TPLUS_UNIVERSE_TTL_MS = 7 * 24 * 3600 * 1000;

  // Valid ticker pattern: 3-4 uppercase letters
  const VALID_TICKER = /^[A-Z]{3,4}$/;

  async function fetchFullUniverse() {
    try {
      const cached = JSON.parse(localStorage.getItem(TPLUS_UNIVERSE_KEY) || "null");
      if (cached && Date.now() - cached.timestamp < TPLUS_UNIVERSE_TTL_MS &&
          cached.data && cached.data.length > 100) {
        return cached.data;
      }
    } catch {}

    try {
      // Fetch HOSE + HNX in parallel (skip UPCOM — too many penny)
      const [hose, hnx] = await Promise.all([
        fetch("https://api-finfo.vndirect.com.vn/v4/stocks?q=floor:HOSE~status:LISTED~type:STOCK&size=2000")
          .then((r) => r.ok ? r.json() : { data: [] }),
        fetch("https://api-finfo.vndirect.com.vn/v4/stocks?q=floor:HNX~status:LISTED~type:STOCK&size=2000")
          .then((r) => r.ok ? r.json() : { data: [] }),
      ]);
      const all = [...(hose.data || []), ...(hnx.data || [])];

      const result = all
        .filter((s) => VALID_TICKER.test(s.code || ""))
        .map((s) => ({
          code: s.code,
          sector: getSector(s.code),
          floor: s.floor,
        }));

      if (result.length < 100) return null;

      try {
        localStorage.setItem(TPLUS_UNIVERSE_KEY, JSON.stringify({
          timestamp: Date.now(), data: result,
        }));
      } catch {}
      return result;
    } catch {
      return null;
    }
  }

  // Set of DCA universe codes for quick membership check
  const DCA_UNIVERSE_SET = new Set(UNIVERSE.map((u) => u.code));

  const FACTOR_NAMES = [
    "ma200Quality", "lowDrawdown", "momentum6m",
    "trendConsistency", "liquidity", "foreignFlow60d",
  ];

  const CACHE_KEY = "dca_top_picks_v1";
  const CACHE_TTL_MS = 24 * 3600 * 1000; // 24h
  const CACHE_KEY_TPLUS = "tplus_top_picks_v1";
  const CACHE_TTL_TPLUS_MS = 1 * 3600 * 1000; // 1h (refresh hourly during market hours)

  // ── Indicator helpers (port từ analysis.js) ──────────
  function calcRsi(closes, period = 14) {
    if (closes.length < period + 1) return null;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) gains += d; else losses -= d;
    }
    let avgG = gains / period, avgL = losses / period;
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
      avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
    }
    if (avgL === 0) return 100;
    return 100 - 100 / (1 + avgG / avgL);
  }

  function calcBB(closes, period = 20, std = 2) {
    if (closes.length < period) return null;
    const slice = closes.slice(-period);
    const mid = slice.reduce((a, b) => a + b, 0) / period;
    const v = slice.reduce((a, b) => a + (b - mid) ** 2, 0) / period;
    const sd = Math.sqrt(v);
    return { upper: mid + sd * std, middle: mid, lower: mid - sd * std };
  }

  function calcMfi(highs, lows, closes, volumes, period = 14) {
    const n = closes.length;
    if (n < period + 1) return null;
    let posFlow = 0, negFlow = 0;
    for (let i = n - period; i < n; i++) {
      const tp = (highs[i] + lows[i] + closes[i]) / 3;
      const tpPrev = (highs[i - 1] + lows[i - 1] + closes[i - 1]) / 3;
      const rmf = tp * volumes[i];
      if (tp > tpPrev) posFlow += rmf;
      else if (tp < tpPrev) negFlow += rmf;
    }
    if (negFlow === 0) return 100;
    const r = posFlow / negFlow;
    return 100 - 100 / (1 + r);
  }

  function calcStoch(highs, lows, closes, kPer = 14, dPer = 3) {
    const n = closes.length;
    if (n < kPer + dPer) return null;
    const ks = [];
    for (let i = kPer - 1; i < n; i++) {
      const hh = Math.max(...highs.slice(i - kPer + 1, i + 1));
      const ll = Math.min(...lows.slice(i - kPer + 1, i + 1));
      ks.push(hh === ll ? 50 : (100 * (closes[i] - ll)) / (hh - ll));
    }
    const k = ks[ks.length - 1];
    const d = ks.slice(-dPer).reduce((a, b) => a + b, 0) / dPer;
    return { k, d };
  }

  function ema(values, period) {
    if (values.length < period) return null;
    const k = 2 / (period + 1);
    let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < values.length; i++) {
      e = values[i] * k + e * (1 - k);
    }
    return e;
  }

  function calcAtr(highs, lows, closes, period = 14) {
    const n = closes.length;
    if (n < period + 1) return null;
    const trs = [];
    for (let i = 1; i < n; i++) {
      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      );
      trs.push(tr);
    }
    let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < trs.length; i++) {
      atr = (atr * (period - 1) + trs[i]) / period;
    }
    return atr;
  }

  function calcAdx(highs, lows, closes, period = 14) {
    const n = closes.length;
    if (n < period * 2 + 1) return null;
    const trs = [], plusDMs = [], minusDMs = [];
    for (let i = 1; i < n; i++) {
      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      );
      const upMove = highs[i] - highs[i - 1];
      const downMove = lows[i - 1] - lows[i];
      const plusDM = upMove > downMove && upMove > 0 ? upMove : 0;
      const minusDM = downMove > upMove && downMove > 0 ? downMove : 0;
      trs.push(tr); plusDMs.push(plusDM); minusDMs.push(minusDM);
    }
    let sTR = trs.slice(0, period).reduce((a, b) => a + b, 0);
    let sPlus = plusDMs.slice(0, period).reduce((a, b) => a + b, 0);
    let sMinus = minusDMs.slice(0, period).reduce((a, b) => a + b, 0);
    const dxs = [];
    for (let i = period; i < trs.length; i++) {
      sTR = sTR - sTR / period + trs[i];
      sPlus = sPlus - sPlus / period + plusDMs[i];
      sMinus = sMinus - sMinus / period + minusDMs[i];
      const plusDI = sTR === 0 ? 0 : (100 * sPlus) / sTR;
      const minusDI = sTR === 0 ? 0 : (100 * sMinus) / sTR;
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

  function calcMacd(closes, fast = 12, slow = 26, signal = 9) {
    if (closes.length < slow + signal) return null;
    // Build MACD line series, then signal EMA
    const macdSeries = [];
    let efast = closes.slice(0, fast).reduce((a, b) => a + b, 0) / fast;
    let eslow = closes.slice(0, slow).reduce((a, b) => a + b, 0) / slow;
    const kf = 2 / (fast + 1), ks = 2 / (slow + 1);
    for (let i = 0; i < closes.length; i++) {
      if (i >= fast) efast = closes[i] * kf + efast * (1 - kf);
      if (i >= slow) eslow = closes[i] * ks + eslow * (1 - ks);
      if (i >= slow - 1) macdSeries.push(efast - eslow);
    }
    if (macdSeries.length < signal) return null;
    const sig = ema(macdSeries, signal);
    const m = macdSeries[macdSeries.length - 1];
    return { macd: m, signal: sig, hist: m - sig };
  }

  // ── T+ Score (mean-reversion focused) ───────────────
  function computeTPlusFactors(ohlcv, foreignDailyData) {
    const closes = ohlcv.closes;
    const highs = ohlcv.highs;
    const lows = ohlcv.lows;
    const volumes = ohlcv.volumes;
    const n = closes.length;
    if (n < 60) return null;

    const currentClose = closes[n - 1];
    const reasons = [];
    let score = 0;

    // RSI today vs 3 days ago (for bounce detection)
    const rsiToday = calcRsi(closes, 14);
    const rsi3 = closes.length >= 17 ? calcRsi(closes.slice(0, n - 3), 14) : null;

    // 1. RSI signals (PRIMARY edge from Phase 1.3 backtest)
    if (rsiToday !== null) {
      if (rsiToday < 25) {
        score += 3;
        reasons.push("RSI<25 quá bán cực mạnh");
      } else if (rsiToday < 30) {
        score += 2;
        reasons.push("RSI<30 quá bán");
      } else if (rsiToday < 35 && rsi3 !== null && rsi3 < 25) {
        score += 3;
        reasons.push("RSI vừa hồi từ đáy");
      }
    }

    // 2. Bollinger Bands
    const bb = calcBB(closes, 20, 2);
    if (bb) {
      if (currentClose <= bb.lower) {
        score += 1.5;
        reasons.push("Chạm BB dưới");
      } else if (closes[n - 2] <= bb.lower && currentClose > bb.lower) {
        score += 2;
        reasons.push("Bounce từ BB dưới");
      }
    }

    // 3. MFI oversold
    const mfi = calcMfi(highs, lows, closes, volumes, 14);
    if (mfi !== null && mfi < 20) {
      score += 1.5;
      reasons.push("MFI<20 quá bán");
    }

    // 4. Stochastic oversold + cross up
    const stoch = calcStoch(highs, lows, closes, 14, 3);
    if (stoch && stoch.k < 20 && stoch.k > stoch.d) {
      score += 1.5;
      reasons.push("Stoch cross lên");
    }

    // 5. Volume spike (catalyst)
    let avgVol = 0;
    if (n >= 21) {
      for (let i = n - 21; i < n - 1; i++) avgVol += volumes[i];
      avgVol /= 20;
    }
    const volRatio = avgVol > 0 ? volumes[n - 1] / avgVol : 0;
    if (volRatio > 1.5) {
      score += 1;
      reasons.push(`Vol ${volRatio.toFixed(1)}x TB`);
    }

    // 6. MACD histogram turning positive
    const macd = calcMacd(closes, 12, 26, 9);
    const macdYest = closes.length >= 36
      ? calcMacd(closes.slice(0, n - 1), 12, 26, 9)
      : null;
    if (macd && macdYest && macd.hist > 0 && macdYest.hist <= 0) {
      score += 1;
      reasons.push("MACD đảo chiều +");
    }

    // 7. Foreign flow reversal (NN bought today after sell streak)
    if (foreignDailyData && foreignDailyData.length >= 5) {
      const recent = foreignDailyData.slice(-5);
      const today = recent[recent.length - 1];
      const prev4 = recent.slice(0, -1);
      const todayBuy = (today.netVal || 0) > 0;
      const sellCount = prev4.filter((d) => (d.netVal || 0) < 0).length;
      if (todayBuy && sellCount >= 3) {
        score += 1.5;
        reasons.push("NN đảo chiều mua");
      }
    }

    // 8. ADX penalty: trend giảm RẤT mạnh + -DI dominant → mean-rev "bắt dao rơi"
    //    Magnitude nhỏ để không kill RSI edge — giảm confidence, không xóa pick
    const adxData = calcAdx(highs, lows, closes, 14);
    if (adxData && adxData.adx > 45 && adxData.minusDI > adxData.plusDI) {
      score -= 1;
      reasons.push(`ADX ${adxData.adx.toFixed(0)} -DI mạnh — bắt dao rơi`);
    }

    // 9. Volume confirmation: bar gần đây vol < 0.8 TB → setup kém tin cậy
    if (volRatio > 0 && volRatio < 0.8) {
      score -= 0.5;
      reasons.push(`Vol thấp ${volRatio.toFixed(1)}x — thiếu xác nhận`);
    }

    // 10. Deep downtrend: giá cách MA50 -12% trở lên → downside còn xa
    let ma50 = null;
    if (n >= 50) {
      ma50 = closes.slice(n - 50).reduce((a, b) => a + b, 0) / 50;
    }
    if (ma50 && currentClose < ma50 * 0.88) {
      score -= 0.5;
      reasons.push("Cách MA50 -12% — downtrend chưa hết");
    }

    // ── Hard filters ──
    let avgTurnover = 0;
    const liqLookback = Math.min(20, n);
    for (let i = n - liqLookback; i < n; i++) {
      avgTurnover += closes[i] * volumes[i] * 1000;
    }
    avgTurnover /= liqLookback;

    const filterIlliquid = avgTurnover < 5e9; // < 5 tỷ/day
    let filterCrash = false;
    if (n > 127) {
      const ret6m = currentClose / closes[n - 127] - 1;
      filterCrash = ret6m < -0.5; // crashed >50% in 6m → catching knife
    }

    if (filterIlliquid || filterCrash) {
      score = -999;
    }

    // Day change
    const dayChange = n >= 2 ? (currentClose - closes[n - 2]) / closes[n - 2] : 0;

    // Session turnover phiên hiện tại (price × vol × 1000 để ra VND vì price k-VND)
    // Khác với avgTurnover (20-day avg) — phiên hôm nay có thể rất khác avg
    const sessionTurnover = currentClose * volumes[n - 1] * 1000;
    const lowSessionLiq = sessionTurnover < 2e9; // < 2 tỷ phiên này = vào dễ ra khó

    // Penalty nếu phiên này thanh khoản kém (không bị filter cứng)
    if (lowSessionLiq && !filterIlliquid && score > -900) {
      score -= 0.5;
      reasons.push("TKL phiên này <2 tỷ — kẹt hàng");
    }

    // Risk flags (đồng nhất với analysis.js — UI consume)
    const flags = {
      bearTrap: !!(adxData && adxData.adx > 45 && adxData.minusDI > adxData.plusDI),
      lowVol: volRatio > 0 && volRatio < 0.8,
      deepDowntrend: !!(ma50 && currentClose < ma50 * 0.88),
      lowSessionLiq,
    };

    return {
      score,
      reasons,
      flags,
      currentPrice: currentClose,
      dayChange,
      rsiToday,
      mfi,
      avgTurnover,
      filterIlliquid,
      filterCrash,
    };
  }

  // ── Helpers ──
  function sma(arr, period, end) {
    if (end < period) return null;
    let sum = 0;
    for (let i = end - period; i < end; i++) sum += arr[i];
    return sum / period;
  }

  // ── Compute factors for one stock from OHLCV + foreign flow data ──
  function computeFactors(ohlcv, foreignDailyData) {
    const closes = ohlcv.closes;
    const highs = ohlcv.highs;
    const volumes = ohlcv.volumes;
    const n = closes.length;
    if (n < 200) return null;

    const currentClose = closes[n - 1];

    // 1. MA200 quality: % time above MA200 in last min(252, n-200) bars
    const ma200Lookback = Math.min(252, n - 200);
    let aboveCount = 0;
    for (let i = n - ma200Lookback; i < n; i++) {
      const ma = sma(closes, 200, i);
      if (ma !== null && closes[i] > ma) aboveCount++;
    }
    const ma200Quality = ma200Lookback > 0 ? aboveCount / ma200Lookback : null;

    // 2. Low drawdown 252 (negative number; higher = better)
    const ddLookback = Math.min(252, n);
    let runningMax = closes[n - ddLookback];
    let maxDD = 0;
    for (let i = n - ddLookback; i < n; i++) {
      if (closes[i] > runningMax) runningMax = closes[i];
      const dd = (closes[i] - runningMax) / runningMax;
      if (dd < maxDD) maxDD = dd;
    }
    const lowDrawdown = maxDD;

    // 3. Momentum 6m (cap at 100%)
    const idx6mAgo = Math.max(0, n - 127);
    const close6m = closes[idx6mAgo];
    const momentum6m = close6m > 0 ? Math.min(1.0, currentClose / close6m - 1) : null;

    // 4. Trend consistency: 252-day daily-return Sharpe
    const retLookback = Math.min(252, n - 1);
    const dailyRets = [];
    for (let i = n - retLookback; i < n; i++) {
      if (closes[i - 1] > 0) {
        dailyRets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
      }
    }
    let trendConsistency = null;
    if (dailyRets.length > 30) {
      const mean = dailyRets.reduce((a, b) => a + b, 0) / dailyRets.length;
      const variance = dailyRets.reduce((a, b) => a + (b - mean) ** 2, 0) / dailyRets.length;
      const std = Math.sqrt(variance);
      trendConsistency = std > 0 ? mean / std : 0;
    }

    // 5. Liquidity: log of avg 20-day turnover (close in thousand-VND → ×1000)
    let sumTurnover = 0;
    let count = 0;
    const liqLookback = Math.min(20, n);
    for (let i = n - liqLookback; i < n; i++) {
      sumTurnover += closes[i] * volumes[i] * 1000;
      count++;
    }
    const avgTurnover = count > 0 ? sumTurnover / count : 0;
    const liquidity = Math.log1p(avgTurnover);

    // 6. Foreign flow 60-day cumulative (sign × log magnitude)
    let nn60d = 0;
    if (foreignDailyData && foreignDailyData.length > 0) {
      const recent = foreignDailyData.slice(-60);
      nn60d = recent.reduce((s, r) => s + (r.netVal || 0), 0);
    }
    const foreignFlow60d = Math.sign(nn60d) * Math.log1p(Math.abs(nn60d) / 1e9);

    // ── Hard filters ──
    const ma200Now = sma(closes, 200, n);
    const ma200_20agoIdx = n - 20;
    const ma200_20ago = ma200_20agoIdx >= 200 ? sma(closes, 200, ma200_20agoIdx) : null;
    const ma200Declining = ma200Now !== null && ma200_20ago !== null && ma200Now < ma200_20ago;
    const filterBelowMa200 = ma200Now === null || currentClose < ma200Now || ma200Declining;
    const filterTooHot = momentum6m !== null && momentum6m >= 1.0;
    const filterIlliquid = avgTurnover < 10e9;

    return {
      ma200Quality, lowDrawdown, momentum6m, trendConsistency,
      liquidity, foreignFlow60d,
      filterBelowMa200, filterTooHot, filterIlliquid,
      avgTurnover, currentPrice: currentClose,
      // Day change for display
      dayChange: n >= 2 ? (currentClose - closes[n - 2]) / closes[n - 2] : 0,
      ma200: ma200Now,
    };
  }

  // ── Cross-sectional z-score across all stocks ──
  function computeZscores(allStocks) {
    for (const fn of FACTOR_NAMES) {
      const values = allStocks
        .map((s) => (s.factors ? s.factors[fn] : null))
        .filter((v) => v !== null && !isNaN(v));
      if (values.length < 5) continue;

      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
      const std = Math.sqrt(variance);

      for (const stock of allStocks) {
        if (!stock.factors) continue;
        const v = stock.factors[fn];
        stock.factors[fn + "_z"] =
          v !== null && !isNaN(v) && std > 0 ? (v - mean) / std : null;
      }
    }

    // Combine z-scores → DCA score (need ≥4 of 6 factors)
    for (const stock of allStocks) {
      if (!stock.factors) {
        stock.score = null;
        stock.eligible = false;
        continue;
      }
      const zVals = FACTOR_NAMES.map((fn) => stock.factors[fn + "_z"]).filter(
        (v) => v !== null && !isNaN(v)
      );
      if (zVals.length < 4) {
        stock.score = null;
      } else {
        stock.score = zVals.reduce((a, b) => a + b, 0) / zVals.length;
      }
      const f = stock.factors;
      stock.eligible = !(f.filterBelowMa200 || f.filterTooHot || f.filterIlliquid);
      if (!stock.eligible) stock.score = null;
    }
  }

  // ── Top-N selection with sector cap ──
  function selectTopN(allStocks, n, sectorCap) {
    const valid = allStocks.filter((s) => s.score !== null && s.eligible);
    valid.sort((a, b) => b.score - a.score);

    const picks = [];
    const sectorCount = {};
    for (const stock of valid) {
      if (sectorCap !== null) {
        if ((sectorCount[stock.sector] || 0) >= sectorCap) continue;
      }
      picks.push(stock);
      sectorCount[stock.sector] = (sectorCount[stock.sector] || 0) + 1;
      if (picks.length >= n) break;
    }
    return picks;
  }

  // ── Fetch foreign flow daily data (returns raw array, not summary) ──
  async function fetchForeignDaily(symbol, daysBack = 70) {
    const toDate = new Date().toISOString().split("T")[0];
    const fromDate = new Date(Date.now() - daysBack * 24 * 3600 * 1000)
      .toISOString().split("T")[0];
    const url = `https://api-finfo.vndirect.com.vn/v4/foreigns?q=code:${symbol}~tradingDate:gte:${fromDate}~tradingDate:lte:${toDate}&size=200&sort=tradingDate:asc`;
    try {
      const res = await fetch(url);
      if (!res.ok) return [];
      const json = await res.json();
      return json.data || [];
    } catch {
      return [];
    }
  }

  // ── Main: load + compute + rank ──
  async function loadTopPicks(opts = {}) {
    const {
      topN = 15,
      sectorCap = 2,
      useCache = true,
      onProgress,
    } = opts;

    if (useCache) {
      try {
        const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
        if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
          return { ...cached.data, fromCache: true };
        }
      } catch {}
    }

    const startTime = Date.now();
    const stocks = UNIVERSE.map((u) => ({ symbol: u.code, sector: u.sector }));

    // Fetch in batches of 10 to avoid overwhelming network
    const batchSize = 10;
    let done = 0;
    for (let i = 0; i < stocks.length; i += batchSize) {
      const batch = stocks.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (stock) => {
          try {
            const [ohlcv, foreign] = await Promise.all([
              ANALYSIS.fetchHistory(stock.symbol, "D", 320),
              fetchForeignDaily(stock.symbol, 70),
            ]);
            stock.factors = computeFactors(ohlcv, foreign);
          } catch (e) {
            stock.error = e.message;
            stock.factors = null;
          }
          done++;
          if (onProgress) onProgress(done, stocks.length);
        })
      );
    }

    computeZscores(stocks);
    const picks = selectTopN(stocks, topN, sectorCap);

    const result = {
      picks: picks.map((p) => ({
        symbol: p.symbol,
        sector: p.sector,
        score: p.score,
        factors: p.factors,
      })),
      allCount: stocks.length,
      eligibleCount: stocks.filter((s) => s.eligible).length,
      timestamp: Date.now(),
      duration: Date.now() - startTime,
      fromCache: false,
    };

    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        timestamp: Date.now(),
        data: result,
      }));
    } catch {}

    return result;
  }

  function clearCache() {
    localStorage.removeItem(CACHE_KEY);
    localStorage.removeItem(CACHE_KEY_TPLUS);
  }

  // ── Market Regime Detection ──────────────────────
  // Phân loại thị trường VN-Index thành BULL/BEAR/RANGE
  // dựa trên MA50/MA200 + 3-month return + volatility.
  // Cache 1 giờ.
  const REGIME_CACHE_KEY = "vnindex_regime_v1";
  const REGIME_CACHE_TTL_MS = 1 * 3600 * 1000;

  async function getMarketRegime() {
    try {
      const cached = JSON.parse(localStorage.getItem(REGIME_CACHE_KEY) || "null");
      if (cached && Date.now() - cached.timestamp < REGIME_CACHE_TTL_MS) {
        return cached.data;
      }
    } catch {}

    try {
      const data = await ANALYSIS.fetchHistory("VNINDEX", "D", 320);
      const closes = data.closes;
      const highs = data.highs;
      const lows = data.lows;
      const n = closes.length;
      if (n < 200) return null;

      const current = closes[n - 1];
      const prev = closes[n - 2];
      const dayChange = ((current - prev) / prev) * 100;

      const ma50 = sma(closes, 50, n);
      const ma200 = sma(closes, 200, n);

      const m3Idx = Math.max(0, n - 63);
      const ret3m = closes[m3Idx] > 0 ? (current / closes[m3Idx] - 1) * 100 : 0;
      const m1Idx = Math.max(0, n - 21);
      const ret1m = closes[m1Idx] > 0 ? (current / closes[m1Idx] - 1) * 100 : 0;

      const atr14 = calcAtr(highs, lows, closes, 14);
      const atrPct = atr14 ? (atr14 / current) * 100 : 0;

      const distMa200 = ma200 ? ((current - ma200) / ma200) * 100 : 0;
      const distMa50 = ma50 ? ((current - ma50) / ma50) * 100 : 0;

      // Classify regime
      const aboveMa200 = ma200 && current > ma200;
      const ma50Above200 = ma50 && ma200 && ma50 > ma200;

      let regime, label, color;
      if (aboveMa200 && ma50Above200 && ret3m > 5) {
        regime = "BULL";
        label = ret3m > 20 ? "Bull mạnh" : "Bull";
        color = "#4CAF50";
      } else if (!aboveMa200 && !ma50Above200 && ret3m < -5) {
        regime = "BEAR";
        label = ret3m < -20 ? "Bear mạnh" : "Bear";
        color = "#ff4444";
      } else if (aboveMa200 && ret3m > 0) {
        regime = "BULL_WEAK";
        label = "Bull yếu";
        color = "#8BC34A";
      } else if (!aboveMa200 && ret3m < 0) {
        regime = "BEAR_WEAK";
        label = "Bear yếu";
        color = "#FF5722";
      } else {
        regime = "RANGE";
        label = "Đi ngang";
        color = "#FF9800";
      }

      const result = {
        regime,
        label,
        color,
        currentValue: current,
        dayChange,
        ma50, ma200,
        distMa50, distMa200,
        ret1m, ret3m,
        atrPct,
        timestamp: Date.now(),
      };

      try {
        localStorage.setItem(REGIME_CACHE_KEY, JSON.stringify({
          timestamp: Date.now(), data: result,
        }));
      } catch {}

      return result;
    } catch {
      return null;
    }
  }

  // ── T+ ranking main ───────────────────────────────
  // Min score threshold (validated by Phase 4b backtest):
  //   - 2.0: no edge vs random (avg +1.10% / Sharpe 0.11)
  //   - 4.0: real edge (avg +2.66% / Sharpe 0.25, win rate 58%)
  //   - 5.0: best (avg +3.99% / Sharpe 0.36, win rate 63%) but rare
  // Use 4.0 as production threshold for balance of signal quality + frequency.
  const TPLUS_MIN_SCORE = 4.0;

  async function loadTopPicksTPlus(opts = {}) {
    const {
      topN = 10,
      useCache = true,
      onProgress,
    } = opts;

    // Bear regime → raise threshold để chỉ pick setup cực mạnh
    const regime = await getMarketRegime().catch(() => null);
    const minScore = (regime && (regime.regime === "BEAR" || regime.regime === "BEAR_WEAK"))
      ? 5.0
      : TPLUS_MIN_SCORE;

    if (useCache) {
      try {
        const cached = JSON.parse(localStorage.getItem(CACHE_KEY_TPLUS) || "null");
        if (cached && Date.now() - cached.timestamp < CACHE_TTL_TPLUS_MS) {
          return { ...cached.data, fromCache: true };
        }
      } catch {}
    }

    const startTime = Date.now();
    // T+ quét full HOSE + HNX (~700 mã). Fallback về DCA universe nếu API fail.
    let universeList = await fetchFullUniverse();
    if (!universeList || universeList.length < 100) {
      universeList = UNIVERSE;
    }
    const stocks = universeList.map((u) => ({ symbol: u.code, sector: u.sector }));

    // Skip foreign flow fetch cho mã ngoài DCA universe để tăng tốc 2x.
    // NN reversal signal worth +1.5/13 max — drop OK cho mã extended.
    // Batch 20 parallel cho fast scan.
    const batchSize = 20;
    let done = 0;
    for (let i = 0; i < stocks.length; i += batchSize) {
      const batch = stocks.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (stock) => {
          try {
            const isDcaUniverse = DCA_UNIVERSE_SET.has(stock.symbol);
            const ohlcv = await ANALYSIS.fetchHistory(stock.symbol, "D", 200);
            const foreign = isDcaUniverse
              ? await fetchForeignDaily(stock.symbol, 10).catch(() => null)
              : null;
            stock.tplusFactors = computeTPlusFactors(ohlcv, foreign);
          } catch (e) {
            stock.error = e.message;
            stock.tplusFactors = null;
          }
          done++;
          if (onProgress) onProgress(done, stocks.length);
        })
      );
    }

    // Filter by min score, sort by score
    const valid = stocks
      .filter((s) => s.tplusFactors && s.tplusFactors.score >= minScore)
      .sort((a, b) => b.tplusFactors.score - a.tplusFactors.score);

    const picks = valid.slice(0, topN).map((s) => ({
      symbol: s.symbol,
      sector: s.sector,
      score: s.tplusFactors.score,
      reasons: s.tplusFactors.reasons,
      factors: s.tplusFactors,
    }));

    const result = {
      picks,
      allCount: stocks.length,
      eligibleCount: valid.length,
      regime,
      minScore,
      timestamp: Date.now(),
      duration: Date.now() - startTime,
      fromCache: false,
    };

    try {
      localStorage.setItem(CACHE_KEY_TPLUS, JSON.stringify({
        timestamp: Date.now(),
        data: result,
      }));
    } catch {}

    return result;
  }

  // ── Paper Trading Tracker ────────────────────────
  // Auto-snapshot top picks để theo dõi performance thực tế vs backtest.
  // - DCA: snapshot 1 lần/tháng
  // - T+: snapshot mỗi ngày có picks
  // Stored in localStorage. Max 24 snapshots/mode (~2 năm DCA, ~1 tháng T+).
  const TRACKER_KEY = "paper_tracker_v1";
  const MAX_SNAPSHOTS_DCA = 24;
  const MAX_SNAPSHOTS_TPLUS = 60;

  function loadTracker() {
    try {
      const raw = localStorage.getItem(TRACKER_KEY);
      if (!raw) return { dca: [], tplus: [] };
      const parsed = JSON.parse(raw);
      return {
        dca: Array.isArray(parsed.dca) ? parsed.dca : [],
        tplus: Array.isArray(parsed.tplus) ? parsed.tplus : [],
      };
    } catch {
      return { dca: [], tplus: [] };
    }
  }

  function saveTracker(t) {
    try {
      localStorage.setItem(TRACKER_KEY, JSON.stringify(t));
    } catch {}
  }

  function shouldSnapshot(mode, tracker) {
    const arr = tracker[mode] || [];
    if (arr.length === 0) return true;
    const last = new Date(arr[arr.length - 1].date);
    const now = new Date();
    if (mode === "dca") {
      // 1 lần/tháng
      return last.getMonth() !== now.getMonth() || last.getFullYear() !== now.getFullYear();
    } else {
      // 1 lần/ngày (theo local date)
      return last.toDateString() !== now.toDateString();
    }
  }

  function takeSnapshot(mode, picks, regime) {
    const tracker = loadTracker();
    const dateIso = new Date().toISOString();
    const regimeStr = regime ? regime.regime : null;
    const picksData = picks.map((p) => ({
      symbol: p.symbol,
      sector: p.sector,
      score: p.score,
      entryPrice: p.factors ? p.factors.currentPrice : null,
      reasons: p.reasons || null,
    }));
    const entry = { date: dateIso, regime: regimeStr, picks: picksData };
    tracker[mode].push(entry);
    const max = mode === "dca" ? MAX_SNAPSHOTS_DCA : MAX_SNAPSHOTS_TPLUS;
    if (tracker[mode].length > max) {
      tracker[mode] = tracker[mode].slice(-max);
    }
    saveTracker(tracker);
    // DB write-through
    if (_isOnline()) {
      _AUTH().dbInsert("tracker_snapshots", {
        mode,
        snapshot_date: dateIso,
        regime: regimeStr,
        picks: picksData,
      }).catch((e) => console.warn("[tracker] DB insert:", e));
    }
  }

  async function clearTracker() {
    localStorage.removeItem(TRACKER_KEY);
    if (_isOnline()) {
      const c = _AUTH();
      try {
        const all = await c.dbSelect("tracker_snapshots", { columns: "id" });
        if (all && all.length > 0) {
          for (const row of all) {
            await c.dbDelete("tracker_snapshots", { eq: { id: row.id } }).catch(() => {});
          }
        }
      } catch (e) {
        console.warn("[tracker] DB clear:", e);
      }
    }
  }

  /** Pull tracker snapshots từ DB → replace local. */
  async function syncTrackerFromDB() {
    if (!_isOnline()) return;
    const data = await _AUTH().dbSelect("tracker_snapshots", {
      order: { column: "snapshot_date", ascending: true },
    });
    if (data) {
      const tracker = { dca: [], tplus: [] };
      for (const row of data) {
        const entry = {
          date: row.snapshot_date,
          regime: row.regime,
          picks: row.picks || [],
        };
        if (row.mode === "dca") tracker.dca.push(entry);
        else if (row.mode === "tplus") tracker.tplus.push(entry);
      }
      // Trim to max
      tracker.dca = tracker.dca.slice(-MAX_SNAPSHOTS_DCA);
      tracker.tplus = tracker.tplus.slice(-MAX_SNAPSHOTS_TPLUS);
      saveTracker(tracker);
    }
  }

  async function migrateTrackerToDB() {
    if (!_isOnline()) return;
    const tracker = loadTracker();
    const all = [];
    for (const m of ["dca", "tplus"]) {
      for (const e of tracker[m] || []) {
        all.push({
          mode: m,
          snapshot_date: e.date,
          regime: e.regime,
          picks: e.picks || [],
        });
      }
    }
    if (all.length === 0) return;
    // Insert in batches
    const batchSize = 20;
    for (let i = 0; i < all.length; i += batchSize) {
      const batch = all.slice(i, i + batchSize);
      await _AUTH().dbInsert("tracker_snapshots", batch).catch(() => {});
    }
  }

  // ── Watchlist (mã user theo dõi) ────────────────────
  // Pattern: localStorage là source of truth cho sync reads,
  // DB sync trong background khi user logged in.
  const WATCHLIST_KEY = "user_watchlist_v1";
  const WATCHLIST_DATA_KEY = "watchlist_data_v1";
  const WATCHLIST_DATA_TTL = 30 * 60 * 1000;

  function _AUTH() { return window.__SSI_AUTH__; }
  function _isOnline() {
    return _AUTH() && _AUTH().isLoggedIn();
  }

  function loadWatchlist() {
    try {
      const raw = localStorage.getItem(WATCHLIST_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function saveWatchlist(arr) {
    try {
      localStorage.setItem(WATCHLIST_KEY, JSON.stringify(arr));
    } catch {}
  }

  function isInWatchlist(symbol) {
    if (!symbol) return false;
    const sym = symbol.toUpperCase();
    return loadWatchlist().some((w) => w.symbol === sym);
  }

  function addToWatchlist(symbol) {
    if (!symbol) return false;
    const sym = symbol.toUpperCase();
    const list = loadWatchlist();
    if (list.some((w) => w.symbol === sym)) return false;
    list.push({ symbol: sym, addedAt: Date.now() });
    saveWatchlist(list);
    try { localStorage.removeItem(WATCHLIST_DATA_KEY); } catch {}
    // DB write-through (fire-and-forget)
    if (_isOnline()) {
      _AUTH().dbInsert("watchlist", { symbol: sym })
        .catch((e) => console.warn("[watchlist] DB insert:", e));
    }
    return true;
  }

  function removeFromWatchlist(symbol) {
    if (!symbol) return false;
    const sym = symbol.toUpperCase();
    const list = loadWatchlist().filter((w) => w.symbol !== sym);
    saveWatchlist(list);
    try { localStorage.removeItem(WATCHLIST_DATA_KEY); } catch {}
    // DB delete (fire-and-forget)
    if (_isOnline()) {
      _AUTH().dbDelete("watchlist", { eq: { symbol: sym } })
        .catch((e) => console.warn("[watchlist] DB delete:", e));
    }
    return true;
  }

  function toggleWatchlist(symbol) {
    if (isInWatchlist(symbol)) {
      removeFromWatchlist(symbol);
      return false;
    } else {
      addToWatchlist(symbol);
      return true;
    }
  }

  /** Pull watchlist từ DB → replace local cache. */
  async function syncWatchlistFromDB() {
    if (!_isOnline()) return;
    const data = await _AUTH().dbSelect("watchlist", {
      order: { column: "added_at", ascending: false },
    });
    if (data) {
      const arr = data.map((d) => ({
        symbol: d.symbol,
        addedAt: new Date(d.added_at).getTime(),
      }));
      saveWatchlist(arr);
    }
  }

  /** Push local watchlist → DB (migration). Skip duplicates. */
  async function migrateWatchlistToDB() {
    if (!_isOnline()) return;
    const local = loadWatchlist();
    if (local.length === 0) return;
    for (const item of local) {
      await _AUTH().dbInsert("watchlist", { symbol: item.symbol })
        .catch(() => {}); // ignore duplicates (unique constraint)
    }
  }

  /**
   * Fetch latest data + analysis for each watchlist symbol.
   * Returns array of {symbol, sector, currentPrice, dayChange, score,
   *   recommendation, recColor, rsi, error?}.
   */
  async function fetchWatchlistData(opts = {}) {
    const { useCache = true, onProgress } = opts;
    const list = loadWatchlist();
    if (list.length === 0) return [];

    if (useCache) {
      try {
        const cached = JSON.parse(localStorage.getItem(WATCHLIST_DATA_KEY) || "null");
        if (cached && Date.now() - cached.timestamp < WATCHLIST_DATA_TTL) {
          // Verify cache covers current watchlist
          const cachedSyms = new Set((cached.data || []).map((d) => d.symbol));
          const currentSyms = new Set(list.map((w) => w.symbol));
          if (cachedSyms.size === currentSyms.size &&
              [...currentSyms].every((s) => cachedSyms.has(s))) {
            return cached.data;
          }
        }
      } catch {}
    }

    const result = [];
    const batchSize = 5;
    let done = 0;
    for (let i = 0; i < list.length; i += batchSize) {
      const batch = list.slice(i, i + batchSize);
      await Promise.all(batch.map(async (w) => {
        try {
          const data = await ANALYSIS.fetchHistory(w.symbol, "D", 250);
          const r = ANALYSIS.analyze(w.symbol, data, {});
          result.push({
            symbol: w.symbol,
            sector: getSector(w.symbol),
            currentPrice: r.current,
            dayChange: r.dayChange,
            score: r.score,
            recommendation: r.recommendation,
            recColor: r.recColor,
            rsi: r.rsi,
            addedAt: w.addedAt,
          });
        } catch (e) {
          result.push({ symbol: w.symbol, error: e.message });
        }
        done++;
        if (onProgress) onProgress(done, list.length);
      }));
    }

    // Sort by addedAt (newest first)
    result.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

    try {
      localStorage.setItem(WATCHLIST_DATA_KEY, JSON.stringify({
        timestamp: Date.now(), data: result,
      }));
    } catch {}

    return result;
  }

  // ── Alert system ─────────────────────────────────
  // Phát hiện thay đổi tín hiệu trong watchlist + log lại để hiện
  // notification trong app (+ optional browser notification).
  const ALERTS_STATE_KEY = "alerts_state_v1";
  const ALERTS_LOG_KEY = "alerts_log_v1";
  const MAX_ALERTS = 100;

  function loadAlertsState() {
    try {
      return JSON.parse(localStorage.getItem(ALERTS_STATE_KEY) || "{}");
    } catch {
      return {};
    }
  }
  function saveAlertsState(state) {
    try {
      localStorage.setItem(ALERTS_STATE_KEY, JSON.stringify(state));
    } catch {}
  }
  function loadAlerts() {
    try {
      const arr = JSON.parse(localStorage.getItem(ALERTS_LOG_KEY) || "[]");
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  function saveAlerts(arr) {
    try {
      localStorage.setItem(ALERTS_LOG_KEY, JSON.stringify(arr.slice(-MAX_ALERTS)));
    } catch {}
  }
  function pushAlert(alert) {
    const arr = loadAlerts();
    arr.push(alert);
    saveAlerts(arr);
    // DB insert (fire-and-forget)
    if (_isOnline()) {
      _AUTH().dbInsert("alerts", {
        symbol: alert.symbol,
        type: alert.type,
        title: alert.title,
        message: alert.message,
        color: alert.color,
        seen: !!alert.seen,
        created_at: new Date(alert.timestamp).toISOString(),
      }).catch((e) => console.warn("[alerts] DB insert:", e));
    }
  }
  function unreadAlertCount() {
    return loadAlerts().filter((a) => !a.seen).length;
  }
  function markAllAlertsSeen() {
    const arr = loadAlerts();
    const wasUnread = arr.filter((a) => !a.seen);
    arr.forEach((a) => { a.seen = true; });
    saveAlerts(arr);
    // DB: mark all unread → seen
    if (_isOnline() && wasUnread.length > 0) {
      _AUTH().dbUpdate("alerts", { seen: true }, { eq: { seen: false } })
        .catch((e) => console.warn("[alerts] DB mark seen:", e));
    }
  }
  async function clearAlerts() {
    try {
      localStorage.removeItem(ALERTS_LOG_KEY);
    } catch {}
    if (_isOnline()) {
      // Supabase JS SDK requires filter cho delete. Dùng id != 0-uuid để match all.
      const c = _AUTH();
      try {
        const all = await c.dbSelect("alerts", { columns: "id" });
        if (all && all.length > 0) {
          for (const row of all) {
            await c.dbDelete("alerts", { eq: { id: row.id } }).catch(() => {});
          }
        }
      } catch (e) {
        console.warn("[alerts] DB clear:", e);
      }
    }
  }
  // alert_state DB sync
  async function syncAlertStateFromDB() {
    if (!_isOnline()) return;
    const data = await _AUTH().dbSelect("alert_state");
    if (data) {
      const state = {};
      for (const row of data) {
        state[row.symbol] = {
          score: row.score,
          rsi: row.rsi,
          dayChange: row.day_change,
          lastSeenAt: new Date(row.last_seen_at).getTime(),
        };
      }
      saveAlertsState(state);
    }
  }
  async function syncAlertsFromDB() {
    if (!_isOnline()) return;
    const data = await _AUTH().dbSelect("alerts", {
      order: { column: "created_at", ascending: true },
      limit: MAX_ALERTS,
    });
    if (data) {
      const arr = data.map((r) => ({
        timestamp: new Date(r.created_at).getTime(),
        symbol: r.symbol,
        type: r.type,
        title: r.title,
        message: r.message,
        color: r.color,
        seen: !!r.seen,
      }));
      saveAlerts(arr);
    }
  }
  async function migrateAlertsToDB() {
    if (!_isOnline()) return;
    const local = loadAlerts();
    for (const a of local) {
      await _AUTH().dbInsert("alerts", {
        symbol: a.symbol,
        type: a.type,
        title: a.title,
        message: a.message,
        color: a.color,
        seen: !!a.seen,
        created_at: new Date(a.timestamp).toISOString(),
      }).catch(() => {});
    }
  }
  async function migrateAlertStateToDB() {
    if (!_isOnline()) return;
    const state = loadAlertsState();
    const rows = Object.entries(state).map(([symbol, s]) => ({
      symbol,
      score: s.score,
      rsi: s.rsi,
      day_change: s.dayChange,
      last_seen_at: new Date(s.lastSeenAt || Date.now()).toISOString(),
    }));
    if (rows.length === 0) return;
    await _AUTH().dbUpsert("alert_state", rows, { onConflict: "user_id,symbol" })
      .catch((e) => console.warn("[alert_state] migrate:", e));
  }

  /**
   * So sánh data mới với state cũ → generate alerts cho mỗi mã có
   * tín hiệu mới đáng chú ý. Returns array of new alerts (also saves to log).
   *
   * Trigger conditions:
   *  - score crossed up to ≥4 (Setup tốt mới hit)
   *  - score crossed down to <-3 (Cảnh báo rủi ro mới hit)
   *  - RSI crossed below 25 (T+ opportunity mới)
   *  - |day change| ≥ 5%
   */
  function detectAlerts(watchlistData) {
    const state = loadAlertsState();
    const newAlerts = [];
    const now = Date.now();

    for (const d of watchlistData) {
      if (d.error) continue;
      const sym = d.symbol;
      const prev = state[sym] || {};

      // 1. Score crossed into "Setup tốt"
      if (d.score >= 4 && (prev.score == null || prev.score < 4)) {
        newAlerts.push({
          timestamp: now, symbol: sym, type: "strong_setup",
          title: `${sym} — Setup tốt`,
          message: `Score ${d.score >= 0 ? "+" : ""}${d.score.toFixed(1)} (từ ${prev.score != null ? (prev.score >= 0 ? "+" : "") + prev.score.toFixed(1) : "?"})`,
          color: "#4CAF50", seen: false,
        });
      }
      // 2. Score crossed into "Cảnh báo"
      if (d.score < -3 && (prev.score == null || prev.score >= -3)) {
        newAlerts.push({
          timestamp: now, symbol: sym, type: "warning",
          title: `${sym} — Cảnh báo rủi ro`,
          message: `Score ${d.score.toFixed(1)} (từ ${prev.score != null ? (prev.score >= 0 ? "+" : "") + prev.score.toFixed(1) : "?"})`,
          color: "#ff4444", seen: false,
        });
      }
      // 3. RSI crossed below 25 (T+ opportunity)
      if (d.rsi != null && d.rsi < 25 && (prev.rsi == null || prev.rsi >= 25)) {
        newAlerts.push({
          timestamp: now, symbol: sym, type: "oversold",
          title: `${sym} — RSI quá bán mạnh`,
          message: `RSI ${d.rsi.toFixed(1)} (T+ opportunity)`,
          color: "#FF9800", seen: false,
        });
      }
      // 4. Big move (|day change| >= 5%)
      const moveAbs = Math.abs(d.dayChange || 0);
      const prevMoveAbs = Math.abs(prev.dayChange || 0);
      if (moveAbs >= 5 && prevMoveAbs < 5) {
        const dir = d.dayChange > 0 ? "tăng" : "giảm";
        newAlerts.push({
          timestamp: now, symbol: sym, type: "big_move",
          title: `${sym} — biến động mạnh`,
          message: `${dir} ${d.dayChange.toFixed(2)}% hôm nay`,
          color: d.dayChange > 0 ? "#4CAF50" : "#ff4444",
          seen: false,
        });
      }

      // Update state
      state[sym] = {
        score: d.score,
        rsi: d.rsi,
        dayChange: d.dayChange,
        lastSeenAt: now,
      };
    }

    saveAlertsState(state);

    // Save new alerts to log (also writes through to DB)
    if (newAlerts.length > 0) {
      // Use pushAlert one-by-one to trigger DB writes
      for (const a of newAlerts) {
        const log = loadAlerts();
        log.push(a);
        saveAlerts(log);
        if (_isOnline()) {
          _AUTH().dbInsert("alerts", {
            symbol: a.symbol,
            type: a.type,
            title: a.title,
            message: a.message,
            color: a.color,
            seen: false,
            created_at: new Date(a.timestamp).toISOString(),
          }).catch((e) => console.warn("[alerts] DB insert:", e));
        }
      }
    }

    // Persist alert_state to DB (upsert affected symbols)
    if (_isOnline() && watchlistData.length > 0) {
      const rows = watchlistData.filter((d) => !d.error).map((d) => ({
        symbol: d.symbol,
        score: d.score,
        rsi: d.rsi,
        day_change: d.dayChange,
        last_seen_at: new Date(now).toISOString(),
      }));
      if (rows.length > 0) {
        _AUTH().dbUpsert("alert_state", rows, { onConflict: "user_id,symbol" })
          .catch((e) => console.warn("[alert_state] DB upsert:", e));
      }
    }
    return newAlerts;
  }

  // Fetch current prices for unique symbols across all snapshots
  async function fetchCurrentPrices(symbols) {
    const result = {};
    const batchSize = 10;
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (sym) => {
          try {
            const data = await ANALYSIS.fetchHistory(sym, "D", 5);
            result[sym] = data.closes[data.closes.length - 1];
          } catch {
            result[sym] = null;
          }
        })
      );
    }
    return result;
  }

  return {
    UNIVERSE,
    FACTOR_NAMES,
    loadTopPicks,
    loadTopPicksTPlus,
    getMarketRegime,
    clearCache,
    // Paper tracker
    loadTracker,
    shouldSnapshot,
    takeSnapshot,
    clearTracker,
    fetchCurrentPrices,
    // Watchlist
    loadWatchlist,
    isInWatchlist,
    addToWatchlist,
    removeFromWatchlist,
    toggleWatchlist,
    fetchWatchlistData,
    // Alerts
    detectAlerts,
    loadAlerts,
    unreadAlertCount,
    markAllAlertsSeen,
    clearAlerts,
    // DB sync helpers (called on login/logout)
    syncWatchlistFromDB,
    syncAlertsFromDB,
    syncAlertStateFromDB,
    syncTrackerFromDB,
    migrateWatchlistToDB,
    migrateAlertsToDB,
    migrateAlertStateToDB,
    migrateTrackerToDB,
  };
})();
