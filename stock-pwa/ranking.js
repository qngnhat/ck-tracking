// ═══════════════════════════════════════
// DCA Ranking — port của backtest/src/dca_score.py + rebalance.py
// ═══════════════════════════════════════

window.__SSI_RANKING__ = (function () {
  "use strict";

  const ANALYSIS = window.__SSI_ANALYSIS__;

  // Universe + sector mapping (từ backtest/src/sectors.py)
  const UNIVERSE = [
    { code: "VCB", sector: "bank" }, { code: "BID", sector: "bank" },
    { code: "CTG", sector: "bank" }, { code: "TCB", sector: "bank" },
    { code: "VPB", sector: "bank" }, { code: "MBB", sector: "bank" },
    { code: "ACB", sector: "bank" }, { code: "HDB", sector: "bank" },
    { code: "STB", sector: "bank" }, { code: "SHB", sector: "bank" },
    { code: "TPB", sector: "bank" }, { code: "EIB", sector: "bank" },
    { code: "LPB", sector: "bank" }, { code: "VIB", sector: "bank" },
    { code: "VHM", sector: "realestate" }, { code: "VIC", sector: "realestate" },
    { code: "VRE", sector: "realestate" }, { code: "NVL", sector: "realestate" },
    { code: "PDR", sector: "realestate" }, { code: "KDH", sector: "realestate" },
    { code: "DXG", sector: "realestate" }, { code: "KBC", sector: "realestate" },
    { code: "DIG", sector: "realestate" }, { code: "NLG", sector: "realestate" },
    { code: "MWG", sector: "retail" }, { code: "PNJ", sector: "retail" },
    { code: "DGW", sector: "retail" }, { code: "FRT", sector: "retail" },
    { code: "MSN", sector: "consumer" }, { code: "VNM", sector: "consumer" },
    { code: "SAB", sector: "consumer" },
    { code: "HPG", sector: "industrial" }, { code: "HSG", sector: "industrial" },
    { code: "NKG", sector: "industrial" }, { code: "GVR", sector: "industrial" },
    { code: "DGC", sector: "industrial" }, { code: "DCM", sector: "industrial" },
    { code: "DPM", sector: "industrial" }, { code: "BCM", sector: "industrial" },
    { code: "PC1", sector: "industrial" },
    { code: "GAS", sector: "energy" }, { code: "BSR", sector: "energy" },
    { code: "PLX", sector: "energy" },
    { code: "POW", sector: "utility" }, { code: "REE", sector: "utility" },
    { code: "NT2", sector: "utility" },
    { code: "FPT", sector: "tech" }, { code: "CMG", sector: "tech" },
    { code: "SSI", sector: "broker" }, { code: "VCI", sector: "broker" },
    { code: "VND", sector: "broker" }, { code: "HCM", sector: "broker" },
    { code: "DHG", sector: "pharma" }, { code: "IMP", sector: "pharma" },
    { code: "DBD", sector: "pharma" },
  ];

  const FACTOR_NAMES = [
    "ma200Quality", "lowDrawdown", "momentum6m",
    "trendConsistency", "liquidity", "foreignFlow60d",
  ];

  const CACHE_KEY = "dca_top_picks_v1";
  const CACHE_TTL_MS = 24 * 3600 * 1000; // 24h

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
  }

  return {
    UNIVERSE,
    FACTOR_NAMES,
    loadTopPicks,
    clearCache,
  };
})();
