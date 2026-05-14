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

  // ── Large+Mid universe (199 mã, median turnover ≥ 3 tỷ/ngày trên 2024 data) ──
  // Match backtest cross-val universe (run_climax_crossvalidate.py).
  // Pre-filter này tránh scan 656 mã full HOSE+HNX (~10 phút) khi chỉ cần 199 mã liquid.
  // Last reviewed: 2026-05-13. Review quarterly nếu VN30 rebalance hoặc mã mới lên top turnover.
  const LARGE_MID_UNIVERSE = [
    "HPG", "FPT", "SSI", "MWG", "STB", "VHM", "SHB", "VIX", "MSN", "VPB",
    "MBB", "TCB", "VND", "DIG", "VNM", "SHS", "CTG", "ACB", "DGC", "GEX",
    "HCM", "DXG", "VRE", "VCI", "GEL", "PDR", "HDB", "NVL", "EIB", "DBC",
    "TPB", "CEO", "KBC", "CII", "PVS", "VCB", "VCG", "VIC", "TCH", "PVD",
    "HAG", "DCM", "BID", "NKG", "GVR", "VIB", "KDH", "HAH", "GMD", "HSG",
    "TCX", "VCK", "VJC", "VPI", "POW", "VSC", "NLG", "EVF", "BAF", "BSR",
    "LPB", "HDG", "MBS", "FTS", "HHV", "MSB", "DGW", "CTD", "IDC", "FRT",
    "DPM", "HDC", "GAS", "PLX", "VTP", "VHC", "PVT", "TCM", "PNJ", "SZC",
    "CTR", "ORS", "VGC", "REE", "VPL", "HVN", "SAB", "SSB", "CTS", "CSV",
    "VPX", "BCM", "KHG", "PAN", "HUT", "TNG", "KSB", "DPG", "ANV", "KDC",
    "BSI", "BCG", "CMG", "BVH", "OCB", "VDS", "IJC", "VOS", "HHS", "PET",
    "NTL", "SIP", "LCG", "DPR", "SBT", "VTZ", "VGS", "BMP", "YEG", "GEE",
    "PHR", "AAA", "BVS", "BFC", "VFS", "NAB", "AGR", "TIG", "SCR", "DXS",
    "SCS", "FCN", "ELC", "KOS", "LAS", "MCH", "NTP", "HQC", "PVC", "DTD",
    "CTI", "DCL", "DRC", "MST", "NHA", "GEG", "QCG", "HAX", "EVG", "DSE",
    "GIL", "AGG", "DHC", "TLG", "BWE", "HPX", "PLC", "NAF", "IDI", "VCS",
    "PTB", "MSH", "ASM", "CTF", "SMC", "CSM", "PVB", "SHI", "TTA", "LDG",
    "TNH", "IDJ", "HTN", "LHG", "PAC", "VAB", "VPG", "PVP", "MIG", "VTO",
    "TDC", "ITC", "TRC", "DBD", "HPA", "BMI", "KSV", "TDP", "SGR", "CDC",
    "APH", "APG", "FIT", "PPC", "NAG", "NRC", "APS", "DLG", "AAV",
  ];

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

  // Curated 58 mã (CORE_VN30 + EXTENDED) — vẫn dùng làm fallback nếu fetchFullUniverse fail
  // + làm reference cho foreign flow fetch (chỉ fetch NN cho mã curated để speed up).
  const CURATED_UNIVERSE_SET = new Set(UNIVERSE.map((u) => u.code));

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

  // ── Vol Climax Bounce detector (separate strategy from Strong Leaders) ──
  // Pattern: 3 phiên giảm > 7% + volume hôm nay > 2× TB20 + nến xanh + RSI < 35
  // Hold 3 phiên (T+3.5). Cross-validated 8.5 năm trên 199 mã Large+Mid:
  //   - 316 trades, win 58.9%, avg +1.07% NET, sharpe 0.92
  //   - Robust qua COVID/BULL/BEAR/sideways (2022 BEAR: avg +4.42%, sharpe 3.08)
  // Logic: panic-selling capitulation + reversal candle + oversold → bounce
  // Source: backtest/run_climax_crossvalidate.py
  //
  // ⚠️ TURNOVER FILTER: backtest test trên universe ≥ 3 tỷ/ngày (Large+Mid).
  // Áp dụng filter này để match backtest universe, tránh small/penny không cover.
  const CLIMAX_TURNOVER_MIN = 3e9; // 3 tỷ VND/ngày (median 20 phiên)

  // 2-tier system (backtest 8.5y cross-validated):
  // - Tier A "Edge cao": drop<-7% + vol>2× + RSI<35 → 38/năm, win 58.9%, sharpe 0.92
  // - Tier B "Edge vừa": drop<-5% + vol>2× + RSI<50 → 57/năm, win 57.7%, sharpe 1.01
  // Tier A là subset của Tier B. Mã match A sẽ ưu tiên gán tier "A".
  function detectVolClimaxBounce(ohlcv) {
    const closes = ohlcv.closes;
    const opens = ohlcv.opens;
    const volumes = ohlcv.volumes;
    const n = closes.length;
    if (n < 30) return null;

    // Turnover filter: median 20 phiên >= 3 tỷ/ngày (Large+Mid universe)
    const turnovers = [];
    for (let i = n - 21; i < n - 1; i++) {
      turnovers.push(closes[i] * volumes[i] * 1000);
    }
    turnovers.sort((a, b) => a - b);
    const medianTurnover = turnovers[Math.floor(turnovers.length / 2)];
    if (medianTurnover < CLIMAX_TURNOVER_MIN) {
      return { matched: false, tier: null, reason: "illiquid", medianTurnover };
    }

    const cur = closes[n - 1];
    const curOpen = opens[n - 1];
    const curVol = volumes[n - 1];
    const prev3 = closes[n - 4];

    const ret3d = (cur - prev3) / prev3 * 100;
    const volSlice = volumes.slice(n - 21, n - 1);
    const volAvg20 = volSlice.reduce((a, b) => a + b, 0) / volSlice.length;
    const volRatio = volAvg20 > 0 ? curVol / volAvg20 : 0;
    const dayGreen = cur > curOpen;
    const rsi = calcRsi(closes, 14);

    if (rsi == null) return null;

    // Common requirements: day green + vol > 2× + sufficient drop
    const baseConditions = dayGreen && volRatio > 2.0;
    const matchedA = baseConditions && ret3d < -7 && rsi < 35;
    const matchedB = baseConditions && ret3d < -5 && rsi < 50;

    const tier = matchedA ? "A" : matchedB ? "B" : null;
    const matched = tier !== null;

    if (!matched) {
      return { matched: false, tier: null, ret3d, volRatio, rsi, medianTurnover };
    }

    const tierLabel = tier === "A" ? "Edge cao" : "Edge vừa";
    return {
      matched, tier, tierLabel,
      ret3d, volRatio, rsi, medianTurnover,
      reasons: [
        `${tier === "A" ? "Tier A " : "Tier B "} · ${tierLabel}`,
        `3 phiên giảm ${ret3d.toFixed(1)}% — capitulation`,
        `Volume ${volRatio.toFixed(1)}× TB20 — lực mua xác nhận`,
        `Nến xanh (close ${cur.toFixed(2)} > open ${curOpen.toFixed(2)})`,
        `RSI ${rsi.toFixed(0)} (${rsi < 35 ? "oversold" : "neutral"})`,
        `Thanh khoản ${(medianTurnover / 1e9).toFixed(1)} tỷ/ngày`,
      ],
    };
  }

  // ── T+ Score (Strong Leaders — momentum/RS/breakout/accumulation) ──
  // VN narrow-leadership regime: chỉ 1 vài mã mạnh tăng, mean-reversion fail.
  // Focus: relative strength vs market, breakout patterns, volume accumulation,
  // MA alignment. Profile multipliers (Phase C) áp dụng nếu được truyền vào.
  function computeTPlusFactors(ohlcv, foreignDailyData, ctx = {}) {
    const closes = ohlcv.closes;
    const highs = ohlcv.highs;
    const lows = ohlcv.lows;
    const volumes = ohlcv.volumes;
    const n = closes.length;
    if (n < 60) return null;

    const vnindexCloses = ctx.vnindexCloses || null;
    const profile = ctx.stockProfile || null;
    const mult = profile?.multipliers || {};
    const wVol = mult.volMultiplier ?? 1;
    const wBreakout = mult.breakoutReliability ?? 1;
    const wTrend = mult.trendReliability ?? 1;
    const wRecovery = mult.recoveryReliability ?? 1;

    const currentClose = closes[n - 1];
    const reasons = [];
    let score = 0;

    // ── A. Relative Strength vs VN-Index ──
    // V7 backtest (199 mã Large+Mid, 2024+): RS signal KEEP — drop nó hurts Sharpe
    // -0.020. Full weight restored sau khi full-universe + Large+Mid test confirm
    // formula gốc work tốt trên universe thực tế (vs 58 mã curated overfit).
    let rs5 = null, rs20 = null;
    if (vnindexCloses && vnindexCloses.length >= 25) {
      const stock5d = (currentClose / closes[n - 6] - 1) * 100;
      const stock20d = (currentClose / closes[n - 21] - 1) * 100;
      const vniLast = vnindexCloses[vnindexCloses.length - 1];
      const vni5d = (vniLast / vnindexCloses[vnindexCloses.length - 6] - 1) * 100;
      const vni20d = (vniLast / vnindexCloses[vnindexCloses.length - 21] - 1) * 100;
      rs5 = stock5d - vni5d;
      rs20 = stock20d - vni20d;

      if (rs5 > 5 && rs20 > 8) {
        score += 3;
        reasons.push(`Strong leader · RS 5d +${rs5.toFixed(1)}% / 20d +${rs20.toFixed(1)}% vs VNI`);
      } else if (rs5 > 2 && rs20 > 3) {
        score += 1.5;
        reasons.push(`Outperform VNI · RS 5d +${rs5.toFixed(1)}%`);
      } else if (rs5 < -3 && rs20 < -5) {
        score -= 2;
        reasons.push(`Laggard · RS 5d ${rs5.toFixed(1)}% / 20d ${rs20.toFixed(1)}% vs VNI`);
      }
    }

    // ── B. Breakout signals (new highs) — INFORMATIONAL ONLY (scoring disabled) ──
    // V7 backtest (199 mã Large+Mid + 655 mã full universe): drop Breakout group
    // → Sharpe +0.030 / +0.022 consistently. Likely vì fake breakouts hurt nhiều
    // hơn real breakouts khi mở rộng pool. Giữ detection cho reasons (user transparency)
    // nhưng KHÔNG cộng điểm.
    const w20H = Math.max(...closes.slice(n - 21, n - 1));
    const recentBreakout = closes.slice(n - 5).some((c) => c > w20H * 1.005);
    if (recentBreakout) {
      reasons.push(`Break w20-high gần đây (info — không tính điểm)`);
    }
    if (n >= 252) {
      const w52H = Math.max(...closes.slice(n - 252, n - 1));
      if (currentClose > w52H * 0.99) {
        reasons.push(`Gần đỉnh 52w (info — không tính điểm)`);
      }
    }
    // Ceiling streak (tăng trần liên tục) — informational only
    let ceilingStreak = 0;
    for (let i = n - 1; i >= Math.max(0, n - 5); i--) {
      const pct = i >= 1 ? (closes[i] - closes[i - 1]) / closes[i - 1] * 100 : 0;
      if (pct >= 6.5) ceilingStreak++;
      else break;
    }
    if (ceilingStreak >= 2) {
      reasons.push(`Tăng trần ${ceilingStreak} phiên liên tiếp (info)`);
    } else if (ceilingStreak === 1) {
      reasons.push(`Tăng trần phiên hôm nay (info)`);
    }

    // ── C. Volume accumulation (Wyckoff-style) ──
    // Up-day vol vs Down-day vol trong 20 phiên
    let upVol = 0, downVol = 0, upDays = 0, downDays = 0;
    for (let i = n - 20; i < n; i++) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) { upVol += volumes[i]; upDays++; }
      else if (change < 0) { downVol += volumes[i]; downDays++; }
    }
    const avgUpVol = upDays > 0 ? upVol / upDays : 0;
    const avgDownVol = downDays > 0 ? downVol / downDays : 0;
    const updownRatio = avgDownVol > 0 ? avgUpVol / avgDownVol : 0;
    if (updownRatio > 1.5) {
      score += 2;
      reasons.push(`Vol accumulation ${updownRatio.toFixed(1)}× (up-day vol > down-day vol)`);
    } else if (updownRatio > 1.2) {
      score += 1;
      reasons.push(`Vol nghiêng mua ${updownRatio.toFixed(1)}×`);
    } else if (updownRatio < 0.7) {
      score -= 1;
      reasons.push(`Vol distribution ${updownRatio.toFixed(1)}× (down-day vol cao)`);
    }

    // Today vol spike confirmation
    let avgVol = 0;
    if (n >= 21) {
      for (let i = n - 21; i < n - 1; i++) avgVol += volumes[i];
      avgVol /= 20;
    }
    const volRatio = avgVol > 0 ? volumes[n - 1] / avgVol : 0;
    const dayChangePct = n >= 2 ? ((currentClose - closes[n - 2]) / closes[n - 2]) * 100 : 0;
    if (volRatio > 2 && dayChangePct >= 0) {
      score += 1.5 * wVol;
      reasons.push(`Vol ${volRatio.toFixed(1)}× TB + giá ${dayChangePct >= 0 ? "+" : ""}${dayChangePct.toFixed(1)}% — lực cầu xác nhận`);
    } else if (volRatio > 1.5 && dayChangePct < -2) {
      score -= 1.5;
      reasons.push(`Vol cao + giá giảm ${dayChangePct.toFixed(1)}% — phân phối`);
    }

    // ── D. MA alignment (perfect uptrend stack) ──
    const ma5 = closes.slice(n - 5).reduce((a, b) => a + b, 0) / 5;
    const ma10 = n >= 10 ? closes.slice(n - 10).reduce((a, b) => a + b, 0) / 10 : null;
    const ma20 = n >= 20 ? closes.slice(n - 20).reduce((a, b) => a + b, 0) / 20 : null;
    let ma50 = null;
    if (n >= 50) ma50 = closes.slice(n - 50).reduce((a, b) => a + b, 0) / 50;

    const aligned = ma5 != null && ma10 != null && ma20 != null && ma50 != null
      && ma5 > ma10 && ma10 > ma20 && ma20 > ma50 && currentClose > ma5;
    if (aligned) {
      score += 2 * wTrend;
      reasons.push(`MA alignment perfect (5>10>20>50) — uptrend mạnh`);
    } else if (ma20 != null && ma50 != null && currentClose > ma20 && ma20 > ma50) {
      score += 1 * wTrend;
      reasons.push(`Trend up (giá > MA20 > MA50)`);
    }

    // MA20 rising slope
    if (n >= 25 && ma20 != null) {
      const ma20_5ago = closes.slice(n - 25, n - 5).reduce((a, b) => a + b, 0) / 20;
      if (ma20 > ma20_5ago * 1.005) {
        score += 0.5;
        reasons.push(`MA20 đang dốc lên`);
      }
    }

    // ── E. ADX + DI direction (trend strength) ──
    const adxData = calcAdx(highs, lows, closes, 14);
    if (adxData && adxData.adx > 25 && adxData.plusDI > adxData.minusDI) {
      score += 1.5 * wTrend;
      reasons.push(`ADX ${adxData.adx.toFixed(0)} +DI dominant — trend mạnh`);
    } else if (adxData && adxData.adx > 25 && adxData.minusDI > adxData.plusDI) {
      score -= 1.5;
      reasons.push(`ADX ${adxData.adx.toFixed(0)} -DI dominant — downtrend mạnh`);
    }

    // ── F. Sell-off bounce (mean-reversion residual — chỉ keep nếu profile recovery reliable) ──
    // Chỉ score nếu có context profile cho thấy mã có lịch sử recovery
    const rsiToday = calcRsi(closes, 14);
    if (rsiToday !== null && rsiToday < 30 && wRecovery >= 1.0) {
      score += 1.5 * wRecovery;
      reasons.push(`RSI<30 + profile có recovery history${wRecovery !== 1 ? ` ×${wRecovery.toFixed(1)}` : ""}`);
    }

    // ── G. Foreign flow buying ──
    if (foreignDailyData && foreignDailyData.length >= 5) {
      const recent = foreignDailyData.slice(-5);
      const positiveDays = recent.filter((d) => (d.netVal || 0) > 0).length;
      const sumNet = recent.reduce((s, r) => s + (r.netVal || 0), 0);
      if (positiveDays >= 4 && sumNet > 0) {
        score += 1.5;
        reasons.push(`NN mua ròng ${positiveDays}/5 phiên`);
      } else if (positiveDays <= 1 && sumNet < 0) {
        score -= 1;
        reasons.push(`NN bán ròng mạnh`);
      }
    }

    // ── Hard filters ──
    let avgTurnover = 0;
    const liqLookback = Math.min(20, n);
    for (let i = n - liqLookback; i < n; i++) {
      avgTurnover += closes[i] * volumes[i] * 1000;
    }
    avgTurnover /= liqLookback;

    const filterIlliquid = avgTurnover < 5e9; // < 5 tỷ/day
    let filterOverExtended = false;
    if (n >= 21) {
      const ret20d = (currentClose / closes[n - 21] - 1) * 100;
      filterOverExtended = ret20d > 50; // tăng > 50% trong 20 phiên → over-extended
    }

    if (filterIlliquid || filterOverExtended) {
      score = -999;
    }

    // Day change
    const dayChange = n >= 2 ? (currentClose - closes[n - 2]) / closes[n - 2] : 0;
    const sessionTurnover = currentClose * volumes[n - 1] * 1000;
    const lowSessionLiq = sessionTurnover < 2e9;

    if (lowSessionLiq && !filterIlliquid && score > -900) {
      score -= 0.5;
      reasons.push("TKL phiên này <2 tỷ — kẹt hàng");
    }

    // Risk flags
    const flags = {
      bearTrap: !!(adxData && adxData.adx > 30 && adxData.minusDI > adxData.plusDI),
      lowVol: volRatio > 0 && volRatio < 0.8,
      volCritical: volRatio > 0 && volRatio < 0.4,
      deepDowntrend: !!(ma50 && currentClose < ma50 * 0.92),
      lowSessionLiq,
      sellPressure: volRatio > 1.5 && dayChangePct < -2,
      distribution: updownRatio > 0 && updownRatio < 0.7,
      overExtended: false, // already filtered
      strongLeader: false, // set below
      breakoutFresh: false,
    };
    // Set positive flags (reuse rs20 đã compute trên)
    if (rs20 != null && rs20 > 8) flags.strongLeader = true;
    if (recentBreakout) flags.breakoutFresh = true;

    return {
      score,
      reasons,
      flags,
      currentPrice: currentClose,
      dayChange,
      rsiToday,
      avgTurnover,
      filterIlliquid,
      filterCrash: filterOverExtended, // rename concept
      updownRatio,
      // Strong leader stats
      profile: profile || null,
    };
  }

  // ── Legacy mean-reversion (giữ làm fallback, không export) ──────
  function computeTPlusFactorsLegacy(ohlcv, foreignDailyData) {
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

    // 5. Volume catalyst — phân biệt buy vs sell pressure
    // Vol cao + giá tăng/ổn = lực cầu/hấp thụ → catalyst tốt cho mean-rev
    // Vol cao + giá giảm = lực bán/phân phối → KHÔNG phải catalyst (bug fix)
    let avgVol = 0;
    if (n >= 21) {
      for (let i = n - 21; i < n - 1; i++) avgVol += volumes[i];
      avgVol /= 20;
    }
    const volRatio = avgVol > 0 ? volumes[n - 1] / avgVol : 0;
    const dayChangePct = n >= 2 ? ((currentClose - closes[n - 2]) / closes[n - 2]) * 100 : 0;
    if (volRatio > 1.5) {
      if (dayChangePct >= -1) {
        // Buy pressure / hấp thụ
        score += 1;
        reasons.push(`Vol ${volRatio.toFixed(1)}x TB — lực cầu/hấp thụ`);
      } else {
        // Sell pressure (vol cao + giá giảm = phân phối)
        // KHÔNG cộng score — đây không phải catalyst cho mean-rev
        reasons.push(`Vol ${volRatio.toFixed(1)}x TB + giá ${dayChangePct.toFixed(1)}% — lực bán`);
      }
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

    // 11. Multi-timeframe weekly RSI filter
    // Build weekly bars by sampling every 5 daily bars (proxy weekly).
    // Weekly RSI < 50 = downtrend mạnh hơn daily — risk knife catching.
    // Phòng case: daily oversold nhưng weekly đang rơi liên tục.
    let weeklyRsi = null;
    let weeklyDowntrend = false;
    if (n >= 75) {
      const weeklyCloses = [];
      // Sample every 5 daily bars going backwards from latest
      for (let i = n - 1; i >= 0; i -= 5) weeklyCloses.unshift(closes[i]);
      if (weeklyCloses.length >= 15) {
        weeklyRsi = calcRsi(weeklyCloses, 14);
        if (weeklyRsi !== null && weeklyRsi < 50) {
          weeklyDowntrend = true;
          score -= 1;
          reasons.push(`Weekly RSI ${weeklyRsi.toFixed(0)}<50 — downtrend trung hạn`);
        } else if (weeklyRsi !== null && weeklyRsi > 60) {
          score += 0.5;
          reasons.push(`Weekly RSI ${weeklyRsi.toFixed(0)}>60 — trend trung hạn OK`);
        }
      }
    }

    // 12. Bullish divergence: giá lower-low, RSI higher-low → reversal signal
    // Tìm 2 swing low gần nhất trong 30 phiên qua, so sánh RSI tại đó.
    let bullishDivergence = false;
    if (n >= 40) {
      // RSI series for divergence comparison
      const rsiSeries = [];
      for (let i = 14; i < n; i++) {
        rsiSeries[i] = calcRsi(closes.slice(0, i + 1), 14);
      }
      // Find swing lows in last 30 bars (pivot: low lower than 3 left + 3 right neighbors)
      const swingLows = [];
      const lookback = Math.min(30, n - 4);
      for (let i = n - lookback; i < n - 3; i++) {
        if (i < 17) continue;
        const isPivot = closes[i] < closes[i - 1] && closes[i] < closes[i - 2] && closes[i] < closes[i - 3]
                     && closes[i] < closes[i + 1] && closes[i] < closes[i + 2] && closes[i] < closes[i + 3];
        if (isPivot && rsiSeries[i] != null) {
          swingLows.push({ idx: i, close: closes[i], rsi: rsiSeries[i] });
        }
      }
      // Check last 2 swing lows for bullish divergence
      if (swingLows.length >= 2) {
        const last = swingLows[swingLows.length - 1];
        const prev = swingLows[swingLows.length - 2];
        if (last.close < prev.close && last.rsi > prev.rsi + 3) {
          bullishDivergence = true;
          score += 2;
          reasons.push(`Bullish divergence — giá đáy thấp hơn (${last.close.toFixed(1)}<${prev.close.toFixed(1)}) nhưng RSI cao hơn (${last.rsi.toFixed(0)}>${prev.rsi.toFixed(0)})`);
        }
      }
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
      volCritical: volRatio > 0 && volRatio < 0.4,
      deepDowntrend: !!(ma50 && currentClose < ma50 * 0.88),
      lowSessionLiq,
      // Sell pressure: vol cao + giá giảm mạnh = phân phối/xả hàng (hard flag)
      sellPressure: volRatio > 1.5 && dayChangePct < -2,
      // Multi-timeframe + divergence flags (mới)
      weeklyDowntrend,
      bullishDivergence,
    };

    return {
      score,
      reasons,
      flags,
      currentPrice: currentClose,
      dayChange,
      rsiToday,
      weeklyRsi,
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

  function clearCache() {
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

  // ── Market snapshot: scan universe để có per-mã metrics ──
  // 2 modes: "dca" (58 mã, fast ~30s) hoặc "full" (~700 mã, slow ~5min).
  // Cache riêng key per mode. Full scan TTL dài hơn (4h vs 1h).
  const SNAPSHOT_CACHE_KEYS = {
    dca: "market_snapshot_dca_v1",
    full: "market_snapshot_full_v1",
  };
  const SNAPSHOT_TTL_DCA_MS = 1 * 3600 * 1000;       // 1h
  const SNAPSHOT_TTL_FULL_MS = 4 * 3600 * 1000;      // 4h (rare scan, persist longer)

  async function loadMarketSnapshot(opts = {}) {
    const { useCache = true, onProgress, universe = "dca" } = opts;
    const cacheKey = SNAPSHOT_CACHE_KEYS[universe] || SNAPSHOT_CACHE_KEYS.dca;
    const ttlMs = universe === "full" ? SNAPSHOT_TTL_FULL_MS : SNAPSHOT_TTL_DCA_MS;

    if (useCache) {
      try {
        const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
        if (cached && Date.now() - cached.timestamp < ttlMs) {
          return { ...cached.data, fromCache: true };
        }
      } catch {}
    }

    const startTime = Date.now();
    let universeList;
    if (universe === "full") {
      universeList = await fetchFullUniverse();
      if (!universeList || universeList.length < 100) {
        universeList = UNIVERSE; // fallback nếu fetch fail
      }
    } else {
      universeList = UNIVERSE; // 58 mã DCA
    }
    const stocks = universeList.map((u) => ({ symbol: u.code, sector: u.sector || "khác" }));

    // Fetch VN-Index for relative strength
    let vniRet1w = 0, vniRet1m = 0;
    try {
      const vniData = await ANALYSIS.fetchHistory("VNINDEX", "D", 100);
      const vniCloses = vniData.closes;
      const vn = vniCloses.length;
      if (vn >= 6) vniRet1w = (vniCloses[vn - 1] / vniCloses[vn - 6] - 1) * 100;
      if (vn >= 22) vniRet1m = (vniCloses[vn - 1] / vniCloses[vn - 22] - 1) * 100;
    } catch {}
    let done = 0;
    const batchSize = 20;

    for (let i = 0; i < stocks.length; i += batchSize) {
      const batch = stocks.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (stock) => {
          try {
            const data = await ANALYSIS.fetchHistory(stock.symbol, "D", 100);
            const closes = data.closes;
            const volumes = data.volumes;
            const n = closes.length;
            if (n < 30) {
              stock.error = "insufficient data";
              return;
            }
            const cur = closes[n - 1];
            stock.close = cur;
            stock.dayChange = n >= 2 ? ((cur - closes[n - 2]) / closes[n - 2]) * 100 : 0;
            stock.ret1w = n >= 6 ? ((cur - closes[n - 6]) / closes[n - 6]) * 100 : null;
            stock.ret1m = n >= 22 ? ((cur - closes[n - 22]) / closes[n - 22]) * 100 : null;
            // 52W high/low check (need 252 days; use min(252, n))
            const lookback = Math.min(252, n);
            const recent = closes.slice(n - lookback);
            const high52w = Math.max(...recent);
            const low52w = Math.min(...recent);
            stock.atHigh52w = cur >= high52w * 0.98;
            stock.atLow52w = cur <= low52w * 1.02;
            // Volume ratio
            if (n >= 21) {
              let avgVol = 0;
              for (let k = n - 21; k < n - 1; k++) avgVol += volumes[k];
              avgVol /= 20;
              stock.volRatio = avgVol > 0 ? volumes[n - 1] / avgVol : 0;
            }

            // ── Pattern detection (Phase 3 — momentum scanner) ──
            // 1. Cross MA20 up: close > MA20 today + close ≤ MA20 yesterday
            if (n >= 21) {
              const ma20Today = closes.slice(n - 20).reduce((a, b) => a + b, 0) / 20;
              const ma20Yest = closes.slice(n - 21, n - 1).reduce((a, b) => a + b, 0) / 20;
              stock.crossMa20Up = (cur > ma20Today) && (closes[n - 2] <= ma20Yest);
              stock.aboveMa20 = cur > ma20Today;
            }

            // 2. Breakout 52W high: cur tại high52w + dayChange tích cực
            stock.breakout52w = stock.atHigh52w && (stock.dayChange ?? 0) > 0;

            // 3. Reversal candidate: RSI<30 (proxy: tính nhanh) + dayChange > 1%
            // RSI compute simplified for snapshot speed
            if (n >= 15) {
              let gains = 0, losses = 0;
              for (let k = n - 14; k < n; k++) {
                const diff = closes[k] - closes[k - 1];
                if (diff > 0) gains += diff;
                else losses -= diff;
              }
              const avgG = gains / 14, avgL = losses / 14;
              if (avgL > 0) {
                const rs = avgG / avgL;
                stock.rsi14 = 100 - 100 / (1 + rs);
              } else {
                stock.rsi14 = 100;
              }
              stock.reversalCandidate = stock.rsi14 < 30 && (stock.dayChange ?? 0) > 1
                && (stock.volRatio || 0) > 1;
            }

            // Foreign net buy 5 phiên gần (skip cho full scan để giảm 2× API call)
            if (universe !== "full") {
              try {
                const foreign = await fetchForeignDaily(stock.symbol, 5).catch(() => null);
                if (foreign && foreign.length > 0) {
                  stock.netForeign5d = foreign.reduce((s, d) => s + (d.netVal || 0), 0);
                }
              } catch {}
            }
          } catch (e) {
            stock.error = e.message;
          }
          done++;
          if (onProgress) onProgress(done, stocks.length);
        })
      );
    }

    // Aggregate per sector
    const sectorMap = {};
    for (const s of stocks) {
      if (s.error || s.ret1w == null) continue;
      const sec = s.sector || "khác";
      if (!sectorMap[sec]) sectorMap[sec] = { sector: sec, count: 0, sum1w: 0, sum1m: 0, sumDay: 0 };
      sectorMap[sec].count++;
      sectorMap[sec].sum1w += s.ret1w;
      if (s.ret1m != null) sectorMap[sec].sum1m += s.ret1m;
      sectorMap[sec].sumDay += s.dayChange || 0;
    }
    const sectorStats = Object.values(sectorMap)
      .map((s) => ({
        ...s,
        avg1w: s.sum1w / s.count,
        avg1m: s.count > 0 ? s.sum1m / s.count : 0,
        avgDay: s.sumDay / s.count,
      }))
      .sort((a, b) => b.avg1w - a.avg1w);

    // Leaders/laggards
    const valid = stocks.filter((s) => !s.error && s.ret1w != null);
    const leaders = [...valid].sort((a, b) => b.ret1w - a.ret1w).slice(0, 5);
    const laggards = [...valid].sort((a, b) => a.ret1w - b.ret1w).slice(0, 3);

    // Foreign flow leaders (top 3 NN buy net 5 phiên)
    const ffLeaders = valid
      .filter((s) => s.netForeign5d != null && s.netForeign5d > 0)
      .sort((a, b) => b.netForeign5d - a.netForeign5d)
      .slice(0, 3);

    // Breadth: % mã giảm vs tăng today
    const upToday = valid.filter((s) => (s.dayChange || 0) > 0).length;
    const downToday = valid.filter((s) => (s.dayChange || 0) < 0).length;
    const upWeek = valid.filter((s) => s.ret1w > 0).length;
    const newHighs = valid.filter((s) => s.atHigh52w).length;
    const newLows = valid.filter((s) => s.atLow52w).length;

    // Distribution stats (today): bao nhiêu mã trong từng range %
    const dist = {
      strong_down: 0,  // <= -5%
      down: 0,         // -5% < x <= -2%
      mild_down: 0,    // -2% < x < 0
      flat: 0,         // x == 0
      mild_up: 0,      // 0 < x < 2
      up: 0,           // 2 <= x < 5
      strong_up: 0,    // >= 5%
    };
    for (const s of valid) {
      const c = s.dayChange ?? 0;
      if (c <= -5) dist.strong_down++;
      else if (c <= -2) dist.down++;
      else if (c < 0) dist.mild_down++;
      else if (c === 0) dist.flat++;
      else if (c < 2) dist.mild_up++;
      else if (c < 5) dist.up++;
      else dist.strong_up++;
    }

    // Volume surge: vol >= 2x avg + dayChange > 0 (catalyst đẹp)
    const volSurges = valid
      .filter((s) => (s.volRatio || 0) >= 2)
      .sort((a, b) => (b.volRatio || 0) - (a.volRatio || 0))
      .slice(0, 8);

    // 52W high/low lists (ưu tiên show top 5 mỗi list)
    const at52wHigh = valid.filter((s) => s.atHigh52w).slice(0, 8);
    const at52wLow = valid.filter((s) => s.atLow52w).slice(0, 8);

    // Trending/momentum lists
    const crossMa20 = valid
      .filter((s) => s.crossMa20Up)
      .sort((a, b) => (b.volRatio || 0) - (a.volRatio || 0))
      .slice(0, 8);
    const breakouts = valid
      .filter((s) => s.breakout52w)
      .sort((a, b) => (b.dayChange || 0) - (a.dayChange || 0))
      .slice(0, 8);
    const reversals = valid
      .filter((s) => s.reversalCandidate)
      .sort((a, b) => (a.rsi14 || 100) - (b.rsi14 || 100))
      .slice(0, 8);

    // Sector rotation quadrant: relative perf vs VN-Index
    // X = sector_1M_rel = sector_avg1m - vniRet1m
    // Y = sector_1W_rel = sector_avg1w - vniRet1w
    // Quadrants: Leading (++), Improving (-+), Lagging (--), Weakening (+-)
    const sectorRotation = { leading: [], improving: [], lagging: [], weakening: [] };
    for (const sec of sectorStats) {
      if (sec.count < 2) continue; // skip sector quá ít data
      const x = sec.avg1m - vniRet1m; // 1M relative
      const y = sec.avg1w - vniRet1w; // 1W relative (momentum)
      const entry = {
        sector: sec.sector,
        count: sec.count,
        rel1m: x,
        rel1w: y,
        avg1m: sec.avg1m,
        avg1w: sec.avg1w,
      };
      if (x >= 0 && y >= 0) sectorRotation.leading.push(entry);
      else if (x < 0 && y >= 0) sectorRotation.improving.push(entry);
      else if (x < 0 && y < 0) sectorRotation.lagging.push(entry);
      else sectorRotation.weakening.push(entry);
    }
    // Sort within each quadrant
    sectorRotation.leading.sort((a, b) => (b.rel1m + b.rel1w) - (a.rel1m + a.rel1w));
    sectorRotation.improving.sort((a, b) => b.rel1w - a.rel1w);
    sectorRotation.lagging.sort((a, b) => (a.rel1m + a.rel1w) - (b.rel1m + b.rel1w)); // worst first
    sectorRotation.weakening.sort((a, b) => a.rel1w - b.rel1w); // momentum drop nhất first

    const result = {
      universe,
      stocks,
      sectorStats,
      leaders,
      laggards,
      ffLeaders,
      breadth: {
        total: valid.length,
        upToday, downToday,
        upWeek,
        newHighs, newLows,
        upTodayPct: valid.length > 0 ? (upToday / valid.length) * 100 : 0,
        upWeekPct: valid.length > 0 ? (upWeek / valid.length) * 100 : 0,
      },
      distribution: dist,
      volSurges,
      at52wHigh,
      at52wLow,
      // Phase 3 — momentum patterns + sector rotation
      trending: { crossMa20, breakouts, reversals },
      sectorRotation,
      vniRet1w,
      vniRet1m,
      timestamp: Date.now(),
      duration: Date.now() - startTime,
      fromCache: false,
    };

    try {
      localStorage.setItem(cacheKey, JSON.stringify({
        timestamp: Date.now(), data: result,
      }));
    } catch {}

    return result;
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
    // T+ quét 199 mã Large+Mid (median turnover ≥ 3 tỷ/ngày) — match backtest
    // universe của Vol Climax Bounce. Hardcoded để pre-filter, tránh scan
    // 656 mã full HOSE+HNX (waste vì sẽ bị turnover filter loại sau).
    const stocks = LARGE_MID_UNIVERSE.map((code) => ({
      symbol: code,
      sector: getSector(code),
    }));

    // Fetch VN-Index history 1 lần cho RS computation + regime detection
    let vnindexCloses = null;
    let vniRegime = "neutral";
    let vniRet20 = null;
    try {
      const vni = await ANALYSIS.fetchHistory("VNINDEX", "D", 250);
      vnindexCloses = vni.closes;
      // VNI regime cho Tier Elite filter: ret20 < -5% → correction = climax có edge cao
      if (vnindexCloses && vnindexCloses.length >= 21) {
        const cur = vnindexCloses[vnindexCloses.length - 1];
        const past20 = vnindexCloses[vnindexCloses.length - 21];
        vniRet20 = ((cur - past20) / past20) * 100;
        if (vniRet20 < -5) vniRegime = "correction";
        else if (vniRet20 > 3) vniRegime = "bull";
        else vniRegime = "neutral";
      }
    } catch {}

    // Foreign flow fetch chỉ cho mã trong curated universe (large/mid caps)
    // để speed up scan 2x. NN signal worth +1.5/13 max.
    const batchSize = 20;
    let done = 0;
    for (let i = 0; i < stocks.length; i += batchSize) {
      const batch = stocks.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (stock) => {
          try {
            const isCurated = CURATED_UNIVERSE_SET.has(stock.symbol);
            const ohlcv = await ANALYSIS.fetchHistory(stock.symbol, "D", 250);
            const foreign = isCurated
              ? await fetchForeignDaily(stock.symbol, 10).catch(() => null)
              : null;
            // Compute stock profile cho adaptive scoring (Phase C)
            const stockProfile = ANALYSIS.computeStockProfile(ohlcv, vnindexCloses);
            stock.tplusFactors = computeTPlusFactors(ohlcv, foreign, {
              vnindexCloses,
              stockProfile,
            });
            // Vol Climax Bounce detection (separate strategy — bắt đáy T+3)
            stock.volClimax = detectVolClimaxBounce(ohlcv);
          } catch (e) {
            stock.error = e.message;
            stock.tplusFactors = null;
          }
          done++;
          if (onProgress) onProgress(done, stocks.length);
        })
      );
    }

    // Cool-down filter: skip mã đã rec trong 5 phiên qua (tránh re-recommend
    // mã đang knife-catching như MCH 07/05, 08/05, 10/05 liên tục).
    // Đọc tracker T+ snapshots từ localStorage.
    const coolDownSymbols = new Set();
    try {
      const tracker = JSON.parse(localStorage.getItem("paper_tracker_v1") || '{"tplus":[]}');
      const cutoff = Date.now() - 5 * 24 * 3600 * 1000;
      for (const snap of (tracker.tplus || [])) {
        if (new Date(snap.date).getTime() < cutoff) continue;
        for (const p of (snap.picks || [])) {
          if (p.symbol) coolDownSymbols.add(p.symbol);
        }
      }
    } catch {}

    // Filter by min score, sort by score, apply cool-down
    const valid = stocks
      .filter((s) => s.tplusFactors && s.tplusFactors.score >= minScore)
      .filter((s) => {
        if (!coolDownSymbols.has(s.symbol)) return true;
        // Đã rec gần đây — chỉ pass nếu score cực mạnh (≥ 6.5) overriding cool-down
        return s.tplusFactors.score >= 6.5;
      })
      .sort((a, b) => b.tplusFactors.score - a.tplusFactors.score);

    const picks = valid.slice(0, topN).map((s) => ({
      symbol: s.symbol,
      sector: s.sector,
      score: s.tplusFactors.score,
      reasons: s.tplusFactors.reasons,
      factors: s.tplusFactors,
    }));

    // Vol Climax Bounce — 2 tiers (A strict + B relax)
    const climaxMatches = stocks
      .filter((s) => s.volClimax?.matched && !coolDownSymbols.has(s.symbol))
      .map((s) => ({
        symbol: s.symbol,
        sector: s.sector,
        tier: s.volClimax.tier,
        tierLabel: s.volClimax.tierLabel,
        ret3d: s.volClimax.ret3d,
        volRatio: s.volClimax.volRatio,
        rsi: s.volClimax.rsi,
        reasons: s.volClimax.reasons,
        bounceStrength: s.volClimax.volRatio * Math.abs(s.volClimax.ret3d),
      }))
      .sort((a, b) => b.bounceStrength - a.bounceStrength);

    const climaxTierA = climaxMatches.filter((m) => m.tier === "A");
    const climaxTierB = climaxMatches.filter((m) => m.tier === "B");

    // Tier Elite: TẤT CẢ climax matches khi VNI in correction (ret20 < -5%).
    // Backtest 8.5y: Win 56% → 61%, Avg +0.8% → +2.0%, Sharpe 0.7 → 1.7.
    // Khi correction mode active, không hiển thị Tier A/B riêng (tất cả đều Elite).
    const isEliteRegime = vniRegime === "correction";
    const climaxElite = isEliteRegime ? climaxMatches.slice(0, 10) : [];

    const result = {
      picks,
      climaxPicks: climaxMatches.slice(0, 10),
      climaxTierA: climaxTierA.slice(0, 8),
      climaxTierB: climaxTierB.slice(0, 8),
      climaxElite,
      isEliteRegime,
      vniRegime,
      vniRet20,
      allCount: stocks.length,
      eligibleCount: valid.length,
      climaxCount: climaxMatches.length,
      climaxCountA: climaxTierA.length,
      climaxCountB: climaxTierB.length,
      climaxCountElite: climaxElite.length,
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

  // ── Paper Trading Tracker (T+ only) ────────────────────────
  // Auto-snapshot top picks mỗi ngày có picks để theo dõi performance vs backtest.
  // Stored in localStorage. Max 60 snapshots (~3 tháng trading days).
  const TRACKER_KEY = "paper_tracker_v1";
  const MAX_SNAPSHOTS_TPLUS = 60;

  function loadTracker() {
    try {
      const raw = localStorage.getItem(TRACKER_KEY);
      if (!raw) return { tplus: [] };
      const parsed = JSON.parse(raw);
      return {
        tplus: Array.isArray(parsed.tplus) ? parsed.tplus : [],
      };
    } catch {
      return { tplus: [] };
    }
  }

  function saveTracker(t) {
    try {
      localStorage.setItem(TRACKER_KEY, JSON.stringify(t));
    } catch {}
  }

  function shouldSnapshot(mode, tracker) {
    // T+ only — 1 lần/ngày (theo local date)
    const arr = tracker.tplus || [];
    if (arr.length === 0) return true;
    const last = new Date(arr[arr.length - 1].date);
    const now = new Date();
    return last.toDateString() !== now.toDateString();
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
    if (!tracker.tplus) tracker.tplus = [];
    tracker.tplus.push(entry);
    if (tracker.tplus.length > MAX_SNAPSHOTS_TPLUS) {
      tracker.tplus = tracker.tplus.slice(-MAX_SNAPSHOTS_TPLUS);
    }
    saveTracker(tracker);
    // DB write-through
    if (_isOnline()) {
      _AUTH().dbInsert("tracker_snapshots", {
        mode: "tplus",
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
      const tracker = { tplus: [] };
      for (const row of data) {
        if (row.mode !== "tplus") continue; // skip legacy DCA rows
        tracker.tplus.push({
          date: row.snapshot_date,
          regime: row.regime,
          picks: row.picks || [],
        });
      }
      // Trim to max
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

  // Fetch lịch sử đầy đủ (OHLC + times) cho mỗi mã — phục vụ tracker tính
  // peak return, max drawdown, TP/SL outcome detection cho từng pick.
  // days mặc định 90 đủ cover snap T+ (max 10 phiên hold) + DCA (rebalance ~30d).
  async function fetchPicksHistory(symbols, days = 90) {
    const result = {};
    const batchSize = 10;
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (sym) => {
          try {
            result[sym] = await ANALYSIS.fetchHistory(sym, "D", days);
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
    loadTopPicksTPlus,
    getMarketRegime,
    loadMarketSnapshot,
    clearCache,
    // Paper tracker
    loadTracker,
    shouldSnapshot,
    takeSnapshot,
    clearTracker,
    fetchCurrentPrices,
    fetchPicksHistory,
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
