// ═══════════════════════════════════════
// Stock Analyzer PWA — App Controller
// ═══════════════════════════════════════

(function () {
  "use strict";

  const ANALYSIS = window.__SSI_ANALYSIS__;

  // ── Pure-logic modules (loaded before app.js in index.html) ──
  const { fp, fmtVol, fmtFlow, peBadge, pbBadge, fmtTime, signedPct, perfPills, escapeHtml, fmtTimeShort, fmtDM, fmtMoney, fmtPriceK, fmtFullDate, getGreeting, row } = window.__SSI_FMT__;
  const { isMarketOpen, vnDateString, isVnHoliday, nextVnHoliday, isMarketOpenNow, getSessionInfo, addTradingDays, tradingDaysBetween } = window.__SSI_MARKET__;
  const { detectOverboughtTopping, detectCandlePattern, detectTrendStatus, detectVolumeAnalysis, detectSupportResistance, detectRsiStatus, buildTechnicalVerdict, aggregateWeekly, aggregateToWeekly, computeSMASeries, detectMacdStatus, detectAdxStatus, detectStochStatus, computeIchimoku, detectIchimokuStatus, generateRoundLevels, detectLevelTouch, detectConfluence, detectBollingerStatus, findSwingPivots, linRegSlope, detectHhHlStructure, detectTrianglePattern, detectDoubleTopBottom, detectVnFlags } = window.__SSI_TA__;
  const { estimateHoldProfile, computeTpTargets, computeBayesianWinProb, getVerdict, getVolatilityLabel, renderRiskChips, renderActionCard, computeMarketOutlook, composeTacticalHint, buildTodayActions } = window.__SSI_VERDICT_UI__;
  const HISTORY_KEY = "stock_analyzer_history";
  const HISTORY_MAX = 10;
  const STOCK_LIST_KEY = "stock_list_v1";
  const STOCK_LIST_EXPIRY_KEY = "stock_list_expiry";
  const STOCK_LIST_TTL = 7 * 24 * 3600 * 1000; // 7 days
  const SUGGEST_MAX = 8;

  let stockList = [];

  // ── Theme token layer ──
  const THEME_KEY = "theme_pref";
  function getThemePref() {
    try { return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark"; }
    catch (e) { return "dark"; }
  }
  function chartCssVar(name, fallback) {
    const v = getComputedStyle(document.body).getPropertyValue(name).trim();
    return v || fallback;
  }
  function getChartTheme() {
    return {
      layout: {
        background: { color: chartCssVar("--bg-deep", "#0a0a14") },
        textColor: chartCssVar("--text-mute", "#888888"),
      },
      grid: {
        vertLines: { color: chartCssVar("--border-dim", "#1f1f2e") },
        horzLines: { color: chartCssVar("--border-dim", "#1f1f2e") },
      },
      up: chartCssVar("--pos", "#4caf50"),
      down: chartCssVar("--neg", "#ff4444"),
      ma20: chartCssVar("--accent", "#00d2ff"),
      ma50: chartCssVar("--warn-soft", "#ffb74d"),
      ma200: chartCssVar("--chart-ma200", "#ef5350"),
      accentSoft: chartCssVar("--accent-soft", "#4dd0e1"),
      border: chartCssVar("--border", "#2a2a3e"),
    };
  }
  function applyChartTheme() {
    const t = getChartTheme();
    [chartInstance, technicalChartInstance, vnindexChartInstance, hdChartInstance]
      .forEach((c) => {
        if (!c) return;
        try { c.applyOptions({ layout: t.layout, grid: t.grid }); } catch (e) { console.warn("applyChartTheme:", e); }
      });
  }
  function applyTheme() {
    const pref = getThemePref();
    document.body.dataset.theme = pref;
    const btn = document.getElementById("theme-btn");
    if (btn) btn.textContent = pref === "light" ? "☀️" : "🌙";
    applyChartTheme();
  }
  function initTheme() {
    const btn = document.getElementById("theme-btn");
    if (btn) btn.addEventListener("click", () => {
      const next = getThemePref() === "light" ? "dark" : "light";
      try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
      applyTheme();
    });
    applyTheme();
  }

  const $ = (id) => document.getElementById(id);

  // ── History ──
  function loadHistory() {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    } catch {
      return [];
    }
  }

  function saveHistory(symbol) {
    let hist = loadHistory();
    hist = hist.filter((s) => s !== symbol);
    hist.unshift(symbol);
    hist = hist.slice(0, HISTORY_MAX);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(hist));
    renderHistory();
  }

  function clearHistory() {
    localStorage.removeItem(HISTORY_KEY);
    renderHistory();
  }

  function renderHistory() {
    const hist = loadHistory();
    const section = $("history-section");
    const chips = $("history-chips");
    if (hist.length === 0) {
      section.style.display = "none";
      return;
    }
    section.style.display = "block";
    chips.innerHTML = hist.map((s) => `<button class="chip" data-symbol="${s}">${s}</button>`).join("");
  }

  // ── Tooltip bottom sheet ──
  const sheet = $("tooltip-sheet");
  const backdrop = $("sheet-backdrop");
  const sheetTitle = $("sheet-title");
  const sheetBody = $("sheet-body");

  function showTooltip(title, body) {
    sheetTitle.textContent = title;
    sheetBody.textContent = body;
    sheet.classList.add("show");
    backdrop.classList.add("show");
  }

  function hideTooltip() {
    sheet.classList.remove("show");
    backdrop.classList.remove("show");
  }

  backdrop.addEventListener("click", hideTooltip);
  sheet.addEventListener("click", (e) => {
    // Only close if tap on handle area (top 40px) or outside body
    if (e.target === sheet || e.target.classList.contains("sheet-handle")) hideTooltip();
  });

  // Swipe down to close
  let touchStartY = 0;
  sheet.addEventListener("touchstart", (e) => {
    touchStartY = e.touches[0].clientY;
  }, { passive: true });
  sheet.addEventListener("touchend", (e) => {
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (dy > 80) hideTooltip();
  }, { passive: true });

  // ── State ──
  let currentData = null;          // daily OHLCV for analysis
  let chartData = null;            // OHLCV at current resolution
  let currentSymbol = null;
  let currentResolution = "D";
  let chartInstance = null;
  let refreshTimer = null;
  let lastUpdated = null;
  // Context for analysis: 'dca' | 'tplus' | null (regular search)
  let analyzeContext = null;
  let analyzeContextPick = null;
  let analyzeContextRank = null;

  const RESOLUTIONS = {
    "W": { label: "Tuần", days: 1820 },
    "D": { label: "Ngày", days: 250 },
    "60": { label: "1h", days: 90 },
    "1": { label: "1p", days: 14 },
  };
  const DEFAULT_RESOLUTION = "D";

  // ── Analysis flow ──
  async function analyzeSymbol(symbol) {
    symbol = symbol.toUpperCase().trim();
    if (!symbol) return;

    if (!ANALYSIS.isValidSymbol(symbol)) {
      showError(`Mã không hợp lệ: "${symbol}"`);
      return;
    }

    $("empty-state").style.display = "none";
    $("analysis-root").innerHTML = `
      <div class="loading">
        <div class="spinner"></div>
        <div>Đang phân tích ${symbol}...</div>
      </div>
    `;

    stopAutoRefresh();
    currentResolution = DEFAULT_RESOLUTION;

    try {
      const [data, fundamentals, foreignFlow, vnindex] = await Promise.all([
        ANALYSIS.fetchHistory(symbol, "D", 250),
        ANALYSIS.fetchFundamentals(symbol).catch(() => null),
        ANALYSIS.fetchForeignFlow(symbol).catch(() => null),
        ANALYSIS.fetchHistory("VNINDEX", "D", 250).catch(() => null),
      ]);
      currentData = data;
      chartData = data; // daily = same as analysis by default
      currentSymbol = symbol;
      // Show reload button now that we have a symbol
      const reloadBtn = $("analyze-reload-btn");
      if (reloadBtn) reloadBtn.style.display = "";
      const r = ANALYSIS.analyze(symbol, data, {
        fundamentals,
        foreignFlow,
        vnindexCloses: vnindex?.closes || null,
      });
      renderAnalysis(r);
      // Defer renderChart 1 frame để DOM layout xong → container.clientWidth ≠ 0
      requestAnimationFrame(() => renderChart());
      updateStatus();
      saveHistory(symbol);
      window.scrollTo({ top: 0, behavior: "smooth" });
      startAutoRefresh();
    } catch (err) {
      showError(`Lỗi tải dữ liệu: ${err.message}`, () => analyzeSymbol(symbol));
    }
  }

  // ── Change chart resolution ──
  async function changeResolution(resolution) {
    if (!currentSymbol || resolution === currentResolution) return;
    currentResolution = resolution;

    // Update active button
    document.querySelectorAll(".range-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.res === resolution);
    });

    const container = $("chart-container");
    if (container) container.innerHTML = `
      <div class="chart-loading">
        <div class="spinner spinner-sm"></div>
        <span>Đang tải ${RESOLUTIONS[resolution].label}...</span>
      </div>
    `;

    try {
      if (resolution === "W") {
        // VND dchart-api không support resolution=W. Fetch daily rồi aggregate.
        const daily = await ANALYSIS.fetchHistory(currentSymbol, "D", RESOLUTIONS["W"].days);
        chartData = aggregateToWeekly(daily);
      } else {
        chartData = await ANALYSIS.fetchHistory(currentSymbol, resolution, RESOLUTIONS[resolution].days);
      }
      renderChart();
      lastUpdated = new Date();
      updateStatus();
    } catch (e) {
      if (container) {
        container.innerHTML = `
          <div class="chart-loading chart-error">
            ⚠️ Lỗi: ${e.message}
            <button class="link-btn chart-retry-btn">Thử lại</button>
          </div>
        `;
        const retry = container.querySelector(".chart-retry-btn");
        if (retry) retry.addEventListener("click", () => changeResolution(resolution));
      }
    }
  }

  // ── Auto-refresh ──
  function startAutoRefresh() {
    stopAutoRefresh();
    refreshTimer = setInterval(doRefresh, 60000);
  }

  function stopAutoRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  async function doRefresh() {
    if (!currentSymbol) return;
    if (document.hidden) return;
    if (!isMarketOpen()) {
      updateStatus();
      return;
    }
    try {
      const fresh = await ANALYSIS.fetchHistory(currentSymbol, currentResolution, RESOLUTIONS[currentResolution].days);
      chartData = fresh;
      renderChart();
      lastUpdated = new Date();
      updateLatestPrice(fresh);
      updateStatus();
    } catch (e) {
      // silent fail, keep previous data
    }
  }

  function updateLatestPrice(data) {
    const closes = data.closes;
    const n = closes.length;
    if (n < 2) return;
    const current = closes[n - 1];
    const prev = closes[n - 2];
    const pct = ((current - prev) / prev) * 100;
    const priceEl = document.querySelector(".an-price");
    const pctEl = document.querySelector(".an-head .pct");
    if (priceEl) priceEl.textContent = fp(current);
    if (pctEl) {
      const sign = pct >= 0 ? "+" : "";
      pctEl.textContent = `${sign}${pct.toFixed(2)}%`;
      pctEl.className = `pct ${pct >= 0 ? "up" : "down"}`;
    }
  }

  function updateStatus() {
    const el = $("chart-status");
    if (!el) return;
    const open = isMarketOpen();
    const timeStr = lastUpdated ? fmtTime(lastUpdated) : "--";
    if (open) {
      el.innerHTML = `<span class="live-dot"></span><span class="live-text">Live</span> <span class="update-time">· ${timeStr}</span>`;
      el.className = "chart-status live";
    } else {
      el.innerHTML = `<span class="closed-dot"></span><span>Đóng cửa</span> <span class="update-time">· ${timeStr}</span>`;
      el.className = "chart-status closed";
    }
  }

  // Stop refresh when tab hidden, resume when visible
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopAutoRefresh();
    } else if (currentSymbol) {
      startAutoRefresh();
      doRefresh(); // immediate catch-up
    }
  });

  // ── Chart rendering ──
  function renderChart() {
    const container = $("chart-container");
    if (!container || !chartData || !window.LightweightCharts) return;

    // Clean up old chart
    container.innerHTML = "";
    if (chartInstance) {
      try { chartInstance.remove(); } catch (_) {}
      chartInstance = null;
    }

    const { times, opens, highs, lows, closes, volumes, resolution } = chartData;
    const len = times.length;

    const candles = [];
    const volBars = [];
    for (let i = 0; i < len; i++) {
      candles.push({
        time: times[i],
        open: opens[i],
        high: highs[i],
        low: lows[i],
        close: closes[i],
      });
      volBars.push({
        time: times[i],
        value: volumes[i],
        color: closes[i] >= opens[i] ? "rgba(76,175,80,0.5)" : "rgba(255,68,68,0.5)",
      });
    }

    // MA20/MA50 overlays
    const ma20Series = computeSMASeries(closes, times, 20);
    const ma50Series = computeSMASeries(closes, times, 50);

    // Intraday resolutions need time-visible
    const isIntraday = resolution === "1" || resolution === "5" || resolution === "15" || resolution === "30" || resolution === "60";

    // Fallback width nếu container chưa measured (clientWidth=0)
    const chartWidth = container.clientWidth || container.parentElement?.clientWidth || window.innerWidth - 32;
    const _ct = getChartTheme();
    chartInstance = window.LightweightCharts.createChart(container, {
      width: chartWidth,
      height: 320,
      layout: { ...(_ct.layout), fontSize: 11 },
      grid: _ct.grid,
      rightPriceScale: {
        borderColor: _ct.border,
      },
      timeScale: {
        borderColor: _ct.border,
        timeVisible: isIntraday,
        secondsVisible: false,
      },
      crosshair: {
        mode: 1,
      },
      handleScroll: true,
      handleScale: true,
    });

    // Candlesticks
    const candleSeries = chartInstance.addCandlestickSeries({
      upColor: _ct.up,
      downColor: _ct.down,
      borderUpColor: _ct.up,
      borderDownColor: _ct.down,
      wickUpColor: _ct.up,
      wickDownColor: _ct.down,
    });
    candleSeries.setData(candles);

    // MA20 line
    const ma20Line = chartInstance.addLineSeries({
      color: _ct.ma20,
      lineWidth: 1,
      title: "MA20",
      priceLineVisible: false,
      lastValueVisible: false,
    });
    ma20Line.setData(ma20Series.filter((p) => p.value !== null));

    // MA50 line
    const ma50Line = chartInstance.addLineSeries({
      color: _ct.ma50,
      lineWidth: 1,
      title: "MA50",
      priceLineVisible: false,
      lastValueVisible: false,
    });
    ma50Line.setData(ma50Series.filter((p) => p.value !== null));

    // Volume histogram on separate scale
    const volSeries = chartInstance.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    volSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });
    volSeries.setData(volBars);

    chartInstance.timeScale().fitContent();

    // Resize observer
    const resize = () => {
      if (chartInstance && container) {
        chartInstance.resize(container.clientWidth, 320);
      }
    };
    window.addEventListener("resize", resize);
  }

  function showError(msg, retryFn) {
    const root = $("analysis-root");
    root.innerHTML = `
      <div class="error">
        <h3>⚠️ ${msg}</h3>
        <p>${navigator.onLine === false ? "Bạn đang offline — kết nối mạng để tiếp tục." : "Kiểm tra lại mã cổ phiếu hoặc kết nối mạng."}</p>
        <button class="btn-primary retry-btn">Thử lại</button>
      </div>
    `;
    const btn = root.querySelector(".retry-btn");
    if (btn) {
      btn.addEventListener("click", () => {
        if (retryFn) retryFn();
        else $("symbol-input").focus();
      });
    }
  }

  // ── Render analysis ──
  // ── Analysis tab state (overview / dca / tplus) ──
  const ANALYSIS_TAB_KEY = "analysis_tab";
  let lastAnalysisResult = null;

  function getAnalysisTabDefault() {
    const persisted = localStorage.getItem(ANALYSIS_TAB_KEY);
    if (["overview", "technical", "verdict"].includes(persisted)) return persisted;
    return "overview";
  }

  function setAnalysisTab(mode) {
    if (!["overview", "technical", "verdict"].includes(mode)) mode = "overview";
    document.querySelectorAll(".analysis-tab").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === mode);
    });
    document.querySelectorAll(".analysis-tab-content").forEach((c) => {
      c.style.display = c.dataset.mode === mode ? "block" : "none";
    });
    localStorage.setItem(ANALYSIS_TAB_KEY, mode);

    if (mode === "technical") {
      initTechnicalTabHandlers();
    }
  }

  function renderAnalysis(r) {
    lastAnalysisResult = r;
    const root = $("analysis-root");

    root.innerHTML = `
      <div class="analysis-tabs" role="tablist">
        <button class="analysis-tab" data-mode="overview" type="button" role="tab">📊 Tổng quan</button>
        <button class="analysis-tab" data-mode="technical" type="button" role="tab">🔍 Kỹ thuật</button>
        <button class="analysis-tab" data-mode="verdict" type="button" role="tab">📋 Trạng thái</button>
      </div>
      <div class="analysis-tab-content" data-mode="overview" id="analysis-tab-overview"></div>
      <div class="analysis-tab-content" data-mode="technical" id="analysis-tab-technical" style="display:none"></div>
      <div class="analysis-tab-content" data-mode="verdict" id="analysis-tab-verdict" style="display:none"></div>
    `;

    // Overview = current default content (always rendered)
    $("analysis-tab-overview").innerHTML = renderOverviewTabContent(r);
    // Technical tab — pattern + vol + S/R + trend analysis
    $("analysis-tab-technical").innerHTML = renderTechnicalTabContent(r);
    // Verdict tab — build ngay (rẻ, thuần tính toán trên r + currentData)
    $("analysis-tab-verdict").innerHTML = renderVerdictTabContent(r);

    // Set default active tab
    setAnalysisTab(getAnalysisTabDefault());

    // Bind tab buttons
    root.querySelectorAll(".analysis-tab").forEach((btn) => {
      btn.addEventListener("click", () => setAnalysisTab(btn.dataset.mode));
    });

    // Bind tooltip taps (label.has-tip + any .has-tip element like profile chips/rows)
    root.querySelectorAll(".has-tip").forEach((el) => {
      el.addEventListener("click", () => {
        showTooltip(el.dataset.tipTitle, el.dataset.tipBody);
      });
    });

    // Bind chart resolution buttons (in overview tab)
    root.querySelectorAll(".range-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        changeResolution(btn.dataset.res);
      });
    });

    // Bind watchlist toggle
    const wlBtn = root.querySelector("#watchlist-toggle");
    if (wlBtn) {
      wlBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const sym = wlBtn.dataset.symbol;
        const added = RANKING.toggleWatchlist(sym);
        wlBtn.classList.toggle("active", added);
        wlBtn.textContent = added ? "★" : "☆";
        wlBtn.title = added ? "Bỏ khỏi watchlist" : "Thêm vào watchlist";
      });
    }

    // Bind alert-setup button → open modal
    const alertBtn = root.querySelector("#alert-setup-btn");
    if (alertBtn) {
      alertBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openAlertModal(alertBtn.dataset.symbol);
      });
    }
  }

  function renderOverboughtBanner(warning, r) {
    if (!warning) return "";
    const cls = warning.severity === "strong" ? "warn-strong" : "warn-mild";
    const icon = warning.severity === "strong" ? "🚨" : "⚠️";
    const titleText = warning.severity === "strong"
      ? "ĐỈNH SÓNG / PHÂN PHỐI — CỰC NGUY HIỂM"
      : "Cảnh báo đỉnh sóng / phân phối";

    return `
      <div class="overbought-banner ${cls}">
        <div class="ob-title">${icon} <b>${titleText}</b></div>
        <div class="ob-reasons">
          ${warning.reasons.map((x) => `<div class="ob-reason">• ${x}</div>`).join("")}
        </div>
        <div class="ob-action">
          <b>👉 KHÔNG khuyến khích mua đỉnh</b>
        </div>
        <div class="ob-tips">
          <div>• Đợi pullback về MA20 (~<b>${fp(warning.pullbackTarget)}</b>) hoặc RSI rớt &lt;60</div>
          <div>• Hoặc đợi nến rút chân + volume xác nhận trở lại</div>
          <div>• Nếu vẫn vào → size nhỏ (5% NAV), SL chặt, không hold qua T+5</div>
        </div>
      </div>
    `;
  }

  // ── Technical Analysis tab — pattern + vol + S/R + trend interpretation ──

  const ICHIMOKU_PREF_KEY = "stock_pwa_show_ichimoku";
  function loadShowIchimoku() {
    try { return localStorage.getItem(ICHIMOKU_PREF_KEY) === "1"; }
    catch { return false; }
  }
  function saveShowIchimoku(v) {
    try { localStorage.setItem(ICHIMOKU_PREF_KEY, v ? "1" : "0"); }
    catch {}
  }

  let technicalChartInstance = null;
  function renderTechnicalChart(containerId, data) {
    const container = document.getElementById(containerId);
    if (!container || !data || !window.LightweightCharts) return;
    container.innerHTML = "";
    if (technicalChartInstance) {
      try { technicalChartInstance.remove(); } catch {}
      technicalChartInstance = null;
    }
    const { times, opens, highs, lows, closes, volumes } = data;
    const candles = [], volBars = [];
    for (let i = 0; i < times.length; i++) {
      candles.push({ time: times[i], open: opens[i], high: highs[i], low: lows[i], close: closes[i] });
      volBars.push({
        time: times[i], value: volumes[i],
        color: closes[i] >= opens[i] ? "rgba(76,175,80,0.5)" : "rgba(255,68,68,0.5)",
      });
    }
    const ma20Series = computeSMASeries(closes, times, 20);
    const ma50Series = computeSMASeries(closes, times, 50);
    const ma200Series = computeSMASeries(closes, times, 200);
    const chartWidth = container.clientWidth || container.parentElement?.clientWidth || window.innerWidth - 32;
    const _ct = getChartTheme();
    technicalChartInstance = window.LightweightCharts.createChart(container, {
      width: chartWidth, height: 320,
      layout: { ...(_ct.layout), fontSize: 11 },
      grid: _ct.grid,
      rightPriceScale: { borderColor: _ct.border },
      timeScale: { borderColor: _ct.border, timeVisible: false },
      crosshair: { mode: 1 },
    });
    const candleSeries = technicalChartInstance.addCandlestickSeries({
      upColor: _ct.up, downColor: _ct.down,
      borderUpColor: _ct.up, borderDownColor: _ct.down,
      wickUpColor: _ct.up, wickDownColor: _ct.down,
    });
    candleSeries.setData(candles);
    if (ma20Series.length) {
      const ma20Line = technicalChartInstance.addLineSeries({ color: _ct.ma20, lineWidth: 1, title: "MA20", priceLineVisible: false, lastValueVisible: false });
      ma20Line.setData(ma20Series.filter((p) => p.value !== null));
    }
    if (ma50Series.length) {
      const ma50Line = technicalChartInstance.addLineSeries({ color: _ct.ma50, lineWidth: 1, title: "MA50", priceLineVisible: false, lastValueVisible: false });
      ma50Line.setData(ma50Series.filter((p) => p.value !== null));
    }
    if (ma200Series.length) {
      const ma200Line = technicalChartInstance.addLineSeries({ color: _ct.ma200, lineWidth: 1, title: "MA200", priceLineVisible: false, lastValueVisible: false });
      ma200Line.setData(ma200Series.filter((p) => p.value !== null));
    }

    // Ichimoku overlay (toggle preference)
    if (loadShowIchimoku()) {
      const ichi = computeIchimoku(highs, lows, closes);
      if (ichi) {
        const n = times.length;
        // Detect bar interval (seconds): difference between consecutive times
        const barInterval = n >= 2 ? (times[1] - times[0]) : 86400;
        // Tenkan + Kijun: bar time = chart time
        const tenkanData = [], kijunData = [];
        for (let i = 0; i < n; i++) {
          if (ichi.tenkanSeries[i] != null) tenkanData.push({ time: times[i], value: ichi.tenkanSeries[i] });
          if (ichi.kijunSeries[i] != null) kijunData.push({ time: times[i], value: ichi.kijunSeries[i] });
        }
        // Senkou A & B: SHIFT +26 bars forward (project into future on chart)
        const senkouAData = [], senkouBData = [];
        for (let i = 0; i < n; i++) {
          const futureTime = times[i] + 26 * barInterval;
          if (ichi.senkouASeries[i] != null) senkouAData.push({ time: futureTime, value: ichi.senkouASeries[i] });
          if (ichi.senkouBSeries[i] != null) senkouBData.push({ time: futureTime, value: ichi.senkouBSeries[i] });
        }
        // Sort + dedupe (chart needs sorted unique times)
        const uniq = (arr) => {
          const m = new Map();
          for (const p of arr) m.set(p.time, p);
          return [...m.values()].sort((a, b) => a.time - b.time);
        };
        const senkouAClean = uniq(senkouAData);
        const senkouBClean = uniq(senkouBData);

        const tenkanLine = technicalChartInstance.addLineSeries({
          color: "#2196F3", lineWidth: 1, title: "Tenkan(9)",
          priceLineVisible: false, lastValueVisible: false,
        });
        tenkanLine.setData(tenkanData);

        const kijunLine = technicalChartInstance.addLineSeries({
          color: "#E91E63", lineWidth: 1, title: "Kijun(26)",
          priceLineVisible: false, lastValueVisible: false,
        });
        kijunLine.setData(kijunData);

        // Senkou A line (đường trên/dưới của cloud)
        const senkouALine = technicalChartInstance.addLineSeries({
          color: "rgba(76,175,80,0.7)", lineWidth: 1, title: "Senkou A",
          priceLineVisible: false, lastValueVisible: false,
        });
        senkouALine.setData(senkouAClean);

        // Senkou B line
        const senkouBLine = technicalChartInstance.addLineSeries({
          color: "rgba(255,68,68,0.7)", lineWidth: 1, title: "Senkou B",
          priceLineVisible: false, lastValueVisible: false,
        });
        senkouBLine.setData(senkouBClean);

        // Cloud fill — use Baseline series (fill between A and B)
        // LightweightCharts không có built-in fill-between-2-lines, dùng trick:
        // tạo Area series cho cả A và B với base = thấp, fill bằng overlap visual
        // Simple approach: area dưới mỗi line semi-transparent
        try {
          const cloudAreaA = technicalChartInstance.addAreaSeries({
            topColor: "rgba(76,175,80,0.10)",
            bottomColor: "rgba(76,175,80,0)",
            lineColor: "transparent",
            priceLineVisible: false, lastValueVisible: false,
            crosshairMarkerVisible: false,
          });
          cloudAreaA.setData(senkouAClean);
        } catch {}
      }
    }

    // Volume bars (sub pane)
    const volSeries = technicalChartInstance.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
      lastValueVisible: false,
    });
    volSeries.setData(volBars);
    technicalChartInstance.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    technicalChartInstance.timeScale().fitContent();
  }

  // Re-run technical analysis với data (D or W aggregated)
  function refreshTechnicalAnalysis(timeframe) {
    if (!currentData || !lastAnalysisResult) return;
    const data = timeframe === "W" ? aggregateWeekly(currentData) : currentData;
    const slot = document.getElementById("technical-analysis-body");
    if (slot) slot.innerHTML = buildTechnicalAnalysisBody(lastAnalysisResult, data, timeframe);
    // Re-render chart
    requestAnimationFrame(() => renderTechnicalChart("technical-chart-container", data));
  }

  // ── Level Analysis: S/R touch + BB + 52w + MA + Confluence ──────

  // Stock Profile interpretation
  function buildStockProfileSection(profile) {
    if (!profile) return "";
    const items = [];
    if (profile.volLabel) {
      const volColor = profile.volLabel === "Calm" ? "#66bb6a"
        : profile.volLabel === "Normal" ? "#FFC107"
        : profile.volLabel === "Volatile" ? "#FFA726"
        : "#ef5350";
      items.push(`<div class="ta-profile-item"><span class="ta-profile-label">Volatility</span>: <b style="color:${volColor}">${profile.volLabel}</b> ${profile.atrPct != null ? `<small>(ATR ${profile.atrPct.toFixed(2)}%)</small>` : ""}</div>`);
    }
    if (profile.trendLabel) {
      items.push(`<div class="ta-profile-item"><span class="ta-profile-label">Trend behavior</span>: <b>${profile.trendLabel}</b></div>`);
    }
    if (profile.betaLabel) {
      items.push(`<div class="ta-profile-item"><span class="ta-profile-label">Beta vs VNI</span>: <b>${profile.betaLabel}</b> ${profile.beta != null ? `<small>(β=${profile.beta.toFixed(2)})</small>` : ""}</div>`);
    }
    if (profile.breakoutCount != null && profile.breakoutWinRate != null) {
      items.push(`<div class="ta-profile-item"><span class="ta-profile-label">Breakout history</span>: ${profile.breakoutCount} lần · Win ${profile.breakoutWinRate.toFixed(0)}%</div>`);
    }
    if (profile.selloffCount != null && profile.recoveryWinRate != null) {
      items.push(`<div class="ta-profile-item"><span class="ta-profile-label">Sell-off pattern</span>: ${profile.selloffCount} lần · Recovery rate ${profile.recoveryWinRate.toFixed(0)}% ${profile.avgRecoveryBars != null ? `<small>(avg ${profile.avgRecoveryBars.toFixed(0)} phiên)</small>` : ""}</div>`);
    }
    if (profile.volPercentile != null) {
      items.push(`<div class="ta-profile-item"><span class="ta-profile-label">Vol today</span>: percentile ${profile.volPercentile.toFixed(0)}% ${profile.volMultiple != null ? `<small>(${profile.volMultiple.toFixed(1)}× avg)</small>` : ""}</div>`);
    }
    if (!items.length) return "";
    return `
      <div class="ta-section">
        <h3 class="ta-section-title">🧬 Đặc thù mã (Stock Profile)</h3>
        <div class="ta-profile-grid">
          ${items.join("")}
        </div>
      </div>`;
  }

  // Build analysis body (sections + verdict) — separate from full tab content
  function buildTechnicalAnalysisBody(r, data, timeframe) {
    const { opens, highs, lows, closes, volumes } = data;
    const n = closes.length;
    if (n < 30) return `<div class="empty-state"><p>Không đủ data (cần ≥30 bars) — timeframe ${timeframe} quá ít sample.</p></div>`;

    const candle = detectCandlePattern(opens, highs, lows, closes, n);
    // Recompute MAs cho timeframe hiện tại
    const ma20 = n >= 20 ? closes.slice(n - 20).reduce((a, b) => a + b, 0) / 20 : null;
    const ma50 = n >= 50 ? closes.slice(n - 50).reduce((a, b) => a + b, 0) / 50 : null;
    const ma200 = n >= 200 ? closes.slice(n - 200).reduce((a, b) => a + b, 0) / 200 : null;
    const cur = closes[n - 1];
    const trend = detectTrendStatus({ current: cur, ma20, ma50, ma200 });
    const volAnalysis = detectVolumeAnalysis(volumes, closes, n);
    const sr = detectSupportResistance(highs, lows, closes, n);
    // RSI compute on closes
    let rsi = null;
    if (n >= 15) {
      let gains = 0, losses = 0;
      for (let i = 1; i <= 14; i++) {
        const d = closes[n - 15 + i] - closes[n - 16 + i];
        if (d > 0) gains += d; else losses -= d;
      }
      let avgG = gains / 14, avgL = losses / 14;
      // Wilder smoothing for n-15 onwards
      rsi = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    }
    const rsiStatus = detectRsiStatus(rsi);
    // Indicators chỉ available cho Daily (r.macd / r.adx / r.stoch tính từ daily data)
    const isDaily = timeframe === "D";
    const macdStatus = isDaily ? detectMacdStatus(r.macd) : null;
    const adxStatus = isDaily ? detectAdxStatus(r.adx) : null;
    const stochStatus = isDaily ? detectStochStatus(r.stoch) : null;
    const vnFlags = isDaily ? detectVnFlags(closes, n) : [];

    // Multi-bar chart patterns
    const pivots = findSwingPivots(highs, lows, 60, 3);
    const hhHl = detectHhHlStructure(pivots);
    const triangle = detectTrianglePattern(pivots, closes, n);
    const doubleTopBot = detectDoubleTopBottom(pivots, closes, n);

    // Level analysis (chỉ daily — r.support/resistance/bb từ daily analysis)
    const levels = isDaily ? detectLevelTouch(r, closes, highs, lows, n) : [];
    const confluences = isDaily ? detectConfluence(levels) : [];
    const touchedLevels = levels.filter((lv) => lv.touched);
    const bbStatus = isDaily ? detectBollingerStatus(r, closes, n) : null;

    // Ichimoku (work cho cả daily + weekly)
    const ichimoku = computeIchimoku(highs, lows, closes);
    const curPrice = closes[n - 1];
    const prevPrice = n >= 2 ? closes[n - 2] : curPrice;
    const ichimokuStatus = detectIchimokuStatus(ichimoku, curPrice, prevPrice);

    const verdict = buildTechnicalVerdict([
      candle, trend, volAnalysis, rsiStatus, macdStatus, adxStatus,
      hhHl, triangle, doubleTopBot, bbStatus, ichimokuStatus,
    ]);
    const tfLabel = timeframe === "W" ? "tuần" : "ngày";

    // Build structured snapshot for AI (sent to Gemini)
    const sigList = [candle, trend, volAnalysis, rsiStatus, macdStatus, adxStatus,
                     hhHl, triangle, doubleTopBot, bbStatus, ichimokuStatus]
      .filter(Boolean)
      .map((s) => ({ label: s.label || "", desc: s.desc || "", sentiment: s.sentiment || "neutral" }));
    window._lastTaSnapshot = {
      symbol: r.symbol,
      timeframe,
      price: cur,
      ma: { ma20, ma50, ma200 },
      rsi: rsi !== null ? Number(rsi.toFixed(1)) : null,
      macd: r.macd || null,
      adx: r.adx || null,
      verdict: { label: verdict.label, color: verdict.color, desc: verdict.desc },
      signals: sigList,
      levels: {
        support: r.support || null,
        resistance: r.resistance || null,
        bb: r.bb || null,
      },
      touchedLevels: touchedLevels.map((lv) => ({ kind: lv.kind, label: lv.label, distance: lv.distance })),
      confluences: confluences.map((c) => ({ label: c.label })),
      vnFlags: vnFlags.map((f) => ({ label: f.label, sentiment: f.sentiment })),
    };

    return `
      <div class="ta-verdict ta-${verdict.color}">
        <div class="ta-verdict-label">${verdict.label}</div>
        <div class="ta-verdict-desc">${verdict.desc} <small>(phân tích trên nến ${tfLabel})</small></div>
      </div>

      <div class="ta-ai-section">
        <div class="ta-ai-actions">
          <button class="ta-ai-btn ta-ai-btn-explain" id="ta-ai-explain-btn" type="button">
            🤖 AI giải thích TA
            <small>nhanh, free</small>
          </button>
          <button class="ta-ai-btn ta-ai-btn-research" id="ta-ai-research-btn" type="button">
            📊 Nghiên cứu sâu
            <small>+ fundamental, news, phốt</small>
          </button>
        </div>
        <div id="ta-ai-result" class="ta-ai-result" style="display:none"></div>
      </div>

      <div class="ta-section">
        <h3 class="ta-section-title">📈 Xu hướng (Trend)</h3>
        <div class="ta-row sentiment-${trend.sentiment}">
          <div class="ta-label">${trend.label}</div>
          <div class="ta-desc">${trend.desc}</div>
        </div>
        <div class="ta-mini-grid">
          <div><span class="ta-mini-label">Close:</span> <b>${cur.toFixed(2)}k</b></div>
          ${ma20 ? `<div><span class="ta-mini-label">MA20:</span> ${ma20.toFixed(2)}k</div>` : ""}
          ${ma50 ? `<div><span class="ta-mini-label">MA50:</span> ${ma50.toFixed(2)}k</div>` : ""}
          ${ma200 ? `<div><span class="ta-mini-label">MA200:</span> ${ma200.toFixed(2)}k</div>` : ""}
        </div>
      </div>

      <div class="ta-section">
        <h3 class="ta-section-title">🕯️ Mẫu hình nến ${tfLabel}</h3>
        ${candle ? `
          <div class="ta-row sentiment-${candle.sentiment}">
            <div class="ta-label">${candle.name}</div>
            <div class="ta-desc">${candle.desc}</div>
          </div>` : `<div class="ta-row"><div class="ta-desc">Không phát hiện mẫu hình rõ rệt</div></div>`}
      </div>

      ${hhHl ? `
      <div class="ta-section">
        <h3 class="ta-section-title">📊 Cấu trúc Swing (HH/HL)</h3>
        <div class="ta-row sentiment-${hhHl.sentiment}">
          <div class="ta-label">${hhHl.label}</div>
          <div class="ta-desc">${hhHl.desc}</div>
        </div>
      </div>` : ""}

      ${triangle ? `
      <div class="ta-section">
        <h3 class="ta-section-title">📐 Mẫu hình Chart (Trendline)</h3>
        <div class="ta-row sentiment-${triangle.sentiment}">
          <div class="ta-label">${triangle.name}</div>
          <div class="ta-desc">${triangle.desc}</div>
        </div>
      </div>` : ""}

      ${doubleTopBot ? `
      <div class="ta-section">
        <h3 class="ta-section-title">🔁 Double Top/Bottom</h3>
        <div class="ta-row sentiment-${doubleTopBot.sentiment}">
          <div class="ta-label">${doubleTopBot.name}</div>
          <div class="ta-desc">${doubleTopBot.desc}</div>
        </div>
      </div>` : ""}

      ${volAnalysis ? `
      <div class="ta-section">
        <h3 class="ta-section-title">📊 Phân tích Volume</h3>
        <div class="ta-row sentiment-${volAnalysis.sentiment}">
          <div class="ta-label">${volAnalysis.signal}</div>
          <div class="ta-desc">${volAnalysis.context}</div>
        </div>
      </div>` : ""}

      ${sr ? `
      <div class="ta-section">
        <h3 class="ta-section-title">🎯 Hỗ trợ / Kháng cự ${tfLabel}</h3>
        <div class="ta-sr-grid">
          <div class="ta-sr-cell">
            <div class="ta-sr-label">⛔ Kháng cự gần nhất</div>
            <div class="ta-sr-value">${sr.nearestR.toFixed(2)}k</div>
            <div class="ta-sr-dist">cách +${sr.distR.toFixed(1)}%</div>
          </div>
          <div class="ta-sr-cell">
            <div class="ta-sr-label">🛡️ Hỗ trợ gần nhất</div>
            <div class="ta-sr-value">${sr.nearestS.toFixed(2)}k</div>
            <div class="ta-sr-dist">cách −${sr.distS.toFixed(1)}%</div>
          </div>
        </div>
        <div class="ta-mini-grid">
          <div><span class="ta-mini-label">30 ${tfLabel} high:</span> ${sr.maxH.toFixed(2)}k</div>
          <div><span class="ta-mini-label">30 ${tfLabel} low:</span> ${sr.minL.toFixed(2)}k</div>
        </div>
      </div>` : ""}

      ${touchedLevels.length > 0 ? `
      <div class="ta-section">
        <h3 class="ta-section-title">🎯 ĐANG chạm levels (within 1.5%)</h3>
        ${touchedLevels.slice(0, 5).map((lv) => `
          <div class="ta-row sentiment-${lv.type === "S" ? "bullish-mild" : "bearish-mild"}">
            <div class="ta-label">${lv.type === "S" ? "🛡️" : "⛔"} ${lv.source}: ${lv.price.toFixed(2)}k</div>
            <div class="ta-desc">cách ${lv.distPct >= 0 ? "+" : ""}${lv.distPct.toFixed(2)}% — ${lv.type === "S" ? "test hỗ trợ" : "test kháng cự"}</div>
          </div>
        `).join("")}
      </div>` : ""}

      ${confluences.length > 0 ? `
      <div class="ta-section">
        <h3 class="ta-section-title">🔥 Confluence (Multi-level cluster)</h3>
        ${confluences.map((c) => `
          <div class="ta-row sentiment-${c.type === "S" ? "bullish" : "bearish"}">
            <div class="ta-label">${c.type === "S" ? "💎 Vùng hỗ trợ mạnh" : "💎 Vùng kháng cự mạnh"} ~${c.price.toFixed(2)}k (${c.count} levels confluence)</div>
            <div class="ta-desc">Sources: ${c.sources.join(" + ")} — vùng giá quan trọng, nhiều technical levels chồng nhau</div>
          </div>
        `).join("")}
      </div>` : ""}

      ${bbStatus ? `
      <div class="ta-section">
        <h3 class="ta-section-title">📏 Bollinger Bands (20, 2σ)</h3>
        <div class="ta-row sentiment-${bbStatus.sentiment}">
          <div class="ta-label">${bbStatus.label}</div>
          <div class="ta-desc">${bbStatus.desc}</div>
        </div>
        ${r.bb ? `
        <div class="ta-mini-grid">
          <div><span class="ta-mini-label">Upper:</span> ${r.bb.upper.toFixed(2)}k</div>
          <div><span class="ta-mini-label">Middle:</span> ${r.bb.middle.toFixed(2)}k</div>
          <div><span class="ta-mini-label">Lower:</span> ${r.bb.lower.toFixed(2)}k</div>
          <div><span class="ta-mini-label">Width:</span> ${bbStatus.widthPct.toFixed(1)}%</div>
        </div>` : ""}
      </div>` : ""}

      ${ichimokuStatus ? `
      <div class="ta-section">
        <h3 class="ta-section-title">☁️ Ichimoku Kinko Hyo (Mây Ichimoku)</h3>
        <div class="ta-row sentiment-${ichimokuStatus.sentiment}">
          <div class="ta-label">${ichimokuStatus.label}</div>
          <div class="ta-desc">${ichimokuStatus.cloudLabel}</div>
        </div>
        ${ichimokuStatus.tkCross ? `
        <div class="ta-row sentiment-${ichimokuStatus.sentiment}" style="margin-top: 6px;">
          <div class="ta-desc">${ichimokuStatus.tkCross}</div>
        </div>` : ""}
        ${ichimokuStatus.futureCloud ? `
        <div class="ta-row" style="margin-top: 6px;">
          <div class="ta-desc">${ichimokuStatus.futureCloud}</div>
        </div>` : ""}
        <div class="ta-mini-grid">
          <div><span class="ta-mini-label">Tenkan (9):</span> ${ichimokuStatus.tenkan.toFixed(2)}k</div>
          <div><span class="ta-mini-label">Kijun (26):</span> ${ichimokuStatus.kijun.toFixed(2)}k</div>
          ${ichimokuStatus.cloudTop != null ? `<div><span class="ta-mini-label">Kumo top:</span> ${ichimokuStatus.cloudTop.toFixed(2)}k</div>` : ""}
          ${ichimokuStatus.cloudBot != null ? `<div><span class="ta-mini-label">Kumo bot:</span> ${ichimokuStatus.cloudBot.toFixed(2)}k</div>` : ""}
        </div>
        <div class="ta-desc" style="margin-top: 6px; font-size: 11px; color: #888;">
          📚 Ichimoku check 3 yếu tố: (1) giá vs mây, (2) Tenkan/Kijun cross, (3) màu mây tương lai
        </div>
      </div>` : ""}

      ${isDaily && (r.distMA20 != null || r.distMA50 != null || r.distMA200 != null) ? `
      <div class="ta-section">
        <h3 class="ta-section-title">📏 Khoảng cách từ MA</h3>
        <div class="ta-mini-grid">
          ${r.distMA20 != null ? `<div><span class="ta-mini-label">vs MA20:</span> <b>${r.distMA20 >= 0 ? "+" : ""}${r.distMA20.toFixed(1)}%</b> ${Math.abs(r.distMA20) > 10 ? "<small>⚠️ xa</small>" : ""}</div>` : ""}
          ${r.distMA50 != null ? `<div><span class="ta-mini-label">vs MA50:</span> <b>${r.distMA50 >= 0 ? "+" : ""}${r.distMA50.toFixed(1)}%</b> ${Math.abs(r.distMA50) > 15 ? "<small>⚠️ xa</small>" : ""}</div>` : ""}
          ${r.distMA200 != null ? `<div><span class="ta-mini-label">vs MA200:</span> <b>${r.distMA200 >= 0 ? "+" : ""}${r.distMA200.toFixed(1)}%</b> ${Math.abs(r.distMA200) > 25 ? "<small>⚠️ extension</small>" : ""}</div>` : ""}
          ${r.posIn52w != null ? `<div><span class="ta-mini-label">52w pos:</span> <b>${r.posIn52w.toFixed(0)}%</b></div>` : ""}
        </div>
        <div class="ta-desc" style="margin-top: 6px; font-size: 11px; color: #888;">
          ⚠️ Distance > 10% từ MA20 / > 15% MA50 / > 25% MA200 → extension cao, có thể mean-revert
        </div>
      </div>` : ""}

      ${rsiStatus ? `
      <div class="ta-section">
        <h3 class="ta-section-title">📐 RSI (14) — nến ${tfLabel}</h3>
        <div class="ta-row sentiment-${rsiStatus.sentiment}">
          <div class="ta-label">${rsiStatus.zone} · RSI = ${rsi.toFixed(1)}</div>
          <div class="ta-desc">${rsiStatus.desc}</div>
        </div>
      </div>` : ""}

      ${macdStatus ? `
      <div class="ta-section">
        <h3 class="ta-section-title">📊 MACD (12,26,9)</h3>
        <div class="ta-row sentiment-${macdStatus.sentiment}">
          <div class="ta-label">${macdStatus.label}</div>
          <div class="ta-desc">${macdStatus.desc}</div>
        </div>
      </div>` : ""}

      ${adxStatus ? `
      <div class="ta-section">
        <h3 class="ta-section-title">💪 ADX (14) — Trend Strength</h3>
        <div class="ta-row sentiment-${adxStatus.sentiment}">
          <div class="ta-label">${adxStatus.label}</div>
          <div class="ta-desc">${adxStatus.desc}</div>
        </div>
      </div>` : ""}

      ${stochStatus ? `
      <div class="ta-section">
        <h3 class="ta-section-title">📈 Stochastic %K%D (14,3)</h3>
        <div class="ta-row sentiment-${stochStatus.sentiment}">
          <div class="ta-label">${stochStatus.label}</div>
          <div class="ta-desc">${stochStatus.desc}</div>
        </div>
      </div>` : ""}

      ${buildStockProfileSection(r.stockProfile)}

      ${vnFlags.length > 0 ? `
      <div class="ta-section">
        <h3 class="ta-section-title">🇻🇳 VN Market Flags</h3>
        ${vnFlags.map((f) => `<div class="ta-row sentiment-${f.type === "warn" ? "bearish-mild" : "neutral"}"><div class="ta-desc">${f.text}</div></div>`).join("")}
      </div>` : ""}

      <div class="ta-disclaimer">
        <small>⚠️ <b>Method</b>: phân tích pure rule-based trên price action + indicator (Wilder RSI, MA20/50/200, swing pivot 5-bar S/R, body/shadow ratio candle pattern). Không AI/ML. Timeframe = nến ${tfLabel}. Chỉ là tín hiệu kỹ thuật, KHÔNG phải lời khuyên đầu tư.</small>
      </div>
    `;
  }

  function renderTechnicalTabContent(r) {
    if (!currentData || !currentData.closes?.length) {
      return `<div class="empty-state"><p>Không đủ data để phân tích kỹ thuật.</p></div>`;
    }
    const { opens, highs, lows, closes, volumes } = currentData;
    const n = closes.length;
    const cur = closes[n - 1];
    const prev = n >= 2 ? closes[n - 2] : cur;
    const dayChange = ((cur - prev) / prev) * 100;
    const dayVol = volumes[n - 1];
    const avgVol20 = n >= 20 ? volumes.slice(n - 21, n - 1).reduce((a, b) => a + b, 0) / 20 : null;
    const volRatio = avgVol20 ? dayVol / avgVol20 : null;
    const sym = r.symbol;
    const changeSign = dayChange >= 0 ? "+" : "";
    const changeColor = dayChange >= 0 ? "up" : "down";
    const dayHigh = currentData.highs[n - 1];
    const dayLow = currentData.lows[n - 1];

    return `
      <div class="ta-info-row">
        <div class="ta-info-symbol">${sym}</div>
        <div class="ta-info-price ${changeColor}">${cur.toFixed(2)}k <span class="ta-info-change">${changeSign}${dayChange.toFixed(2)}%</span></div>
        <div class="ta-info-stats">
          <span>H: ${dayHigh.toFixed(2)}k</span>
          <span>L: ${dayLow.toFixed(2)}k</span>
          <span>Vol: ${dayVol >= 1e6 ? (dayVol/1e6).toFixed(1) + "M" : (dayVol/1e3).toFixed(0) + "K"} ${volRatio ? `<small>(${volRatio.toFixed(1)}× TB20)</small>` : ""}</span>
        </div>
      </div>

      <div class="ta-controls">
        <span class="ctrl-label">Timeframe:</span>
        <div class="seg-toggle" id="ta-tf-toggle">
          <button class="seg-btn active" data-tf="D">Daily</button>
          <button class="seg-btn" data-tf="W">Weekly</button>
        </div>
        <label class="ta-checkbox-toggle">
          <input type="checkbox" id="ta-ichimoku-toggle" ${loadShowIchimoku() ? "checked" : ""}>
          <span>☁️ Ichimoku</span>
        </label>
      </div>

      <div class="ta-chart-wrap">
        <div id="technical-chart-container"></div>
        <div class="ta-chart-legend" id="ta-chart-legend">
          <span class="ta-legend-item"><span class="ta-legend-dot" style="background:#00d2ff"></span>MA20</span>
          <span class="ta-legend-item"><span class="ta-legend-dot" style="background:#FFC107"></span>MA50</span>
          <span class="ta-legend-item"><span class="ta-legend-dot" style="background:#ef5350"></span>MA200</span>
          ${loadShowIchimoku() ? `
          <span class="ta-legend-item"><span class="ta-legend-dot" style="background:#2196F3"></span>Tenkan(9)</span>
          <span class="ta-legend-item"><span class="ta-legend-dot" style="background:#E91E63"></span>Kijun(26)</span>
          <span class="ta-legend-item"><span class="ta-legend-dot" style="background:rgba(76,175,80,0.7)"></span>Senkou A</span>
          <span class="ta-legend-item"><span class="ta-legend-dot" style="background:rgba(255,68,68,0.7)"></span>Senkou B</span>
          ` : ""}
        </div>
      </div>

      <div id="technical-analysis-body">${buildTechnicalAnalysisBody(r, currentData, "D")}</div>
    `;
  }

  // Bind timeframe toggle + Ichimoku toggle + render chart on tab show
  function initTechnicalTabHandlers() {
    const toggle = document.getElementById("ta-tf-toggle");
    if (toggle && !toggle.dataset.bound) {
      toggle.dataset.bound = "1";
      toggle.querySelectorAll(".seg-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          toggle.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          refreshTechnicalAnalysis(btn.dataset.tf);
        });
      });
    }
    // Ichimoku toggle — re-render chart + update legend
    const ichiToggle = document.getElementById("ta-ichimoku-toggle");
    if (ichiToggle && !ichiToggle.dataset.bound) {
      ichiToggle.dataset.bound = "1";
      ichiToggle.addEventListener("change", () => {
        saveShowIchimoku(ichiToggle.checked);
        // Re-render entire tab (refresh chart + legend)
        const activeTf = document.querySelector("#ta-tf-toggle .seg-btn.active")?.dataset.tf || "D";
        refreshTechnicalAnalysis(activeTf);
        // Also re-render tab container HTML to update legend
        if (lastAnalysisResult) {
          $("analysis-tab-technical").innerHTML = renderTechnicalTabContent(lastAnalysisResult);
          // Re-bind handlers (innerHTML wipes old listeners)
          document.getElementById("ta-tf-toggle").dataset.bound = "";
          document.getElementById("ta-ichimoku-toggle").dataset.bound = "";
          initTechnicalTabHandlers();
        }
      });
    }
    // AI buttons (explain TA / research sâu via Gemini)
    const explainBtn = document.getElementById("ta-ai-explain-btn");
    if (explainBtn && !explainBtn.dataset.bound) {
      explainBtn.dataset.bound = "1";
      explainBtn.addEventListener("click", () => callAiAnalysis("explain"));
    }
    const researchBtn = document.getElementById("ta-ai-research-btn");
    if (researchBtn && !researchBtn.dataset.bound) {
      researchBtn.dataset.bound = "1";
      researchBtn.addEventListener("click", () => callAiAnalysis("research"));
    }
    // Initial chart render
    if (currentData) {
      requestAnimationFrame(() => renderTechnicalChart("technical-chart-container", currentData));
    }
  }

  // ── Buy Verdict tab render ────────────────────────────────────
  function renderVerdictTabContent(r) {
    // Gọi qua global UMD (verdict-core.js load trước app.js trong index.html)
    const V = window.__SSI_VERDICT__;
    if (!V) return `<div class="an-reasons">Không tải được module đánh giá.</div>`;
    // Backtest chứng minh scoring/dự báo KHÔNG có edge → tab chỉ MÔ TẢ trạng thái khách quan.
    const s = V.describeState(r);
    const fwd = currentData
      ? V.computeSetupForwardReturn(currentData.closes, currentData.highs, currentData.lows, currentData.volumes)
      : null;

    // Header — nhắc rõ đây là mô tả trạng thái, không khuyến nghị
    const head = `
      <div class="ta-verdict ta-neutral">
        <div class="ta-verdict-label">Trạng thái kỹ thuật</div>
        <div class="ta-verdict-desc">Mô tả khách quan chart / giá / dòng tiền hiện tại. Không phải khuyến nghị mua/bán.</div>
      </div>`;

    // Các nhóm trạng thái — mỗi nhóm 1 dòng mô tả, tô màu theo tone
    const groupRow = (g) =>
      `<div class="vd-state vd-state-${g.tone}"><span class="vd-state-label">${g.label}</span><span class="vd-state-text">${g.text}</span></div>`;
    const states = `
      <div class="an-card">
        <div class="an-title">Trạng thái hiện tại</div>
        <div class="vd-states">${s.groups.map(groupRow).join("")}</div>
      </div>`;

    // Cảnh báo rủi ro — chỉ hiện khi có
    const warns = s.warns.length
      ? `<div class="an-card"><div class="an-title">⚠ Cảnh báo</div>
           <div class="vd-reasons">${s.warns.map((x) => `<span class="chip vd-chip-warn">${x}</span>`).join("")}</div></div>`
      : "";

    // Thống kê lịch sử (tham khảo) — forward-return từ setup tương tự trong quá khứ
    let stats;
    if (!fwd) {
      stats = `<div class="an-card"><div class="an-title">Thống kê lịch sử (tham khảo)</div>
        <div class="an-reasons">Không đủ dữ liệu lịch sử (cần ≥ 50 phiên).</div></div>`;
    } else {
      const note = fwd.method === "atr-fallback"
        ? `<div class="an-reasons">Ít mẫu lịch sử khớp trạng thái — ước lượng biên độ từ biến động (ATR ${fwd.atrPct ? fwd.atrPct.toFixed(2) : "--"}%/phiên).</div>`
        : `<div class="an-reasons">Trong quá khứ, các phiên có trạng thái tương tự (vị trí MA50 · RSI · ADX · volume) diễn biến như sau:</div>`;
      // h null (atr-fallback với atrPct null) → hiện "—", không crash
      const hRow = (lbl, h) => h
        ? `<div class="vd-fc-row"><span>${lbl}</span>
             <b class="${h.median >= 0 ? "up" : "down"}">${h.median >= 0 ? "+" : ""}${h.median.toFixed(1)}%</b>
             <small>dải ${h.p25.toFixed(1)}% … ${h.p75.toFixed(1)}%${h.n ? ` · n=${h.n}` : ""}</small></div>`
        : `<div class="vd-fc-row"><span>${lbl}</span><small>—</small></div>`;
      stats = `<div class="an-card"><div class="an-title">Thống kê lịch sử (tham khảo)</div>
        ${note}
        ${hRow("Sau 5 phiên", fwd.horizons.h5)}
        ${hRow("Sau 10 phiên", fwd.horizons.h10)}
        ${hRow("Sau 20 phiên", fwd.horizons.h20)}</div>`;
    }

    // Vùng tham chiếu — hỗ trợ/kháng cự/stop (mô tả vùng, không phải lệnh)
    const pct = (to) => r.current ? ((to - r.current) / r.current) * 100 : 0;
    const action = `<div class="an-card"><div class="an-title">Vùng giá tham chiếu</div>
      ${r.resistance ? `<div class="vd-fc-row"><span>Kháng cự gần</span><b>${fp(r.resistance)}</b><small>${pct(r.resistance) >= 0 ? "+" : ""}${pct(r.resistance).toFixed(1)}%</small></div>` : ""}
      ${r.support ? `<div class="vd-fc-row"><span>Hỗ trợ gần</span><b>${fp(r.support)}</b><small>${pct(r.support).toFixed(1)}%</small></div>` : ""}
      ${r.stopLoss ? `<div class="vd-fc-row"><span>Mốc rủi ro (2·ATR)</span><b>${fp(r.stopLoss)}</b><small>${pct(r.stopLoss).toFixed(1)}%</small></div>` : ""}
    </div>`;

    const disclaimer = `<div class="an-reasons" style="margin-top:10px;font-style:italic">
      Backtest cho thấy chỉ báo kỹ thuật thuần không dự báo được xu hướng tăng/giảm trên thị trường VN,
      nên tab này chỉ MÔ TẢ trạng thái, KHÔNG khuyến nghị mua/bán. Thống kê lịch sử là phân phối quá khứ,
      không đảm bảo tương lai.</div>`;

    return head + states + warns + stats + action + disclaimer;
  }

  // ── AI analysis (Gemini via worker) ────────────────────────────
  const AI_WORKER_BASE = "https://stock-pwa-bot.qngnhat.workers.dev";

  async function callAiAnalysis(mode) {
    const snap = window._lastTaSnapshot;
    if (!snap) return;
    const resultEl = document.getElementById("ta-ai-result");
    if (!resultEl) return;

    const explainBtn = document.getElementById("ta-ai-explain-btn");
    const researchBtn = document.getElementById("ta-ai-research-btn");
    if (explainBtn) explainBtn.disabled = true;
    if (researchBtn) researchBtn.disabled = true;

    const modeLabel = mode === "explain" ? "AI giải thích TA" : "AI nghiên cứu sâu";
    const estTime = mode === "explain" ? "~1-2s" : "~3-5s";
    resultEl.style.display = "block";
    resultEl.innerHTML = `
      <div class="ta-ai-loading">
        <div class="ta-ai-spinner"></div>
        <div>${modeLabel} đang chạy… ${estTime}</div>
        <small>Lần đầu trong ngày sẽ chậm hơn (chưa cache).</small>
      </div>
    `;

    try {
      const r = await fetch(`${AI_WORKER_BASE}/ai-${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: snap.symbol, ta: snap }),
      });
      const data = await r.json();
      if (!r.ok || data.error) {
        resultEl.innerHTML = `
          <div class="ta-ai-error">
            ❌ Lỗi: ${escapeHtml(data.error || `HTTP ${r.status}`)}
            <small>Liên hệ admin nếu lặp lại. Worker cần GEMINI_API_KEY config.</small>
          </div>
        `;
        return;
      }
      renderAiResponse(resultEl, data, modeLabel);
    } catch (e) {
      resultEl.innerHTML = `
        <div class="ta-ai-error">
          ❌ Network error: ${escapeHtml(e.message)}
        </div>
      `;
    } finally {
      if (explainBtn) explainBtn.disabled = false;
      if (researchBtn) researchBtn.disabled = false;
    }
  }

  function renderAiResponse(el, data, modeLabel) {
    const cachedTag = data.cached
      ? `<span class="ta-ai-cached" title="Đã cache trong ngày, không tốn token">♻️ cached</span>`
      : "";
    const citationsHtml = data.citations && data.citations.length
      ? `<div class="ta-ai-citations">
          <div class="ta-ai-citations-title">📎 Nguồn (${data.citations.length}):</div>
          <ul>
            ${data.citations.slice(0, 8).map((c, i) =>
              `<li><a href="${escapeHtml(c.uri)}" target="_blank" rel="noopener">${escapeHtml(c.title || c.uri).slice(0, 80)}</a></li>`
            ).join("")}
          </ul>
        </div>`
      : "";
    el.innerHTML = `
      <div class="ta-ai-header">
        <span class="ta-ai-header-label">${modeLabel}</span>
        ${cachedTag}
        <small class="ta-ai-disclaimer">Phân tích tham khảo, KHÔNG phải lời khuyên đầu tư.</small>
      </div>
      <div class="ta-ai-body markdown-body">${renderSimpleMarkdown(data.response || "")}</div>
      ${citationsHtml}
    `;
  }

  // Lightweight markdown → HTML (bold, italic, links, headers, lists, line breaks)
  function renderSimpleMarkdown(md) {
    if (!md) return "";
    let html = escapeHtml(md);
    // Bold **text**
    html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    // Italic *text* (avoid double-star)
    html = html.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    // Inline code `text`
    html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    // Links [text](url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    // Headers # / ## / ###
    html = html.replace(/^### (.+)$/gm, "<h4>$1</h4>");
    html = html.replace(/^## (.+)$/gm, "<h3>$1</h3>");
    html = html.replace(/^# (.+)$/gm, "<h3>$1</h3>");
    // Bullet lists - / *
    html = html.replace(/^[-*] (.+)$/gm, "<li>$1</li>");
    html = html.replace(/(<li>[\s\S]+?<\/li>)(\n(?!<li>)|$)/g, "<ul>$1</ul>$2");
    // Line breaks
    html = html.replace(/\n\n+/g, "</p><p>");
    html = html.replace(/\n/g, "<br>");
    return `<p>${html}</p>`;
  }

  function renderOverviewTabContent(r) {
    const changeClass = r.dayChange >= 0 ? "up" : "down";
    const changeSign = r.dayChange >= 0 ? "+" : "";
    const rsiColor = r.rsi === null ? "#888" : r.rsi < 30 ? "#4CAF50" : r.rsi > 70 ? "#ff4444" : "#ccc";
    const trendIcon =
      r.trendDir === "up" ? "▲"
      : r.trendDir === "down" ? "▼"
      : r.trendDir === "up-weak" ? "↗"
      : r.trendDir === "down-weak" ? "↘"
      : "─";

    const buyZoneHtml = (r.buyZoneLow && r.buyZoneHigh)
      ? row("Vùng mua tốt", `${fp(r.buyZoneLow)} – ${fp(r.buyZoneHigh)}`, null, "color:#4CAF50;font-weight:600")
      : "";

    const inWatchlist = RANKING.isInWatchlist(r.symbol);
    const meta = getStockMeta(r.symbol) || { name: "", floor: "", sector: null };
    const companyParts = [];
    if (meta.name) companyParts.push(escapeHtml(meta.name));
    if (meta.sector) companyParts.push(sectorLabel(meta.sector));
    if (meta.floor) companyParts.push(meta.floor);
    const companyLine = companyParts.length
      ? `<div class="an-company-line">${companyParts.join(" · ")}</div>`
      : "";
    const overboughtWarning = detectOverboughtTopping(r);
    const overboughtBanner = renderOverboughtBanner(overboughtWarning, r);
    return `
      ${overboughtBanner}
      <!-- Header card -->
      <div class="an-card full-width">
        <button class="watchlist-toggle ${inWatchlist ? 'active' : ''}" id="watchlist-toggle" data-symbol="${r.symbol}" title="${inWatchlist ? 'Bỏ khỏi watchlist' : 'Thêm vào watchlist'}">
          ${inWatchlist ? '★' : '☆'}
        </button>
        <button class="alert-setup-btn" id="alert-setup-btn" data-symbol="${r.symbol}" title="Đặt cảnh báo tự động">🔔</button>
        <div class="an-head">
          <div class="an-symbol">${r.symbol}</div>
          ${companyLine}
          <div class="an-price-row">
            <span class="an-price">${fp(r.current)}</span>
            <span class="pct ${changeClass}">${changeSign}${r.dayChange.toFixed(2)}%</span>
          </div>
        </div>
        ${renderVerdictBadge(r.score, r.flags, r.atrPct)}
        <div class="an-recommend-sub" style="color:${r.recColor}">${r.recommendation}</div>
        <div class="an-reasons">${r.reasons.map((x) => `• ${x}`).join("<br>") || "Không có tín hiệu rõ"}</div>
        ${buyZoneHtml}
        ${row("Stop loss", fp(r.stopLoss),
          "Mức giá cắt lỗ đề xuất: dựa trên max(2×ATR, hỗ trợ -3%). Nếu giá phá xuống, khả năng cao xu hướng đã thay đổi, nên thoát vị thế để hạn chế thua lỗ.",
          "color:#ff9800;font-weight:600")}
      </div>

      ${renderActionCard(r)}

      <!-- Chart -->
      <div class="an-card chart-card full-width">
        <div class="chart-head">
          <div class="an-title" style="margin-bottom:0">Biểu đồ giá</div>
          <div class="chart-range" id="chart-range">
            <button class="range-btn" data-res="W">Tuần</button>
            <button class="range-btn active" data-res="D">Ngày</button>
            <button class="range-btn" data-res="60">1h</button>
            <button class="range-btn" data-res="1">1p</button>
          </div>
        </div>
        <div class="chart-subhead">
          <div class="chart-legend">
            <span><span class="legend-dot" style="background:#00d2ff"></span>MA20</span>
            <span><span class="legend-dot" style="background:#ff9800"></span>MA50</span>
          </div>
          <div class="chart-status" id="chart-status"></div>
        </div>
        <div id="chart-container"></div>
      </div>

      <!-- Momentum -->
      <div class="an-card">
        <div class="an-title">Động lực & Momentum</div>
        ${row("RSI(14)",
          `${r.rsi !== null ? r.rsi.toFixed(1) : "--"} <small>(${r.rsiSignal})</small>`,
          "RSI (Relative Strength Index): đo tốc độ và mức độ thay đổi giá trong 14 phiên. <30 = quá bán (có thể hồi), >70 = quá mua (có thể điều chỉnh), 30-70 = trung tính.",
          `color:${rsiColor};font-weight:600`)}
        ${r.macd ? row("MACD",
          `${r.macd.macd.toFixed(2)} / ${r.macd.signal.toFixed(2)} <small>(${r.macd.hist >= 0 ? "+" : ""}${r.macd.hist.toFixed(2)})</small>`,
          "MACD (12,26,9): chênh lệch giữa 2 EMA. MACD cắt lên đường tín hiệu + histogram dương = tín hiệu mua. Ngược lại = tín hiệu bán.",
          `color:${r.macd.hist >= 0 ? "#4CAF50" : "#ff4444"};font-weight:600`) : ""}
        ${r.bb ? row("Bollinger",
          `${fp(r.bb.lower)} / ${fp(r.bb.middle)} / ${fp(r.bb.upper)}`,
          "Bollinger Bands (20, 2σ): giữa = SMA20, trên/dưới = ±2 độ lệch chuẩn. Giá chạm dải trên = quá mua. Chạm dải dưới = quá bán. Dải hẹp = biến động thấp, thường trước breakout.",
          "") : ""}
      </div>

      <!-- MA -->
      <div class="an-card">
        <div class="an-title">Đường trung bình</div>
        ${row("MA20", `${fp(r.ma20)} <small>(${signedPct(r.distMA20)})</small>`,
          "SMA 20 phiên: xu hướng ngắn hạn. Giá trên MA20 = tích cực ngắn hạn. Thường làm hỗ trợ/kháng cự động.", "")}
        ${row("MA50", `${fp(r.ma50)} <small>(${signedPct(r.distMA50)})</small>`,
          "SMA 50 phiên: xu hướng trung hạn. MA20 cắt lên MA50 = golden cross (bull). MA20 cắt xuống = death cross (bear).", "")}
        ${row("MA200", `${fp(r.ma200)} <small>(${signedPct(r.distMA200)})</small>`,
          "SMA 200 phiên: xu hướng dài hạn. Giá trên MA200 = thị trường bò dài hạn. Dưới = thị trường gấu. Chỉ báo được các quỹ lớn theo dõi sát.", "")}
        ${row("Xu hướng", `${trendIcon} ${r.trend}`,
          "Tổng hợp vị trí giá vs MA20/MA50. MA20 > MA50 và giá trên MA20 = xu hướng tăng mạnh nhất.", "")}
      </div>

      <!-- Secondary indicators -->
      <div class="an-card">
        <div class="an-title">Chỉ báo phụ</div>
        ${r.adx ? row("ADX(14)",
          `${r.adx.adx.toFixed(1)} <small>(+DI ${r.adx.plusDI.toFixed(0)} / -DI ${r.adx.minusDI.toFixed(0)})</small><br><small>${r.adxStrength}</small>`,
          "ADX (Average Directional Index): đo ĐỘ MẠNH của trend (không phải hướng). <20 = đi ngang, 20-25 = trend hình thành, 25-50 = trend mạnh, >50 = rất mạnh. +DI > -DI = trend tăng; ngược lại = trend giảm.",
          `color:${r.adx.adx >= 25 ? "#00d2ff" : "#888"};font-weight:600`) : ""}
        ${r.stoch ? row("Stochastic",
          `%K ${r.stoch.k.toFixed(0)} / %D ${r.stoch.d.toFixed(0)}`,
          "Stochastic (14,3): so sánh giá đóng cửa với range cao-thấp 14 phiên. <20 = quá bán, >80 = quá mua. %K cắt lên %D = mua; cắt xuống = bán. Nhạy hơn RSI với đảo chiều ngắn hạn.",
          `color:${r.stoch.k < 20 ? "#4CAF50" : r.stoch.k > 80 ? "#ff4444" : "#ccc"}`) : ""}
        ${r.mfi !== null ? row("MFI(14)", r.mfi.toFixed(1),
          "Money Flow Index: giống RSI nhưng có weight theo volume. <20 = dòng tiền rút ra mạnh (quá bán), >80 = dòng tiền đổ vào mạnh (quá mua). Bắt divergence tốt hơn RSI thuần.",
          `color:${r.mfi < 20 ? "#4CAF50" : r.mfi > 80 ? "#ff4444" : "#ccc"};font-weight:600`) : ""}
        ${r.atr ? row("ATR(14)", `${fp(r.atr)} <small>(${r.atrPct.toFixed(2)}% giá)</small>`,
          "ATR (Average True Range): biên độ dao động trung bình/phiên. Dùng để định vị stop loss phù hợp với biến động của mã. Thường stop loss = 2×ATR dưới entry.",
          "") : ""}
      </div>

      <!-- Foreign flow -->
      ${r.foreignFlow ? `
      <div class="an-card">
        <div class="an-title">Khối ngoại (Smart money)</div>
        ${row("Hôm nay", fmtFlow(r.foreignFlow.todayNet),
          "Giá trị mua/bán ròng khối ngoại phiên hôm nay. Xanh = NN mua ròng (tín hiệu tích cực), đỏ = bán ròng.", "")}
        ${row("5 phiên", fmtFlow(r.foreignFlow.sum5),
          "Tổng mua/bán ròng NN 5 phiên gần nhất. Phản ánh xu hướng ngắn hạn của dòng tiền NN.", "")}
        ${row("10 phiên", fmtFlow(r.foreignFlow.sum10),
          "Tổng mua/bán ròng NN 10 phiên. Khối ngoại là smart money trong TTCK VN — họ có thông tin tốt và vốn lớn, đáng theo dõi.", "")}
        ${row("20 phiên", fmtFlow(r.foreignFlow.sum20),
          "Tổng mua/bán ròng NN 20 phiên (~1 tháng). Phản ánh xu hướng gom/xả dài hạn hơn.", "")}
        ${row("Tần suất 10p",
          `<span class="flow-pos">${r.foreignFlow.positiveDays} mua</span> / <span class="flow-neg">${r.foreignFlow.negativeDays} bán</span>`,
          "Số phiên NN mua ròng vs bán ròng trong 10 phiên gần nhất. Xu hướng nhất quán (>=6/10) là tín hiệu mạnh hơn tổng net đơn thuần.", "")}
      </div>` : ""}

      <!-- Fundamentals -->
      ${r.fundamentals ? `
      <div class="an-card">
        <div class="an-title">Định giá cơ bản</div>
        ${r.fundamentals.pe ? row("P/E", `${r.fundamentals.pe.toFixed(2)}${peBadge(r.fundamentals.pe)}`,
          "Price to Earnings: thị giá / EPS. <10 (rẻ), 10-20 (hợp lý), >25 (đắt). So sánh P/E với ngành và lịch sử để đánh giá chính xác.", "") : ""}
        ${r.fundamentals.pb ? row("P/B", `${r.fundamentals.pb.toFixed(2)}${pbBadge(r.fundamentals.pb)}`,
          "Price to Book: thị giá / BVPS. <1 = dưới giá sổ sách, 1-3 = hợp lý, >3 = đắt. Ngành ngân hàng thường thấp hơn trung bình.", "") : ""}
        ${r.fundamentals.roe ? row("ROE",
          `${(r.fundamentals.roe * 100).toFixed(2)}% <span class="badge ${r.fundamentals.roe > 0.15 ? "badge-cheap" : r.fundamentals.roe > 0.1 ? "badge-fair" : "badge-exp"}">${r.fundamentals.roe > 0.15 ? "Tốt" : r.fundamentals.roe > 0.1 ? "OK" : "Yếu"}</span>`,
          "Return on Equity: lợi nhuận / vốn chủ sở hữu. Đo hiệu quả sinh lời trên vốn cổ đông. >15% = tốt, 10-15% = OK, <10% = yếu.", "") : ""}
        ${r.fundamentals.roa ? row("ROA", `${(r.fundamentals.roa * 100).toFixed(2)}%`,
          "Return on Assets: lợi nhuận / tổng tài sản. Đo hiệu quả sử dụng tài sản để sinh lời. So với ROE để đánh giá đòn bẩy.", "") : ""}
        ${r.fundamentals.eps ? row("EPS", `${r.fundamentals.eps.toLocaleString("vi-VN")} đ`,
          "Earnings per Share: lợi nhuận ròng / số cổ phiếu. EPS tăng qua các năm = doanh nghiệp tăng trưởng tốt.", "") : ""}
        ${r.fundamentals.bvps ? row("BVPS", `${r.fundamentals.bvps.toLocaleString("vi-VN")} đ`,
          "Book Value per Share: giá trị sổ sách / số cổ phiếu. Đại diện giá trị tài sản ròng mỗi CP.", "") : ""}
      </div>` : ""}

      <!-- Price zones & performance -->
      <div class="an-card">
        <div class="an-title">Vùng giá & Hiệu suất</div>
        ${row("Kháng cự", fp(r.resistance),
          "Vùng giá mà lực bán thường xuất hiện, ngăn giá tăng tiếp. Tính từ swing high gần nhất trên giá hiện tại (60 phiên).", "color:#ff4444;font-weight:600")}
        ${row("Hỗ trợ", fp(r.support),
          "Vùng giá mà lực mua thường xuất hiện, ngăn giá giảm tiếp. Tính từ swing low gần nhất dưới giá hiện tại (60 phiên).", "color:#4CAF50;font-weight:600")}
        ${row("Range 52w", `${fp(r.w52Low)} – ${fp(r.w52High)}`,
          "Mức giá thấp/cao nhất trong 52 tuần (~1 năm). Giúp đánh giá giá hiện tại đang rẻ hay đắt so với lịch sử gần.", "")}
        ${row("Vị trí 52w", `${r.posIn52w.toFixed(0)}%`,
          "Vị trí giá hiện tại trong dải 52w. 0% = đáy, 100% = đỉnh. <30% thường là vùng tích lũy, >80% là vùng phân phối.", "")}
        ${row("Volume", `${fmtVol(r.currentVol)} <small>(${r.volRatio.toFixed(1)}x TB20)</small>`,
          "Khối lượng giao dịch phiên hôm nay so với trung bình 20 phiên. >2x = bất thường (thường đi kèm tin). <0.5x = thanh khoản kém, tín hiệu kỹ thuật kém tin cậy.", "")}
        ${perfPills(r.performance)}
      </div>

      <!-- Text analysis -->
      <div class="an-card full-width">
        <div class="an-title">Phân tích chi tiết</div>
        <div class="text-analysis">${r.textAnalysis}</div>
      </div>

      <div class="disclaimer full-width">
        ⚠️ "Setup tốt/khá/yếu" là <b>chỉ báo chất lượng kỹ thuật</b>, KHÔNG phải tín hiệu mua/bán. Để chọn setup T+ chất lượng, dùng tab <b>Lướt sóng T+</b> với plan giao dịch cụ thể. Quyết định cuối cùng là của bạn.
      </div>
    `;
  }

  function clearAnalyzeContext() {
    analyzeContext = null;
    analyzeContextPick = null;
    analyzeContextRank = null;
  }

  // ── Settings modal ──
  async function openSettings() {
    const modal = $("settings-modal");
    const backdrop = $("settings-backdrop");
    const body = $("settings-body");
    if (!modal || !backdrop || !body) return;
    body.innerHTML = await renderSettingsBody();
    bindSettingsActions();
    backdrop.classList.add("open");
    modal.classList.add("open");
    document.body.style.overflow = "hidden";
  }

  function closeSettings() {
    const modal = $("settings-modal");
    const backdrop = $("settings-backdrop");
    if (!modal || !backdrop) return;
    backdrop.classList.remove("open");
    modal.classList.remove("open");
    document.body.style.overflow = "";
  }

  // ── Alert setup modal (per-symbol custom triggers) ──
  let alertModalSymbol = null;

  function openAlertModal(symbol) {
    if (!symbol) return;
    alertModalSymbol = symbol;
    const modal = $("alert-modal");
    const backdrop = $("alert-modal-backdrop");
    if (!modal || !backdrop) return;

    // Title
    const title = $("alert-modal-title");
    if (title) title.textContent = `🔔 Đặt cảnh báo · ${symbol}`;

    // Existing watch? prefill triggers
    const watches = loadTplusWatches();
    const existing = watches.find((w) => w.symbol === symbol && !w.dismissedByUser);

    const closeEnable = $("alert-close-enable");
    const closeValue = $("alert-close-value");
    const volEnable = $("alert-vol-enable");
    const volValue = $("alert-vol-value");
    const gapEnable = $("alert-gap-enable");
    const gapValue = $("alert-gap-value");
    const removeBtn = $("alert-remove-btn");

    // Reasonable defaults from current analysis context
    const r = lastAnalysisResult;
    const curPrice = r?.current || 0;
    const avgVol = r?.avgVol || (r?.currentVol && r?.volRatio ? r.currentVol / r.volRatio : 0);
    const defaultCloseTrigger = curPrice ? +(curPrice * 1.02).toFixed(2) : "";
    const defaultVolTrigger = avgVol ? Math.round((avgVol * 1.5) / 1000) : ""; // K shares
    const defaultGapTrigger = curPrice ? +(curPrice * 1.015).toFixed(2) : "";

    const t = existing?.triggers || {};
    closeEnable.checked = t.closeAbove != null;
    closeValue.value = t.closeAbove != null ? t.closeAbove : defaultCloseTrigger;
    closeValue.disabled = !closeEnable.checked;

    volEnable.checked = t.volAbove != null;
    // Store as K-shares in UI; convert to absolute shares on save
    volValue.value = t.volAbove != null ? Math.round(t.volAbove / 1000) : defaultVolTrigger;
    volValue.disabled = !volEnable.checked;

    gapEnable.checked = t.gapAbove != null;
    gapValue.value = t.gapAbove != null ? t.gapAbove : defaultGapTrigger;
    gapValue.disabled = !gapEnable.checked;

    removeBtn.style.display = existing ? "" : "none";

    bindAlertModal();
    updateAlertSummary();
    backdrop.classList.add("open");
    modal.classList.add("open");
    document.body.style.overflow = "hidden";
  }

  function closeAlertModal() {
    $("alert-modal")?.classList.remove("open");
    $("alert-modal-backdrop")?.classList.remove("open");
    document.body.style.overflow = "";
    alertModalSymbol = null;
  }

  function bindAlertModal() {
    const modal = $("alert-modal");
    if (!modal || modal.dataset.bound) return;
    modal.dataset.bound = "1";

    $("alert-modal-close")?.addEventListener("click", closeAlertModal);
    $("alert-modal-backdrop")?.addEventListener("click", closeAlertModal);
    $("alert-cancel")?.addEventListener("click", closeAlertModal);

    // Enable/disable input theo checkbox
    [
      ["alert-close-enable", "alert-close-value"],
      ["alert-vol-enable", "alert-vol-value"],
      ["alert-gap-enable", "alert-gap-value"],
    ].forEach(([cbId, inId]) => {
      const cb = $(cbId);
      const inp = $(inId);
      if (!cb || !inp) return;
      cb.addEventListener("change", () => {
        inp.disabled = !cb.checked;
        if (cb.checked) inp.focus();
        updateAlertSummary();
      });
      inp.addEventListener("input", updateAlertSummary);
    });

    $("alert-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      await saveAlertSetup();
    });

    $("alert-remove-btn")?.addEventListener("click", async () => {
      if (!alertModalSymbol) return;
      if (!confirm(`Xoá theo dõi ${alertModalSymbol}?`)) return;
      await removeTplusWatch(alertModalSymbol);
      notifyBrowser(`Đã xoá theo dõi ${alertModalSymbol}`, "Bot không gửi alert nữa.", "#999");
      closeAlertModal();
      if (lastAnalysisResult) renderAnalysis(lastAnalysisResult);
    });
  }

  function updateAlertSummary() {
    const summary = $("alert-form-summary");
    if (!summary) return;
    const triggers = collectAlertTriggers();
    const parts = [];
    if (triggers.closeAbove) parts.push(`giá đóng > <b>${fp(triggers.closeAbove)}</b>`);
    if (triggers.volAbove) parts.push(`khối lượng > <b>${fmtVol(triggers.volAbove)}</b>`);
    if (triggers.gapAbove) parts.push(`giá mở > <b>${fp(triggers.gapAbove)}</b>`);
    if (!parts.length) {
      summary.innerHTML = `<span style="color:#999">Bật ít nhất 1 trigger để lưu.</span>`;
      return;
    }
    summary.innerHTML = `Bot sẽ báo khi: ${parts.join(" <i>HOẶC</i> ")}`;
  }

  function collectAlertTriggers() {
    const triggers = {};
    if ($("alert-close-enable")?.checked) {
      const v = parseFloat($("alert-close-value")?.value);
      if (isFinite(v) && v > 0) triggers.closeAbove = v;
    }
    if ($("alert-vol-enable")?.checked) {
      const k = parseFloat($("alert-vol-value")?.value);
      if (isFinite(k) && k > 0) triggers.volAbove = k * 1000; // K shares → shares
    }
    if ($("alert-gap-enable")?.checked) {
      const v = parseFloat($("alert-gap-value")?.value);
      if (isFinite(v) && v > 0) triggers.gapAbove = v;
    }
    return triggers;
  }

  async function saveAlertSetup() {
    if (!alertModalSymbol) return;
    const triggers = collectAlertTriggers();
    if (!Object.keys(triggers).length) {
      alert("Bật ít nhất 1 trigger để lưu.");
      return;
    }
    // Request notification permission (silent if already granted/denied)
    if ("Notification" in window && Notification.permission === "default") {
      await Notification.requestPermission();
    }
    await addTplusWatch(alertModalSymbol, triggers);

    const auth = window.__SSI_AUTH__;
    const tip = auth?.isLoggedIn?.()
      ? "Đã sync Supabase — bot sẽ check mỗi 3 phút và gửi Telegram."
      : "Đăng nhập + kết nối Telegram để bot tự check khi đóng app.";
    notifyBrowser(`Đã đặt cảnh báo ${alertModalSymbol}`, tip, "#4CAF50");

    closeAlertModal();
    if (lastAnalysisResult) renderAnalysis(lastAnalysisResult);
  }

  async function renderSettingsBody() {
    const auth = window.__SSI_AUTH__;
    const loggedIn = auth?.isLoggedIn?.() || false;

    // Telegram status — read from cached connection if logged in
    const tgConnected = window.__SSI_TG_CACHE__ === true;
    const tgStatus = !loggedIn
      ? "Đăng nhập để dùng Telegram"
      : tgConnected
      ? "✅ Đã kết nối"
      : "❌ Chưa kết nối";

    // Notification permission
    const notifSupport = "Notification" in window;
    const notifPerm = notifSupport ? Notification.permission : "unsupported";
    const notifBadge = notifPerm === "granted" ? "✅ Đã cho phép"
      : notifPerm === "denied" ? "🚫 Bị chặn — bật trong cài đặt browser"
      : notifPerm === "default" ? "⚠️ Chưa bật"
      : "Không hỗ trợ";
    const showNotifBtn = notifPerm === "default";

    // Universe pref (chỉ còn full — DCA-58 đã removed)
    const uni = localStorage.getItem("snap_universe_pref") || "full";

    // Cache size estimate
    let cacheKeys = 0;
    let cacheBytes = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      cacheKeys++;
      cacheBytes += (localStorage.getItem(k) || "").length;
    }
    const cacheKb = (cacheBytes / 1024).toFixed(1);

    // App version (SW cache name) — read live from Cache Storage instead of hardcode
    let appVersion = "?";
    try {
      const keys = await caches.keys();
      const cacheKey = keys.find((k) => k.startsWith("stock-analyzer-v"));
      if (cacheKey) appVersion = cacheKey.replace("stock-analyzer-", "");
    } catch {}

    return `
      <section class="settings-section">
        <h3>📱 Telegram</h3>
        <div class="settings-row">
          <span class="settings-label">Trạng thái</span>
          <span class="settings-value">${tgStatus}</span>
        </div>
        <div class="settings-hint">Quản lý kết nối từ icon avatar (góc trên phải) → "Kết nối Telegram"</div>
      </section>

      <section class="settings-section">
        <h3>🔔 Thông báo browser</h3>
        <div class="settings-row">
          <span class="settings-label">Quyền notification</span>
          <span class="settings-value">${notifBadge}</span>
        </div>
        ${showNotifBtn
          ? `<button class="btn-primary" id="settings-enable-notif">Cho phép thông báo</button>`
          : ""}
        <div class="settings-hint">Cần để nhận trigger T+ khi mở app. Telegram bot không yêu cầu (bot tự gửi).</div>
      </section>

      <section class="settings-section">
        <h3>🗑️ Dữ liệu</h3>
        <div class="settings-row">
          <span class="settings-label">Cache</span>
          <span class="settings-value">${cacheKeys} keys · ${cacheKb} KB</span>
        </div>
        <div class="settings-button-grid">
          <button class="link-btn settings-btn" data-clear="history">Xóa lịch sử search</button>
          <button class="link-btn settings-btn" data-clear="picks">Xóa cache picks</button>
          <button class="link-btn settings-btn" data-clear="watchlist">Xóa watchlist + alerts</button>
          <button class="link-btn settings-btn" data-clear="tracker">Xóa lịch sử khuyến nghị</button>
          <button class="link-btn settings-btn settings-btn-danger" data-clear="all">⚠️ Xóa toàn bộ cache local</button>
        </div>
        <div class="settings-hint">Data trên Supabase (logged in) không bị xóa — chỉ cache browser.</div>
      </section>

      <section class="settings-section">
        <h3>ℹ️ App</h3>
        <div class="settings-row">
          <span class="settings-label">Phiên bản</span>
          <span class="settings-value">${appVersion}</span>
        </div>
        <button class="link-btn settings-btn" id="settings-force-reload">🔄 Force reload (clear SW cache)</button>
      </section>
    `;
  }

  function bindSettingsActions() {
    const body = $("settings-body");
    if (!body) return;

    const enableNotif = body.querySelector("#settings-enable-notif");
    if (enableNotif) {
      enableNotif.addEventListener("click", async () => {
        if ("Notification" in window) {
          await Notification.requestPermission();
          $("settings-body").innerHTML = renderSettingsBody();
          bindSettingsActions();
        }
      });
    }

    body.querySelectorAll("input[name='settings-uni']").forEach((radio) => {
      radio.addEventListener("change", (e) => {
        localStorage.setItem("snap_universe_pref", e.target.value);
      });
    });

    body.querySelectorAll("[data-clear]").forEach((btn) => {
      btn.addEventListener("click", () => handleSettingsClear(btn.dataset.clear));
    });

    const reloadBtn = body.querySelector("#settings-force-reload");
    if (reloadBtn) {
      reloadBtn.addEventListener("click", async () => {
        if (!confirm("Force reload: xóa SW cache + reload trang. Tiếp tục?")) return;
        try {
          if ("caches" in window) {
            const keys = await caches.keys();
            await Promise.all(keys.map((k) => caches.delete(k)));
          }
        } catch {}
        location.reload();
      });
    }
  }

  function handleSettingsClear(target) {
    let msg = "";
    let action = null;
    switch (target) {
      case "history":
        msg = "Xóa lịch sử search?";
        action = () => localStorage.removeItem("stock_analyzer_history");
        break;
      case "picks":
        msg = "Xóa cache top picks (sẽ fetch lại khi vào tab)?";
        action = () => {
          ["tplus_top_picks_v1", "vnindex_regime_v1", "market_snapshot_full_v1"].forEach((k) => localStorage.removeItem(k));
        };
        break;
      case "watchlist":
        msg = "Xóa watchlist + alerts khỏi browser? (Supabase data không bị xóa nếu đã đăng nhập)";
        action = () => {
          localStorage.removeItem("watchlist_v1");
          localStorage.removeItem("watchlist_data_v1");
          localStorage.removeItem("alerts_v1");
          localStorage.removeItem("alerts_state_v1");
        };
        break;
      case "tracker":
        msg = "Xóa toàn bộ lịch sử khuyến nghị T+?";
        action = () => RANKING.clearTracker?.();
        break;
      case "all":
        msg = "⚠️ XÓA TOÀN BỘ cache local? App sẽ về trạng thái mới (login session vẫn giữ).";
        action = () => {
          const keep = ["last_user_id", "ssi_migrated_v1"];
          const all = [];
          for (let i = 0; i < localStorage.length; i++) all.push(localStorage.key(i));
          all.forEach((k) => { if (k && !keep.includes(k)) localStorage.removeItem(k); });
        };
        break;
    }
    if (!msg || !action) return;
    if (!confirm(msg)) return;
    action();
    // Refresh modal to show updated cache stats
    $("settings-body").innerHTML = renderSettingsBody();
    bindSettingsActions();
    notifyBrowser?.("✅ Đã xóa", "Cache đã được xóa. Reload nếu cần.", "#4CAF50");
  }

  // ── Command palette (Cmd+K / Ctrl+K / "/") ──
  let cmdpSelectedIdx = 0;
  let cmdpResultsCache = [];

  function getCmdpStaticCommands() {
    const tg = window.__SSI_CONFIG__?.TELEGRAM_BOT_USERNAME;
    return [
      { id: "nav-home", label: "Đi đến Trang chủ", icon: "🏠", kind: "Tab", action: () => switchTab("home") },
      { id: "nav-analyze", label: "Mở Phân tích", icon: "📊", kind: "Tab", action: () => switchTab("analyze") },
      { id: "nav-ranking", label: "Mở Top picks", icon: "🏆", kind: "Tab", action: () => switchTab("ranking") },
      { id: "nav-portfolio", label: "Mở Danh mục", icon: "💼", kind: "Tab", action: () => switchTab("portfolio") },
      { id: "act-settings", label: "Mở Cài đặt", icon: "⚙️", kind: "Lệnh", action: () => openSettings() },
      { id: "act-bell", label: "Mở Cảnh báo", icon: "🔔", kind: "Lệnh", action: () => toggleAlertPanel(true) },
      ...(tg ? [{ id: "act-tg", label: `Mở bot Telegram @${tg}`, icon: "📱", kind: "Lệnh",
                 action: () => window.open(`https://t.me/${tg}`, "_blank") }] : []),
      { id: "act-reload", label: "Force reload (clear SW cache)", icon: "🔄", kind: "Lệnh", action: async () => {
        if (!confirm("Force reload?")) return;
        try { if ("caches" in window) (await caches.keys()).forEach((k) => caches.delete(k)); } catch {}
        location.reload();
      }},
    ];
  }

  function searchCmdp(query) {
    const q = query.trim();
    const qUpper = q.toUpperCase();
    const qLower = q.toLowerCase();
    const results = [];

    // Ticker matches (top priority)
    if (qUpper.length >= 1 && stockList.length > 0) {
      const tickerMatches = stockList
        .filter((s) => s.code.startsWith(qUpper) || s.name?.toLowerCase().includes(qLower))
        .slice(0, 5);
      for (const s of tickerMatches) {
        results.push({
          id: "ticker-" + s.code,
          label: `${s.code} · ${s.name || ""}`,
          icon: "📈",
          kind: "Mã",
          action: () => { switchTab("analyze"); clearAnalyzeContext(); analyzeSymbol(s.code); },
        });
      }
    }

    // Static commands
    const cmds = getCmdpStaticCommands();
    if (q === "") {
      // Default: all commands
      results.push(...cmds);
    } else {
      const matched = cmds.filter((c) => c.label.toLowerCase().includes(qLower));
      results.push(...matched);
    }

    return results.slice(0, 12);
  }

  function renderCmdpResults() {
    const list = $("cmdp-results");
    if (!list) return;
    if (cmdpResultsCache.length === 0) {
      list.innerHTML = `<div class="cmdp-empty">Không có kết quả. Thử mã CP hoặc "settings"...</div>`;
      return;
    }
    list.innerHTML = cmdpResultsCache.map((r, i) => `
      <div class="cmdp-row ${i === cmdpSelectedIdx ? 'cmdp-row-active' : ''}" data-idx="${i}">
        <span class="cmdp-row-icon">${r.icon}</span>
        <span class="cmdp-row-label">${r.label}</span>
        <span class="cmdp-row-kind">${r.kind}</span>
      </div>
    `).join("");
    // Scroll active into view
    const active = list.querySelector(".cmdp-row-active");
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  function openCmdp() {
    const cmdp = $("cmdp");
    const backdrop = $("cmdp-backdrop");
    const input = $("cmdp-input");
    if (!cmdp || !backdrop || !input) return;
    cmdp.classList.add("open");
    backdrop.classList.add("open");
    input.value = "";
    cmdpSelectedIdx = 0;
    cmdpResultsCache = searchCmdp("");
    renderCmdpResults();
    setTimeout(() => input.focus(), 30);
  }

  function closeCmdp() {
    const cmdp = $("cmdp");
    const backdrop = $("cmdp-backdrop");
    if (!cmdp || !backdrop) return;
    cmdp.classList.remove("open");
    backdrop.classList.remove("open");
  }

  function executeCmdpResult(idx) {
    const r = cmdpResultsCache[idx];
    if (!r) return;
    closeCmdp();
    setTimeout(() => r.action(), 50);
  }

  function renderVerdictBadge(score, flags, atrPct) {
    const v = getVerdict(score, flags, atrPct);
    if (!v) return "";
    const chipsHtml = renderRiskChips(flags);
    return `
      <div class="verdict-block">
        <div class="verdict-badge" style="background:${v.color}22;border-color:${v.color};color:${v.color}">
          ${v.icon} <b>${v.tag}</b> · <span class="verdict-desc">${v.desc}</span>
        </div>
        ${chipsHtml}
      </div>
    `;
  }


  // Event delegation: bind 1 lần trên document → bất kỳ .tplus-watch-btn nào
  // (cả button hiện tại lẫn future buttons sau re-render) đều work mà không
  // cần rebind. Fix bug: toggle off → re-render → button mới không có listener.
  let tplusWatchToggleInflight = false;
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest(".tplus-watch-btn");
    if (!btn) return;
    if (tplusWatchToggleInflight) return; // debounce double-click
    tplusWatchToggleInflight = true;
    try {
      const symbol = btn.dataset.symbol;
      if (!symbol) return;
      if (isTplusWatched(symbol)) {
        // Toggle off → re-render để switch khỏi live tracker mode
        await removeTplusWatch(symbol);
        if (lastAnalysisResult) renderAnalysis(lastAnalysisResult);
        return;
      }
      // Toggle on — request notification permission first
      if ("Notification" in window && Notification.permission === "default") {
        await Notification.requestPermission();
      }
      if ("Notification" in window && Notification.permission === "granted") {
        const triggers = {
          closeAbove: parseFloat(btn.dataset.closeTrigger) || null,
          volAbove: parseFloat(btn.dataset.volTrigger) || null,
          gapAbove: parseFloat(btn.dataset.gapTrigger) || null,
        };
        await addTplusWatch(symbol, triggers);
        const auth = window.__SSI_AUTH__;
        const tip = auth?.isLoggedIn?.()
          ? "Đã sync Supabase — sẽ báo qua Telegram nếu đã kết nối."
          : "Browser-only. Đăng nhập + kết nối Telegram để nhận push khi đóng app.";
        notifyBrowser(`Đã bật theo dõi ${symbol}`, tip, "#4CAF50");
        // Re-render để switch sang live tracker mode
        if (lastAnalysisResult) renderAnalysis(lastAnalysisResult);
      } else {
        alert("Cần cấp quyền notification để theo dõi trigger. Vào cài đặt browser bật notification cho trang này.");
      }
    } finally {
      tplusWatchToggleInflight = false;
    }
  });


  // ── Stock list caching + autocomplete ──
  async function ensureStockList() {
    try {
      const cached = localStorage.getItem(STOCK_LIST_KEY);
      const expiry = parseInt(localStorage.getItem(STOCK_LIST_EXPIRY_KEY) || "0", 10);
      if (cached && Date.now() < expiry) {
        stockList = JSON.parse(cached);
        return;
      }
    } catch (_) {}
    try {
      stockList = await ANALYSIS.fetchStockList();
      localStorage.setItem(STOCK_LIST_KEY, JSON.stringify(stockList));
      localStorage.setItem(STOCK_LIST_EXPIRY_KEY, String(Date.now() + STOCK_LIST_TTL));
    } catch (_) {
      // Offline or API down — suggestions simply won't appear
    }
  }

  // ── Stock metadata helpers ──
  const SECTOR_LABELS = {
    bank: "Ngân hàng",
    realestate: "Bất động sản",
    retail: "Bán lẻ / Tiêu dùng",
    industrial: "Công nghiệp / Thép",
    energy: "Năng lượng / Dầu khí",
    utility: "Tiện ích",
    tech: "Công nghệ",
    broker: "Chứng khoán",
    pharma: "Dược phẩm",
    food: "Thực phẩm",
    aviation: "Hàng không",
    other: "Khác",
  };

  function sectorLabel(sector) {
    if (!sector) return "";
    return SECTOR_LABELS[sector] || sector;
  }

  function getStockMeta(symbol) {
    if (!symbol) return null;
    const sym = symbol.toUpperCase();
    const found = stockList.find((s) => s.code === sym);
    const sector = (window.__SSI_RANKING__?.UNIVERSE || []).find((u) => u.code === sym)?.sector;
    return {
      code: sym,
      name: found?.name || "",
      floor: found?.floor || "",
      sector: sector || null,
    };
  }

  // Generic autocomplete attach (cho bất kỳ input nào)
  function attachAutocomplete(inputEl, onSelect) {
    if (!inputEl || inputEl.dataset.autocompleteBound) return;
    inputEl.dataset.autocompleteBound = "1";

    // Wrap input with relative container if not already
    const parent = inputEl.parentElement;
    if (parent && getComputedStyle(parent).position === "static") {
      parent.style.position = "relative";
    }

    const wrap = document.createElement("div");
    wrap.className = "suggestions ac-suggestions";
    parent.appendChild(wrap);

    let idx = -1;

    function render(list) {
      if (!list || list.length === 0) {
        wrap.classList.remove("show");
        wrap.innerHTML = "";
        idx = -1;
        return;
      }
      wrap.innerHTML = list
        .map((s, i) => `
          <div class="suggestion-item" data-code="${s.code}" data-idx="${i}">
            <span class="sugg-code">${s.code}</span>
            <span class="sugg-name">${escapeHtml(s.name || "")}</span>
            <span class="sugg-floor">${s.floor || ""}</span>
          </div>
        `).join("");
      wrap.classList.add("show");
      idx = -1;
    }

    function hide() {
      wrap.classList.remove("show");
      idx = -1;
    }

    inputEl.addEventListener("input", () => render(filterStocks(inputEl.value)));
    inputEl.addEventListener("focus", () => {
      if (inputEl.value.trim()) render(filterStocks(inputEl.value));
    });
    inputEl.addEventListener("keydown", (e) => {
      const items = wrap.querySelectorAll(".suggestion-item");
      if (e.key === "Escape") hide();
      else if (e.key === "ArrowDown" && items.length) {
        e.preventDefault();
        idx = Math.min(idx + 1, items.length - 1);
        items.forEach((el, i) => el.classList.toggle("active", i === idx));
      } else if (e.key === "ArrowUp" && items.length) {
        e.preventDefault();
        idx = Math.max(idx - 1, -1);
        items.forEach((el, i) => el.classList.toggle("active", i === idx));
      } else if (e.key === "Enter" && idx >= 0 && items[idx]) {
        e.preventDefault();
        const code = items[idx].dataset.code;
        inputEl.value = code;
        hide();
        onSelect?.(code);
      }
    });

    wrap.addEventListener("click", (e) => {
      const item = e.target.closest(".suggestion-item");
      if (!item) return;
      inputEl.value = item.dataset.code;
      hide();
      onSelect?.(item.dataset.code);
    });

    document.addEventListener("click", (e) => {
      if (!wrap.contains(e.target) && e.target !== inputEl) hide();
    });
  }

  function filterStocks(query) {
    query = query.trim().toUpperCase();
    if (!query || stockList.length === 0) return [];
    const qLower = query.toLowerCase();
    const prefix = [];
    const contains = [];
    const byName = [];
    for (const s of stockList) {
      if (s.code.startsWith(query)) {
        prefix.push(s);
      } else if (s.code.includes(query)) {
        contains.push(s);
      } else if (s.name && s.name.toLowerCase().includes(qLower)) {
        byName.push(s);
      }
      if (prefix.length >= SUGGEST_MAX) break;
    }
    return [...prefix, ...contains, ...byName].slice(0, SUGGEST_MAX);
  }

  let suggestIndex = -1;
  const suggestionsEl = $("suggestions");

  function renderSuggestions(list) {
    if (list.length === 0) {
      suggestionsEl.classList.remove("show");
      suggestionsEl.innerHTML = "";
      suggestIndex = -1;
      return;
    }
    suggestionsEl.innerHTML = list.map((s, i) => `
      <div class="suggestion-item" data-code="${s.code}" data-idx="${i}">
        <span class="sugg-code">${s.code}</span>
        <span class="sugg-name">${escapeHtml(s.name)}</span>
        <span class="sugg-floor">${s.floor}</span>
      </div>
    `).join("");
    suggestionsEl.classList.add("show");
    suggestIndex = -1;
  }

  function hideSuggestions() {
    suggestionsEl.classList.remove("show");
    suggestIndex = -1;
  }

  function updateSuggestHighlight() {
    const items = suggestionsEl.querySelectorAll(".suggestion-item");
    items.forEach((el, i) => el.classList.toggle("active", i === suggestIndex));
    if (suggestIndex >= 0 && items[suggestIndex]) {
      items[suggestIndex].scrollIntoView({ block: "nearest" });
    }
  }

  // ── Event listeners ──
  const input = $("symbol-input");

  input.addEventListener("input", () => {
    renderSuggestions(filterStocks(input.value));
  });

  input.addEventListener("focus", () => {
    if (input.value.trim()) renderSuggestions(filterStocks(input.value));
  });

  input.addEventListener("keydown", (e) => {
    const isShowing = suggestionsEl.classList.contains("show");
    const items = suggestionsEl.querySelectorAll(".suggestion-item");

    if (e.key === "ArrowDown" && isShowing) {
      e.preventDefault();
      suggestIndex = Math.min(suggestIndex + 1, items.length - 1);
      updateSuggestHighlight();
    } else if (e.key === "ArrowUp" && isShowing) {
      e.preventDefault();
      suggestIndex = Math.max(suggestIndex - 1, -1);
      updateSuggestHighlight();
    } else if (e.key === "Enter") {
      if (isShowing && suggestIndex >= 0 && items[suggestIndex]) {
        const code = items[suggestIndex].dataset.code;
        input.value = code;
        hideSuggestions();
        input.blur();
        clearAnalyzeContext();
        analyzeSymbol(code);
      } else {
        input.blur();
        hideSuggestions();
        clearAnalyzeContext();
        analyzeSymbol(input.value);
      }
    } else if (e.key === "Escape") {
      hideSuggestions();
    }
  });

  suggestionsEl.addEventListener("click", (e) => {
    const item = e.target.closest(".suggestion-item");
    if (!item) return;
    const code = item.dataset.code;
    input.value = code;
    hideSuggestions();
    input.blur();
    clearAnalyzeContext();
    analyzeSymbol(code);
  });

  // Hide when tapping outside
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-input-wrap")) hideSuggestions();
  });

  $("search-btn").addEventListener("click", () => {
    hideSuggestions();
    clearAnalyzeContext();
    analyzeSymbol(input.value);
  });

  // Reload button — re-analyze current symbol (fresh fetch)
  $("analyze-reload-btn")?.addEventListener("click", async () => {
    if (!currentSymbol) return;
    const btn = $("analyze-reload-btn");
    btn.disabled = true;
    btn.classList.add("spinning");
    try {
      await analyzeSymbol(currentSymbol);
    } finally {
      btn.disabled = false;
      btn.classList.remove("spinning");
    }
  });

  // Delegate chip clicks
  document.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (chip && chip.dataset.symbol) {
      input.value = chip.dataset.symbol;
      hideSuggestions();
      clearAnalyzeContext();
      analyzeSymbol(chip.dataset.symbol);
    }
  });

  $("clear-history").addEventListener("click", clearHistory);

  // ════════════════════════════════════════════════════
  // ── TAB NAVIGATION ──
  // ════════════════════════════════════════════════════
  const RANKING = window.__SSI_RANKING__;
  let currentTab = "ranking"; // mặc định Lướt sóng T+ — fast access

  function switchTab(tab) {
    if (tab === currentTab) return;
    currentTab = tab;
    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
    document.querySelectorAll(".tab-content").forEach((el) => {
      el.classList.toggle("active", el.classList.contains("tab-" + tab));
    });
    // Portfolio auto-refresh: chỉ chạy khi tab Danh mục active
    if (tab === "portfolio") startPortfolioAutoRefresh();
    else stopPortfolioAutoRefresh();
    // Performance tab: render fresh data
    if (tab === "perf") renderPerfTab();
  }

  // Auto-refresh portfolio mỗi 60s khi tab active. Pause khi tab ẩn/đổi tab khác.
  let portfolioRefreshTimer = null;
  function startPortfolioAutoRefresh() {
    stopPortfolioAutoRefresh();
    portfolioRefreshTimer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (currentTab !== "portfolio") return;
      // Bust analysis cache so re-fetch giá hiện tại
      Object.keys(portfolioAnalysisCache).forEach((k) => delete portfolioAnalysisCache[k]);
      renderPortfolio().catch(() => {});
    }, 60000);
  }
  function stopPortfolioAutoRefresh() {
    if (portfolioRefreshTimer) {
      clearInterval(portfolioRefreshTimer);
      portfolioRefreshTimer = null;
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && currentTab === "portfolio") {
      startPortfolioAutoRefresh();
    } else {
      stopPortfolioAutoRefresh();
    }
  });

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  // Swipe gesture removed per user request — đôi khi vô tình chuyển tab khi
  // scroll trong card/list. Tab navigation chỉ qua tab buttons.

  // ════════════════════════════════════════════════════
  // ── MARKET REGIME WIDGET ──
  // ════════════════════════════════════════════════════
  async function loadMarketRegime() {
    const widget = $("regime-widget");
    if (!widget) return;
    try {
      const r = await RANKING.getMarketRegime();
      if (!r) return;
      widget.style.display = "block";
      widget.style.borderLeftColor = r.color;

      $("regime-icon").textContent =
        r.regime === "BULL" ? "📈"
          : r.regime === "BEAR" ? "📉"
          : r.regime === "BULL_WEAK" ? "↗"
          : r.regime === "BEAR_WEAK" ? "↘"
          : "↔";

      $("regime-value").textContent = r.currentValue.toLocaleString("vi-VN", { maximumFractionDigits: 2 });

      const dayChangeEl = $("regime-day-change");
      const sign = r.dayChange >= 0 ? "+" : "";
      dayChangeEl.textContent = `${sign}${r.dayChange.toFixed(2)}%`;
      dayChangeEl.className = `pct ${r.dayChange >= 0 ? "up" : "down"}`;

      const tagEl = $("regime-tag");
      tagEl.textContent = r.label;
      tagEl.style.color = r.color;
      tagEl.style.background = `${r.color}22`;
      tagEl.style.borderColor = `${r.color}55`;

      const ret3mSign = r.ret3m >= 0 ? "+" : "";
      const distSign = r.distMa200 >= 0 ? "+" : "";
      $("regime-detail").innerHTML =
        `MA200: <b>${distSign}${r.distMa200.toFixed(1)}%</b> · ` +
        `3 tháng: <b>${ret3mSign}${r.ret3m.toFixed(1)}%</b> · ` +
        `Volatility: <b>${r.atrPct.toFixed(2)}%</b>`;
    } catch {
      // silent fail
    }
  }
  loadMarketRegime();

  // ════════════════════════════════════════════════════
  // ── AUTH (Supabase) ──
  // ════════════════════════════════════════════════════
  const AUTH = window.__SSI_AUTH__;

  function renderAuthUI() {
    const btn = $("auth-btn");
    const dropdown = $("auth-dropdown");
    if (!btn) return;

    if (!AUTH || !AUTH.isConfigured()) {
      btn.style.display = "none";
      return;
    }

    if (AUTH.isLoggedIn()) {
      const user = AUTH.getUser();
      const meta = user?.user_metadata || {};
      const avatar = meta.avatar_url;
      const name = meta.full_name || meta.name || user.email?.split("@")[0] || "User";
      const email = user.email || "";

      btn.classList.add("logged-in");
      btn.innerHTML = avatar
        ? `<img src="${avatar}" class="auth-avatar-img" alt="${name}">`
        : `<span class="auth-avatar-letter">${name[0].toUpperCase()}</span>`;
      btn.title = name;

      // Fill dropdown
      const av = $("auth-avatar");
      if (av) {
        if (avatar) {
          av.style.backgroundImage = `url(${avatar})`;
          av.textContent = "";
        } else {
          av.style.backgroundImage = "";
          av.textContent = name[0].toUpperCase();
        }
      }
      const nameEl = $("auth-name");
      const emailEl = $("auth-email");
      if (nameEl) nameEl.textContent = name;
      if (emailEl) emailEl.textContent = email;
      // Refresh Telegram connection status
      refreshTelegramStatus();
    } else {
      btn.classList.remove("logged-in");
      btn.innerHTML = `<span class="auth-text">Đăng nhập</span>`;
      btn.title = "Đăng nhập";
      if (dropdown) dropdown.classList.remove("open");
    }
  }

  // Bind auth UI
  if (AUTH) {
    const authBtn = $("auth-btn");
    if (authBtn) {
      authBtn.addEventListener("click", () => {
        if (!AUTH.isConfigured()) {
          alert("Chưa cấu hình Supabase. Đọc supabase-setup.md để setup.");
          return;
        }
        if (AUTH.isLoggedIn()) {
          // Toggle dropdown
          const dd = $("auth-dropdown");
          if (dd) dd.classList.toggle("open");
        } else {
          AUTH.signInWithGoogle();
        }
      });
    }

    const signoutBtn = $("auth-signout");
    if (signoutBtn) {
      signoutBtn.addEventListener("click", async () => {
        await AUTH.signOut();
        const dd = $("auth-dropdown");
        if (dd) dd.classList.remove("open");
        renderAuthUI();
      });
    }

    const settingsBtn = $("auth-settings");
    if (settingsBtn) {
      settingsBtn.addEventListener("click", () => {
        const dd = $("auth-dropdown");
        if (dd) dd.classList.remove("open");
        openSettings();
      });
    }

    // Close dropdown on outside click
    document.addEventListener("click", (e) => {
      const dd = $("auth-dropdown");
      const btn = $("auth-btn");
      if (!dd || !btn) return;
      if (dd.classList.contains("open") &&
          !dd.contains(e.target) && !btn.contains(e.target)) {
        dd.classList.remove("open");
      }
    });

    // Listen auth state — handle login/logout sync
    AUTH.onAuthChange(async (event, session) => {
      console.log("[auth] state change:", event, session?.user?.email);
      renderAuthUI();
      if (event === "SIGNED_IN" && session?.user) {
        await onUserLoggedIn(session.user);
      } else if (event === "SIGNED_OUT") {
        onUserLoggedOut();
      }
    });

    // Initialize — also handle case khi đã login (refresh page)
    AUTH.init().then(async (session) => {
      renderAuthUI();
      if (session?.user) {
        await onUserLoggedIn(session.user, /*silent*/true);
      }
    });
  } else {
    renderAuthUI();
  }

  const LAST_USER_KEY = "ssi_last_user_id";

  async function onUserLoggedIn(user, silent = false) {
    const userId = user.id;
    const lastUser = localStorage.getItem(LAST_USER_KEY);

    if (lastUser !== userId) {
      // Different user → clear local user data trước khi pull
      console.log("[auth] new user, clearing local data");
      localStorage.removeItem("user_watchlist_v1");
      localStorage.removeItem("watchlist_data_v1");
      localStorage.removeItem("alerts_log_v1");
      localStorage.removeItem("alerts_state_v1");
      localStorage.removeItem("paper_tracker_v1");
      localStorage.removeItem("portfolio_tx_v1");
      localStorage.removeItem("portfolio_cash_v1");
    }
    localStorage.setItem(LAST_USER_KEY, userId);

    // Phase 1: pull DB → local
    await Promise.all([
      RANKING.syncWatchlistFromDB(),
      RANKING.syncAlertsFromDB(),
      RANKING.syncAlertStateFromDB(),
      RANKING.syncTrackerFromDB(),
      window.__SSI_PORTFOLIO__?.syncTransactionsFromDB(),
      window.__SSI_PORTFOLIO__?.syncCashFromDB(),
    ]);

    // Phase 2: migrate any local-only data → DB (case: user was guest with data)
    // Note: chỉ migrate nếu DB còn empty cho từng table
    // (đơn giản: just attempt migrate, DB unique constraints prevent dupes)
    // We use a flag to migrate ONCE per user
    const MIGRATED_KEY = `ssi_migrated_${userId}`;
    if (!localStorage.getItem(MIGRATED_KEY)) {
      console.log("[auth] first login for this user, migrating local → DB");
      await Promise.all([
        RANKING.migrateWatchlistToDB(),
        RANKING.migrateAlertsToDB(),
        RANKING.migrateAlertStateToDB(),
        RANKING.migrateTrackerToDB(),
        window.__SSI_PORTFOLIO__?.migrateTransactionsToDB(),
        window.__SSI_PORTFOLIO__?.migrateCashToDB(),
      ]);
      // Re-sync after migration để pickup migrated data với DB-assigned IDs
      await Promise.all([
        RANKING.syncWatchlistFromDB(),
        RANKING.syncAlertsFromDB(),
        RANKING.syncTrackerFromDB(),
        window.__SSI_PORTFOLIO__?.syncTransactionsFromDB(),
      ]);
      localStorage.setItem(MIGRATED_KEY, "1");
    }

    // Re-render UI
    updateBellBadge();
    if (currentTab === "home") renderHome();
    if (currentTab === "ranking") renderTrackerSection();
  }

  function onUserLoggedOut() {
    // Giữ local data — guest mode tiếp tục dùng. Re-render để clear UI state.
    updateBellBadge();
    if (currentTab === "home") renderHome();
  }

  // ════════════════════════════════════════════════════
  // ── ALERT SYSTEM ──
  // ════════════════════════════════════════════════════
  function updateBellBadge() {
    const count = RANKING.unreadAlertCount();
    const badge = $("bell-badge");
    if (!badge) return;
    if (count > 0) {
      badge.textContent = count > 9 ? "9+" : count;
      badge.style.display = "inline-flex";
    } else {
      badge.style.display = "none";
    }
  }

  function renderAlertPanel() {
    const body = $("alert-panel-body");
    if (!body) return;
    const alerts = RANKING.loadAlerts().slice().reverse(); // newest first

    if (alerts.length === 0) {
      body.innerHTML = `<div class="alert-empty">Chưa có cảnh báo nào. Watchlist sẽ tự check khi mày mở app.</div>`;
      return;
    }
    body.innerHTML = alerts.map((a) => `
      <div class="alert-row ${a.seen ? '' : 'unread'}" data-symbol="${a.symbol}" style="border-left-color: ${a.color}">
        <div class="alert-row-head">
          <span class="alert-row-title">${a.title}</span>
          <span class="alert-row-time">${fmtTimeShort(a.timestamp)}</span>
        </div>
        <div class="alert-row-msg">${a.message}</div>
      </div>
    `).join("");

    body.querySelectorAll(".alert-row").forEach((row) => {
      row.addEventListener("click", () => {
        const sym = row.dataset.symbol;
        toggleAlertPanel(false);
        switchTab("analyze");
        const input = document.getElementById("symbol-input");
        if (input) input.value = sym;
        clearAnalyzeContext();
        analyzeSymbol(sym);
      });
    });

    // Show notification permission button if not granted
    const permBtn = $("alert-permission-btn");
    if (permBtn && "Notification" in window) {
      if (Notification.permission === "default") {
        permBtn.style.display = "inline";
      } else {
        permBtn.style.display = "none";
      }
    }
  }

  function toggleAlertPanel(force) {
    const panel = $("alert-panel");
    if (!panel) return;
    const open = force !== undefined ? force : !panel.classList.contains("open");
    panel.classList.toggle("open", open);
    if (open) {
      renderAlertPanel();
      RANKING.markAllAlertsSeen();
      updateBellBadge();
    }
  }

  // ── Telegram bot integration (Phase B) ──
  // Bot username: configured trong config.js (TELEGRAM_BOT_USERNAME)
  const TELEGRAM_BOT_USERNAME = window.__SSI_CONFIG__?.TELEGRAM_BOT_USERNAME || "stock_pwa_bot";

  async function loadTelegramConnection() {
    const auth = window.__SSI_AUTH__;
    if (!auth || !auth.isLoggedIn()) return null;
    const data = await auth.dbSelect("user_telegram").catch(() => null);
    return data && data.length > 0 ? data[0] : null;
  }

  async function generateTelegramLinkToken() {
    const auth = window.__SSI_AUTH__;
    if (!auth || !auth.isLoggedIn()) return null;
    // Generate UUID token, expire 10 min
    const token = crypto.randomUUID();
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    try {
      const result = await auth.dbUpsert("user_telegram", {
        link_token: token,
        link_token_expires_at: expires,
      }, { onConflict: "user_id" });
      if (result === null) {
        console.error("[telegram] gen token returned null — RLS or schema issue?");
        return null;
      }
      return token;
    } catch (e) {
      console.error("[telegram] gen token failed:", e);
      alert(`Không tạo được link token: ${e.message || e}\n\nKiểm tra:\n1. Đã run schema SQL chưa?\n2. Đã run schema-fix.sql (chat_id NULL)?`);
      return null;
    }
  }

  async function refreshTelegramStatus() {
    const labelEl = $("auth-telegram-label");
    const btnEl = $("auth-telegram-connect");
    const sectionEl = $("auth-telegram-section");
    if (!labelEl || !btnEl) return;

    const auth = window.__SSI_AUTH__;
    if (!auth || !auth.isLoggedIn()) {
      if (sectionEl) sectionEl.style.display = "none";
      return;
    }
    if (sectionEl) sectionEl.style.display = "";

    const conn = await loadTelegramConnection();
    if (conn && conn.chat_id) {
      labelEl.textContent = `Telegram: ✅ ${conn.username ? "@" + conn.username : "đã kết nối"}`;
      btnEl.textContent = "Ngắt kết nối";
      btnEl.dataset.action = "disconnect";
    } else {
      labelEl.textContent = "Telegram: chưa kết nối";
      btnEl.textContent = "Kết nối Telegram";
      btnEl.dataset.action = "connect";
    }
  }

  async function connectTelegram() {
    const auth = window.__SSI_AUTH__;
    if (!auth || !auth.isLoggedIn()) {
      alert("Cần đăng nhập trước.");
      return;
    }
    const token = await generateTelegramLinkToken();
    if (!token) {
      alert("Không tạo được link token. Thử lại sau.");
      return;
    }
    // Open Telegram bot với deep-link parameter
    const botUrl = `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${token}`;
    window.open(botUrl, "_blank");
    alert("📱 Mở bot Telegram, bấm Start. Quay lại đây sau ~5s rồi reload trang.");
  }

  async function disconnectTelegram() {
    const auth = window.__SSI_AUTH__;
    if (!auth || !auth.isLoggedIn()) return;
    if (!confirm("Ngắt kết nối Telegram? Sẽ không nhận notification trigger T+ nữa.")) return;
    const user = auth.getUser();
    if (user?.id) {
      await auth.dbDelete("user_telegram", { eq: { user_id: user.id } }).catch(() => {});
    }
    refreshTelegramStatus();
  }

  // Bind Telegram button (delegate vì auth-dropdown được render late)
  document.addEventListener("click", (e) => {
    if (e.target?.id === "auth-telegram-connect") {
      const action = e.target.dataset.action;
      if (action === "disconnect") disconnectTelegram();
      else connectTelegram();
    }
  });

  // ── T+ trigger watch (báo khi entry trigger met) ──
  const TPLUS_WATCH_KEY = "tplus_trigger_watches_v1";
  const TPLUS_WATCH_TTL_MS = 7 * 24 * 3600 * 1000; // 7 ngày

  function loadTplusWatches() {
    try {
      const arr = JSON.parse(localStorage.getItem(TPLUS_WATCH_KEY) || "[]");
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }

  function saveTplusWatches(arr) {
    try { localStorage.setItem(TPLUS_WATCH_KEY, JSON.stringify(arr)); } catch {}
  }

  async function addTplusWatch(symbol, triggers) {
    const watches = loadTplusWatches();
    const idx = watches.findIndex((w) => w.symbol === symbol);
    const watch = {
      symbol,
      addedAt: Date.now(),
      triggers,
      notified: false,
      notifiedAt: null,
      metCount: 0,
      lastNotifiedCount: 0,
      dismissedByUser: false,
    };
    if (idx >= 0) watches[idx] = watch;
    else watches.push(watch);
    saveTplusWatches(watches);

    // Sync to Supabase nếu logged in (cho cron worker check)
    const auth = window.__SSI_AUTH__;
    if (auth && auth.isLoggedIn()) {
      try {
        await auth.dbUpsert("tplus_watches", {
          symbol,
          triggers,
          notified: false,
          notified_at: null,
          met_count: 0,
          last_notified_count: 0,
          dismissed_by_user: false,
        }, { onConflict: "user_id,symbol" });
      } catch (e) {
        console.warn("[tplus_watch] sync DB add failed:", e);
      }
    }
  }

  // Manual unsubscribe: set dismissed_by_user=true (keep row for history).
  // Local: cũng đánh dấu dismissed thay vì xóa, để render đúng trong UI.
  async function removeTplusWatch(symbol) {
    const watches = loadTplusWatches();
    const idx = watches.findIndex((w) => w.symbol === symbol);
    if (idx >= 0) {
      // Filter out (local) — UI logic check via isTplusWatched only
      saveTplusWatches(watches.filter((w) => w.symbol !== symbol));
    }
    const auth = window.__SSI_AUTH__;
    if (auth && auth.isLoggedIn()) {
      try {
        // SET dismissed_by_user=true thay vì DELETE — keep history cho EOD digest + analytics
        await auth.dbUpdate("tplus_watches",
          { dismissed_by_user: true },
          { eq: { symbol } }
        );
      } catch (e) {
        console.warn("[tplus_watch] sync DB dismiss failed:", e);
      }
    }
  }

  function isTplusWatched(symbol) {
    const watches = loadTplusWatches();
    return watches.some((w) => w.symbol === symbol && !w.dismissedByUser);
  }

  // Run on home/T+ refresh — check triggers met → notify
  async function checkTplusTriggers() {
    const watches = loadTplusWatches();
    if (!watches.length) return;

    // Prune notified > 7 ngày
    const now = Date.now();
    const fresh = watches.filter((w) => !w.notified || (now - (w.notifiedAt || 0)) < TPLUS_WATCH_TTL_MS);
    if (fresh.length !== watches.length) {
      saveTplusWatches(fresh);
    }

    const unnotified = fresh.filter((w) => !w.notified);
    if (!unnotified.length) return;

    let changed = false;
    for (const w of unnotified) {
      try {
        const data = await ANALYSIS.fetchHistory(w.symbol, "D", 50);
        const closes = data.closes;
        const volumes = data.volumes;
        const n = closes.length;
        if (n < 2) continue;
        const cur = closes[n - 1];
        const curVol = volumes[n - 1];

        const t = w.triggers || {};
        const reasons = [];
        if (t.closeAbove && cur >= t.closeAbove) reasons.push(`close ${fp(cur)} ≥ ${fp(t.closeAbove)}`);
        if (t.volAbove && curVol >= t.volAbove) reasons.push(`vol ${fmtVol(curVol)} ≥ ${fmtVol(t.volAbove)}`);
        // Gap up: today open > previous close (proxy for "next session opened above")
        if (t.gapAbove && data.opens && data.opens[n - 1] > t.gapAbove) {
          reasons.push(`open ${fp(data.opens[n - 1])} > ${fp(t.gapAbove)} (gap up)`);
        }

        if (reasons.length > 0) {
          notifyBrowser(
            `🔔 ${w.symbol} T+ entry trigger`,
            `${reasons.join(" · ")}. Mở app để xem plan.`,
            "#4CAF50"
          );
          w.notified = true;
          w.notifiedAt = Date.now();
          changed = true;
        }
      } catch {}
    }
    if (changed) saveTplusWatches(fresh);
  }

  function notifyBrowser(title, body, color) {
    if (!("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    try {
      new Notification(title, {
        body,
        icon: "icons/icon-192.png",
        badge: "icons/icon-192.png",
        tag: title, // dedupe same title
      });
    } catch {}
  }

  async function checkWatchlistAlerts({ silent = false } = {}) {
    const list = RANKING.loadWatchlist();
    if (list.length === 0) return;
    try {
      // Fetch fresh data nếu cache hết hạn (30 phút)
      const data = await RANKING.fetchWatchlistData({ useCache: true });
      const newAlerts = RANKING.detectAlerts(data);
      updateBellBadge();
      // Show browser notification for each new alert (if permission)
      if (!silent) {
        newAlerts.forEach((a) => notifyBrowser(a.title, a.message, a.color));
      }
    } catch {}
  }

  // Bind bell button
  const bellBtn = $("bell-btn");
  if (bellBtn) bellBtn.addEventListener("click", () => toggleAlertPanel());
  const alertCloseBtn = $("alert-close-btn");
  if (alertCloseBtn) alertCloseBtn.addEventListener("click", () => toggleAlertPanel(false));
  const alertClearBtn = $("alert-clear-btn");
  if (alertClearBtn) {
    alertClearBtn.addEventListener("click", () => {
      if (!confirm("Xóa toàn bộ cảnh báo?")) return;
      RANKING.clearAlerts();
      renderAlertPanel();
      updateBellBadge();
    });
  }
  const alertPermBtn = $("alert-permission-btn");
  if (alertPermBtn) {
    alertPermBtn.addEventListener("click", async () => {
      if (!("Notification" in window)) return;
      const result = await Notification.requestPermission();
      if (result === "granted") {
        alertPermBtn.style.display = "none";
        notifyBrowser("Đã bật thông báo", "Bạn sẽ nhận cảnh báo cho watchlist", "#4CAF50");
      }
    });
  }

  // Initial badge
  updateBellBadge();
  // Check on app load (background)
  setTimeout(() => checkWatchlistAlerts({ silent: true }), 1500);

  // ════════════════════════════════════════════════════
  // ── HOME DASHBOARD ──
  // ════════════════════════════════════════════════════
  // Active T+ watches summary: total + met count today
  function getActiveWatchSummary() {
    let total = 0, hasOpenWatches = 0;
    try {
      const raw = localStorage.getItem("tplus_trigger_watches_v1");
      if (!raw) return { total: 0, hasOpenWatches: 0 };
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return { total: 0, hasOpenWatches: 0 };
      total = arr.length;
      hasOpenWatches = arr.filter((w) => !w.notified).length;
    } catch {}
    return { total, hasOpenWatches };
  }

  function getDaysToRebalance() {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return Math.ceil((next - now) / (24 * 3600 * 1000));
  }

  // Portfolio MTD return (rough, from cached analysis)
  // Daily Briefing narrative — như GPT-coach tóm tắt sáng.
  // Reads cached regime + activeClimaxPicks + portfolio holdings → composes story.
  function generateDailyBriefing(ctx) {
    const { regime, vniRet20, climaxPicks, momentumPicks, holdings, mtdReturn } = ctx;
    const sections = [];

    // Section 1: Market regime
    let marketPara;
    if (regime === "correction") {
      marketPara = `📊 VN-Index <b>${vniRet20.toFixed(1)}%</b> trong 20 phiên → đang <b class="db-tag-correction">correction</b>. ✅ <b>Climax Elite</b> regime ACTIVE — Win 61%, Sharpe 1.71 (backtest 8.5y).`;
    } else if (regime === "bull") {
      marketPara = `📊 VN-Index <b>+${vniRet20.toFixed(1)}%</b> trong 20 phiên → đang <b class="db-tag-bull">bull</b>. ⚠️ Climax pattern edge thấp (Win 28-35%). 🚀 <b>Momentum Swing</b> là strategy phù hợp.`;
    } else if (vniRet20 != null) {
      marketPara = `📊 VN-Index <b>${vniRet20 >= 0 ? "+" : ""}${vniRet20.toFixed(1)}%</b> trong 20 phiên → <b class="db-tag-neutral">neutral</b>. Climax pattern edge bình thường.`;
    } else {
      marketPara = `📊 Chưa có data VN-Index regime — bấm Scan để update.`;
    }
    sections.push(`<p class="db-section">${marketPara}</p>`);

    // Section 2: Signals
    const climaxCount = climaxPicks.length;
    const momentumCount = momentumPicks.length;
    let signalPara;
    if (climaxCount === 0 && momentumCount === 0) {
      signalPara = `🎯 <b>Không có signal hôm nay</b> — pattern hiếm (Climax ~0.8/day, Momentum ~0.8/day với universe 1411 mã). Ngày 0-1 match là bình thường.`;
    } else {
      const parts = [];
      if (climaxCount > 0) {
        const top = climaxPicks.slice(0, 3).map((p) => p.symbol).join(", ");
        const moreClimax = climaxCount > 3 ? ` +${climaxCount - 3}` : "";
        parts.push(`<b>${climaxCount} Climax</b> (${top}${moreClimax})`);
      }
      if (momentumCount > 0) {
        const top = momentumPicks.slice(0, 3).map((p) => p.symbol).join(", ");
        const moreMomentum = momentumCount > 3 ? ` +${momentumCount - 3}` : "";
        parts.push(`<b>${momentumCount} Momentum</b> (${top}${moreMomentum})`);
      }
      signalPara = `🎯 Hôm nay phát hiện ${parts.join(" + ")}.`;
    }
    sections.push(`<p class="db-section">${signalPara}</p>`);

    // Section 3: Portfolio
    let critical = [];
    let targetHit = [];
    if (holdings.length === 0) {
      sections.push(`<p class="db-section">💼 Chưa có danh mục — bắt đầu với 2-3 mã, size 10-15% NAV/lệnh để học pattern.</p>`);
    } else {
      critical = holdings.filter((h) => h.action?.priority === 1);
      targetHit = holdings.filter((h) => h.pnlPct >= 5);

      let portPara = `💼 Danh mục <b>${holdings.length} mã</b>`;
      if (mtdReturn != null) {
        portPara += `, MTD <b class="${mtdReturn >= 0 ? 'up' : 'down'}">${mtdReturn >= 0 ? "+" : ""}${mtdReturn.toFixed(1)}%</b>`;
      }
      portPara += `.`;

      const lines = [portPara];
      if (critical.length > 0) {
        const names = critical.map((h) => `<b>${h.symbol}</b> (${h.pnlPct.toFixed(1)}%)`).join(", ");
        lines.push(`🚨 <b class="db-tag-warn">${critical.length} sát/thủng SL</b>: ${names} → cần action`);
      }
      if (targetHit.length > 0) {
        const names = targetHit.map((h) => `<b>${h.symbol}</b> (+${h.pnlPct.toFixed(1)}%)`).join(", ");
        lines.push(`🎯 <b class="db-tag-target">${targetHit.length} hit TP</b>: ${names} → cân nhắc chốt`);
      }
      if (critical.length === 0 && targetHit.length === 0) {
        lines.push(`✅ Tất cả holdings ổn — hold theo plan, không action urgent.`);
      }
      sections.push(`<p class="db-section">${lines.join("<br>")}</p>`);
    }

    // Section 4: Recommendations (priority list)
    const recs = [];
    if (critical.length > 0) {
      const first = critical[0];
      recs.push(`Mở SSI iBoard → check <b>${first.symbol}</b> close ATC. Nếu thủng SL → đặt <b>Lệnh thường ATC bán</b> ngay.`);
    }
    if (climaxPicks.length > 0) {
      const p = climaxPicks[0];
      const entryMax = (p.entry_price * 1.02).toFixed(2);
      recs.push(`Sáng mai 8:00-8:45 → đặt <b>LO mua ${p.symbol}</b> giá ≤ ${entryMax} (Climax T+3-5, target ${p.target_price.toFixed(2)}).`);
    }
    if (momentumPicks.length > 0 && climaxPicks.length === 0) {
      const m = momentumPicks[0];
      const entryMax = (m.entry_price * 1.02).toFixed(2);
      recs.push(`Sáng mai 8:00-8:45 → đặt <b>LO mua ${m.symbol}</b> giá ≤ ${entryMax} (Momentum hold ~20 phiên, trailing 7%).`);
    }
    if (targetHit.length > 0 && critical.length === 0) {
      const first = targetHit[0];
      recs.push(`<b>${first.symbol}</b> đã +${first.pnlPct.toFixed(1)}% → cân nhắc <b>GTD bán</b> 1/2 chốt lời.`);
    }
    if (recs.length === 0 && climaxCount === 0 && momentumCount === 0 && holdings.length === 0) {
      recs.push(`Hôm nay không action gì. Đợi signal Telegram hoặc thị trường correction.`);
    }

    if (recs.length > 0) {
      sections.push(`<div class="db-recs"><div class="db-recs-title">📌 Ưu tiên hôm nay:</div><ol class="db-recs-list">${recs.map((r) => `<li>${r}</li>`).join("")}</ol></div>`);
    }

    return sections.join("");
  }

  // Compose context cho generateDailyBriefing từ state hiện tại.
  function buildBriefingContext() {
    // Regime + ret20
    let regime = "neutral";
    let vniRet20 = null;
    try {
      const cached = JSON.parse(localStorage.getItem("vnindex_regime_v1") || "null");
      if (cached?.data?.ret20 != null) {
        vniRet20 = cached.data.ret20;
        if (vniRet20 < -5) regime = "correction";
        else if (vniRet20 > 3) regime = "bull";
      }
    } catch {}

    // Active picks (từ Supabase via fetchActiveClimaxPicks)
    const climaxPicks = [];
    const momentumPicks = [];
    for (const p of activeClimaxPicks.values()) {
      if (p.tier === "Momentum") momentumPicks.push(p);
      else climaxPicks.push(p);
    }

    // Holdings + verdicts
    const holdingsRaw = window.__SSI_PORTFOLIO__?.currentHoldings?.() ?? [];
    const holdings = holdingsRaw.map((h) => {
      const ana = portfolioAnalysisCache[h.symbol];
      if (!ana) return { symbol: h.symbol, pnlPct: 0 };
      const cur = ana.current;
      const pnlPct = h.cost_basis > 0
        ? ((cur * h.qty - h.cost_basis) / h.cost_basis) * 100
        : 0;
      const inTplusTop = activeClimaxPicks.has(h.symbol);
      const action = window.__SSI_PORTFOLIO__?.recommendAction?.(h, ana, inTplusTop);
      return { symbol: h.symbol, pnlPct, rsi: ana.rsi, action };
    });

    return {
      regime,
      vniRet20,
      climaxPicks,
      momentumPicks,
      holdings,
      mtdReturn: getPortfolioMtdReturn(),
    };
  }

  function getPortfolioMtdReturn() {
    try {
      const pf = window.__SSI_PORTFOLIO__;
      if (!pf) return null;
      const holdings = pf.currentHoldings?.() ?? [];
      if (!holdings.length) return null;
      let totalCost = 0, totalNow = 0;
      for (const h of holdings) {
        const a = portfolioAnalysisCache[h.symbol];
        const curPrice = a?.current;
        if (!curPrice || !h.avgPrice) continue;
        totalCost += h.qty * h.avgPrice * 1000;
        totalNow += h.qty * curPrice * 1000;
      }
      if (totalCost === 0) return null;
      return ((totalNow - totalCost) / totalCost) * 100;
    } catch { return null; }
  }

  function renderMarketOutlookSection(outlook) {
    const l1 = outlook.l1;
    const l2 = outlook.l2;
    const l3 = outlook.l3;

    // Layer 1 — Index state
    const ret1mTxt = l1.ret1m != null ? `${l1.ret1m >= 0 ? "+" : ""}${l1.ret1m.toFixed(1)}%` : "--";
    const ret3mTxt = l1.ret3m != null ? `${l1.ret3m >= 0 ? "+" : ""}${l1.ret3m.toFixed(1)}%` : "--";
    const distMa200Txt = l1.distMa200 != null ? `${l1.distMa200 >= 0 ? "+" : ""}${l1.distMa200.toFixed(1)}%` : "--";
    const distMa50Txt = l1.distMa50 != null ? `${l1.distMa50 >= 0 ? "+" : ""}${l1.distMa50.toFixed(1)}%` : "--";
    const atrTxt = l1.atrPct != null ? `${l1.atrPct.toFixed(2)}%` : "--";
    const volLabel = l1.atrPct == null ? "--"
      : l1.atrPct >= 2.5 ? "cao"
      : l1.atrPct >= 1.5 ? "vừa" : "thấp";

    const l1Html = `
      <div class="mo-layer">
        <div class="mo-layer-title">🎯 VN-Index trạng thái</div>
        <div class="mo-row">
          <span class="mo-label">Trend:</span>
          <span class="mo-val" style="color:${l1.regimeColor}"><b>${l1.regimeLabel}</b></span>
          ${l1.ma50Above200 != null ? `<span class="mo-sub">· ${l1.ma50Above200 ? "MA50 > MA200 (uptrend cấu trúc)" : "MA50 ≤ MA200 (chưa xác nhận)"}</span>` : ""}
        </div>
        <div class="mo-row">
          <span class="mo-label">Distance MA:</span>
          <span class="mo-val">MA200 ${distMa200Txt} · MA50 ${distMa50Txt}</span>
        </div>
        <div class="mo-row">
          <span class="mo-label">Return:</span>
          <span class="mo-val">1M ${ret1mTxt} · 3M ${ret3mTxt}</span>
        </div>
        <div class="mo-row">
          <span class="mo-label">Volatility:</span>
          <span class="mo-val">ATR ${atrTxt} (${volLabel})</span>
        </div>
      </div>
    `;

    // Layer 2 — Breadth proxy
    let l2Html = "";
    if (l2.tplusEligible != null && l2.tplusTotal != null) {
      const ratio = l2.tplusTotal > 0 ? (l2.tplusEligible / l2.tplusTotal) * 100 : 0;
      const ageTxt = l2.tplusAge != null ? `${l2.tplusAge} phút trước` : "lâu rồi";
      l2Html = `
        <div class="mo-layer">
          <div class="mo-layer-title">📈 Breadth (sức khỏe rộng)</div>
          <div class="mo-row">
            <span class="mo-label">Setup T+ confluence:</span>
            <span class="mo-val"><b>${l2.tplusEligible}/${l2.tplusTotal}</b> mã (${ratio.toFixed(1)}%)</span>
          </div>
          <div class="mo-row mo-sub-row">
            <span class="mo-sub">Cập nhật: ${ageTxt}</span>
          </div>
        </div>
      `;
    } else {
      l2Html = `
        <div class="mo-layer">
          <div class="mo-layer-title">📈 Breadth (sức khỏe rộng)</div>
          <div class="mo-row mo-empty">Chưa có data — vào tab Lướt sóng T+ → bấm ↻ để quét.</div>
        </div>
      `;
    }

    // Layer 3 — Money flow + Sector
    let l3Html = "";
    if (l3.sectorBreakdown && l3.sectorBreakdown.length > 0) {
      const sectorTxt = l3.sectorBreakdown
        .map((s) => `<span class="mo-sector-tag">${sectorLabel(s.sector)} (${s.count})</span>`)
        .join("");
      const bullishPct = (l3.bullishPicksRatio * 100).toFixed(0);
      const avgDayChg = l3.avgDayChange != null ? `${l3.avgDayChange >= 0 ? "+" : ""}${l3.avgDayChange.toFixed(2)}%` : "--";
      const flagAct = l3.flagActivation || {};
      const flagsLine = (flagAct.bearTrap || flagAct.sellPressure || flagAct.lowSessionLiq)
        ? `<div class="mo-row mo-sub-row"><span class="mo-sub">Risk flags: bearTrap ${flagAct.bearTrap || 0} · sellPressure ${flagAct.sellPressure || 0} · kẹt hàng ${flagAct.lowSessionLiq || 0}</span></div>`
        : "";
      l3Html = `
        <div class="mo-layer">
          <div class="mo-layer-title">💰 Money flow & Sector</div>
          <div class="mo-row">
            <span class="mo-label">Top sector (T+):</span>
            <span class="mo-sector-tags">${sectorTxt}</span>
          </div>
          <div class="mo-row">
            <span class="mo-label">Picks tăng:</span>
            <span class="mo-val">${bullishPct}% picks tăng giá hôm nay · avg ${avgDayChg}</span>
          </div>
          ${flagsLine}
        </div>
      `;
    } else {
      l3Html = `
        <div class="mo-layer">
          <div class="mo-layer-title">💰 Money flow & Sector</div>
          <div class="mo-row mo-empty">Chưa có data — load Top picks T+ để có insight.</div>
        </div>
      `;
    }

    // Layer 4 — Tactical hint
    const l4Html = `
      <div class="mo-layer mo-hint-layer">
        <div class="mo-layer-title">🎯 Hint hôm nay</div>
        <div class="mo-hint">${outlook.hint}</div>
      </div>
    `;

    return `
      <div class="home-card mo-card">
        <div class="home-card-title">📊 Nhận định thị trường</div>
        ${l1Html}
        ${l2Html}
        ${l3Html}
        ${l4Html}
        <div class="mo-disclaimer">⚠️ Đây là tổng hợp tín hiệu kỹ thuật — không phải lời khuyên đầu tư.</div>
      </div>
    `;
  }

  // ── Sector detail modal (deep dive) ──
  let sectorModalCurrent = null;
  function openSectorDetail(sectorKey, snapshot) {
    sectorModalCurrent = { sectorKey, snapshot };
    const modal = $("sector-modal");
    const backdrop = $("sector-modal-backdrop");
    if (!modal || !backdrop) return;
    bindSectorModal();
    renderSectorDetailBody(sectorKey, snapshot);
    modal.classList.add("open");
    backdrop.classList.add("open");
  }

  function closeSectorModal() {
    $("sector-modal")?.classList.remove("open");
    $("sector-modal-backdrop")?.classList.remove("open");
    sectorModalCurrent = null;
  }

  function bindSectorModal() {
    const modal = $("sector-modal");
    if (!modal || modal.dataset.bound) return;
    modal.dataset.bound = "1";
    $("sector-modal-close")?.addEventListener("click", closeSectorModal);
    $("sector-modal-backdrop")?.addEventListener("click", closeSectorModal);
  }

  let sectorSortMode = "ret1w"; // ret1w | ret1m | dayChange | volRatio

  function renderSectorDetailBody(sectorKey, snapshot) {
    const body = $("sector-modal-body");
    const titleEl = $("sector-modal-title");
    if (!body || !snapshot) return;

    const stocksInSector = (snapshot.stocks || []).filter(
      (s) => !s.error && (s.sector || "khác") === sectorKey
    );

    titleEl.textContent = `${sectorLabel(sectorKey)} (${stocksInSector.length} mã)`;

    if (stocksInSector.length === 0) {
      body.innerHTML = `<div class="hd-section"><p>Không có mã trong sector này.</p></div>`;
      return;
    }

    // Sort
    const sorted = [...stocksInSector].sort((a, b) => {
      const av = a[sectorSortMode] ?? -Infinity;
      const bv = b[sectorSortMode] ?? -Infinity;
      return bv - av;
    });

    // Aggregate stats
    const valid1w = stocksInSector.filter((s) => s.ret1w != null);
    const valid1m = stocksInSector.filter((s) => s.ret1m != null);
    const avg1w = valid1w.length > 0 ? valid1w.reduce((s, x) => s + x.ret1w, 0) / valid1w.length : 0;
    const avg1m = valid1m.length > 0 ? valid1m.reduce((s, x) => s + x.ret1m, 0) / valid1m.length : 0;
    const avgDay = stocksInSector.reduce((s, x) => s + (x.dayChange || 0), 0) / stocksInSector.length;
    const upToday = stocksInSector.filter((s) => (s.dayChange || 0) > 0).length;

    const aggHtml = `
      <div class="hd-section">
        <div class="hd-section-title">📊 Sector summary</div>
        <div class="hd-pos-grid">
          <div><span class="hd-lbl">Avg today</span><span class="hd-val pct ${avgDay >= 0 ? "up" : "down"}">${avgDay >= 0 ? "+" : ""}${avgDay.toFixed(2)}%</span></div>
          <div><span class="hd-lbl">Avg 1W</span><span class="hd-val pct ${avg1w >= 0 ? "up" : "down"}">${avg1w >= 0 ? "+" : ""}${avg1w.toFixed(2)}%</span></div>
          <div><span class="hd-lbl">Avg 1M</span><span class="hd-val pct ${avg1m >= 0 ? "up" : "down"}">${avg1m >= 0 ? "+" : ""}${avg1m.toFixed(2)}%</span></div>
          <div><span class="hd-lbl">Tăng hôm nay</span><span class="hd-val">${upToday}/${stocksInSector.length}</span></div>
        </div>
      </div>
    `;

    const sortBtns = `
      <div class="sector-sort-bar">
        <span class="hd-lbl">Sort:</span>
        ${["ret1w", "ret1m", "dayChange", "volRatio"].map((k) => {
          const labels = { ret1w: "1W", ret1m: "1M", dayChange: "Today", volRatio: "Vol" };
          return `<button class="sector-sort-btn ${sectorSortMode === k ? "active" : ""}" data-sort="${k}">${labels[k]}</button>`;
        }).join("")}
      </div>
    `;

    const stockRows = sorted.map((s) => {
      const dayCls = (s.dayChange ?? 0) >= 0 ? "up" : "down";
      const daySign = (s.dayChange ?? 0) >= 0 ? "+" : "";
      const w1Cls = (s.ret1w ?? 0) >= 0 ? "up" : "down";
      const w1Sign = (s.ret1w ?? 0) >= 0 ? "+" : "";
      const m1Cls = (s.ret1m ?? 0) >= 0 ? "up" : "down";
      const m1Sign = (s.ret1m ?? 0) >= 0 ? "+" : "";
      const flagLabel = s.atHigh52w ? '<span class="sd-flag sd-flag-high">52W H</span>'
        : s.atLow52w ? '<span class="sd-flag sd-flag-low">52W L</span>'
        : "";
      return `
        <div class="sd-stock-row" data-symbol="${s.symbol}">
          <span class="sd-sym">${s.symbol}</span>
          <span class="sd-flag-cell">${flagLabel}</span>
          <span class="sd-price">${fp(s.close ?? 0)}</span>
          <span class="sd-day pct ${dayCls}">${daySign}${(s.dayChange ?? 0).toFixed(2)}%</span>
          <span class="sd-1w pct ${w1Cls}">${w1Sign}${(s.ret1w ?? 0).toFixed(1)}%</span>
          <span class="sd-1m pct ${m1Cls}">${m1Sign}${(s.ret1m ?? 0).toFixed(1)}%</span>
          <span class="sd-vol">${(s.volRatio || 0).toFixed(1)}×</span>
        </div>
      `;
    }).join("");

    const headerRow = `
      <div class="sd-stock-row sd-stock-header">
        <span class="sd-sym">Mã</span>
        <span class="sd-flag-cell"></span>
        <span class="sd-price">Giá</span>
        <span class="sd-day">Today</span>
        <span class="sd-1w">1W</span>
        <span class="sd-1m">1M</span>
        <span class="sd-vol">Vol</span>
      </div>
    `;

    body.innerHTML = `
      ${aggHtml}
      ${sortBtns}
      <div class="sd-stocks-list">
        ${headerRow}
        ${stockRows}
      </div>
    `;

    // Bind sort buttons
    body.querySelectorAll(".sector-sort-btn").forEach((b) => {
      b.addEventListener("click", () => {
        sectorSortMode = b.dataset.sort;
        renderSectorDetailBody(sectorKey, snapshot);
      });
    });

    // Bind stock rows
    body.querySelectorAll(".sd-stock-row[data-symbol]").forEach((row) => {
      row.addEventListener("click", () => {
        const sym = row.dataset.symbol;
        if (!sym) return;
        closeSectorModal();
        switchTab("analyze");
        const input = document.getElementById("symbol-input");
        if (input) input.value = sym;
        clearAnalyzeContext();
        analyzeSymbol(sym);
      });
    });
  }

  let _lastTplusCheck = 0;
  async function maybeCheckTplusTriggers() {
    const now = Date.now();
    if (now - _lastTplusCheck < 3 * 60 * 1000) return;
    _lastTplusCheck = now;
    checkTplusTriggers().catch(() => {});
  }

  async function renderHome() {
    const container = $("home-container");
    if (!container) return;

    // Defensive: set placeholder immediately so even if subsequent code throws,
    // user sees SOMETHING instead of blank screen.
    if (!container.innerHTML.trim()) {
      container.innerHTML = `<div class="loading"><div class="spinner"></div><div>Đang tải trang chủ…</div></div>`;
    }

    try {
      await renderHomeImpl(container);
    } catch (e) {
      console.error("[renderHome] fail:", e);
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">⚠️</div>
          <p><b>Lỗi tải Trang chủ</b></p>
          <p><small>${e?.message || e}</small></p>
          <button class="btn-primary" onclick="location.reload()">Reload app</button>
        </div>`;
    }
  }

  async function renderHomeImpl(container) {
    // Fetch active picks for briefing context (non-blocking — uses cache if fresh)
    fetchActiveClimaxPicks().catch(() => {});

    // 1. Greeting card (immediate)
    const greeting = getGreeting();
    const dateStr = fmtFullDate();

    // Get cached data (no fresh fetch on home)
    let regime = null;
    try {
      const cached = JSON.parse(localStorage.getItem("vnindex_regime_v1") || "null");
      regime = cached?.data || null;
    } catch {}

    let tplusCached = null;
    try {
      tplusCached = JSON.parse(localStorage.getItem("tplus_top_picks_v1") || "null")?.data;
    } catch {}

    const actions = buildTodayActions(regime, tplusCached?.eligibleCount || 0);

    const watchlist = RANKING.loadWatchlist();
    const watchlistCount = watchlist.length;

    // Compute market outlook (Layer 1+2+3+4)
    const outlook = computeMarketOutlook(regime, tplusCached);
    const outlookHtml = renderMarketOutlookSection(outlook);

    // Market snapshot section removed (loadMarketSnapshot stripped cùng Rà soát).
    const snapshotHtml = "";

    // Session info + personal stats for briefing
    const sess = getSessionInfo();
    const watchSummary = getActiveWatchSummary();
    const pfMtd = getPortfolioMtdReturn();

    const countdownLabel = sess.countdown != null
      ? (sess.countdown >= 60
          ? `${Math.floor(sess.countdown / 60)}h${String(sess.countdown % 60).padStart(2, "0")}`
          : `${sess.countdown}'`)
      : null;

    // VN-Index quick line từ regime cache
    let indexLine = "";
    if (regime && regime.currentValue != null) {
      const ret1m = regime.ret1m != null ? `${regime.ret1m >= 0 ? "+" : ""}${regime.ret1m.toFixed(1)}%` : "--";
      indexLine = `<div class="briefing-context">📊 VN-Index <b>${regime.currentValue.toLocaleString("vi-VN")}</b> · 1M ${ret1m} · <span style="color:${regime.color || '#aab'}">${regime.label || regime.regime || "?"}</span></div>`;
    }

    let html = `
      <div class="home-briefing">
        <div class="briefing-row1">
          <div>
            <div class="briefing-greet">${greeting}!</div>
            <div class="briefing-date">${dateStr}</div>
          </div>
          <button class="btn-icon home-reload-btn" id="home-reload-btn" title="Reload home — fetch fresh regime, snapshot, picks">↻</button>
          ${countdownLabel
            ? `<div class="briefing-session" style="background:${sess.color}22;color:${sess.color};border-color:${sess.color}55">
                 <span>${sess.icon}</span>
                 <span class="briefing-session-label">${sess.label}</span>
                 <b class="briefing-session-countdown">${countdownLabel}</b>
               </div>`
            : `<div class="briefing-session" style="background:${sess.color}22;color:${sess.color};border-color:${sess.color}55">
                 <span>${sess.icon}</span>
                 <span class="briefing-session-label">${sess.label}</span>
               </div>`}
        </div>
        ${indexLine}
        <div class="briefing-stats">
          <div class="briefing-stat ${watchSummary.hasOpenWatches > 0 ? 'stat-active' : ''}" data-target-tab="ranking">
            <div class="briefing-stat-val">${watchSummary.hasOpenWatches}<small> / ${watchSummary.total}</small></div>
            <div class="briefing-stat-label">🔔 Watch chờ trigger</div>
          </div>
          ${pfMtd != null
            ? `<div class="briefing-stat" data-target-tab="portfolio">
                 <div class="briefing-stat-val ${pfMtd >= 0 ? 'up' : 'down'}">${pfMtd >= 0 ? "+" : ""}${pfMtd.toFixed(1)}<small>%</small></div>
                 <div class="briefing-stat-label">💼 Portfolio P&amp;L</div>
               </div>`
            : `<div class="briefing-stat briefing-stat-muted" data-target-tab="portfolio">
                 <div class="briefing-stat-val">--</div>
                 <div class="briefing-stat-label">💼 Add holdings</div>
               </div>`}
        </div>
      </div>

      <!-- Daily Briefing — narrative tóm tắt sáng -->
      <div class="home-card home-briefing-card">
        <div class="home-card-title">📰 Briefing</div>
        <div class="daily-briefing">${generateDailyBriefing(buildBriefingContext())}</div>
      </div>

      <!-- Hôm nay nên làm -->
      <div class="home-card">
        <div class="home-card-title">📋 Hôm nay nên làm (rule-based)</div>
        <ul class="home-actions">
          ${actions.map((a) => `<li><span class="home-action-icon">${a.icon}</span><span>${a.text}</span></li>`).join("")}
        </ul>
      </div>

      <!-- VN-Index chart -->
      <div class="home-card vnindex-card">
        <div class="home-card-title">
          📈 VN-Index
          <div class="vnindex-range" id="vnindex-range">
            <button class="vni-range-btn" data-days="60">3M</button>
            <button class="vni-range-btn active" data-days="120">6M</button>
            <button class="vni-range-btn" data-days="250">1Y</button>
          </div>
        </div>
        <div id="vnindex-chart-container" class="vnindex-chart"></div>
      </div>

      ${outlookHtml}

      ${snapshotHtml}
    `;

    // Watchlist section
    if (watchlistCount > 0) {
      html += `
        <div class="home-card watchlist-card">
          <div class="home-card-title">
            ⭐ Watchlist (${watchlistCount} mã)
            <button class="home-card-action" id="watchlist-refresh-home" title="Cập nhật">↻</button>
          </div>
          <div id="home-watchlist-content">
            <div class="home-card-empty">Tap ↻ để load giá hiện tại</div>
          </div>
        </div>
      `;
    } else {
      html += `
        <div class="home-card">
          <div class="home-card-title">⭐ Watchlist</div>
          <div class="home-card-empty">Chưa có mã nào trong watchlist. Vào tab Phân tích → bấm ☆ để thêm.</div>
        </div>
      `;
    }

    // Active watches list (sub mới hoặc đã notified, chưa dismissed)
    const activeWatches = loadTplusWatches().filter((w) => !w.dismissedByUser);
    if (activeWatches.length > 0) {
      const rows = activeWatches.map((w) => {
        const subscribedAgo = w.addedAt
          ? Math.max(0, Math.floor((Date.now() - w.addedAt) / (24 * 3600 * 1000)))
          : null;
        const subStr = subscribedAgo === 0 ? "hôm nay" : subscribedAgo === 1 ? "hôm qua" : `${subscribedAgo}d trước`;
        const metCount = w.metCount || 0;
        const statusBadge = w.notified
          ? `<span class="watch-row-status watch-status-met">🎯 ${metCount}/3 met</span>`
          : `<span class="watch-row-status watch-status-pending">⏳ chờ</span>`;
        return `
          <div class="watch-row" data-symbol="${w.symbol}">
            <div class="watch-row-info">
              <span class="watch-row-sym">${w.symbol}</span>
              <span class="watch-row-sub">${subStr}</span>
              ${statusBadge}
            </div>
            <button class="watch-row-dismiss" data-dismiss-symbol="${w.symbol}" title="Bỏ theo dõi">✕</button>
          </div>
        `;
      }).join("");
      html += `
        <div class="home-card">
          <div class="home-card-title">🔔 Đang theo dõi T+ (${activeWatches.length})</div>
          <div class="watch-list">${rows}</div>
        </div>
      `;
    }

    // 5. Quick search
    html += `
      <div class="home-card home-card-clickable" data-target-tab="analyze" data-focus-search="1">
        <div class="home-card-title">🔍 Phân tích nhanh</div>
        <div class="home-card-empty">Tap để mở phân tích chi tiết 1 mã cổ phiếu.</div>
      </div>
    `;

    container.innerHTML = html;

    // Reload home — bust caches + re-fetch fresh data
    document.getElementById("home-reload-btn")?.addEventListener("click", async (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = "⟳";
      btn.classList.add("spinning");
      try {
        // Bust caches related to home
        ["vnindex_regime_v1", "market_snapshot_full_v1"].forEach((k) => localStorage.removeItem(k));
        activeClimaxPicksFetchedAt = 0;
        drawdownFetchedAt = 0;
        // Re-fetch + re-render
        await loadMarketRegime();
        await renderHome();
      } catch (err) {
        console.warn("[home-reload] fail:", err.message);
      }
    });

    // Bind clickable cards
    container.querySelectorAll(".home-card-clickable, .briefing-stat[data-target-tab]").forEach((card) => {
      card.addEventListener("click", () => {
        const targetTab = card.dataset.targetTab;
        if (targetTab) switchTab(targetTab);
        if (card.dataset.focusSearch) {
          setTimeout(() => {
            const input = document.getElementById("symbol-input");
            if (input) input.focus();
          }, 100);
        }
      });
    });

    // Active watches list — click row → analyze, click ✕ → dismiss
    container.querySelectorAll(".watch-row").forEach((row) => {
      row.addEventListener("click", async (e) => {
        const dismissBtn = e.target.closest(".watch-row-dismiss");
        if (dismissBtn) {
          e.stopPropagation();
          const sym = dismissBtn.dataset.dismissSymbol;
          if (sym && confirm(`Bỏ theo dõi ${sym}?`)) {
            await removeTplusWatch(sym);
            renderHome();
          }
          return;
        }
        const sym = row.dataset.symbol;
        if (sym) {
          switchTab("analyze");
          const input = document.getElementById("symbol-input");
          if (input) input.value = sym;
          clearAnalyzeContext();
          analyzeSymbol(sym);
        }
      });
    });

    // Watchlist: auto load nếu watchlist không empty, dùng cache nếu fresh,
    // fallback fetch fresh nếu chưa có cache.
    const wlRefresh = document.getElementById("watchlist-refresh-home");
    if (wlRefresh) {
      wlRefresh.addEventListener("click", (e) => {
        e.stopPropagation();
        loadWatchlistInHome(true);
      });
    }
    if (watchlistCount > 0) {
      let usedCache = false;
      try {
        const cached = JSON.parse(localStorage.getItem("watchlist_data_v1") || "null");
        if (cached && Date.now() - cached.timestamp < 30 * 60 * 1000) {
          renderWatchlistInHome(cached.data);
          usedCache = true;
        }
      } catch {}
      // Fetch fresh nếu không có cache (auto, không cần tap)
      if (!usedCache) loadWatchlistInHome(false);
    }

    // VN-Index chart: render với 6M default + bind range buttons
    renderVnindexChart(120);
    document.querySelectorAll("#vnindex-range .vni-range-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        document.querySelectorAll("#vnindex-range .vni-range-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        renderVnindexChart(parseInt(btn.dataset.days, 10));
      });
    });

    // Market snapshot scan/rows/sector handlers removed cùng snapshot section.
  }

  // ── VN-Index chart on home ──
  // Cache VNINDEX history 30 phút (less stale risk vì chart hiển thị nhiều tháng).
  let vnindexChartInstance = null;
  let vnindexCachedData = null; // full history 250 phiên — slice trên đó
  async function renderVnindexChart(days) {
    const container = document.getElementById("vnindex-chart-container");
    if (!container) return;
    if (!window.LightweightCharts) {
      container.innerHTML = `<div class="chart-loading"><span>Chart library chưa load...</span></div>`;
      return;
    }
    container.innerHTML = `<div class="chart-loading"><div class="spinner spinner-sm"></div><span>Tải VN-Index...</span></div>`;
    try {
      if (!vnindexCachedData) {
        const cached = JSON.parse(localStorage.getItem("vnindex_chart_v1") || "null");
        if (cached && Date.now() - cached.timestamp < 30 * 60 * 1000) {
          vnindexCachedData = cached.data;
        }
      }
      if (!vnindexCachedData) {
        vnindexCachedData = await ANALYSIS.fetchHistory("VNINDEX", "D", 250);
        try {
          localStorage.setItem("vnindex_chart_v1", JSON.stringify({
            timestamp: Date.now(), data: vnindexCachedData,
          }));
        } catch {}
      }
      const d = vnindexCachedData;
      const slice = Math.min(days, d.times.length);
      const startIdx = d.times.length - slice;
      const candles = [];
      for (let i = startIdx; i < d.times.length; i++) {
        candles.push({
          time: d.times[i],
          open: d.opens[i],
          high: d.highs[i],
          low: d.lows[i],
          close: d.closes[i],
        });
      }

      container.innerHTML = "";
      if (vnindexChartInstance) {
        try { vnindexChartInstance.remove(); } catch {}
        vnindexChartInstance = null;
      }
      const chartWidth = container.clientWidth || container.parentElement?.clientWidth || window.innerWidth - 32;
      const _ct = getChartTheme();
      vnindexChartInstance = window.LightweightCharts.createChart(container, {
        width: chartWidth,
        height: 220,
        // Keep transparent background — card has its own background
        layout: { background: { color: "transparent" }, textColor: _ct.layout.textColor, fontSize: 10 },
        grid: _ct.grid,
        rightPriceScale: { borderColor: _ct.border },
        timeScale: { borderColor: _ct.border, timeVisible: false },
        crosshair: { mode: 0 },
      });
      const series = vnindexChartInstance.addCandlestickSeries({
        upColor: _ct.up, downColor: _ct.down,
        borderUpColor: _ct.up, borderDownColor: _ct.down,
        wickUpColor: _ct.up, wickDownColor: _ct.down,
      });
      series.setData(candles);
      vnindexChartInstance.timeScale().fitContent();

      // Resize on window resize
      const resizeFn = () => {
        if (!vnindexChartInstance) return;
        try {
          vnindexChartInstance.applyOptions({ width: container.clientWidth });
        } catch {}
      };
      window.removeEventListener("resize", window.__vniResizeFn);
      window.__vniResizeFn = resizeFn;
      window.addEventListener("resize", resizeFn);
    } catch (e) {
      container.innerHTML = `
        <div class="chart-loading chart-error">
          ⚠️ Lỗi VN-Index: ${e.message}
          <button class="link-btn vni-retry-btn">Thử lại</button>
        </div>
      `;
      const retry = container.querySelector(".vni-retry-btn");
      if (retry) retry.addEventListener("click", () => {
        vnindexCachedData = null;
        renderVnindexChart(days);
      });
    }
  }

  async function loadWatchlistInHome(forceFresh = false) {
    const wrap = $("home-watchlist-content");
    if (!wrap) return;
    wrap.innerHTML = `<div class="home-card-empty">Đang tải...</div>`;
    try {
      const data = await RANKING.fetchWatchlistData({ useCache: !forceFresh });
      renderWatchlistInHome(data);
      // Detect alerts from fresh data
      const newAlerts = RANKING.detectAlerts(data);
      updateBellBadge();
      newAlerts.forEach((a) => notifyBrowser(a.title, a.message, a.color));
      // Check T+ trigger watches (throttled)
      maybeCheckTplusTriggers();
    } catch (e) {
      wrap.innerHTML = `
        <div class="home-card-empty">
          ⚠️ Lỗi: ${e.message}
          <button class="link-btn home-retry-btn">Thử lại</button>
        </div>
      `;
      const retry = wrap.querySelector(".home-retry-btn");
      if (retry) retry.addEventListener("click", () => loadWatchlistInHome(true));
    }
  }

  function renderWatchlistInHome(data) {
    const wrap = $("home-watchlist-content");
    if (!wrap) return;
    if (!data || data.length === 0) {
      wrap.innerHTML = `<div class="home-card-empty">Watchlist trống</div>`;
      return;
    }
    wrap.innerHTML = data.map((d) => {
      if (d.error) {
        return `<div class="watchlist-row" data-symbol="${d.symbol}">
          <span class="wl-symbol">${d.symbol}</span>
          <span class="home-card-empty">Lỗi: ${d.error}</span>
        </div>`;
      }
      const dayCls = d.dayChange >= 0 ? "up" : "down";
      const daySign = d.dayChange >= 0 ? "+" : "";
      return `
        <div class="watchlist-row" data-symbol="${d.symbol}">
          <span class="wl-symbol">${d.symbol}</span>
          <span class="wl-sector">${sectorLabel(d.sector)}</span>
          <span class="wl-price">${fp(d.currentPrice)}</span>
          <span class="pct ${dayCls}">${daySign}${d.dayChange.toFixed(2)}%</span>
          <span class="wl-rec" style="color:${d.recColor}">${d.recommendation}</span>
        </div>
      `;
    }).join("");

    // Tap row → analyze
    wrap.querySelectorAll(".watchlist-row").forEach((row) => {
      row.addEventListener("click", () => {
        const sym = row.dataset.symbol;
        switchTab("analyze");
        const input = document.getElementById("symbol-input");
        if (input) input.value = sym;
        clearAnalyzeContext();
        analyzeSymbol(sym);
      });
    });
  }

  // Render home initially + re-render when switching to home tab.
  // Defer 1 tick: renderHome() → buildBriefingContext đọc state (activeClimaxPicks,
  // drawdownStatus...) khai báo ở section Portfolio phía dưới cùng IIFE — gọi đồng bộ
  // sẽ TDZ ("Cannot access before initialization"). Cùng pattern setTimeout(renderHome) bên dưới.
  setTimeout(renderHome, 0);
  // Initial T+ trigger check on app load
  setTimeout(() => maybeCheckTplusTriggers(), 2000);
  const originalSwitchTab = switchTab;
  // Re-render home on returning to it (data may be cached now)
  document.addEventListener("click", (e) => {
    if (e.target.matches?.('.tab-btn[data-tab="home"]')) {
      setTimeout(renderHome, 50);
      maybeCheckTplusTriggers();
    }
  });

  // ════════════════════════════════════════════════════
  // ── RANKING TAB (Rà soát) — STRIPPED ──
  // Toàn bộ logic picks/scan/tracker đã gỡ để build lại từ đầu.
  // Giữ lại: date helpers (Portfolio dùng), shell init (#ranking-content rỗng).
  // ════════════════════════════════════════════════════
  // ── Shell init: tab Rà soát rỗng, chờ build lại ──
  // #ranking-content để trống; header + nút refresh giữ trong index.html.
  // renderTrackerSection no-op để switchTab("ranking") không vỡ (gọi ở line ~4795).
  function renderTrackerSection() {}

  $("ranking-refresh")?.addEventListener("click", () => {
    // TODO: wire lại khi build logic Rà soát mới.
  });

  // ════════════════════════════════════════════════════
  // ── PORTFOLIO TAB ──
  // ════════════════════════════════════════════════════
  const PORTFOLIO = window.__SSI_PORTFOLIO__;
  let editingTxId = null;
  // Cache analysis results per symbol khi render holdings
  const portfolioAnalysisCache = {};
  // Track current T+ top picks symbols (consumed by portfolio recommendAction)
  let tplusTopSymbols = new Set();
  // Authoritative climax active picks from bot Supabase (signal_date based T+ count)
  // Map: symbol → { signal_date, entry_price, target_price, tier, expires_at }
  let activeClimaxPicks = new Map();
  let activeClimaxPicksFetchedAt = 0;

  // C1 Drawdown circuit breaker status (cached 5min)
  let drawdownStatus = null;
  let drawdownFetchedAt = 0;

  // C2 Sector concentration: compute current portfolio sector exposure
  // Used to warn before picking new mã trong sector đã > 50% NAV.
  function computeSectorExposure() {
    const exposure = {};
    let totalMarket = 0;
    try {
      const cash = window.__SSI_PORTFOLIO__?.loadCash?.() ?? 0;
      const holdings = window.__SSI_PORTFOLIO__?.currentHoldings?.() ?? [];
      for (const h of holdings) {
        const a = portfolioAnalysisCache?.[h.symbol];
        if (!a?.current) continue;
        const value = h.qty * a.current * 1000;
        totalMarket += value;
        const sec = RANKING.getSector?.(h.symbol) || "other";
        exposure[sec] = (exposure[sec] || 0) + value;
      }
      const nav = totalMarket + cash;
      const exposurePct = {};
      for (const [sec, val] of Object.entries(exposure)) {
        exposurePct[sec] = nav > 0 ? (val / nav) * 100 : 0;
      }
      return { nav, totalMarket, exposurePct };
    } catch {
      return { nav: 0, totalMarket: 0, exposurePct: {} };
    }
  }

  function buildDrawdownBanner() {
    if (!drawdownStatus) return "";
    // Show banner if any tier has consecLosses >= 2 (warning) or isPaused (critical)
    const issues = [];
    for (const [tier, s] of Object.entries(drawdownStatus)) {
      if (s.isPaused) {
        issues.push(`<div class="drawdown-row drawdown-critical">
          🚫 <b>${tier}</b> PAUSED — ${s.consecLosses} losses liên tiếp · cooldown đến <b>${s.pausedUntil || "?"}</b>.
          <div class="drawdown-sub">Skip ${tier} tier trong cooldown để tránh emotional spiral. Cần reset.</div>
        </div>`);
      } else if (s.consecLosses >= 2) {
        issues.push(`<div class="drawdown-row drawdown-warn">
          ⚠️ <b>${tier}</b>: ${s.consecLosses} loss liên tiếp · gần pause threshold ${3 - s.consecLosses} loss nữa.
          <div class="drawdown-sub">Cân nhắc giảm size hoặc skip pick ${tier} tiếp theo.</div>
        </div>`);
      }
    }
    if (issues.length === 0) return "";
    return `<div class="drawdown-banner">
      <div class="drawdown-banner-title">📉 Drawdown circuit breaker</div>
      ${issues.join("")}
    </div>`;
  }

  async function fetchDrawdownStatus(forceRefresh = false) {
    const TTL_MS = 5 * 60 * 1000;
    if (!forceRefresh && drawdownStatus && Date.now() - drawdownFetchedAt < TTL_MS) {
      return drawdownStatus;
    }
    try {
      const r = await fetch("https://stock-pwa-bot.qngnhat.workers.dev/drawdown-status", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      drawdownStatus = json.status || {};
      drawdownFetchedAt = Date.now();
      return drawdownStatus;
    } catch (e) {
      console.warn("[drawdown] fetch failed:", e.message);
      return drawdownStatus || {};
    }
  }

  async function fetchActiveClimaxPicks(forceRefresh = false) {
    // Cache 5 phút, server cũng cache 5 phút → tổng worst-case 10 phút lag
    const TTL_MS = 5 * 60 * 1000;
    if (!forceRefresh && Date.now() - activeClimaxPicksFetchedAt < TTL_MS && activeClimaxPicks.size > 0) {
      return;
    }
    try {
      const r = await fetch("https://stock-pwa-bot.qngnhat.workers.dev/active-picks", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      const map = new Map();
      for (const p of json.picks || []) {
        map.set(p.symbol, p);
      }
      activeClimaxPicks = map;
      activeClimaxPicksFetchedAt = Date.now();
      console.log(`[portfolio] fetched ${map.size} active climax picks`);
    } catch (e) {
      console.warn("[portfolio] active picks fetch failed:", e.message);
    }
  }

  // Click handlers cho add buttons (delegated since portfolio re-renders)
  function openTxModal(editTx = null) {
    console.log("[portfolio] openTxModal called", { editTx });
    editingTxId = editTx?.id || null;
    const modal = $("tx-modal");
    const backdrop = $("tx-modal-backdrop");
    if (!modal || !backdrop) {
      console.error("[portfolio] modal not found in DOM", { modal, backdrop });
      return;
    }

    // Ensure form bound (in case portfolio tab never rendered yet)
    bindTxModal();

    modal.classList.add("open");
    backdrop.classList.add("open");

    // Pre-fill or reset (defensive null checks)
    const setEl = (id, val) => {
      const el = $(id);
      if (el) el.value = val;
    };
    const setText = (id, txt) => {
      const el = $(id);
      if (el) el.textContent = txt;
    };
    setText("tx-modal-title", editTx ? "Sửa giao dịch" : "Thêm giao dịch");
    setEl("tx-symbol", editTx?.symbol || "");
    setEl("tx-quantity", editTx?.quantity || "");
    setEl("tx-price", editTx?.price || "");
    setEl("tx-fee", editTx ? Math.round((editTx.fee || 0) * 1000) : 0); // k-VND → VND for input
    setEl("tx-date", editTx
      ? new Date(editTx.trade_date).toISOString().split("T")[0]
      : new Date().toISOString().split("T")[0]);
    setEl("tx-notes", editTx?.notes || "");
    // Side toggle
    document.querySelectorAll("#tx-side-toggle .seg-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.side === (editTx?.side || "buy"));
    });
    updateTxSummary();
    const sym = $("tx-symbol");
    if (sym) setTimeout(() => sym.focus(), 50);
  }

  function closeTxModal() {
    $("tx-modal")?.classList.remove("open");
    $("tx-modal-backdrop")?.classList.remove("open");
    editingTxId = null;
  }

  function updateTxSummary() {
    const qty = Number($("tx-quantity").value) || 0;
    const price = Number($("tx-price").value) || 0;
    const feeVnd = Number($("tx-fee").value) || 0;
    const symbol = ($("tx-symbol")?.value || "").trim().toUpperCase();
    const side = document.querySelector("#tx-side-toggle .seg-btn.active")?.dataset.side || "buy";
    const gross = qty * price * 1000;
    const summary = $("tx-summary");
    if (!summary) return;
    if (!qty || !price) {
      summary.textContent = "";
      return;
    }

    // Avg cost preview: nếu mua thêm mã đã có holding → tính avg cost mới
    let avgCostHtml = "";
    if (side === "buy" && symbol && qty > 0 && price > 0) {
      const existing = PORTFOLIO.currentHoldings().find((h) => h.symbol === symbol);
      if (existing && existing.qty > 0) {
        const newQty = existing.qty + qty;
        const newAvgCost = (existing.qty * existing.avg_cost + qty * price) / newQty;
        const oldAvg = existing.avg_cost;
        const direction = newAvgCost < oldAvg ? "↓" : "↑";
        const dirColor = newAvgCost < oldAvg ? "#4CAF50" : "#FF9800";
        avgCostHtml = `<br><span style="color:${dirColor}">Avg cost: ${oldAvg.toFixed(2)} ${direction} <b>${newAvgCost.toFixed(2)}</b> (KL mới ${newQty.toLocaleString("vi-VN")})</span>`;
      }
    }

    // Position sizing suggestion: max 2% NAV at risk, SL distance từ analysis cache
    let sizingHtml = "";
    if (side === "buy" && symbol && price > 0) {
      const ana = portfolioAnalysisCache[symbol];
      const cash = PORTFOLIO.loadCash();
      // Compute NAV from current holdings + cash (approximate using cached analyses)
      let totalMarket = 0;
      for (const h of PORTFOLIO.currentHoldings()) {
        const a = portfolioAnalysisCache[h.symbol];
        if (a && a.current) totalMarket += h.qty * a.current * 1000;
      }
      const nav = totalMarket + cash;
      // SL distance: từ analysis nếu có, else default 8%
      let slDistPct = 8;
      if (ana && ana.stopLoss && ana.current && ana.stopLoss < ana.current) {
        slDistPct = ((ana.current - ana.stopLoss) / ana.current) * 100;
        slDistPct = Math.max(3, Math.min(15, slDistPct)); // clamp [3, 15]%
      }
      const RISK_PCT = 2; // 2% NAV at risk per trade
      const maxRiskVnd = nav * (RISK_PCT / 100);
      const maxLossPerShareVnd = price * 1000 * (slDistPct / 100); // VND per share
      const maxQtyByRisk = maxLossPerShareVnd > 0 ? Math.floor(maxRiskVnd / maxLossPerShareVnd) : 0;
      const maxValueVnd = maxQtyByRisk * price * 1000;
      if (maxQtyByRisk > 0 && nav > 0) {
        const overSize = qty > maxQtyByRisk ? `<span style="color:#ff5722"> · ⚠️ Quá size khuyến nghị (${qty}/${maxQtyByRisk})</span>` : "";
        sizingHtml = `<br><span style="color:#888">💡 Size khuyến nghị: <b style="color:#00d2ff">${maxQtyByRisk.toLocaleString("vi-VN")} cp</b> (~${fmtMoney(maxValueVnd)}, max 2% NAV at risk, SL ~${slDistPct.toFixed(1)}%)${overSize}</span>`;
      }
    }

    if (side === "buy") {
      const total = gross + feeVnd;
      const newCash = PORTFOLIO.loadCash() - total;
      summary.innerHTML = `Tổng: <b>${fmtMoney(total)}</b> · Cash sau khi mua: <b>${fmtMoney(newCash)}</b>${avgCostHtml}${sizingHtml}`;
    } else {
      const proceeds = gross - feeVnd;
      const newCash = PORTFOLIO.loadCash() + proceeds;
      summary.innerHTML = `Thu về: <b>${fmtMoney(proceeds)}</b> · Cash sau khi bán: <b>${fmtMoney(newCash)}</b>`;
    }
  }

  function bindTxModal() {
    const form = $("tx-form");
    if (!form || form.dataset.bound) return;
    form.dataset.bound = "1";

    // Symbol autocomplete (gợi ý mã giống search bar)
    attachAutocomplete($("tx-symbol"), () => {
      $("tx-quantity")?.focus();
    });

    // Side toggle
    document.querySelectorAll("#tx-side-toggle .seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#tx-side-toggle .seg-btn").forEach((b) =>
          b.classList.remove("active")
        );
        btn.classList.add("active");
        updateTxSummary();
      });
    });

    // Live summary
    ["tx-quantity", "tx-price", "tx-fee", "tx-symbol"].forEach((id) => {
      $(id)?.addEventListener("input", updateTxSummary);
    });

    // Cancel + close
    $("tx-cancel")?.addEventListener("click", closeTxModal);
    $("tx-modal-close")?.addEventListener("click", closeTxModal);
    $("tx-modal-backdrop")?.addEventListener("click", closeTxModal);

    // Submit
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const side = document.querySelector("#tx-side-toggle .seg-btn.active")?.dataset.side || "buy";
      const symbol = $("tx-symbol").value.trim().toUpperCase();
      const qty = Number($("tx-quantity").value);
      const price = Number($("tx-price").value);
      const fee = (Number($("tx-fee").value) || 0) / 1000; // VND input → k-VND storage
      const date = $("tx-date").value
        ? new Date($("tx-date").value).toISOString()
        : new Date().toISOString();
      const notes = $("tx-notes").value.trim() || null;

      if (!symbol || !qty || !price) {
        alert("Điền đủ Mã, KL, Giá.");
        return;
      }

      // If editing, delete old then add new (simpler than update)
      if (editingTxId) {
        await PORTFOLIO.deleteTransaction(editingTxId);
      }

      await PORTFOLIO.addTransaction({
        symbol, side, quantity: qty, price, fee,
        trade_date: date, notes,
      });

      closeTxModal();
      renderPortfolio();
    });
  }

  // Cash modal
  function openCashModal() {
    const modal = $("cash-modal");
    const backdrop = $("cash-modal-backdrop");
    if (!modal || !backdrop) return;
    modal.classList.add("open");
    backdrop.classList.add("open");
    $("cash-amount").value = Math.round(PORTFOLIO.loadCash()); // already VND
    setTimeout(() => $("cash-amount").focus(), 50);
  }

  function closeCashModal() {
    $("cash-modal")?.classList.remove("open");
    $("cash-modal-backdrop")?.classList.remove("open");
  }

  function bindCashModal() {
    const form = $("cash-form");
    if (!form || form.dataset.bound) return;
    form.dataset.bound = "1";
    $("cash-cancel")?.addEventListener("click", closeCashModal);
    $("cash-modal-close")?.addEventListener("click", closeCashModal);
    $("cash-modal-backdrop")?.addEventListener("click", closeCashModal);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const vnd = Number($("cash-amount").value) || 0;
      await PORTFOLIO.updateCash(vnd); // already VND
      closeCashModal();
      renderPortfolio();
    });
  }

  // ── Deposit modal (cộng vào cash) ──
  function openDepositModal() {
    bindDepositModal();
    const modal = $("deposit-modal");
    const backdrop = $("deposit-modal-backdrop");
    if (!modal || !backdrop) return;
    modal.classList.add("open");
    backdrop.classList.add("open");
    $("deposit-amount").value = "";
    updateDepositSummary();
    setTimeout(() => $("deposit-amount")?.focus(), 50);
  }

  function closeDepositModal() {
    $("deposit-modal")?.classList.remove("open");
    $("deposit-modal-backdrop")?.classList.remove("open");
  }

  function updateDepositSummary() {
    const amt = Number($("deposit-amount")?.value) || 0;
    const summary = $("deposit-summary");
    if (!summary) return;
    if (amt > 0) {
      const newCash = PORTFOLIO.loadCash() + amt;
      summary.textContent = `Cash sau khi nạp: ${fmtMoney(newCash)}`;
    } else {
      summary.textContent = "";
    }
  }

  function bindDepositModal() {
    const form = $("deposit-form");
    if (!form || form.dataset.bound) return;
    form.dataset.bound = "1";
    $("deposit-cancel")?.addEventListener("click", closeDepositModal);
    $("deposit-modal-close")?.addEventListener("click", closeDepositModal);
    $("deposit-modal-backdrop")?.addEventListener("click", closeDepositModal);
    $("deposit-amount")?.addEventListener("input", updateDepositSummary);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const vnd = Number($("deposit-amount").value) || 0;
      if (vnd <= 0) {
        alert("Nhập số tiền nạp > 0.");
        return;
      }
      await PORTFOLIO.depositCash(vnd);
      closeDepositModal();
      renderPortfolio();
    });
  }

  // ── Holding detail modal (per-symbol portfolio analysis + tx history) ──
  let hdCurrentSymbol = null;
  let hdChartInstance = null;

  function openHoldingDetail(symbol) {
    hdCurrentSymbol = symbol;
    const modal = $("hd-modal");
    const backdrop = $("hd-modal-backdrop");
    if (!modal || !backdrop) return;
    bindHoldingDetailModal();
    modal.classList.add("open");
    backdrop.classList.add("open");
    $("hd-modal-title").textContent = `${symbol} — phân tích danh mục`;
    renderHoldingDetail(symbol);
  }

  function closeHoldingDetail() {
    $("hd-modal")?.classList.remove("open");
    $("hd-modal-backdrop")?.classList.remove("open");
    hdCurrentSymbol = null;
    if (hdChartInstance) {
      try { hdChartInstance.remove(); } catch {}
      hdChartInstance = null;
    }
  }

  function bindHoldingDetailModal() {
    const modal = $("hd-modal");
    if (!modal || modal.dataset.bound) return;
    modal.dataset.bound = "1";
    $("hd-modal-close")?.addEventListener("click", closeHoldingDetail);
    $("hd-modal-backdrop")?.addEventListener("click", closeHoldingDetail);
  }

  // Build action plan with concrete numbers (TP zones, stop loss, sizing)
  function buildHoldingActionPlan(holding, ana, inTplusTop = false) {
    const cur = ana.current;
    const avg = holding.avg_cost;
    const qty = holding.qty;
    const pnlPct = avg > 0 ? ((cur - avg) / avg) * 100 : 0;
    const score = ana.score ?? 0;
    const flags = ana.flags || {};
    const items = [];

    // 1. Cut-loss level: max(2*ATR below current, -8% from avg cost)
    const slFromAtr = ana.atr ? cur - 2 * ana.atr : null;
    const slFromAvg = avg * 0.92; // -8% from cost basis
    const stopCandidates = [slFromAtr, ana.support, slFromAvg].filter((x) => x && x > 0);
    const stopLoss = stopCandidates.length ? Math.max(...stopCandidates.filter((x) => x < cur)) : slFromAvg;
    const stopPct = avg > 0 ? ((stopLoss - avg) / avg) * 100 : 0;

    // 2. T+ Take-profit zones: TP1 +5%, TP2 +12% (per Strong Leaders spec)
    if (pnlPct > -3) {
      const tp1 = avg * 1.05; // +5%
      const tp2 = avg * 1.12; // +12%
      const tp3 = ana.resistance && ana.resistance > cur && ana.resistance < avg * 1.25 ? ana.resistance : avg * 1.20;
      items.push({
        kind: "tp",
        title: "🎯 Vùng chốt lời (T+ swing)",
        rows: [
          [`TP1 (+5%)`, fp(tp1), cur >= tp1 ? "Đã chạm — TP 1/3 đến 1/2" : `Còn ${(((tp1 - cur) / cur) * 100).toFixed(1)}%`],
          [`TP2 (+12%)`, fp(tp2), cur >= tp2 ? "Đã chạm — TP 1/3 phần còn lại" : `Còn ${(((tp2 - cur) / cur) * 100).toFixed(1)}%`],
          [`TP3 (kháng cự)`, fp(tp3), cur >= tp3 ? "Đã chạm — exit full" : `Còn ${(((tp3 - cur) / cur) * 100).toFixed(1)}%`],
        ],
      });
    }

    // 3. Stop loss
    items.push({
      kind: "sl",
      title: "🛡️ Mức cắt lỗ đề xuất",
      rows: [
        [`Stop loss`, fp(stopLoss), `${stopPct.toFixed(1)}% so với cost`],
        [`Lỗ tối đa`, fmtMoney((stopLoss - avg) * qty * 1000), `nếu ${cur > stopLoss ? "trigger" : "đã thua từ trước"}`],
      ],
    });

    // 4. Hold horizon hint cho T+ — sau 10-15 phiên hết edge
    if (holding.first_buy_date) {
      const daysHeld = Math.floor((Date.now() - new Date(holding.first_buy_date).getTime()) / 86400000);
      let hint;
      if (daysHeld <= 10) hint = `${daysHeld}d / 10-15d expected — vẫn trong horizon T+`;
      else if (daysHeld <= 15) hint = `${daysHeld}d — gần cuối horizon T+, chuẩn bị exit nếu chưa lãi rõ`;
      else hint = `${daysHeld}d > 15 — T+ stale, đề xuất exit nếu setup yếu`;
      items.push({
        kind: "hold",
        title: "⏰ Hold horizon",
        rows: [[`Đã hold`, `${daysHeld} phiên`, hint]],
      });
    }

    // 5. Add zone — chỉ nếu Strong Leader/breakout + chưa lãi quá
    if (score >= 5 && (flags.strongLeader || flags.breakoutFresh) && pnlPct < 5) {
      const buyZoneLow = ana.buyZoneLow ?? cur * 0.97;
      const buyZoneHigh = ana.buyZoneHigh ?? cur * 1.02;
      const reason = flags.strongLeader ? "Strong leader (RS vs VNI)" : "Fresh breakout";
      items.push({
        kind: "add",
        title: "🚀 Vùng tilt buy (T+ momentum)",
        rows: [
          [`Vùng giá`, `${fp(buyZoneLow)} – ${fp(buyZoneHigh)}`, ""],
          [`Lý do`, `Score ${score.toFixed(1)} + ${reason}`, ""],
        ],
      });
    } else if (score >= 4 && inTplusTop && pnlPct < 5) {
      const buyZoneLow = ana.buyZoneLow ?? cur * 0.97;
      const buyZoneHigh = ana.buyZoneHigh ?? cur * 1.02;
      items.push({
        kind: "add",
        title: "📈 Vùng tilt buy",
        rows: [
          [`Vùng giá`, `${fp(buyZoneLow)} – ${fp(buyZoneHigh)}`, ""],
          [`Lý do`, `Vẫn trong T+ top picks, score ${score.toFixed(1)}`, ""],
        ],
      });
    }

    return { stopLoss, items };
  }

  function renderHoldingDetail(symbol) {
    const body = $("hd-modal-body");
    if (!body) return;

    const txs = PORTFOLIO.loadTransactions().filter((t) => t.symbol === symbol);
    const holdings = PORTFOLIO.allHoldings().filter((h) => h.symbol === symbol);
    const holding = holdings[0];
    const ana = portfolioAnalysisCache[symbol];

    if (!holding && txs.length === 0) {
      body.innerHTML = `<div class="hd-section"><p>Không có giao dịch cho mã ${symbol}.</p></div>`;
      return;
    }

    const cur = ana?.current ?? 0;
    const avg = holding?.avg_cost ?? 0;
    const qty = holding?.qty ?? 0;
    const marketValue = qty * cur * 1000;
    const costBasis = (holding?.cost_basis ?? 0) * 1000;
    const pnl = marketValue - costBasis;
    const pnlPct = costBasis > 0 ? (pnl / costBasis) * 100 : 0;
    const pnlCls = pnl >= 0 ? "up" : "down";
    const pnlSign = pnl >= 0 ? "+" : "";
    const realized = (holding?.realized_pnl ?? 0) * 1000;

    const inTplusTop = tplusTopSymbols.has(symbol);
    const action = ana && holding ? PORTFOLIO.recommendAction(holding, ana, inTplusTop) : null;
    const plan = ana && holding && qty > 0 ? buildHoldingActionPlan(holding, ana, inTplusTop) : null;

    const meta = getStockMeta(symbol) || {};
    const companyParts = [meta.name, sectorLabel(meta.sector), meta.floor].filter(Boolean);
    const companyLine = companyParts.length
      ? `<div class="hd-company">${escapeHtml(companyParts.join(" · "))}</div>`
      : "";

    const setupLabel = ana?.recommendation || "--";
    const setupColor = ana?.recColor || "#888";

    const positionHtml = qty > 0 ? `
      <div class="hd-section hd-position">
        <div class="hd-section-title">📊 Vị thế hiện tại</div>
        <div class="hd-pos-grid">
          <div><span class="hd-lbl">Khối lượng</span><span class="hd-val">${qty.toLocaleString("vi-VN")} cp</span></div>
          <div><span class="hd-lbl">Giá vốn TB</span><span class="hd-val">${fp(avg)}</span></div>
          <div><span class="hd-lbl">Giá hiện tại</span><span class="hd-val">${fp(cur)}</span></div>
          <div><span class="hd-lbl">Giá trị TT</span><span class="hd-val">${fmtMoney(marketValue)}</span></div>
          <div><span class="hd-lbl">Vốn đã bỏ</span><span class="hd-val">${fmtMoney(costBasis)}</span></div>
          <div><span class="hd-lbl">P&L</span><span class="hd-val pct ${pnlCls}">${pnlSign}${pnlPct.toFixed(2)}%</span></div>
        </div>
        <div class="hd-pos-pnl ${pnlCls}">
          ${pnlSign}${fmtMoney(pnl)} ${realized !== 0 ? `<span class="hd-realized">· đã chốt ${realized >= 0 ? "+" : ""}${fmtMoney(realized)}</span>` : ""}
        </div>
      </div>
    ` : `
      <div class="hd-section">
        <div class="hd-section-title">📊 Vị thế</div>
        <p class="hd-muted">Đã bán hết. Lãi/lỗ thực hiện: <b>${realized >= 0 ? "+" : ""}${fmtMoney(realized)}</b></p>
      </div>
    `;

    const setupHtml = ana ? `
      <div class="hd-section">
        <div class="hd-section-title">🔬 Tín hiệu kỹ thuật</div>
        <div class="hd-signal-row">
          <span class="hd-setup-tag" style="background:${setupColor}22;color:${setupColor};border-color:${setupColor}55">${setupLabel}</span>
          <span class="hd-muted">Score <b>${ana.score?.toFixed(1) ?? "--"}</b></span>
          ${ana.rsi !== null && ana.rsi !== undefined ? `<span class="hd-muted">RSI <b>${ana.rsi.toFixed(0)}</b></span>` : ""}
          ${ana.trendDir ? `<span class="hd-muted">Xu hướng <b>${ana.trendDir}</b></span>` : ""}
        </div>
        <div class="hd-reasons">${(ana.reasons || []).map((x) => `• ${escapeHtml(x)}`).join("<br>") || "<em>Không có tín hiệu rõ.</em>"}</div>
      </div>
    ` : "";

    const actionHtml = action ? `
      <div class="hd-section hd-action-card" style="border-left-color:${action.color}">
        <div class="hd-section-title">🎯 Hành động đề xuất</div>
        <div class="hd-action-main">
          <span class="hd-action-icon">${action.icon}</span>
          <span class="hd-action-text">${escapeHtml(action.text)}</span>
        </div>
      </div>
    ` : "";

    const planHtml = plan ? plan.items.map((it) => `
      <div class="hd-section hd-plan-${it.kind}">
        <div class="hd-section-title">${it.title}</div>
        <div class="hd-plan-rows">
          ${it.rows.map(([k, v, hint]) => `
            <div class="hd-plan-row">
              <span class="hd-plan-k">${escapeHtml(k)}</span>
              <span class="hd-plan-v">${v}</span>
              <span class="hd-plan-hint">${escapeHtml(hint || "")}</span>
            </div>
          `).join("")}
        </div>
      </div>
    `).join("") : "";

    const sortedTxs = [...txs].sort((a, b) =>
      new Date(b.trade_date).getTime() - new Date(a.trade_date).getTime()
    );
    const txHtml = `
      <div class="hd-section">
        <div class="hd-section-title">📋 Lịch sử giao dịch (${txs.length})</div>
        <div class="hd-tx-list">
          ${sortedTxs.map((t) => {
            const sideCls = t.side === "buy" ? "buy" : "sell";
            const sideLabel = t.side === "buy" ? "MUA" : "BÁN";
            const total = (t.quantity * t.price + (t.fee || 0)) * 1000;
            const date = new Date(t.trade_date).toLocaleDateString("vi-VN");
            return `
              <div class="hd-tx-item" data-tx-id="${t.id}">
                <div class="hd-tx-main">
                  <span class="hd-tx-side ${sideCls}">${sideLabel}</span>
                  <span class="hd-tx-qty">${Number(t.quantity).toLocaleString("vi-VN")}cp</span>
                  <span class="hd-tx-price">@ ${fp(t.price)}</span>
                  <span class="hd-tx-total">${fmtMoney(total)}</span>
                </div>
                <div class="hd-tx-meta">
                  <span class="hd-tx-date">${date}</span>
                  ${t.notes ? `<span class="hd-tx-notes">${escapeHtml(t.notes)}</span>` : ""}
                </div>
                <div class="hd-tx-actions">
                  <button class="link-btn hd-tx-edit" data-tx-id="${t.id}">Sửa</button>
                  <button class="link-btn hd-tx-del" data-tx-id="${t.id}">Xóa</button>
                </div>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `;

    const chartHtml = `
      <div class="hd-section hd-chart-section">
        <div class="hd-section-title">📈 Biểu đồ giá</div>
        <div class="hd-chart-legend">
          <span class="hd-chart-leg hd-leg-cost">— Giá vốn</span>
          ${qty > 0 && pnlPct > 0 ? `<span class="hd-chart-leg hd-leg-tp">— TP1/TP2</span>` : ""}
          ${qty > 0 ? `<span class="hd-chart-leg hd-leg-sl">— Stop loss</span>` : ""}
          <span class="hd-chart-leg hd-leg-ma">— MA20</span>
        </div>
        <div id="hd-chart-container"></div>
      </div>
    `;

    body.innerHTML = `
      ${companyLine}
      ${positionHtml}
      ${chartHtml}
      ${actionHtml}
      ${planHtml}
      ${setupHtml}
      ${txHtml}
      <div class="form-actions" style="justify-content:space-between">
        <button class="link-btn" id="hd-add-tx">+ Thêm giao dịch</button>
        <button class="link-btn" id="hd-open-analysis">Xem phân tích đầy đủ →</button>
      </div>
    `;

    // Render chart async (don't block UI)
    renderHoldingChart(symbol, holding, plan).catch((e) => {
      console.warn("[hd] chart render failed", e);
    });

    // Bind action buttons
    $("hd-add-tx")?.addEventListener("click", () => {
      closeHoldingDetail();
      openTxModal();
      $("tx-symbol").value = symbol;
    });
    $("hd-open-analysis")?.addEventListener("click", () => {
      closeHoldingDetail();
      switchTab("analyze");
      const input = document.getElementById("symbol-input");
      if (input) input.value = symbol;
      clearAnalyzeContext();
      analyzeSymbol(symbol);
    });

    // Bind tx edit/delete
    body.querySelectorAll(".hd-tx-edit").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.txId;
        const tx = txs.find((t) => t.id === id);
        if (!tx) return;
        closeHoldingDetail();
        openTxModal(tx);
      });
    });
    body.querySelectorAll(".hd-tx-del").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.txId;
        if (!confirm("Xóa giao dịch này?")) return;
        await PORTFOLIO.deleteTransaction(id);
        // Re-render this modal + parent list
        renderHoldingDetail(symbol);
        renderPortfolio();
      });
    });
  }

  async function renderHoldingChart(symbol, holding, plan) {
    const container = $("hd-chart-container");
    if (!container || !window.LightweightCharts) return;

    // Clean up old
    container.innerHTML = "";
    if (hdChartInstance) {
      try { hdChartInstance.remove(); } catch {}
      hdChartInstance = null;
    }

    let data;
    try {
      data = await ANALYSIS.fetchHistory(symbol, "D", 120);
    } catch (e) {
      container.innerHTML = `<div class="hd-muted">Không tải được biểu đồ.</div>`;
      return;
    }

    // Modal might have closed before fetch finished — bail
    if (hdCurrentSymbol !== symbol) return;
    const cur = $("hd-chart-container");
    if (!cur) return;

    const candles = data.times.map((t, i) => ({
      time: t,
      open: data.opens[i],
      high: data.highs[i],
      low: data.lows[i],
      close: data.closes[i],
    }));

    const _ct = getChartTheme();
    hdChartInstance = window.LightweightCharts.createChart(cur, {
      width: cur.clientWidth,
      height: 220,
      layout: { ...(_ct.layout), fontSize: 10 },
      grid: _ct.grid,
      rightPriceScale: { borderColor: _ct.border },
      timeScale: { borderColor: _ct.border, timeVisible: false, secondsVisible: false },
      crosshair: { mode: 1 },
    });

    const candleSeries = hdChartInstance.addCandlestickSeries({
      upColor: _ct.up, downColor: _ct.down,
      borderUpColor: _ct.up, borderDownColor: _ct.down,
      wickUpColor: _ct.up, wickDownColor: _ct.down,
    });
    candleSeries.setData(candles);

    // MA20 overlay
    const ma20Pts = computeSMASeries(data.closes, data.times, 20).filter((p) => p.value !== null);
    if (ma20Pts.length) {
      const ma20Line = hdChartInstance.addLineSeries({
        color: chartCssVar("--text-mute", "#888888"), lineWidth: 1, title: "MA20",
        priceLineVisible: false, lastValueVisible: false,
      });
      ma20Line.setData(ma20Pts);
    }

    // Horizontal lines: avg cost, stop loss, TP1, TP2
    const addLine = (price, color, title) => {
      if (!price || price <= 0 || isNaN(price)) return;
      candleSeries.createPriceLine({
        price,
        color,
        lineWidth: 2,
        lineStyle: 2, // dashed
        axisLabelVisible: true,
        title,
      });
    };

    if (holding && holding.qty > 0 && holding.avg_cost > 0) {
      addLine(holding.avg_cost, "#00d2ff", "Vốn");
      const cur = data.closes[data.closes.length - 1];
      const pnl = cur - holding.avg_cost;
      // Show TP only if currently profitable
      if (pnl > 0) {
        addLine(holding.avg_cost * 1.10, "#FF9800", "TP1");
        addLine(holding.avg_cost * 1.20, "#FF9800", "TP2");
      }
      if (plan?.stopLoss) {
        addLine(plan.stopLoss, "#ff4444", "SL");
      }
    }

    hdChartInstance.timeScale().fitContent();
  }

  // ── Portfolio risk hints (panel-level analytics) ──
  // 3 hint khi triggered: Cash/Equity ratio, "Xanh vỏ đỏ lòng", Holiday + low cash.
  function renderPortfolioRiskHints(enriched, totalMarket, cash, nav) {
    const hints = [];

    // Cash/Equity ratio
    if (nav > 0) {
      const equityPct = (totalMarket / nav) * 100;
      const cashPct = (cash / nav) * 100;
      hints.push({
        kind: "ratio",
        text: `Cổ <b>${equityPct.toFixed(1)}%</b> · Cash <b>${cashPct.toFixed(1)}%</b>`,
      });

      // Holiday + low cash combo
      const holiday = nextVnHoliday(7);
      if (holiday && holiday.daysAway > 0 && cashPct < 10) {
        hints.push({
          kind: "warn",
          text: `⚠️ Cash thấp (${cashPct.toFixed(1)}%) + còn ${holiday.daysAway} phiên tới nghỉ lễ — không có dự phòng nếu thị trường gap down sau lễ.`,
        });
      }
      // Cash dư + sắp lễ → tránh re-deploy panic
      if (holiday && holiday.daysAway > 0 && cashPct > 30) {
        hints.push({
          kind: "info",
          text: `💡 Cash <b>${cashPct.toFixed(1)}%</b> NAV + còn ${holiday.daysAway} phiên tới nghỉ lễ. Cân nhắc <b>hold cash qua lễ</b> — gap risk hậu lễ ~5%, re-deploy sau khi market settle.`,
        });
      }
    }

    // "Xanh vỏ đỏ lòng": losers ngốn lợi nhuận winners
    let winnersTotal = 0, losersTotal = 0;
    for (const h of enriched) {
      if (!h.analysis) continue;
      const pnl = h.qty * h.analysis.current * 1000 - h.cost_basis * 1000;
      if (pnl > 0) winnersTotal += pnl;
      else losersTotal += Math.abs(pnl);
    }
    if (winnersTotal > 0 && losersTotal >= winnersTotal * 0.8) {
      const ratio = (losersTotal / winnersTotal) * 100;
      const verb = ratio >= 100 ? "đã ngốn sạch" : "đang ngốn";
      hints.push({
        kind: "warn",
        text: `⚠️ Mã lỗ ${verb} <b>${ratio.toFixed(0)}%</b> lợi nhuận từ winners — cân nhắc cắt lỗ để bảo vệ phần lãi.`,
      });
    }

    if (hints.length === 0) return "";
    return `
      <div class="port-risk-hints">
        ${hints.map((h) => `<div class="port-risk-hint port-risk-${h.kind}">${h.text}</div>`).join("")}
      </div>
    `;
  }

  // ── Closed positions render (mã đã bán hết, có realized P&L) ──
  function renderClosedPositions() {
    const all = PORTFOLIO.allHoldings();
    const closed = all
      .filter((h) => h.qty === 0 && Math.abs(h.realized_pnl ?? 0) > 0.001)
      .sort((a, b) => new Date(b.last_tx_date) - new Date(a.last_tx_date)); // mới nhất trước

    if (closed.length === 0) return "";

    let totalRealized = 0;
    let wins = 0, losses = 0;
    for (const c of closed) {
      const r = (c.realized_pnl || 0) * 1000; // k-VND → VND
      totalRealized += r;
      if (r > 0) wins++;
      else if (r < 0) losses++;
    }
    const winRate = closed.length > 0 ? (wins / closed.length) * 100 : 0;

    const items = closed.map((c) => {
      const realized = (c.realized_pnl || 0) * 1000; // VND
      const realizedPct = c.total_bought > 0 && c.avg_cost > 0
        ? (realized / (c.total_bought * c.avg_cost * 1000)) * 100
        : 0;
      const cls = realized >= 0 ? "up" : "down";
      const sign = realized >= 0 ? "+" : "";
      const firstDate = c.first_buy_date ? new Date(c.first_buy_date).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" }) : "--";
      const lastDate = c.last_tx_date ? new Date(c.last_tx_date).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" }) : "--";
      const days = c.first_buy_date && c.last_tx_date
        ? Math.round((new Date(c.last_tx_date) - new Date(c.first_buy_date)) / 86400000)
        : null;
      return `
        <div class="closed-item">
          <div class="closed-row1">
            <span class="closed-symbol">${c.symbol}</span>
            <span class="closed-pnl pct ${cls}">${sign}${fmtMoney(realized)} (${sign}${realizedPct.toFixed(1)}%)</span>
          </div>
          <div class="closed-row2">
            <span class="closed-date">${firstDate} → ${lastDate}${days != null ? ` · ${days} ngày` : ""}</span>
            <span class="closed-qty">${(c.total_bought || 0).toLocaleString("vi-VN")} cp · avg ${fmtPriceK(c.avg_cost)}</span>
          </div>
        </div>
      `;
    }).join("");

    const totalCls = totalRealized >= 0 ? "up" : "down";
    const totalSign = totalRealized >= 0 ? "+" : "";

    return `
      <div class="port-closed-section" id="closed-section">
        <div class="port-closed-header" id="closed-header">
          <span>📋 Đã đóng vị thế (${closed.length}) · Realized: <b class="pct ${totalCls}">${totalSign}${fmtMoney(totalRealized)}</b> · Win ${winRate.toFixed(0)}%</span>
          <span class="port-closed-toggle" id="closed-toggle">▼</span>
        </div>
        <div class="port-closed-body" id="closed-body" style="display:none">
          ${items}
        </div>
      </div>
    `;
  }

  // ── Performance tab: forward-test tracker ──
  let perfTradesCache = null;
  let perfFetchedAt = 0;

  async function fetchTradeLog(forceRefresh = false) {
    const TTL = 60 * 1000;
    if (!forceRefresh && perfTradesCache && Date.now() - perfFetchedAt < TTL) {
      return perfTradesCache;
    }
    try {
      const r = await fetch("https://stock-pwa-bot.qngnhat.workers.dev/trade-log", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      perfTradesCache = json.trades || [];
      perfFetchedAt = Date.now();
      return perfTradesCache;
    } catch (e) {
      console.warn("[perf] fetch fail:", e.message);
      return perfTradesCache || [];
    }
  }

  // Backtest expectations per tier
  const TIER_BACKTEST = {
    "Premium":  { win: 61, avg: 2.62, sharpe: 1.90 },
    "Elite":    { win: 61, avg: 2.05, sharpe: 1.71 },
    "A":        { win: 56, avg: 0.81, sharpe: 0.67 },
    "B":        { win: 56, avg: 0.81, sharpe: 0.70 },
    "Momentum": { win: 60, avg: 0.78, sharpe: 0.60 },
    // Phase 1 verified: run_midterm_phase1.py + run_midterm_portfolio_100shares.py
    // Test 2025-26: Win 51.9%, avg +6.95%/trade, Sharpe +1.13, PF 2.82.
    // Annualized +29.8%/năm với 10M VND/signal trên 200M vốn.
    "MidTerm":  { win: 52, avg: 6.95, sharpe: 1.13 },
    // V1 verified: run_foreign_flow_deep.py.
    // Test 2026: Win 71.4%, avg +1.28%/trade, Sharpe +1.42, PF 1.61 (n=14 small).
    // Pattern: drop 3d<-5% + day green + RSI<50 + NN net 5d > 0.
    "FBO":      { win: 71, avg: 1.28, sharpe: 1.42 },
  };

  // Rule-based verdict — KHÔNG cảm tính, chỉ dựa số liệu
  function computeVerdict(trades, activeCount) {
    const resolved = trades.filter((t) => t.resolved_at);
    const n = resolved.length;
    const wins = resolved.filter((t) => t.is_win).length;
    const winRate = n > 0 ? (wins / n) * 100 : null;
    const totalRet = resolved.reduce((s, t) => s + parseFloat(t.net_ret || 0), 0);
    const avgRet = n > 0 ? (totalRet / n) * 100 : null;

    // Rule 1: app idle hoàn toàn
    if (n === 0 && activeCount === 0) {
      return {
        level: "idle",
        emoji: "🚨",
        title: "APP IDLE — KHÔNG SINH SIGNAL",
        body: "Trade log trống + 0 active picks. Worker scan đang không tìm thấy mã nào hợp lệ.",
        actions: [
          "Khả năng cao: signal logic quá strict (recall ~0.3%).",
          "Cần relax điều kiện Vol Climax / Strength Continuation, hoặc add pattern mới.",
          "Kiểm tra cron worker có chạy: <code>/scan-restart?secret=…</code>",
        ],
      };
    }

    // Rule 2: chờ resolve
    if (n === 0 && activeCount > 0) {
      return {
        level: "waiting",
        emoji: "⏳",
        title: "ĐANG CHỜ KẾT QUẢ FORWARD-TEST",
        body: `${activeCount} pick đang active, sẽ resolve sau 7 phiên giao dịch. Chưa có data thực để đánh giá.`,
        actions: ["Quay lại sau ≥7 phiên để xem actual P&L."],
      };
    }

    // Rule 3: sample nhỏ — chưa đủ kết luận
    if (n < 20) {
      return {
        level: "insufficient",
        emoji: "📊",
        title: `SAMPLE NHỎ (n=${n}) — CHƯA ĐỦ KẾT LUẬN`,
        body: `Win rate ${winRate.toFixed(1)}%, avg return ${avgRet >= 0 ? "+" : ""}${avgRet.toFixed(2)}%. Cần ít nhất 30 resolved trades để có statistical significance.`,
        actions: ["Đừng all-in dựa trên data này. Giữ size nhỏ, tích lũy thêm sample."],
      };
    }

    // Rule 4: lỗ thật
    if (winRate < 45 || avgRet < -0.5) {
      return {
        level: "losing",
        emoji: "🔴",
        title: "APP ĐANG LỖ — TẠM DỪNG ENTRY",
        body: `Win rate ${winRate.toFixed(1)}% (target ≥50%), avg return ${avgRet.toFixed(2)}% (target ≥+0.8%). Forward-test không validate backtest.`,
        actions: [
          "Tạm dừng entry theo signal app. Review backtest cho overfitting / survivorship bias.",
          "Check tier nào lỗ nhất (table phía dưới) — tắt tier đó trước.",
          "Re-run backtest với slippage realistic (cost 0.5-1%) trước khi dùng tiếp.",
        ],
      };
    }

    // Rule 5: hoà — không rõ rệt
    if (winRate < 55 && avgRet < 0.5) {
      return {
        level: "neutral",
        emoji: "🟡",
        title: "PERFORMANCE HOÀ — KHÔNG RÕ EDGE",
        body: `Win rate ${winRate.toFixed(1)}%, avg return ${avgRet.toFixed(2)}%. Đang break-even sau cost — không có edge rõ ràng.`,
        actions: [
          "Giảm size 50% cho đến khi có tier ăn rõ.",
          "Xem table per-tier: tier nào lệch âm nhiều thì tắt, giữ tier ăn nhất.",
        ],
      };
    }

    // Rule 6: ăn rõ
    return {
      level: "winning",
      emoji: "🟢",
      title: "APP ĐANG ĂN — TIẾP TỤC THEO SIGNAL",
      body: `Win rate ${winRate.toFixed(1)}%, avg return +${avgRet.toFixed(2)}%. Forward-test xác nhận edge.`,
      actions: [
        "Tiếp tục entry theo signal, size theo Kelly per-tier như config.",
        "Vẫn check drawdown circuit breaker — 3 consec losses → pause 5 phiên.",
      ],
    };
  }

  function renderVerdictCard(verdict) {
    const actionsHtml = verdict.actions.map((a) => `<li>${a}</li>`).join("");
    return `
      <div class="perf-verdict verdict-${verdict.level}">
        <div class="verdict-header">
          <span class="verdict-emoji">${verdict.emoji}</span>
          <span class="verdict-title">${verdict.title}</span>
        </div>
        <div class="verdict-body">${verdict.body}</div>
        <ul class="verdict-actions">${actionsHtml}</ul>
      </div>`;
  }

  // Per-tier action recommendation dựa trên discrepancy vs backtest
  function tierAction(tier, n, avgActual, avgBacktest) {
    if (n < 5) return { label: "Sample <5", cls: "tier-action-skip" };
    const diff = avgActual - avgBacktest; // điểm phần trăm
    if (diff < -1.0) return { label: "🚨 Tạm tắt tier", cls: "tier-action-stop" };
    if (diff < -0.5) return { label: "⚠️ Giảm size 50%", cls: "tier-action-reduce" };
    if (diff >= -0.2) return { label: "✅ OK", cls: "tier-action-ok" };
    return { label: "📊 Theo dõi tiếp", cls: "tier-action-watch" };
  }

  async function renderPerfTab() {
    const content = document.getElementById("perf-content");
    if (!content) return;
    content.innerHTML = `<div class="empty-state ranking-intro"><div class="empty-icon">⏳</div><p>Đang tải trade log...</p></div>`;

    // Fetch parallel: trade log + Climax active picks (verdict full picture)
    // Mid-term picks removed cùng tab Rà soát strip.
    const [trades] = await Promise.all([
      fetchTradeLog(true),
      fetchActiveClimaxPicks(true).catch(() => {}),
    ]);
    const climaxCount = activeClimaxPicks?.size || 0;
    const midTermCount = 0;
    const activeCount = climaxCount + midTermCount;
    const verdict = computeVerdict(trades, activeCount);

    // No trades AND no active → render verdict only (idle state)
    if (trades.length === 0) {
      content.innerHTML = `
        ${renderVerdictCard(verdict)}
        <div class="empty-state ranking-intro" style="margin-top: 20px;">
          <div class="empty-icon">📊</div>
          <p><b>Chưa có forward-test data</b></p>
          <p>Mỗi lần app fire signal (Premium/Elite/A/B/Momentum/MidTerm), trade log ghi nhận.</p>
          <p>Mid-term resolve sau T+30 trading (~44 ngày). Classical resolve sau T+5 (~7 ngày).</p>
        </div>`;
      return;
    }

    const resolved = trades.filter((t) => t.resolved_at);
    const unresolved = trades.filter((t) => !t.resolved_at);

    // Per-tier stats
    const tiers = {};
    for (const t of resolved) {
      if (!tiers[t.tier]) tiers[t.tier] = { n: 0, wins: 0, sumRet: 0 };
      tiers[t.tier].n++;
      if (t.is_win) tiers[t.tier].wins++;
      tiers[t.tier].sumRet += parseFloat(t.net_ret || 0);
    }

    // Overall
    const totalN = resolved.length;
    const totalWins = resolved.filter((t) => t.is_win).length;
    const totalRet = resolved.reduce((s, t) => s + parseFloat(t.net_ret || 0), 0);

    let html = `
      ${renderVerdictCard(verdict)}
      <div class="perf-summary">
        <div class="perf-summary-card">
          <div class="perf-summary-label">Total resolved</div>
          <div class="perf-summary-value">${totalN}</div>
          <div class="perf-summary-sub">${unresolved.length} đang chờ</div>
        </div>
        <div class="perf-summary-card">
          <div class="perf-summary-label">Win rate actual</div>
          <div class="perf-summary-value">${totalN > 0 ? ((totalWins / totalN) * 100).toFixed(1) : "--"}%</div>
          <div class="perf-summary-sub">${totalWins}/${totalN}</div>
        </div>
        <div class="perf-summary-card">
          <div class="perf-summary-label">Avg net return</div>
          <div class="perf-summary-value ${totalRet >= 0 ? "up" : "down"}">${totalN > 0 ? ((totalRet / totalN) * 100).toFixed(2) : "--"}%</div>
          <div class="perf-summary-sub">per trade</div>
        </div>
        <div class="perf-summary-card">
          <div class="perf-summary-label">Cumulative</div>
          <div class="perf-summary-value ${totalRet >= 0 ? "up" : "down"}">${(totalRet * 100).toFixed(1)}%</div>
          <div class="perf-summary-sub">gross sum</div>
        </div>
      </div>

      <div class="perf-section">
        <h3>📈 Equity curve (actual vs backtest expected)</h3>
        <div id="perf-equity-chart" style="height: 240px; width: 100%;"></div>
        <div class="perf-chart-hint">Solid line = actual cumulative. Dashed = backtest expectation cùng số trades.</div>
      </div>

      <div class="perf-section">
        <h3>📉 Drawdown (running peak to trough)</h3>
        <div id="perf-drawdown-chart" style="height: 160px; width: 100%;"></div>
      </div>

      <div class="perf-section">
        <h3>Actual vs Backtest expectation</h3>
        <table class="perf-table">
          <thead>
            <tr>
              <th>Tier</th>
              <th>n</th>
              <th>Win actual</th>
              <th>Win backtest</th>
              <th>Avg actual</th>
              <th>Avg backtest</th>
              <th>Discrepancy</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
    `;
    for (const [tier, s] of Object.entries(tiers)) {
      const bt = TIER_BACKTEST[tier] || { win: 0, avg: 0 };
      const winActual = (s.wins / s.n) * 100;
      const avgActual = (s.sumRet / s.n) * 100;
      const winDiff = winActual - bt.win;
      const avgDiff = avgActual - bt.avg;
      const ok = winDiff >= -10 && avgDiff >= -0.5;
      const action = tierAction(tier, s.n, avgActual, bt.avg);
      html += `
        <tr>
          <td><b>${tier}</b></td>
          <td>${s.n}</td>
          <td>${winActual.toFixed(1)}%</td>
          <td>${bt.win}%</td>
          <td class="${avgActual >= 0 ? "up" : "down"}">${avgActual >= 0 ? "+" : ""}${avgActual.toFixed(2)}%</td>
          <td>${bt.avg >= 0 ? "+" : ""}${bt.avg.toFixed(2)}%</td>
          <td>${ok ? "✅" : "⚠️"} ${(avgDiff >= 0 ? "+" : "") + avgDiff.toFixed(2)}%</td>
          <td class="${action.cls}">${action.label}</td>
        </tr>`;
    }
    html += `</tbody></table>
      <div class="perf-chart-hint" style="margin-top:8px">
        <b>Action rule:</b> Tạm tắt nếu avg actual lệch &lt; −1.0% so với backtest. Giảm size 50% nếu lệch −0.5% đến −1.0%. OK nếu lệch ≥ −0.2%.
      </div>
    </div>`;

    // Recent trades table
    html += `<div class="perf-section">
      <h3>Recent trades (last 20)</h3>
      <table class="perf-table">
        <thead><tr><th>Date</th><th>Mã</th><th>Tier</th><th>Entry</th><th>Exit</th><th>Reason</th><th>Net</th></tr></thead>
        <tbody>`;
    const recent = [...trades].sort((a, b) => b.signal_date.localeCompare(a.signal_date)).slice(0, 20);
    for (const t of recent) {
      const ret = t.net_ret != null ? (parseFloat(t.net_ret) * 100).toFixed(2) : "--";
      const cls = t.net_ret != null && parseFloat(t.net_ret) > 0 ? "up" : t.net_ret != null ? "down" : "";
      html += `
        <tr>
          <td>${t.signal_date}</td>
          <td><b>${t.symbol}</b>${t.is_premium ? " 💎" : ""}</td>
          <td>${t.tier}</td>
          <td>${parseFloat(t.entry_price).toFixed(2)}</td>
          <td>${t.exit_price ? parseFloat(t.exit_price).toFixed(2) : "..."}</td>
          <td>${t.exit_reason || "pending"}</td>
          <td class="${cls}">${ret !== "--" ? (parseFloat(t.net_ret) > 0 ? "+" : "") + ret + "%" : "--"}</td>
        </tr>`;
    }
    html += `</tbody></table></div>`;

    content.innerHTML = html;

    // ── Render charts (after DOM exists) ──
    if (resolved.length >= 2 && typeof LightweightCharts !== "undefined") {
      renderPerfCharts(resolved);
    }
  }

  function renderPerfCharts(resolved) {
    // Sort by signal_date ascending
    const sorted = [...resolved].sort((a, b) => a.signal_date.localeCompare(b.signal_date));

    // Compute cumulative equity (actual)
    let cumActual = 0;
    let cumExpected = 0;
    let peak = 0;
    const actualData = [];
    const expectedData = [];
    const drawdownData = [];

    for (const t of sorted) {
      const ret = parseFloat(t.net_ret || 0);
      const expectedRet = (TIER_BACKTEST[t.tier]?.avg || 0) / 100; // backtest avg in %
      cumActual += ret;
      cumExpected += expectedRet;
      peak = Math.max(peak, cumActual);
      const drawdown = cumActual - peak;  // ≤ 0
      actualData.push({ time: t.signal_date, value: cumActual * 100 });
      expectedData.push({ time: t.signal_date, value: cumExpected * 100 });
      drawdownData.push({ time: t.signal_date, value: drawdown * 100 });
    }

    const chartOpts = {
      layout: {
        background: { type: "solid", color: "transparent" },
        textColor: "#aaa",
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.05)" },
        horzLines: { color: "rgba(255,255,255,0.05)" },
      },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.1)" },
      timeScale: { borderColor: "rgba(255,255,255,0.1)" },
      crosshair: { mode: 0 },
    };

    // Equity curve chart
    const equityEl = document.getElementById("perf-equity-chart");
    if (equityEl) {
      equityEl.innerHTML = "";
      const chart = LightweightCharts.createChart(equityEl, {
        ...chartOpts,
        width: equityEl.clientWidth,
        height: 240,
      });
      const actualSeries = chart.addLineSeries({
        color: "#4CAF50",
        lineWidth: 2,
        title: "Actual",
      });
      actualSeries.setData(actualData);
      const expectedSeries = chart.addLineSeries({
        color: "#ff9800",
        lineWidth: 1,
        lineStyle: 2,  // dashed
        title: "Backtest expected",
      });
      expectedSeries.setData(expectedData);
      chart.timeScale().fitContent();
    }

    // Drawdown chart
    const ddEl = document.getElementById("perf-drawdown-chart");
    if (ddEl) {
      ddEl.innerHTML = "";
      const chart2 = LightweightCharts.createChart(ddEl, {
        ...chartOpts,
        width: ddEl.clientWidth,
        height: 160,
      });
      const ddSeries = chart2.addAreaSeries({
        topColor: "rgba(255, 82, 82, 0.4)",
        bottomColor: "rgba(255, 82, 82, 0.05)",
        lineColor: "#ff5252",
        lineWidth: 2,
      });
      ddSeries.setData(drawdownData);
      chart2.timeScale().fitContent();
    }
  }

  document.getElementById("perf-refresh")?.addEventListener("click", () => {
    perfFetchedAt = 0;  // bust cache
    renderPerfTab();
  });

  // ── Portfolio render ──
  // Build TA verdict + key signals + smart recommendation for portfolio coach
  // Reuse detectors từ tab Kỹ thuật (detectMacdStatus, etc.)
  function buildPortfolioTaCoach(ana) {
    if (!ana || !ana._raw || !ana._raw.closes?.length) return null;
    const { opens, highs, lows, closes, volumes } = ana._raw;
    const n = closes.length;
    if (n < 30) return null;

    // Reuse detectors
    const candle = detectCandlePattern(opens, highs, lows, closes, n);
    const trend = detectTrendStatus({
      current: ana.current,
      ma20: ana.ma20, ma50: ana.ma50, ma200: ana.ma200,
    });
    const volAnalysis = detectVolumeAnalysis(volumes, closes, n);
    const rsiStatus = detectRsiStatus(ana.rsi);
    const macdStatus = detectMacdStatus(ana.macd);
    const adxStatus = detectAdxStatus(ana.adx);

    // Multi-bar patterns
    const pivots = findSwingPivots(highs, lows, 60, 3);
    const hhHl = detectHhHlStructure(pivots);
    const triangle = detectTrianglePattern(pivots, closes, n);
    const doubleTopBot = detectDoubleTopBottom(pivots, closes, n);

    // Compute verdict
    const verdict = buildTechnicalVerdict([
      candle, trend, volAnalysis, rsiStatus, macdStatus, adxStatus,
      hhHl, triangle, doubleTopBot,
    ]);

    // Pick TOP 5 most actionable signals (priority: pattern > trend > momentum)
    const signals = [];
    const pushSig = (s, prefix = "") => {
      if (s && s.sentiment) {
        const icon = s.sentiment === "bullish" ? "✓" : s.sentiment === "bearish" ? "✗" : "•";
        const label = s.label || s.name;
        if (label) signals.push({ icon, label: prefix + label, sentiment: s.sentiment });
      }
    };
    pushSig(doubleTopBot);
    pushSig(triangle);
    pushSig(hhHl);
    pushSig(macdStatus, "MACD: ");
    pushSig(adxStatus);
    pushSig(volAnalysis);
    pushSig(trend);
    pushSig(candle);
    pushSig(rsiStatus);

    // Smart recommendation based on verdict + position context
    let smartRec = null;
    const v = verdict.color;
    if (v === "strong-bull") {
      smartRec = "💎 Tín hiệu BULLISH MẠNH — giữ chặt, có thể trail SL lên swing low gần nhất";
    } else if (v === "mild-bull") {
      smartRec = "🟡 Momentum tích cực — hold + theo dõi, đặt SL bảo vệ lãi";
    } else if (v === "strong-bear") {
      smartRec = "🚨 Tín hiệu BEARISH MẠNH — cân nhắc chốt lời/cắt lỗ, nhiều cảnh báo";
    } else if (v === "mild-bear") {
      smartRec = "⚠️ Có cảnh báo bearish — thắt chặt SL, không add-on";
    } else {
      smartRec = "⚪ Tín hiệu hỗn hợp — hold theo plan, không can thiệp";
    }

    return {
      verdict,
      signals: signals.slice(0, 5),
      smartRec,
      // Suggest trail SL based on recent swing low (if uptrend)
      suggestedSL: (() => {
        if (verdict.color !== "strong-bull" && verdict.color !== "mild-bull") return null;
        const swingLows = pivots.filter((p) => p.type === "L").slice(-3);
        if (!swingLows.length) return null;
        const recentLow = swingLows[swingLows.length - 1];
        return recentLow.price;
      })(),
    };
  }

  async function renderPortfolio() {
    const container = $("portfolio-content");
    const empty = $("portfolio-empty");
    if (!container || !empty) return;

    bindTxModal();
    bindCashModal();

    // Fetch active climax picks (cache 5min) — không await, render dùng cache hiện tại
    fetchActiveClimaxPicks().catch(() => {});

    const holdings = PORTFOLIO.currentHoldings();
    const cash = PORTFOLIO.loadCash();
    const allTxs = PORTFOLIO.loadTransactions();

    if (holdings.length === 0 && allTxs.length === 0 && cash === 0) {
      empty.style.display = "block";
      container.innerHTML = "";
      // Direct bind cho safety (delegation đôi khi không fire trong PWA)
      const emptyBtn = $("portfolio-empty-add");
      if (emptyBtn && !emptyBtn.dataset.bound) {
        emptyBtn.dataset.bound = "1";
        emptyBtn.onclick = () => {
          console.log("[portfolio] empty-add direct clicked");
          openTxModal();
        };
      }
      return;
    }
    empty.style.display = "none";

    // Detect duplicate transactions (caused by old migration bug)
    const dupeCount = PORTFOLIO.countDuplicateTransactions();
    const dupeBannerHtml = dupeCount > 0 ? `
      <div class="dupe-banner" id="dupe-banner">
        <div class="dupe-banner-text">
          ⚠️ Phát hiện <b>${dupeCount}</b> giao dịch trùng lặp (do bug đồng bộ DB cũ). Khối lượng holdings có thể bị nhân đôi.
        </div>
        <button class="btn-primary" id="dedupe-btn">Dọn duplicates</button>
      </div>
    ` : "";

    // Show skeleton first, fetch analysis in background
    container.innerHTML = `
      ${dupeBannerHtml}
      <div class="port-summary-card" id="port-summary-card">
        <div class="port-summary-header">
          <span class="port-summary-title">📊 Tổng quan</span>
          <div class="port-summary-actions">
            <button class="link-btn" id="deposit-top">+ Nạp tiền</button>
            <button class="link-btn" id="add-tx-top">+ Giao dịch</button>
          </div>
        </div>
        <div class="port-summary-loading">Đang tải giá hiện tại...</div>
      </div>
      <div id="holdings-list">
        <div class="loading"><div class="spinner"></div><div>Đang phân tích từng mã...</div></div>
      </div>
      ${renderClosedPositions()}
    `;

    // Bind closed positions toggle
    const closedHeader = $("closed-header");
    const closedBody = $("closed-body");
    const closedToggle = $("closed-toggle");
    if (closedHeader && closedBody && closedToggle) {
      closedHeader.onclick = () => {
        const isOpen = closedBody.style.display === "block";
        closedBody.style.display = isOpen ? "none" : "block";
        closedToggle.textContent = isOpen ? "▼" : "▲";
      };
    }

    // Bind dedupe button
    const dedupeBtn = $("dedupe-btn");
    if (dedupeBtn) {
      dedupeBtn.onclick = async () => {
        if (!confirm(`Sẽ xóa ${dupeCount} giao dịch trùng lặp (giữ lại 1 cho mỗi cặp). Tiếp tục?`)) return;
        dedupeBtn.disabled = true;
        dedupeBtn.textContent = "Đang dọn...";
        const removed = await PORTFOLIO.dedupeTransactions();
        alert(`Đã xóa ${removed} giao dịch trùng lặp.`);
        renderPortfolio();
      };
    }

    // Load T+ top picks (cached) for "in-top" check
    try {
      const cached = JSON.parse(localStorage.getItem("tplus_top_picks_v1") || "null");
      if (cached?.data?.picks) {
        tplusTopSymbols = new Set(cached.data.picks.map((p) => p.symbol));
      }
    } catch {}

    // Fetch current price + analysis for each holding (parallel)
    // Also cache raw OHLCV (for TA verdict + pattern detection in coach)
    const enriched = await Promise.all(
      holdings.map(async (h) => {
        try {
          if (!portfolioAnalysisCache[h.symbol] ||
              Date.now() - portfolioAnalysisCache[h.symbol]._ts > 30 * 60 * 1000) {
            const data = await ANALYSIS.fetchHistory(h.symbol, "D", 250);
            const r = ANALYSIS.analyze(h.symbol, data, {});
            portfolioAnalysisCache[h.symbol] = { ...r, _raw: data, _ts: Date.now() };
          }
          return { ...h, analysis: portfolioAnalysisCache[h.symbol] };
        } catch (e) {
          return { ...h, analysis: null, error: e.message };
        }
      })
    );

    // Compute totals
    let totalCost = 0, totalMarket = 0;
    for (const h of enriched) {
      totalCost += h.cost_basis;
      if (h.analysis) {
        totalMarket += h.qty * h.analysis.current * 1000; // price in k-VND × qty
      }
    }
    const totalRealized = enriched.reduce((s, h) => s + (h.realized_pnl || 0) * 1000, 0); // k-VND

    // Wait: we compute cost_basis using qty * avg_cost where avg_cost stored in k-VND (raw price). Convert at display.
    // Actually let's normalize: in transactions, price is k-VND (since user inputs that). cost_basis = qty * avg_cost (k-VND). Multiply by 1000 to get VND.
    totalCost *= 1000;

    const unrealized = totalMarket - totalCost;
    const unrealizedPct = totalCost > 0 ? (unrealized / totalCost) * 100 : 0;
    const nav = totalMarket + cash;

    // Render summary
    const summaryCard = $("port-summary-card");
    if (summaryCard) {
      const pnlCls = unrealized >= 0 ? "up" : "down";
      const pnlSign = unrealized >= 0 ? "+" : "";
      summaryCard.innerHTML = `
        <div class="port-summary-header">
          <span class="port-summary-title">📊 Tổng quan</span>
          <div class="port-summary-actions">
            <button class="link-btn" id="deposit-top">+ Nạp tiền</button>
            <button class="link-btn" id="add-tx-top">+ Giao dịch</button>
          </div>
        </div>
        <div class="port-summary-grid">
          <div class="port-stat">
            <div class="port-stat-label">Tổng vốn</div>
            <div class="port-stat-value">${fmtMoney(totalCost)}</div>
          </div>
          <div class="port-stat">
            <div class="port-stat-label">Giá trị thị trường</div>
            <div class="port-stat-value">${fmtMoney(totalMarket)}</div>
          </div>
          <div class="port-stat">
            <div class="port-stat-label">Lãi/Lỗ chưa thực hiện</div>
            <div class="port-stat-value pct ${pnlCls}">${pnlSign}${unrealizedPct.toFixed(2)}%</div>
            <div class="port-stat-sub">${pnlSign}${fmtMoney(unrealized)}</div>
          </div>
          <div class="port-stat port-stat-clickable" id="cash-stat-card">
            <div class="port-stat-label">Cash <span class="port-stat-edit">Sửa</span></div>
            <div class="port-stat-value">${fmtMoney(cash)}</div>
          </div>
        </div>
        <div class="port-summary-foot">
          NAV: <b>${fmtMoney(nav)}</b>
          ${totalRealized !== 0 ? ` · Lãi/lỗ thực hiện: <b>${totalRealized >= 0 ? "+" : ""}${fmtMoney(totalRealized)}</b>` : ""}
          · ${enriched.length} mã
        </div>
        ${renderPortfolioRiskHints(enriched, totalMarket, cash, nav)}
      `;
      // Direct bind sau render (safety: delegation không phải lúc nào cũng fire)
      const addBtn = $("add-tx-top");
      if (addBtn) addBtn.onclick = () => openTxModal();
      const depBtn = $("deposit-top");
      if (depBtn) depBtn.onclick = () => openDepositModal();
      const cashCard = $("cash-stat-card");
      if (cashCard) cashCard.onclick = () => openCashModal();
    }

    // Render holdings list
    const list = $("holdings-list");
    if (list) {
      // Sort: by P&L % desc (winners first)
      enriched.sort((a, b) => {
        const pnlA = a.analysis ? (a.analysis.current - a.avg_cost) / a.avg_cost : 0;
        const pnlB = b.analysis ? (b.analysis.current - b.avg_cost) / b.avg_cost : 0;
        return pnlB - pnlA;
      });

      list.innerHTML = enriched.map((h) => {
        const ana = h.analysis;
        const cur = ana?.current || 0;
        const dayChange = ana?.dayChange || 0;
        const marketValue = h.qty * cur * 1000;
        const costBasis = h.cost_basis * 1000;
        const pnl = marketValue - costBasis;
        const pnlPct = costBasis > 0 ? (pnl / costBasis) * 100 : 0;
        const pnlCls = pnl >= 0 ? "up" : "down";
        const pnlSign = pnl >= 0 ? "+" : "";
        const dayCls = dayChange >= 0 ? "up" : "down";
        const daySign = dayChange >= 0 ? "+" : "";

        const climaxPick = activeClimaxPicks.get(h.symbol);
        const inTplusTop = tplusTopSymbols.has(h.symbol) || !!climaxPick;
        const action = ana ? PORTFOLIO.recommendAction(h, ana, inTplusTop) : null;
        const setupLabel = ana?.recommendation || "--";
        const setupColor = ana?.recColor || "#888";

        // TA Coach — verdict + signals + smart rec (reuse tab Kỹ thuật logic)
        const taCoach = ana ? buildPortfolioTaCoach(ana) : null;

        // Coach UI: T+ chip, RSI chip, range bar SL←now→target
        const coach = action?.coach;

        // Authoritative override: nếu climax pick từ DB → dùng signal_date + entry_price plan
        if (coach && climaxPick) {
          coach.isTplusPick = true;
          coach.climaxTier = climaxPick.tier;
          coach.climaxSignalDate = climaxPick.signal_date;
          coach.climaxEntryPrice = climaxPick.entry_price;
          coach.peakPrice = climaxPick.peak_price ?? null;
          coach.peakDate = climaxPick.peak_date ?? null;
          coach.isPremium = climaxPick.is_premium === true;
          coach.nnNet5dBn = climaxPick.nn_net_5d_bn ?? null;
          // Trading days từ signal_date — đếm phiên (loại bỏ T7/CN)
          coach.tPlusPosition = tradingDaysBetween(climaxPick.signal_date, new Date());
          coach.daysHeld = coach.tPlusPosition;
          // Override target = DB target_price (entry × 1.03), SL = entry × 0.92
          if (cur > 0) {
            const targetP = climaxPick.target_price;
            const slP = climaxPick.entry_price * 0.92;
            coach.distTarget = { price: targetP, pct: ((targetP - cur) / cur) * 100 };
            coach.distSL = { price: slP, pct: ((cur - slP) / cur) * 100 };
          }
        } else if (coach && coach.tPlusPosition != null && coach.daysHeld != null && h.first_buy_date) {
          // Non-climax: chuyển daysHeld calendar → trading days
          coach.tPlusPosition = tradingDaysBetween(h.first_buy_date, new Date());
          coach.daysHeld = coach.tPlusPosition;
        }
        const chipsHtml = coach ? (() => {
          const chips = [];
          if (coach.isPremium) {
            const nnTag = coach.nnNet5dBn != null ? ` · NN +${coach.nnNet5dBn}B/5d` : "";
            chips.push(`<span class="coach-chip coach-chip-premium">💎 Premium${nnTag}</span>`);
          }
          if (coach.tPlusPosition != null) {
            const lbl = coach.isTplusPick
              ? `T+${coach.tPlusPosition} · ${coach.climaxTier || "Climax"}`
              : `T+${coach.tPlusPosition} · ${coach.daysHeld}d held`;
            const cls = coach.isTplusPick ? "coach-chip-tplus" : "coach-chip-neutral";
            chips.push(`<span class="coach-chip ${cls}">${lbl}</span>`);
          }
          // Peak tracker chip — show if peak exists post-entry
          if (coach.peakPrice && coach.climaxEntryPrice) {
            const peakGain = ((coach.peakPrice - coach.climaxEntryPrice) / coach.climaxEntryPrice) * 100;
            const curPx = coach.currentPrice;
            const drawdownFromPeak = curPx > 0 ? ((curPx - coach.peakPrice) / coach.peakPrice) * 100 : 0;
            const cls = drawdownFromPeak <= -3 ? "coach-chip-rsi-mild" : "coach-chip-neutral";
            chips.push(`<span class="coach-chip ${cls}">📈 Đỉnh ${coach.peakPrice.toFixed(2)} (+${peakGain.toFixed(1)}%)${drawdownFromPeak < -0.5 ? ` · cách đỉnh ${drawdownFromPeak.toFixed(1)}%` : ""}</span>`);
          }
          if (coach.rsiWarn === "strong") {
            chips.push(`<span class="coach-chip coach-chip-rsi-strong">🚨 RSI ${coach.rsiValue.toFixed(0)} (cực overbought)</span>`);
          } else if (coach.rsiWarn === "mild") {
            chips.push(`<span class="coach-chip coach-chip-rsi-mild">⚠️ RSI ${coach.rsiValue.toFixed(0)} (overbought)</span>`);
          } else if (coach.rsiValue != null && coach.rsiValue <= 30) {
            chips.push(`<span class="coach-chip coach-chip-rsi-low">RSI ${coach.rsiValue.toFixed(0)} (oversold)</span>`);
          }
          return chips.length ? `<div class="holding-chips">${chips.join("")}</div>` : "";
        })() : "";

        const rangeHtml = coach?.distSL && coach?.distTarget ? (() => {
          const sl = coach.distSL.price;
          const tp = coach.distTarget.price;
          const curPx = coach.currentPrice;
          const total = tp - sl;
          let pos = total > 0 ? ((curPx - sl) / total) * 100 : 50;
          let outClass = "";
          if (curPx <= sl) { pos = 0; outClass = "range-broken-sl"; }
          else if (curPx >= tp) { pos = 100; outClass = "range-hit-tp"; }
          pos = Math.max(0, Math.min(100, pos));
          return `
            <div class="holding-range">
              <div class="holding-range-labels">
                <span class="range-lbl-sl">SL ${sl.toFixed(2)}</span>
                <span class="range-lbl-cur">Now ${curPx.toFixed(2)}</span>
                <span class="range-lbl-tp">Target ${tp.toFixed(2)}</span>
              </div>
              <div class="holding-range-bar ${outClass}">
                <div class="holding-range-fill" style="width:${pos}%"></div>
                <div class="holding-range-marker" style="left:${pos}%"></div>
              </div>
              <div class="holding-range-stats">
                <span class="range-stat-sl">−${coach.distSL.pct.toFixed(1)}% tới SL</span>
                <span class="range-stat-tp">+${coach.distTarget.pct.toFixed(1)}% tới target</span>
              </div>
            </div>
          `;
        })() : "";

        return `
          <div class="holding-card" data-symbol="${h.symbol}">
            <div class="holding-row1">
              <span class="holding-symbol">${h.symbol}</span>
              <span class="holding-setup" style="color:${setupColor}">${setupLabel}</span>
              <span class="holding-day pct ${dayCls}">${daySign}${dayChange.toFixed(2)}%</span>
            </div>
            <div class="holding-row2">
              <span class="holding-qty">KL: <b>${h.qty.toLocaleString("vi-VN")}</b></span>
              <span class="holding-cost">Cost: <b>${fmtPriceK(h.avg_cost)}</b> → <b>${fmtPriceK(cur)}</b></span>
              <span class="holding-mv">${fmtMoney(marketValue)}</span>
            </div>
            <div class="holding-row3">
              <span class="holding-pnl pct ${pnlCls}">${pnlSign}${pnlPct.toFixed(2)}% (${pnlSign}${fmtMoney(pnl)})</span>
            </div>
            ${action ? `
              <div class="holding-action" style="border-left-color: ${action.color}">
                <span class="holding-action-icon">${action.icon}</span>
                <span class="holding-action-text">${action.text}</span>
              </div>
            ` : ""}
            ${taCoach ? `
              <div class="holding-ta-coach ta-${taCoach.verdict.color}">
                <div class="ta-coach-verdict">
                  <span class="ta-coach-label">${taCoach.verdict.label}</span>
                  <span class="ta-coach-count">${taCoach.signals.length} signals</span>
                </div>
                <div class="ta-coach-signals">
                  ${taCoach.signals.map((s) => `
                    <div class="ta-coach-sig sentiment-${s.sentiment}">
                      <span class="ta-coach-sig-icon">${s.icon}</span>
                      <span class="ta-coach-sig-text">${s.label}</span>
                    </div>
                  `).join("")}
                </div>
                <div class="ta-coach-rec">${taCoach.smartRec}</div>
                ${taCoach.suggestedSL && coach?.distSL ? `
                  <div class="ta-coach-trail">💡 Gợi ý trail SL: ${taCoach.suggestedSL.toFixed(2)}k (swing low gần nhất, thay vì SL cố định ${coach.distSL.price.toFixed(2)}k)</div>
                ` : ""}
              </div>
            ` : ""}
            ${chipsHtml}
            ${rangeHtml}
            ${coach?.distTarget && coach?.distSL ? `
              <div class="holding-copy-row">
                <button class="copy-chip copy-chip-target" data-copy="${coach.distTarget.price.toFixed(2)}" title="Copy giá target để đặt lệnh">
                  📋 Target <b>${coach.distTarget.price.toFixed(2)}</b>
                </button>
                <button class="copy-chip copy-chip-sl" data-copy="${coach.distSL.price.toFixed(2)}" title="Copy giá SL để check ATC">
                  📋 SL <b>${coach.distSL.price.toFixed(2)}</b>
                </button>
              </div>
            ` : ""}
            <div class="holding-actions-row">
              <button class="link-btn holding-analyze">Phân tích</button>
              ${action?.priority === 1 && pnl < 0
                ? `<button class="link-btn holding-add-tx holding-sell-cta" data-prefill-side="sell">+ Bán ${h.symbol}</button>`
                : `<button class="link-btn holding-add-tx">+ Giao dịch</button>`}
            </div>
          </div>
        `;
      }).join("");

      // Bind row buttons
      list.querySelectorAll(".holding-card").forEach((card) => {
        const sym = card.dataset.symbol;
        card.querySelector(".holding-analyze")?.addEventListener("click", () => {
          openHoldingDetail(sym);
        });
        card.querySelector(".holding-add-tx")?.addEventListener("click", (e) => {
          // Open modal pre-filled with symbol; nếu nút bán cam → pre-select side=sell
          openTxModal();
          $("tx-symbol").value = sym;
          const prefillSide = e.currentTarget?.dataset?.prefillSide;
          if (prefillSide === "sell") {
            document.querySelectorAll("#tx-side-toggle .seg-btn").forEach((b) =>
              b.classList.toggle("active", b.dataset.side === "sell")
            );
          }
          updateTxSummary();
        });
        card.querySelectorAll(".copy-chip").forEach((btn) => {
          btn.addEventListener("click", async (e) => {
            const price = btn.dataset.copy;
            if (!price) return;
            try {
              await navigator.clipboard.writeText(price);
              const original = btn.innerHTML;
              btn.classList.add("copy-chip-copied");
              btn.innerHTML = `✅ Copied <b>${price}</b>`;
              setTimeout(() => {
                btn.classList.remove("copy-chip-copied");
                btn.innerHTML = original;
              }, 1500);
            } catch {
              btn.innerHTML = "❌ Copy fail";
            }
          });
        });
      });
    }
  }

  // Bind portfolio buttons (delegated, since portfolio re-renders)
  document.addEventListener("click", (e) => {
    if (e.target.closest?.("#portfolio-empty-add")) {
      console.log("[portfolio] empty-add clicked");
      openTxModal();
    }
    if (e.target.closest?.("#add-tx-top")) {
      console.log("[portfolio] add-tx-top clicked");
      openTxModal();
    }
    if (e.target.closest?.("#deposit-top")) {
      console.log("[portfolio] deposit-top clicked");
      openDepositModal();
    }
    if (e.target.closest?.("#cash-stat-card")) {
      console.log("[portfolio] cash card clicked");
      openCashModal();
    }
  });

  // Re-render portfolio when switching to that tab
  // Direct bind on tab button (more reliable than delegation)
  const portfolioTab = document.querySelector('.tab-btn[data-tab="portfolio"]');
  if (portfolioTab) {
    portfolioTab.addEventListener("click", () => {
      console.log("[portfolio] tab clicked, render in 50ms");
      setTimeout(renderPortfolio, 50);
    });
  }

  // ── Back to top button (mobile UX) ──
  const backToTopBtn = document.getElementById("back-to-top");
  if (backToTopBtn) {
    let ticking = false;
    const updateVisibility = () => {
      const show = window.scrollY > 400;
      backToTopBtn.classList.toggle("visible", show);
      ticking = false;
    };
    window.addEventListener("scroll", () => {
      if (!ticking) {
        requestAnimationFrame(updateVisibility);
        ticking = true;
      }
    }, { passive: true });
    backToTopBtn.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  // ── Init ──
  renderHistory();
  ensureStockList();

  // Settings modal close handlers (bound once)
  const settingsClose = document.getElementById("settings-close");
  const settingsBackdrop = document.getElementById("settings-backdrop");
  if (settingsClose) settingsClose.addEventListener("click", closeSettings);
  if (settingsBackdrop) settingsBackdrop.addEventListener("click", closeSettings);

  // Command palette handlers
  const cmdpInput = document.getElementById("cmdp-input");
  const cmdpResults = document.getElementById("cmdp-results");
  const cmdpBackdrop = document.getElementById("cmdp-backdrop");
  if (cmdpBackdrop) cmdpBackdrop.addEventListener("click", closeCmdp);
  if (cmdpInput) {
    cmdpInput.addEventListener("input", (e) => {
      cmdpResultsCache = searchCmdp(e.target.value);
      cmdpSelectedIdx = 0;
      renderCmdpResults();
    });
    cmdpInput.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        cmdpSelectedIdx = Math.min(cmdpSelectedIdx + 1, cmdpResultsCache.length - 1);
        renderCmdpResults();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        cmdpSelectedIdx = Math.max(cmdpSelectedIdx - 1, 0);
        renderCmdpResults();
      } else if (e.key === "Enter") {
        e.preventDefault();
        executeCmdpResult(cmdpSelectedIdx);
      }
    });
  }
  if (cmdpResults) {
    cmdpResults.addEventListener("click", (e) => {
      const row = e.target.closest(".cmdp-row");
      if (!row) return;
      executeCmdpResult(parseInt(row.dataset.idx, 10));
    });
  }

  // Global keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    // Esc closes any modal
    if (e.key === "Escape") {
      if (document.getElementById("cmdp")?.classList.contains("open")) {
        closeCmdp();
        return;
      }
      if (document.getElementById("settings-modal")?.classList.contains("open")) {
        closeSettings();
        return;
      }
    }
    // Cmd+K / Ctrl+K → open palette
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      const cmdp = document.getElementById("cmdp");
      if (cmdp?.classList.contains("open")) closeCmdp();
      else openCmdp();
      return;
    }
    // "/" → open palette (only if not typing in input)
    if (e.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
      e.preventDefault();
      openCmdp();
    }
  });

  // Offline banner: show/hide based on navigator.onLine
  const offlineBanner = document.getElementById("offline-banner");
  function syncOfflineBanner() {
    const offline = !navigator.onLine;
    if (offlineBanner) offlineBanner.hidden = !offline;
    document.body.classList.toggle("is-offline", offline);
  }
  initTheme();
  syncOfflineBanner();
  window.addEventListener("online", syncOfflineBanner);
  window.addEventListener("offline", syncOfflineBanner);

  // Register service worker + auto-update on new deploy
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").then((reg) => {
        // Check for updates every time app loads
        reg.update();
        reg.addEventListener("updatefound", () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener("statechange", () => {
            if (nw.state === "installed" && navigator.serviceWorker.controller) {
              // New version ready — reload to apply
              window.location.reload();
            }
          });
        });
      }).catch(() => {});
    });
  }
})();
