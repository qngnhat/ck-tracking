// ═══════════════════════════════════════
// Stock Analyzer PWA — App Controller
// ═══════════════════════════════════════

(function () {
  "use strict";

  const ANALYSIS = window.__SSI_ANALYSIS__;
  const HISTORY_KEY = "stock_analyzer_history";
  const HISTORY_MAX = 10;
  const STOCK_LIST_KEY = "stock_list_v1";
  const STOCK_LIST_EXPIRY_KEY = "stock_list_expiry";
  const STOCK_LIST_TTL = 7 * 24 * 3600 * 1000; // 7 days
  const SUGGEST_MAX = 8;

  let stockList = [];

  const $ = (id) => document.getElementById(id);

  // ── Formatters ──
  function fp(n) {
    if (n === null || n === undefined || isNaN(n)) return "--";
    // Round to 4 decimals to absorb float artifacts, then trim trailing zeros via locale
    return n.toLocaleString("vi-VN", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 4,
    });
  }

  function fmtVol(n) {
    if (!n || isNaN(n)) return "--";
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return n.toFixed(0);
  }

  function fmtFlow(v) {
    if (v === null || v === undefined) return '<span class="flow-neu">--</span>';
    const cls = v > 0 ? "flow-pos" : v < 0 ? "flow-neg" : "flow-neu";
    const sign = v > 0 ? "+" : "";
    const bil = v / 1e9;
    const text = Math.abs(bil) >= 1
      ? `${sign}${bil.toFixed(2)} tỷ`
      : `${sign}${(v / 1e6).toFixed(1)} tr`;
    return `<span class="${cls}">${text}</span>`;
  }

  function peBadge(pe) {
    if (!pe) return "";
    if (pe < 10 && pe > 0) return '<span class="badge badge-cheap">Rẻ</span>';
    if (pe > 25) return '<span class="badge badge-exp">Đắt</span>';
    return '<span class="badge badge-fair">Hợp lý</span>';
  }

  function pbBadge(pb) {
    if (!pb) return "";
    if (pb < 1) return '<span class="badge badge-cheap">Dưới BV</span>';
    if (pb > 3) return '<span class="badge badge-exp">Đắt</span>';
    return '<span class="badge badge-fair">Hợp lý</span>';
  }

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

  // ── Market hours (Vietnam: Mon-Fri, 9:00-11:30 & 13:00-14:45) ──
  function isMarketOpen() {
    const vnTime = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
    const day = vnTime.getDay();
    if (day === 0 || day === 6) return false;
    const min = vnTime.getHours() * 60 + vnTime.getMinutes();
    if (min >= 540 && min <= 690) return true;   // 9:00 - 11:30
    if (min >= 780 && min <= 885) return true;   // 13:00 - 14:45
    return false;
  }

  function fmtTime(d) {
    return d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
  }

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
      bindForwardStatsPoolBtn();
      bindTplusWatchBtn();
      window.scrollTo({ top: 0, behavior: "smooth" });
      startAutoRefresh();
    } catch (err) {
      showError(`Lỗi tải dữ liệu: ${err.message}`, () => analyzeSymbol(symbol));
    }
  }

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
    chartInstance = window.LightweightCharts.createChart(container, {
      width: chartWidth,
      height: 320,
      layout: {
        background: { color: "#0f0f1e" },
        textColor: "#a0a0b0",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#1f1f2e" },
        horzLines: { color: "#1f1f2e" },
      },
      rightPriceScale: {
        borderColor: "#2a2a3e",
      },
      timeScale: {
        borderColor: "#2a2a3e",
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
      upColor: "#4CAF50",
      downColor: "#ff4444",
      borderUpColor: "#4CAF50",
      borderDownColor: "#ff4444",
      wickUpColor: "#4CAF50",
      wickDownColor: "#ff4444",
    });
    candleSeries.setData(candles);

    // MA20 line
    const ma20Line = chartInstance.addLineSeries({
      color: "#00d2ff",
      lineWidth: 1,
      title: "MA20",
      priceLineVisible: false,
      lastValueVisible: false,
    });
    ma20Line.setData(ma20Series.filter((p) => p.value !== null));

    // MA50 line
    const ma50Line = chartInstance.addLineSeries({
      color: "#ff9800",
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
    if (analyzeContext === "tplus") return "tplus";
    const persisted = localStorage.getItem(ANALYSIS_TAB_KEY);
    if (["overview", "tplus"].includes(persisted)) return persisted;
    return "overview";
  }

  function setAnalysisTab(mode) {
    if (!["overview", "technical", "tplus"].includes(mode)) mode = "overview";
    document.querySelectorAll(".analysis-tab").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === mode);
    });
    document.querySelectorAll(".analysis-tab-content").forEach((c) => {
      c.style.display = c.dataset.mode === mode ? "block" : "none";
    });
    localStorage.setItem(ANALYSIS_TAB_KEY, mode);

    if (mode === "tplus") {
      const c = $("analysis-tab-tplus");
      if (c && !c.dataset.loaded) lazyLoadTplusTab();
    }
    if (mode === "technical") {
      initTechnicalTabHandlers();
    }
  }

  async function lazyLoadTplusTab() {
    const container = $("analysis-tab-tplus");
    if (!container || !lastAnalysisResult) return;
    container.dataset.loaded = "1";
    container.innerHTML = `<div class="loading"><div class="spinner"></div><div>Tìm ${lastAnalysisResult.symbol} trong Top T+...</div></div>`;
    try {
      const result = await RANKING.loadTopPicksTPlus();
      const picks = result?.picks || [];
      const idx = picks.findIndex((p) => p.symbol === lastAnalysisResult.symbol);
      if (idx >= 0) {
        container.innerHTML = renderTplusContextCard(picks[idx], idx + 1, lastAnalysisResult);
      } else {
        container.innerHTML = renderTplusNotInTopFallback(lastAnalysisResult);
      }
      // Bind watch + pool buttons after lazy render (T+ context card has watch btn)
      bindTplusWatchBtn();
      bindForwardStatsPoolBtn();
    } catch (e) {
      container.dataset.loaded = "";
      container.innerHTML = `<div class="error">Lỗi tải Top T+: ${e.message} <button class="link-btn" onclick="document.querySelector('.analysis-tab[data-mode=tplus]').click()">Thử lại</button></div>`;
    }
  }

  function renderTplusNotInTopFallback(r) {
    const eligibility = renderTplusEligibilityCheck(r);
    return `
      <div class="an-card context-card context-tplus">
        <div class="context-header">
          <span class="context-icon">⚡</span>
          <div>
            <div class="context-title">T+ · Không trong Top hôm nay</div>
            <div class="context-subtitle">Mã ${r.symbol} không lọt Top T+ picks — kiểm tra eligibility dưới</div>
          </div>
        </div>
        <div class="context-disclaimer">
          T+ scoring áp dụng confluence rules (RSI quá bán + ADX yếu + vol > TB + …). Mã không đạt confluence sẽ không hiện trong top.
        </div>
      </div>
      ${eligibility}
    `;
  }

  function renderAnalysis(r) {
    lastAnalysisResult = r;
    const root = $("analysis-root");

    root.innerHTML = `
      <div class="analysis-tabs" role="tablist">
        <button class="analysis-tab" data-mode="overview" type="button" role="tab">📊 Tổng quan</button>
        <button class="analysis-tab" data-mode="technical" type="button" role="tab">🔍 Kỹ thuật</button>
        <button class="analysis-tab" data-mode="tplus" type="button" role="tab">⚡ T+ Plan</button>
      </div>
      <div class="analysis-tab-content" data-mode="overview" id="analysis-tab-overview"></div>
      <div class="analysis-tab-content" data-mode="technical" id="analysis-tab-technical" style="display:none"></div>
      <div class="analysis-tab-content" data-mode="tplus" id="analysis-tab-tplus" style="display:none"></div>
    `;

    // Overview = current default content (always rendered)
    $("analysis-tab-overview").innerHTML = renderOverviewTabContent(r);
    // Technical tab — pattern + vol + S/R + trend analysis
    $("analysis-tab-technical").innerHTML = renderTechnicalTabContent(r);

    // Pre-render T+ tab if context exists (came from Ranking click)
    if (analyzeContext === "tplus" && analyzeContextPick) {
      $("analysis-tab-tplus").innerHTML = renderTplusContextCard(analyzeContextPick, analyzeContextRank, r);
      $("analysis-tab-tplus").dataset.loaded = "1";
    }

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
    technicalChartInstance = window.LightweightCharts.createChart(container, {
      width: chartWidth, height: 320,
      layout: { background: { color: "#0f0f1e" }, textColor: "#a0a0b0", fontSize: 11 },
      grid: { vertLines: { color: "#1f1f2e" }, horzLines: { color: "#1f1f2e" } },
      rightPriceScale: { borderColor: "#2a2a3e" },
      timeScale: { borderColor: "#2a2a3e", timeVisible: false },
      crosshair: { mode: 1 },
    });
    const candleSeries = technicalChartInstance.addCandlestickSeries({
      upColor: "#4CAF50", downColor: "#ff4444",
      borderUpColor: "#4CAF50", borderDownColor: "#ff4444",
      wickUpColor: "#4CAF50", wickDownColor: "#ff4444",
    });
    candleSeries.setData(candles);
    if (ma20Series.length) {
      const ma20Line = technicalChartInstance.addLineSeries({ color: "#00d2ff", lineWidth: 1, title: "MA20", priceLineVisible: false, lastValueVisible: false });
      ma20Line.setData(ma20Series.filter((p) => p.value !== null));
    }
    if (ma50Series.length) {
      const ma50Line = technicalChartInstance.addLineSeries({ color: "#FFC107", lineWidth: 1, title: "MA50", priceLineVisible: false, lastValueVisible: false });
      ma50Line.setData(ma50Series.filter((p) => p.value !== null));
    }
    if (ma200Series.length) {
      const ma200Line = technicalChartInstance.addLineSeries({ color: "#ef5350", lineWidth: 1, title: "MA200", priceLineVisible: false, lastValueVisible: false });
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

  // ── Level Analysis: S/R touch + BB + 52w + MA + Confluence ──────

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

    return `
      <div class="ta-verdict ta-${verdict.color}">
        <div class="ta-verdict-label">${verdict.label}</div>
        <div class="ta-verdict-desc">${verdict.desc} <small>(phân tích trên nến ${tfLabel})</small></div>
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
    // Initial chart render
    if (currentData) {
      requestAnimationFrame(() => renderTechnicalChart("technical-chart-container", currentData));
    }
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

      ${renderStockProfileCard(r)}

      ${renderTplusEligibilityCheck(r)}

      ${renderForwardStatsCard(r)}

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

  // ── Hold profile (dynamic theo signal mã) ──
  // 4 preset thay vì continuous formula — magnitude xác định, dễ test/backtest sau.
  function estimateHoldProfile(r) {
    if (r?.flags?.bearTrap) return {
      icon: "⚠️", label: "Bear trap risk", min: 3, max: 7,
      hint: "Cắt sớm nếu sau 5 phiên setup không trigger (RSI vẫn dưới 30 + vol thấp).",
    };
    if (r?.rsi !== null && r?.rsi !== undefined && r.rsi < 20
        && r?.volRatio !== undefined && r.volRatio >= 1.5) return {
      icon: "🔥", label: "Bounce nhanh", min: 3, max: 7,
      hint: "Catalyst rõ — bounce thường về MA20 trong 5-7 phiên.",
    };
    if (r?.atrPct !== null && r?.atrPct !== undefined && r.atrPct < 2) return {
      icon: "🐢", label: "Hồi chậm", min: 8, max: 15,
      hint: "Biến động thấp → cần kiên nhẫn. Reset thesis sau 10 phiên không động.",
    };
    return {
      icon: "⚡", label: "Standard mean-rev", min: 5, max: 12,
      hint: "Sau 10 phiên không hồi → review thesis.",
    };
  }

  // ── TP targets (shared giữa T+ context + action card) ──
  // Cap +10% (TP1) / +18% (TP2). Ưu tiên structure (MA20/resistance) khi nó nằm
  // trong cap VÀ trên current/tp1. Tránh bug TP <= current.
  function computeTpTargets(r) {
    const c = r.current;
    if (!c) return { tp1: null, tp2: null };
    const tp1Cap = c * 1.10;
    const tp2Cap = c * 1.18;
    const tp1 = (r.ma20 && r.ma20 > c && r.ma20 <= tp1Cap) ? r.ma20 : tp1Cap;
    const tp2 = (r.resistance && r.resistance > tp1 && r.resistance <= tp2Cap) ? r.resistance : tp2Cap;
    return { tp1, tp2 };
  }

  // ── Bayesian win probability (T+ context) ──
  // Multipliers từ backtest 2492 trades, hold 10 phiên, score≥4 cross-section 58 mã DCA.
  // Source: backtest/results/bayesian_flags/multipliers.json (Phase 6a).
  // CAVEAT: cross-stock pooled. Individual mã behavior có thể khác.
  // Sample lowSessionLiq nhỏ (n=6) → multiplier 0.638 không robust.
  const BAYES_BASELINE_WIN = 0.523; // T+ score≥4, hold 10 phiên baseline win rate
  const BAYES_MULTIPLIERS = {
    bearTrap:      1.078, // FLAG ON win 56.4% vs 51.5% off (n_on=417)
    sellPressure:  1.048, // FLAG ON win 54.8% vs 51.4% off (n_on=622)
    deepDowntrend: 1.105, // FLAG ON win 57.8% vs 46.1% off (n_on=1322) — strongest positive
    lowVol:        0.908, // FLAG ON win 47.5% vs 53.7% off (n_on=558)
    volCritical:   0.905, // FLAG ON win 47.3% vs 52.4% off (n_on=74)
    lowSessionLiq: 0.638, // FLAG ON win 33% (n=6 — small sample, low confidence)
  };

  function computeBayesianWinProb(score, flags) {
    if (score == null || score < 4) return null; // baseline only valid for T+ pick threshold
    let prob = BAYES_BASELINE_WIN;
    const breakdown = [{ label: "Baseline T+ score≥4 (10 phiên)", value: BAYES_BASELINE_WIN }];
    for (const [flag, mul] of Object.entries(BAYES_MULTIPLIERS)) {
      if (flags?.[flag]) {
        prob *= mul;
        breakdown.push({ label: flag, value: mul });
      }
    }
    return { prob: Math.max(0, Math.min(1, prob)), breakdown };
  }

  // ── Verdict (decision layer) — DATA-DRIVEN theo Bayesian P(win) ──
  // Rewrite: trust Bayesian backtest data, KHÔNG dùng intuition "hard flag = risk".
  // Backtest cho thấy: bearTrap/sellPressure/deepDowntrend thực tế TĂNG P(win)
  // (contrarian setup, panic capitulation). lowSessionLiq + lowVol thật sự HẠI.
  // Bayesian đã capture impact của tất cả flag → verdict chỉ cần xét P(win).
  function getVerdict(score, flags, atrPct, bayesProb = null) {
    if (score === null || score === undefined || isNaN(score)) return null;

    // Score < 2 = không có signal nào, không vào
    if (score < 2) return { tag: "Avoid", color: "#ff4444", icon: "🔴",
      desc: "Score thấp, không có confluence. Không vào lệnh." };

    // Score 2-4 = chưa đủ confluence, chờ
    if (score < 4) return { tag: "Watchlist", color: "#FF9800", icon: "🟡",
      desc: "Score chưa đủ confluence (cần ≥ 4). Theo dõi thêm." };

    // Score >= 4: dựa Bayesian P(win) để quyết định
    // Auto-compute Bayesian nếu chưa pass vào
    if (bayesProb == null) {
      const b = computeBayesianWinProb(score, flags);
      bayesProb = b?.prob ?? null;
    }

    // Special case: lowSessionLiq là TRUE killer (Bayesian × 0.638 — n=6 small sample)
    if (flags?.lowSessionLiq) {
      return { tag: "Watchlist", color: "#FF9800", icon: "🟡",
        desc: "Thanh khoản cực thấp (vào dễ ra khó). Tránh hoặc size cực nhỏ." };
    }

    // No Bayesian data — fallback theo score
    if (bayesProb == null) {
      let sizeHint = atrPct != null && atrPct >= 3 ? "1/4 vốn (vol cao)" : "1/3 vốn";
      return { tag: "Spec Buy", color: "#4CAF50", icon: "🟢",
        desc: `Score ${score.toFixed(1)} đủ confluence — <b>${sizeHint}</b>. Cân nhắc chờ xác nhận.` };
    }

    // P(win) < 50% = không có edge thật → KHÔNG MUA
    if (bayesProb < 0.50) {
      return { tag: "Watchlist", color: "#FF9800", icon: "🟡",
        desc: `<b>P(win) ${(bayesProb * 100).toFixed(0)}% < flip coin</b> — risk flags hại edge. Bỏ qua hoặc chờ xác nhận đảo chiều.` };
    }

    // P(win) 50-53% = edge mỏng, borderline
    if (bayesProb < 0.53) {
      return { tag: "Spec Buy (borderline)", color: "#FFC107", icon: "🟡",
        desc: `Edge mỏng (P(win) ${(bayesProb * 100).toFixed(0)}%). Nếu vào: <b>1/4 vốn</b>, ưu tiên Confirmed entry.` };
    }

    // P(win) >= 53% = MUA
    let sizeHint;
    if (atrPct != null && atrPct >= 3) sizeHint = "1/4 vốn (biến động cao)";
    else if (bayesProb >= 0.58) sizeHint = "1/3 - 1/2 vốn (edge mạnh)";
    else sizeHint = "1/3 vốn";
    return { tag: "Spec Buy", color: "#4CAF50", icon: "🟢",
      desc: `Có thể vào — <b>${sizeHint}</b>, P(win) ${(bayesProb * 100).toFixed(0)}%.` };
  }

  // Volatility label từ ATR% — chỉ là proxy biến động, KHÔNG phải "risk cao = setup xấu"
  function getVolatilityLabel(atrPct) {
    if (atrPct == null) return null;
    if (atrPct >= 4) return { txt: "Biến động cao — chia size 1/3", color: "#ff5722" };
    if (atrPct >= 2.5) return { txt: "Biến động vừa", color: "#ff9800" };
    return { txt: "Biến động thấp", color: "#4CAF50" };
  }

  function renderRiskChips(flags) {
    if (!flags) return "";
    const chips = [];
    // Positive signals first (xanh)
    if (flags.strongLeader) chips.push({ label: "🚀 Strong leader (RS vs VNI)", color: "#4CAF50" });
    if (flags.breakoutFresh) chips.push({ label: "🎯 Fresh breakout", color: "#4CAF50" });
    if (flags.bullishDivergence) chips.push({ label: "📈 Bullish divergence", color: "#4CAF50" });
    // Negative signals (đỏ/cam)
    if (flags.distribution) chips.push({ label: "📦 Distribution (down-vol > up-vol)", color: "#ff5722" });
    if (flags.bearTrap) chips.push({ label: "⚠️ Bắt dao rơi", color: "#ff5722" });
    if (flags.sellPressure) chips.push({ label: "📉 Lực bán mạnh — vol cao + giá giảm", color: "#ff5722" });
    if (flags.volCritical) chips.push({ label: "🚨 Vol cực thấp — khó có lực hồi", color: "#ff5722" });
    else if (flags.lowVol) chips.push({ label: "Vol thấp — thiếu xác nhận", color: "#ff9800" });
    if (flags.weeklyDowntrend) chips.push({ label: "📅 Weekly RSI<50 — trung hạn yếu", color: "#ff9800" });
    if (flags.deepDowntrend) chips.push({ label: "Downtrend mạnh", color: "#ff9800" });
    if (flags.lowSessionLiq) chips.push({ label: "🐢 Kẹt hàng — vào dễ ra khó", color: "#ff9800" });
    if (chips.length === 0) return "";
    return `<div class="risk-chips">${chips.map((c) =>
      `<span class="risk-chip" style="border-color:${c.color}55;color:${c.color}">${c.label}</span>`
    ).join("")}</div>`;
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

  // ── Live tracker mode: hiển thị status thực-tế của watch đã subscribe ──
  // Khi user đã bấm "🔔 BÁO KHI TRIGGER MET" trước đó, lock thresholds tại
  // thời điểm subscribe. Mỗi lần mở app sau đó, compare current data với
  // thresholds locked → cho biết NGAY HÔM NAY nên hành động sao.
  function getTplusWatchData(symbol) {
    const watches = loadTplusWatches();
    return watches.find((w) => w.symbol === symbol) || null;
  }

  // Walk historical bars từ subscribe date → tìm các ngày met trigger
  // Phòng case: hôm trước trigger met (cron đã/chưa fire), nhưng user reset
  // watch hôm nay → mất context. Giờ vẫn hiển thị "đã có X lần met".
  function computeTriggerHistory(triggers, history, addedAt) {
    if (!history?.times || !history?.closes) return { events: [], totalDays: 0 };
    const events = [];
    let totalDays = 0;
    const minTs = Math.floor(addedAt / 1000);
    for (let i = 0; i < history.times.length; i++) {
      const ts = history.times[i];
      if (ts < minTs) continue;
      // Skip today (current bar) — already shown trong verdict trên
      const isToday = i === history.times.length - 1;
      if (isToday) continue;

      totalDays++;
      const close = history.closes[i];
      const vol = history.volumes?.[i];
      const open = history.opens?.[i];
      const dayMet = [];
      if (triggers.closeAbove && close >= triggers.closeAbove) {
        dayMet.push({ kind: "close", label: `close ${fp(close)} ≥ ${fp(triggers.closeAbove)}` });
      }
      if (triggers.volAbove && vol >= triggers.volAbove) {
        dayMet.push({ kind: "vol", label: `vol ${fmtVol(vol)} ≥ ${fmtVol(triggers.volAbove)}` });
      }
      if (triggers.gapAbove && open != null && open > triggers.gapAbove) {
        dayMet.push({ kind: "gap", label: `open ${fp(open)} > ${fp(triggers.gapAbove)} (gap)` });
      }
      if (dayMet.length > 0) {
        events.push({ ts, date: new Date(ts * 1000), met: dayMet });
      }
    }
    return { events, totalDays };
  }

  function computeLiveTrackerVerdict(triggers, r, watch) {
    const cur = r.current;
    const curOpen = r.dayOpen;
    const curVol = r.currentVol;
    const dayChange = r.dayChange ?? 0;
    const avgVol = r.avgVol;

    const checks = [];
    if (triggers.closeAbove) {
      const met = cur >= triggers.closeAbove;
      const pct = ((cur - triggers.closeAbove) / triggers.closeAbove) * 100;
      checks.push({
        kind: "closeAbove",
        label: "Giá hiện tại ≥ ngưỡng",
        threshold: triggers.closeAbove,
        thresholdLabel: `${fp(triggers.closeAbove)}`,
        currentLabel: `${fp(cur)}`,
        met,
        delta: `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
        hint: met ? "Giá đã vượt ngưỡng entry" : "Giá còn dưới ngưỡng",
      });
    }
    if (triggers.volAbove) {
      const met = curVol >= triggers.volAbove;
      const pctOfTarget = (curVol / triggers.volAbove) * 100;
      checks.push({
        kind: "volAbove",
        label: "Volume hôm nay ≥ ngưỡng",
        threshold: triggers.volAbove,
        thresholdLabel: fmtVol(triggers.volAbove),
        currentLabel: fmtVol(curVol),
        met,
        delta: `${pctOfTarget.toFixed(0)}% target`,
        hint: met ? "Lực cầu xác nhận" : `Còn cần thêm ${fmtVol(triggers.volAbove - curVol)} vol`,
      });
    }
    if (triggers.gapAbove) {
      const met = curOpen != null && curOpen > triggers.gapAbove;
      checks.push({
        kind: "gapAbove",
        label: "Phiên mở cửa > ngưỡng",
        threshold: triggers.gapAbove,
        thresholdLabel: `${fp(triggers.gapAbove)}`,
        currentLabel: curOpen != null ? `${fp(curOpen)}` : "--",
        met,
        delta: curOpen != null
          ? `${((curOpen - triggers.gapAbove) / triggers.gapAbove * 100).toFixed(2)}%`
          : "—",
        hint: met
          ? "Đã gap up — entry valid ATO"
          : (curOpen != null ? "Không gap up phiên này" : "Chưa có dữ liệu open"),
      });
    }

    const metCount = checks.filter((c) => c.met).length;
    const totalCount = checks.length;

    // Setup-fail check: rơi -3% kèm vol > 2× avg → khả năng cao reversal/distribution
    const setupFailed = dayChange <= -3 && avgVol && curVol > avgVol * 2;

    let verdict;
    if (setupFailed) {
      verdict = {
        tag: "ABANDON",
        icon: "❌",
        color: "#ff4444",
        bg: "rgba(255, 68, 68, 0.12)",
        title: "Setup có thể fail — đề xuất bỏ kèo",
        advice: `Giá rơi ${dayChange.toFixed(1)}% kèm vol cao (${(curVol / avgVol).toFixed(1)}× TB). Phân phối / reversal mạnh — tránh bắt đáy.`,
      };
    } else if (metCount === 0) {
      verdict = {
        tag: "CHỜ",
        icon: "⏳",
        color: "#FF9800",
        bg: "rgba(255, 152, 0, 0.10)",
        title: `0/${totalCount} trigger met — chờ tiếp`,
        advice: dayChange < -1
          ? "Giá đang yếu — chờ thêm nến rút chân hoặc end-of-day re-evaluate."
          : "Chưa có confluence rõ — giữ nguyên kế hoạch chờ trigger.",
      };
    } else if (metCount === 1) {
      verdict = {
        tag: "VÀO SIZE NHỎ",
        icon: "🟡",
        color: "#FFC107",
        bg: "rgba(255, 193, 7, 0.12)",
        title: `1/${totalCount} trigger met — vào với 50% size`,
        advice: "Có dấu hiệu confluence nhưng chưa mạnh. Vào trước 50% size, giữ cash chờ trigger thứ 2 confirm thêm.",
      };
    } else if (metCount >= 2) {
      verdict = {
        tag: "VÀO FULL SIZE",
        icon: "✅",
        color: "#4CAF50",
        bg: "rgba(76, 175, 80, 0.12)",
        title: `${metCount}/${totalCount} trigger confirmed — strong setup`,
        advice: metCount === totalCount
          ? "Cả 3 trigger đều met — confluence rất mạnh. Vào full size theo plan, set SL strict."
          : "Confluence rõ. Vào full size theo plan dưới.",
      };
    }

    return { checks, metCount, totalCount, verdict };
  }

  function renderLiveTrackerCard(pick, rank, r, watch) {
    const triggers = watch.triggers || {};
    const { checks, verdict } = computeLiveTrackerVerdict(triggers, r, watch);
    const subscribedAgo = watch.addedAt
      ? Math.max(0, Math.floor((Date.now() - watch.addedAt) / (24 * 3600 * 1000)))
      : null;
    const subscribedLabel = subscribedAgo == null
      ? ""
      : subscribedAgo === 0
      ? "subscribe hôm nay"
      : `subscribe ${subscribedAgo} ngày trước`;

    // Historical events: check past bars từ addedAt → coi đã met chưa
    const history = currentData; // raw OHLCV từ analyzeSymbol
    const { events, totalDays } = computeTriggerHistory(triggers, history, watch.addedAt || Date.now());
    const eventsHtml = events.length > 0
      ? `
        <div class="lt-history lt-history-fired">
          <div class="lt-history-title">🎯 Đã met trigger <b>${events.length} ngày</b> trong lịch sử (${totalDays} phiên qua từ Day 1)</div>
          <ul class="lt-history-list">
            ${events.slice(-5).reverse().map((e) => {
              const dateStr = e.date.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" });
              const reasonsTxt = e.met.map((m) => m.label).join(" · ");
              return `<li><b>${dateStr}</b>: ${reasonsTxt}</li>`;
            }).join("")}
          </ul>
          <div class="lt-history-hint">⚠️ Nếu mày từng reset trigger sau khi nó met, có thể đã missed notification. Cron worker chỉ fire 1 lần per watch.</div>
        </div>
      `
      : totalDays > 0
      ? `<div class="lt-history lt-history-clean">📜 ${totalDays} phiên qua từ Day 1 — chưa lần nào met trigger.</div>`
      : "";

    const cur = r.current;
    const symbol = watch.symbol;

    const checksHtml = checks.map((c) => {
      const cls = c.met ? "lt-check-met" : "lt-check-pending";
      const icon = c.met ? "✅" : "⏳";
      return `
        <div class="lt-check-row ${cls}">
          <div class="lt-check-head">
            <span class="lt-check-icon">${icon}</span>
            <span class="lt-check-label">${c.label}</span>
            <span class="lt-check-delta">${c.delta}</span>
          </div>
          <div class="lt-check-body">
            <span class="lt-check-current">Hiện tại: <b>${c.currentLabel}</b></span>
            <span class="lt-check-vs">vs</span>
            <span class="lt-check-threshold">Ngưỡng: <b>${c.thresholdLabel}</b></span>
          </div>
          <div class="lt-check-hint">${c.hint}</div>
        </div>
      `;
    }).join("");

    return `
      <div class="an-card context-card context-tplus lt-card">
        <div class="context-header">
          <span class="context-icon">🔔</span>
          <div>
            <div class="context-title">Đang theo dõi ${symbol} ${rank ? `· #${rank}` : ""}</div>
            <div class="context-subtitle">${subscribedLabel} · giá lúc đó ${triggers.gapAbove ? fp(triggers.gapAbove) : (cur ? fp(cur) : "?")}</div>
          </div>
        </div>

        <!-- Today action verdict (BIG) -->
        <div class="lt-verdict" style="background:${verdict.bg}; border-left: 4px solid ${verdict.color}">
          <div class="lt-verdict-tag" style="color:${verdict.color}">${verdict.icon} ${verdict.tag}</div>
          <div class="lt-verdict-title">${verdict.title}</div>
          <div class="lt-verdict-advice">${verdict.advice}</div>
        </div>

        <!-- Triggers status -->
        <div class="context-section">
          <div class="context-section-title">📊 Trạng thái triggers HÔM NAY (locked từ Day 1)</div>
          <div class="lt-checks">${checksHtml}</div>
        </div>

        ${eventsHtml}

        <!-- Action -->
        <div class="lt-actions">
          <button class="tplus-watch-btn active" data-symbol="${symbol}" data-close-trigger="${triggers.closeAbove || ''}" data-vol-trigger="${triggers.volAbove || ''}" data-gap-trigger="${triggers.gapAbove || ''}">
            ✅ ĐANG THEO DÕI · BỎ
          </button>
          <small class="lt-actions-hint">Bỏ theo dõi để reset triggers theo giá mới khi mày subscribe lại.</small>
        </div>

        <div class="context-disclaimer">
          ⚠️ Verdict dựa trên data realtime VS thresholds locked. Cron 15 phút check + báo Telegram khi 1 trong 3 trigger met.
          Nếu setup fail (giá rơi -3%+ kèm vol cao) → bỏ kèo, không bắt đáy.
        </div>
      </div>
    `;
  }

  function renderTplusContextCard(pick, rank, r) {
    // Khi user đã subscribe (lock thresholds): render Live Tracker LÊN TRÊN +
    // giữ nguyên plan analysis chi tiết phía dưới (collapsible) — không xóa
    // mất thông tin phân tích.
    const symbol = pick?.symbol || r?.symbol;
    const watch = symbol ? getTplusWatchData(symbol) : null;
    if (watch && watch.triggers) {
      return renderLiveTrackerCard(pick, rank, r, watch) + renderTplusContextCardPlan(pick, rank, r, { collapsed: true });
    }
    return renderTplusContextCardPlan(pick, rank, r);
  }

  function renderTplusContextCardPlan(pick, rank, r, opts = {}) {
    const planCollapsed = opts.collapsed === true;
    const allReasons = pick.reasons || [];
    // Filter ra reasons đã được hiển thị qua chip — tránh duplicate (ChatGPT đề xuất)
    const chipKeywords = ["Vol thấp", "Cách MA50", "ADX", "TKL phiên này"];
    const reasons = allReasons.filter((rr) =>
      !chipKeywords.some((kw) => rr.includes(kw))
    );
    const f = pick.factors || {};
    const cur = f.currentPrice || r.current;

    // Stop loss: max(2*ATR below, -8%)
    const slFromAtr = r.atr ? cur - 2 * r.atr : null;
    const slFromPct = cur * 0.92;
    const slFinal = slFromAtr ? Math.max(slFromAtr, slFromPct) : slFromPct;
    const slPct = ((slFinal - cur) / cur) * 100;

    // TP shared helper — đảm bảo nhất quán giữa T+ card và action card
    const { tp1, tp2 } = computeTpTargets({ ...r, current: cur });
    const tp1UseMa = r.ma20 && r.ma20 > cur && r.ma20 <= cur * 1.10;
    const tp2UseRes = r.resistance && r.resistance > tp1 && r.resistance <= cur * 1.18;
    const tp1Note = tp1UseMa ? "hồi về MA20 — khả năng cao" : "Mục tiêu gần (~10%) — khả năng cao";
    const tp2Note = tp2UseRes ? "kháng cự gần — cần thị trường thuận lợi" : "Mục tiêu tối đa (~18%) — cần thị trường thuận lợi";
    const targets = [
      `Mục tiêu 1: <b>${fp(tp1)}</b> (${tp1Note}, +${(((tp1 - cur) / cur) * 100).toFixed(1)}%)`,
      `Mục tiêu 2: <b>${fp(tp2)}</b> (${tp2Note}, +${(((tp2 - cur) / cur) * 100).toFixed(1)}%)`,
    ];

    // Entry — 2 option để user chọn theo risk profile
    const aggLow = cur * 0.98;
    const aggHigh = cur * 1.02;

    // Subtitle context-aware
    const subtitle = (r.dayChange ?? 0) <= -3
      ? "Cơ hội mean-reversion — đang rơi mạnh, ưu tiên chờ xác nhận"
      : "Cơ hội mean-reversion ngắn hạn";

    // Volatility label từ ATR% (proxy biến động — KHÔNG phải Risk)
    const vol = getVolatilityLabel(r.atrPct);
    const volHtml = vol
      ? ` <span class="context-risk" style="color:${vol.color}">· ${vol.txt}</span>` : "";

    // Risk chips + flags (dùng pick.flags từ ranking, fallback r.flags từ analyze)
    const flags = pick.flags || r.flags || {};

    // Hold profile dynamic theo signal (RSI / vol / ATR / bearTrap)
    const hold = estimateHoldProfile({ ...r, flags });

    // Entry order theo flagCount: có risk → Confirmed first, else Aggressive first
    const flagCount = [
      flags.bearTrap, flags.lowVol, flags.deepDowntrend, flags.lowSessionLiq, flags.sellPressure
    ].filter(Boolean).length;

    // ── Concrete entry triggers (specific numbers user check được) ──
    const closeTrigger = cur * 1.005; // close > 0.5% above current → momentum cuối phiên
    const volAvg20 = r.avgVol || (cur && r.currentVol ? r.currentVol / (r.volRatio || 1) : null);
    const volTrigger = volAvg20 ? volAvg20 * 1.5 : null;

    const symbol = pick.symbol || r.symbol;
    const isWatched = isTplusWatched(symbol);
    const watchBtnHtml = `
      <li class="tplus-watch-row">
        <button class="tplus-watch-btn ${isWatched ? 'active' : ''}"
          data-symbol="${symbol}"
          data-close-trigger="${closeTrigger}"
          data-vol-trigger="${volTrigger || ''}"
          data-gap-trigger="${cur}"
          title="${isWatched ? 'Đang theo dõi — bấm để bỏ' : 'Bật notification khi trigger met'}">
          ${isWatched ? '✅ ĐANG THEO DÕI · BỎ' : '🔔 BÁO KHI TRIGGER MET'}
        </button>
        <small class="tplus-watch-hint">${isWatched
          ? `App tự check + báo notification khi ${symbol} đạt 1 trong 3 trigger trên`
          : `Nhận notification khi ${symbol} đạt trigger entry — không phải mở app suốt`}</small>
      </li>
    `;

    const triggerListHtml = `
      <li><b>Confirmed entry — đợi ≥ 1 trong 3 trigger</b> (có thể check end-of-day hoặc sáng phiên sau):
        <ul class="entry-triggers-sub">
          <li>① Phiên hôm nay close > <b>${fp(closeTrigger)}</b> (close mạnh, momentum cuối phiên)</li>
          <li>② Vol hôm nay ≥ <b>${volTrigger ? fmtVol(volTrigger) : "1.5× TB20"}</b> (lực cầu xác nhận)</li>
          <li>③ Phiên sau mở cửa > <b>${fp(cur)}</b> (gap up, không reverse)</li>
        </ul>
        <small style="color:#888">📍 Vào lúc: cuối phiên hiện tại (~14:30) HOẶC ATO/ATC sáng phiên sau</small>
      </li>
      ${watchBtnHtml}`;
    const aggressiveLi = `<li><b>Aggressive entry</b>: vào vùng <b>${fp(aggLow)} – ${fp(aggHigh)}</b> (current ±2%) — <i>scale-in 2-3 lệnh, không all-in</i></li>`;
    const entryHtml = flagCount >= 1
      ? `${triggerListHtml}
         <li><i>Tùy chọn aggressive:</i> vào vùng <b>${fp(aggLow)} – ${fp(aggHigh)}</b> — chỉ khi đã chấp nhận size cực nhỏ (rủi ro cao).</li>`
      : aggressiveLi + triggerListHtml;

    // ── Position sizing concrete (NAV-based) ──
    let sizingHtml = "";
    try {
      const cash = window.__SSI_PORTFOLIO__?.loadCash?.() ?? 0;
      const holdings = window.__SSI_PORTFOLIO__?.currentHoldings?.() ?? [];
      let totalMarket = 0;
      for (const h of holdings) {
        const a = portfolioAnalysisCache[h.symbol];
        if (a?.current) totalMarket += h.qty * a.current * 1000;
      }
      const nav = totalMarket + cash;
      if (nav > 0 && cur > 0) {
        const riskPct = isBorderline || isDowngraded ? 1 : 2; // 1% if risky, 2% if clean
        const slDistPct = Math.abs((slFinal - cur) / cur) * 100;
        const slDistClamped = Math.max(3, Math.min(15, slDistPct));
        const maxRiskVnd = nav * (riskPct / 100);
        const maxLossPerShare = cur * 1000 * (slDistClamped / 100);
        const maxQty = maxLossPerShare > 0 ? Math.floor(maxRiskVnd / maxLossPerShare) : 0;
        const maxValue = maxQty * cur * 1000;
        if (maxQty > 0) {
          sizingHtml = `<li class="entry-sizing">💰 <b>Size khuyến nghị</b>: <b>${maxQty.toLocaleString("vi-VN")} cp</b> (~${fmtMoney(maxValue)}, max ${riskPct}% NAV at risk, SL ~${slDistClamped.toFixed(1)}%) — Cash: ${fmtMoney(cash)} / NAV: ${fmtMoney(nav)}</li>`;
        }
      }
    } catch {}

    const rankTxt = rank ? `#${rank}` : "";

    // ── Bayesian P(win) — pass to verdict for data-driven demote ──
    const bayes = computeBayesianWinProb(pick.score ?? r.score, flags);
    const bayesProb = bayes?.prob ?? null;

    // ── BIG ACTION BANNER (verdict + 1-line clear advice) ──
    const verdict = getVerdict(pick.score ?? r.score, flags, r.atrPct, bayesProb);
    const isDowngraded = verdict?.tag === "Watchlist" && (pick.score ?? r.score) >= 4;
    const isAvoid = verdict?.tag === "Avoid";
    const isClean = verdict?.tag === "Spec Buy";
    const isBorderline = verdict?.tag === "Spec Buy (borderline)";

    let actionLabel, actionAdvice, bannerColor;
    if (isAvoid) {
      actionLabel = "🚫 KHÔNG VÀO";
      actionAdvice = "Score thấp + risk cao. Chờ tín hiệu đảo chiều rõ trước khi xét lại.";
      bannerColor = "#ff4444";
    } else if (isDowngraded) {
      const hasLowProb = bayesProb != null && bayesProb < 0.50;
      actionLabel = "⚠️ CHỜ XÁC NHẬN";
      actionAdvice = hasLowProb
        ? `Score cao nhưng <b>P(win) ${(bayesProb * 100).toFixed(0)}% < baseline 52%</b> — backtest data nói setup này yếu hơn lệnh T+ trung bình. Chờ trigger đảo chiều hoặc bỏ qua.`
        : "Setup oversold mạnh nhưng có risk flag. <b>Đừng vào aggressive hôm nay</b> — chờ trigger đảo chiều hoặc bỏ qua kèo này.";
      bannerColor = "#FF9800";
    } else if (isBorderline) {
      actionLabel = "🟡 CÓ THỂ VÀO (BORDERLINE)";
      actionAdvice = `P(win) ~${(bayesProb * 100).toFixed(0)}% — sát baseline 52%, edge mỏng. <b>Ưu tiên Confirmed entry</b> để có buffer; nếu Aggressive thì size cực nhỏ.`;
      bannerColor = "#FFC107";
    } else if (verdict?.tag === "Watchlist") {
      actionLabel = "🟡 WATCHLIST";
      actionAdvice = "Score chưa đủ confluence. Theo dõi, không vào lệnh mới.";
      bannerColor = "#FF9800";
    } else if (isClean) {
      actionLabel = "✅ CÓ THỂ VÀO";
      actionAdvice = bayesProb != null
        ? `Confluence rõ, P(win) <b>${(bayesProb * 100).toFixed(0)}%</b> trên baseline 52%. Vào theo plan dưới với size khuyến nghị.`
        : "Confluence rõ, không có hard flag. Vào theo plan dưới với size khuyến nghị.";
      bannerColor = "#4CAF50";
    } else {
      actionLabel = "ℹ️ THEO DÕI";
      actionAdvice = "Tín hiệu chưa đủ rõ.";
      bannerColor = "#888";
    }

    const chipsHtml = renderRiskChips(flags);

    // ── Lý do đợi (cho Watchlist downgraded) ──
    let waitReasonsHtml = "";
    if (isDowngraded) {
      const items = [];
      if (flags.bearTrap) items.push(`<li><b>ADX cao + -DI dominant</b>: trend giảm còn rất mạnh — "bắt dao rơi" rủi ro cao. Mean-rev đánh ngược trend mạnh thường fail.</li>`);
      if (flags.deepDowntrend) items.push(`<li><b>Cách MA50 -12%+</b>: downtrend chưa hết, thị trường VN thường tiếp tục rớt 5-10% trước khi đảo.</li>`);
      if (flags.lowSessionLiq) items.push(`<li><b>TKL phiên thấp (<2 tỷ)</b>: vào dễ ra khó, gây kẹt khi muốn cắt.</li>`);
      if (flags.sellPressure) items.push(`<li><b>Vol cao + giá giảm</b>: lực bán đè giá, không phải lực cầu hấp thụ.</li>`);
      if (flags.lowVol && !flags.volCritical) items.push(`<li><b>Vol thấp</b>: thiếu xác nhận thanh khoản cho nhịp hồi.</li>`);
      if (flags.volCritical) items.push(`<li><b>Vol cực thấp (<0.4×)</b>: gần như không có dòng tiền — khó có lực hồi.</li>`);
      if (items.length > 0) {
        waitReasonsHtml = `
          <div class="ctx-wait-section">
            <div class="ctx-wait-title">🚨 Tại sao chưa nên vào aggressive:</div>
            <ul class="ctx-wait-list">${items.join("")}</ul>
          </div>
        `;
      }
    }

    // ── Trigger để cân nhắc vào (cho Watchlist downgraded) ──
    let triggerHtml = "";
    if (isDowngraded) {
      const triggers = [
        `<li><b>Nến rút chân</b> close gần đỉnh phiên (hammer/inverted hammer)</li>`,
        `<li><b>Vol ≥ 1.5×</b> phiên SAU + giá giữ trên BB lower 2 phiên liên tiếp</li>`,
      ];
      if (flags.bearTrap) {
        triggers.push(`<li><b>+DI cross lên</b> 10+ và <b>ADX giảm dưới 45</b> (bên mua bắt đầu vào)</li>`);
      }
      triggers.push(`<li><b>Bounce từ BB lower xác nhận</b> (close > BB lower 2 phiên)</li>`);
      triggerHtml = `
        <div class="ctx-trigger-section">
          <div class="ctx-trigger-title">✅ Cân nhắc vào (size nhỏ 10-20%) khi thấy ≥ 1 trong:</div>
          <ul class="ctx-trigger-list">${triggers.join("")}</ul>
        </div>
      `;
    }

    const cardOpenTag = planCollapsed
      ? `<details class="an-card context-card context-tplus ctx-plan-collapsed"><summary class="ctx-plan-summary">📋 Plan giao dịch & phân tích chi tiết (collapsed — bấm để mở)</summary>`
      : `<div class="an-card context-card context-tplus">`;
    const cardCloseTag = planCollapsed ? `</details>` : `</div>`;

    return `
      ${cardOpenTag}
        <!-- BIG action banner -->
        <div class="ctx-action-banner" style="border-color:${bannerColor};background:${bannerColor}14">
          <div class="ctx-action-label" style="color:${bannerColor}">${actionLabel}</div>
          <div class="ctx-action-advice">${actionAdvice}</div>
          ${chipsHtml ? `<div class="ctx-action-chips">${chipsHtml}</div>` : ""}
        </div>

        <!-- Rank + score (smaller, secondary) -->
        <div class="ctx-rank-line">
          <span>⚡ T+ ${rankTxt} · Score <b>${pick.score >= 0 ? "+" : ""}${pick.score.toFixed(2)}</b>${volHtml}</span>
          <span class="ctx-rank-disclaimer">(rank theo confluence, không phải khuyến nghị mua)</span>
        </div>

        <!-- Bayesian win probability (data-driven) -->
        ${(() => {
          const bayes = computeBayesianWinProb(pick.score ?? r.score, flags);
          if (!bayes) return "";
          const probPct = (bayes.prob * 100).toFixed(0);
          const baselinePct = (BAYES_BASELINE_WIN * 100).toFixed(0);
          const breakdownHtml = bayes.breakdown.map((b) => {
            const sign = b.value > 1 ? "+" : "";
            const delta = ((b.value - 1) * 100).toFixed(1);
            return b.label === "Baseline T+ score≥4 (10 phiên)"
              ? `<li><b>${b.label}</b>: ${(b.value * 100).toFixed(0)}%</li>`
              : `<li>${b.label}: <b style="color:${b.value > 1 ? '#4CAF50' : '#ff5722'}">${sign}${delta}%</b></li>`;
          }).join("");
          const interp = bayes.prob >= 0.6 ? "Cao hơn baseline — setup có edge"
            : bayes.prob >= 0.5 ? "Gần baseline — setup trung tính"
            : "Thấp hơn baseline — setup yếu hơn lệnh T+ trung bình";
          const probColor = bayes.prob >= 0.6 ? "#4CAF50" : bayes.prob >= 0.5 ? "#FF9800" : "#ff5722";
          return `
            <div class="ctx-bayes-section">
              <div class="ctx-bayes-title">📈 Bayesian win probability (data-driven)</div>
              <div class="ctx-bayes-prob" style="color:${probColor}">
                P(win 10 phiên) ≈ <b>${probPct}%</b> <span class="ctx-bayes-baseline">(baseline ${baselinePct}%)</span>
              </div>
              <div class="ctx-bayes-interp">${interp}</div>
              <details class="ctx-bayes-details">
                <summary>Breakdown calculation</summary>
                <ul class="ctx-bayes-breakdown">${breakdownHtml}</ul>
                <div class="ctx-bayes-note">
                  Multipliers từ backtest 2492 trades cross-section 58 mã DCA, hold 10 phiên.
                  Independent assumption naive — flags correlated. Cross-stock pooled, mã specific có thể khác.
                </div>
              </details>
            </div>
          `;
        })()}

        <!-- Lý do đợi (chỉ Watchlist downgraded) -->
        ${waitReasonsHtml}

        <!-- Trigger để cân nhắc vào -->
        ${triggerHtml}

        <!-- Tín hiệu đang fire -->
        <div class="context-section">
          <div class="context-section-title">📊 Tín hiệu đang fire</div>
          <ul class="context-bullets">${reasons.map((rr) => `<li><b>${rr}</b></li>`).join("")}</ul>
        </div>

        <!-- Plan giao dịch (collapsible nếu downgraded) -->
        <details class="context-section ctx-plan-details" ${isDowngraded ? "" : "open"}>
          <summary class="context-section-title">
            📋 Plan giao dịch ${isDowngraded ? `<span class="ctx-plan-note">(bấm để mở — chỉ áp dụng nếu bạn vẫn quyết định vào)</span>` : ""}
          </summary>
          <ul class="context-bullets">
            ${entryHtml}
            ${sizingHtml}
            <li>Stop loss: <b>${fp(slFinal)}</b> (${slPct.toFixed(1)}%) — max của -8% và 2×ATR</li>
            ${targets.map((t) => `<li>${t}</li>`).join("")}
            <li>Hold: <b>${hold.min}-${hold.max} phiên</b> ${hold.icon} <i>${hold.label}</i> — ${hold.hint}</li>
            <li>Exit khi: RSI hồi &gt;50 HOẶC đạt mục tiêu HOẶC dính SL</li>
            <li class="anti-fomo">❌ <b>KHÔNG vào khi</b>: gap down kèm vol tăng (lực bán đè giá)${flags.bearTrap ? ` HOẶC -DI tiếp tục mạnh hơn +DI` : ""}</li>
          </ul>
        </details>

        <div class="context-disclaimer">
          ⚠️ Mean-reversion có thể fail nếu thị trường tiếp tục giảm. Backtest 2023-2026: score≥4 win rate <b>61%</b>, avg <b>+3.3%/lệnh</b> — 4/10 lệnh thua, tuân thủ SL.
        </div>
      ${cardCloseTag}
    `;
  }

  // ── Pool sector forward stats (improve sample size) ──
  // Cache peer history 1h per symbol
  const PEER_HISTORY_CACHE = {};
  async function fetchPeerHistoryCached(symbol) {
    const cached = PEER_HISTORY_CACHE[symbol];
    if (cached && Date.now() - cached.ts < 3600 * 1000) return cached.data;
    try {
      const data = await ANALYSIS.fetchHistory(symbol, "D", 250);
      PEER_HISTORY_CACHE[symbol] = { ts: Date.now(), data };
      return data;
    } catch { return null; }
  }

  async function computePoolForwardStats(currentSym, sector, currentBucket) {
    const universe = window.__SSI_RANKING__?.UNIVERSE || [];
    const peers = universe
      .filter((u) => u.sector === sector && u.code !== currentSym)
      .slice(0, 7); // top 7 peer mã trong sector
    if (peers.length === 0) return null;

    // Aggregate stats per horizon
    const all = { fwd5: [], fwd10: [], fwd20: [] };

    for (const peer of peers) {
      const data = await fetchPeerHistoryCached(peer.code);
      if (!data?.closes) continue;
      const stats = ANALYSIS.computeForwardStats(data.closes);
      if (!stats || stats.currentBucket !== currentBucket) {
        // Skip if peer's CURRENT bucket different — hmm, but we want HISTORICAL matches của bucket
        // Need to recompute pool-based, not from stats output
      }
      // Need raw matches not aggregated stats. Re-walk history:
      const closes = data.closes;
      const n = closes.length;
      if (n < 50) continue;
      // Quick inline RSI compute (mirror analysis.js logic)
      const rsiSeries = computeRsiSeriesInline(closes, 14);
      for (let i = 14; i <= n - 21; i++) {
        const rsi = rsiSeries[i];
        if (rsi == null) continue;
        if (rsiBucketInline(rsi) !== currentBucket) continue;
        const base = closes[i];
        if (!base || base <= 0) continue;
        all.fwd5.push(((closes[i + 5] - base) / base) * 100);
        all.fwd10.push(((closes[i + 10] - base) / base) * 100);
        all.fwd20.push(((closes[i + 20] - base) / base) * 100);
      }
    }

    return {
      peerCount: peers.length,
      fwd5: statsOfArray(all.fwd5),
      fwd10: statsOfArray(all.fwd10),
      fwd20: statsOfArray(all.fwd20),
    };
  }

  // Inline RSI helpers (mirror analysis.js computeRsiSeries + rsiBucket)
  function computeRsiSeriesInline(closes, period = 14) {
    const series = new Array(closes.length).fill(null);
    if (closes.length < period + 1) return series;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) gains += d; else losses -= d;
    }
    let avgG = gains / period, avgL = losses / period;
    series[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      const g = d > 0 ? d : 0;
      const l = d < 0 ? -d : 0;
      avgG = (avgG * (period - 1) + g) / period;
      avgL = (avgL * (period - 1) + l) / period;
      series[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    }
    return series;
  }

  function rsiBucketInline(rsi) {
    if (rsi == null) return null;
    if (rsi < 25) return "OS_extreme";
    if (rsi < 30) return "OS_strong";
    if (rsi < 45) return "OS_mild";
    if (rsi < 55) return "neutral";
    if (rsi < 70) return "OB_mild";
    if (rsi < 75) return "OB_strong";
    return "OB_extreme";
  }

  function statsOfArray(arr) {
    if (arr.length === 0) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const sum = arr.reduce((a, b) => a + b, 0);
    const avg = sum / arr.length;
    const wins = arr.filter((x) => x > 0).length;
    return {
      n: arr.length,
      avg,
      median: sorted[Math.floor(sorted.length / 2)],
      winRate: wins / arr.length,
      best: sorted[sorted.length - 1],
      worst: sorted[0],
    };
  }

  // ── T+ eligibility diagnostic (giải thích why mã không trong T+ pick) ──
  function renderTplusEligibilityCheck(r) {
    const issues = [];
    if (r.avgTurnover20d != null && r.avgTurnover20d < 5e9) {
      issues.push({
        icon: "⛔",
        text: `Thanh khoản TB 20 phiên = <b>${(r.avgTurnover20d / 1e9).toFixed(2)} tỷ</b> (filter < 5 tỷ — illiquid)`,
      });
    }
    if (r.ret6m != null && r.ret6m < -0.5) {
      issues.push({
        icon: "⛔",
        text: `6 tháng return = <b>${(r.ret6m * 100).toFixed(1)}%</b> (filter < -50% — falling knife)`,
      });
    }

    // Score check (analyze score, not T+ score, nhưng correlated)
    if (r.score != null && r.score < 4) {
      issues.push({
        icon: "⚠️",
        text: `Setup score analyze = <b>${r.score.toFixed(1)}</b> (T+ pick threshold ≥ 4 — chưa đủ confluence)`,
      });
    }

    // Skip render nếu không có issue
    if (issues.length === 0) return "";

    return `
      <div class="an-card full-width tplus-elig-card">
        <div class="an-title">⚠️ Mã này có thể KHÔNG xuất hiện trong T+ Top picks</div>
        <ul class="tplus-elig-list">
          ${issues.map((i) => `<li>${i.icon} ${i.text}</li>`).join("")}
        </ul>
        <div class="tplus-elig-note">
          T+ Top picks chỉ list mã pass tất cả hard filters + score threshold. Mã này có thể có signal kỹ thuật mạnh nhưng bị loại do hard rules
          (illiquid → khó exit, falling knife → trend giảm chưa hết). Cẩn thận khi trade — đó là lý do app filter ra.
        </div>
      </div>
    `;
  }

  // ── Forward stats card (dự đoán dựa lịch sử cùng setup) ──
  // ── Stock Personality Profile card ──
  function renderStockProfileCard(r) {
    const p = r?.stockProfile;
    if (!p) return "";

    const fmt1 = (v) => v == null ? "--" : v.toFixed(1);
    const fmt0 = (v) => v == null ? "--" : v.toFixed(0);

    // Volatility chip color
    const volColor = p.volLabel === "Calm" ? "#4CAF50"
      : p.volLabel === "Normal" ? "#8BC34A"
      : p.volLabel === "Volatile" ? "#FF9800"
      : p.volLabel === "Wild" ? "#ff5722" : "#888";

    const trendColor = p.trendLabel === "Steady climber" ? "#4CAF50"
      : p.trendLabel === "Trend-follower" ? "#8BC34A"
      : p.trendLabel === "Choppy" ? "#ff5722"
      : p.trendLabel === "Range-bound" ? "#FF9800" : "#888";

    const betaColor = p.betaLabel === "High-beta" ? "#ff5722"
      : p.betaLabel === "Market" ? "#FF9800"
      : p.betaLabel === "Low-beta" ? "#8BC34A"
      : p.betaLabel === "Defensive" ? "#4CAF50" : "#888";

    // Breakout reliability label
    const bkWinRate = p.breakoutWinRate;
    const bkLabel = bkWinRate == null ? "Chưa có data"
      : bkWinRate >= 65 ? `Reliable (${fmt0(bkWinRate)}% win)`
      : bkWinRate >= 50 ? `OK (${fmt0(bkWinRate)}% win)`
      : `Yếu (${fmt0(bkWinRate)}% win — hay fake)`;

    // Recovery label
    const rcCount = p.selloffCount;
    const recoveryStr = rcCount === 0
      ? "Chưa từng -10% trong 2y (ổn định)"
      : p.avgRecoveryBars != null
      ? `${rcCount} lần -10%+ · recovery TB ${fmt0(p.avgRecoveryBars)} phiên · bounce 10d +${fmt1(p.avgBounce10)}%`
      : `${rcCount} lần -10%+ · chưa hồi`;

    // Vol regime label
    const volRegStr = p.volPercentile == null ? "--"
      : p.volPercentile > 90 ? `Top ${fmt0(100 - p.volPercentile)}% (rare high)`
      : p.volPercentile > 75 ? `Top 25% (above avg)`
      : p.volPercentile > 25 ? `Trung tính (${fmt0(p.volPercentile)}% percentile)`
      : `Bottom 25% (low activity)`;

    // Tooltips (escape quotes)
    const esc = (s) => String(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");

    const tipVol = esc(
      `ATR % (Average True Range) đo biến động trung bình mỗi phiên. Hiện tại ${fmt1(p.atrPct)}% (percentile ${fmt0(p.atrPercentile)}% so với 1 năm).\n\n` +
      `• Calm (<1.5%): mã ổn định, biến động thấp.\n` +
      `• Normal (1.5-3%): biến động vừa.\n` +
      `• Volatile (3-5%): biến động cao, cần size nhỏ + SL rộng.\n` +
      `• Wild (>5%): rất biến động, dễ pump/dump.\n\n` +
      `Profile multiplier áp dụng vào T+ scoring: mã volatile sẵn → vol spike không novel, weight giảm.`
    );

    const tipTrend = esc(
      `Phân loại theo độ dài trend up trung bình + pullback depth.\n\n` +
      `Hiện tại: trend TB ${fmt0(p.avgUpTrendLen)} phiên, pullback ${fmt1(p.avgPullbackPct)}%.\n\n` +
      `• Steady climber: trend dài (>15 phiên) + pullback nhỏ (<7%). Mã đẹp cho trend-following.\n` +
      `• Trend-follower: trend vừa (10-15 phiên), pullback OK.\n` +
      `• Range-bound: trend ngắn, đi ngang.\n` +
      `• Choppy: trend rất ngắn (<5 phiên), không có direction rõ.\n\n` +
      `Adaptive: Steady climber → trend signals ×1.3, Choppy → ×0.7.`
    );

    const tipBeta = esc(
      `Beta đo độ nhạy của mã so với VN-Index trên 100 phiên gần nhất.\n\n` +
      `Hiện tại β ${p.beta != null ? p.beta.toFixed(2) : "--"} → ${p.betaLabel}.\n\n` +
      `• High-beta (β>1.3): khuếch đại move của VNI. VNI +5% → mã +6.5%+.\n` +
      `• Market (0.8-1.3): cùng pace với index.\n` +
      `• Low-beta (0.3-0.8): ít nhạy hơn index.\n` +
      `• Defensive (<0.3): độc lập với index — phù hợp diversification.\n\n` +
      `High-beta trong BULL regime → outperform; trong BEAR → underperform mạnh.`
    );

    const tipTrendBehavior = esc(
      `Trend lengths được tính từ pivot lows → pivot highs trong 250 phiên qua.\n` +
      `Pullback depth = giảm từ pivot high tới pivot low kế tiếp (% từ peak).\n\n` +
      `Trend trung bình ${fmt0(p.avgUpTrendLen)} phiên → kỳ vọng hold thời gian này.\n` +
      `Pullback TB ${fmt1(p.avgPullbackPct)}% → SL nên đặt > pullback bình thường để tránh false stop.`
    );

    const tipBreakout = esc(
      `Breakout = giá vượt w20-high (đỉnh 20 phiên) trong 252 phiên qua.\n` +
      `Win rate = % breakouts có giá tăng tiếp sau 10 phiên.\n\n` +
      `Hiện tại: ${p.breakoutCount} lần breakout, win rate ${fmt0(p.breakoutWinRate)}%, avg +${fmt1(p.breakoutAvgRet)}% sau 10d.\n\n` +
      `• >65% reliable: breakout signal mạnh cho mã này.\n` +
      `• 50-65% OK: breakout có edge nhẹ.\n` +
      `• <50% yếu: mã hay fake breakout, giảm trust signal.\n\n` +
      `Adaptive: weight breakout × (winRate/50). Reliable mã được boost, fake-breakout mã giảm.`
    );

    const tipSelloff = esc(
      `Sell-off = giảm > 10% trong 5 phiên liên tiếp trong 2 năm qua.\n` +
      `Recovery time = số phiên đến khi giá vượt lại đỉnh trước sell-off.\n` +
      `Bounce 10d = return trung bình 10 phiên sau khi sell-off bottom.\n\n` +
      `Hiện tại: ${p.selloffCount} lần -10%+.\n` +
      `${p.avgRecoveryBars != null ? `Recovery TB ${fmt0(p.avgRecoveryBars)} phiên, bounce 10d +${fmt1(p.avgBounce10)}%.` : "Chưa có history recovery."}\n\n` +
      `Adaptive: nếu mã có history recovery (>=2 lần) → RSI<30 signal được apply weight × recoveryReliability. Mã chưa từng hồi mạnh → RSI<30 chỉ là noise, drop.`
    );

    const tipVolToday = esc(
      `Volume hôm nay = ${p.volMultiple != null ? p.volMultiple.toFixed(1) : "--"}× TB 1 năm.\n` +
      `Percentile = vị trí volume hôm nay trong distribution 252 phiên.\n\n` +
      `• Top 5% (>95th percentile): rare event — institutional activity, news catalyst.\n` +
      `• Top 25% (>75th percentile): above average activity.\n` +
      `• 25-75%: trung tính.\n` +
      `• Bottom 25%: low activity, signal kém tin cậy.\n\n` +
      `Vol regime giúp distinguish "high vol cho riêng mã này" vs "thấp tuyệt đối". Mã illiquid tự nhiên vol thấp, không phải bug.`
    );

    return `
      <div class="an-card full-width stock-profile-card">
        <div class="an-title">🎭 Đặc thù giao dịch của mã <small style="font-size:11px;color:#888;font-weight:400">(tap để xem giải thích)</small></div>

        <div class="profile-chips">
          <span class="profile-chip has-tip" data-tip-title="Volatility · ${p.volLabel}" data-tip-body="${tipVol}" style="border-color:${volColor}55;color:${volColor}">
            <b>${p.volLabel}</b> · ATR ${fmt1(p.atrPct)}%
          </span>
          <span class="profile-chip has-tip" data-tip-title="Trend behavior · ${p.trendLabel}" data-tip-body="${tipTrend}" style="border-color:${trendColor}55;color:${trendColor}">
            <b>${p.trendLabel}</b>
          </span>
          <span class="profile-chip has-tip" data-tip-title="Beta vs VN-Index · ${p.betaLabel}" data-tip-body="${tipBeta}" style="border-color:${betaColor}55;color:${betaColor}">
            <b>${p.betaLabel}</b> · β ${p.beta != null ? p.beta.toFixed(2) : "--"}
          </span>
        </div>

        <div class="profile-rows">
          <div class="profile-row has-tip" data-tip-title="📈 Trend behavior" data-tip-body="${tipTrendBehavior}">
            <span class="profile-label">📈 Trend behavior</span>
            <span class="profile-val">Trend trung bình <b>${fmt0(p.avgUpTrendLen)} phiên</b> · pullback ${fmt1(p.avgPullbackPct)}%</span>
          </div>
          <div class="profile-row has-tip" data-tip-title="🚀 Breakout history (1 năm)" data-tip-body="${tipBreakout}">
            <span class="profile-label">🚀 Breakout history (1y)</span>
            <span class="profile-val"><b>${p.breakoutCount}</b> lần · ${bkLabel} · avg +${fmt1(p.breakoutAvgRet)}%/10d</span>
          </div>
          <div class="profile-row has-tip" data-tip-title="📉 Sell-off patterns (2 năm)" data-tip-body="${tipSelloff}">
            <span class="profile-label">📉 Sell-off patterns (2y)</span>
            <span class="profile-val">${recoveryStr}</span>
          </div>
          <div class="profile-row has-tip" data-tip-title="📊 Volume regime" data-tip-body="${tipVolToday}">
            <span class="profile-label">📊 Volume hôm nay</span>
            <span class="profile-val">${volRegStr}${p.volMultiple != null ? ` · ${p.volMultiple.toFixed(1)}× TB` : ""}</span>
          </div>
        </div>

        <div class="profile-hint">
          💡 Profile từ ${Math.min(252, currentData?.closes?.length || 0)} phiên gần nhất. Tap mỗi mục để xem giải thích chi tiết. Adaptive multipliers áp dụng vào T+ scoring.
        </div>
      </div>
    `;
  }

  function renderForwardStatsCard(r) {
    const fs = r.forwardStats;
    if (!fs || (!fs.fwd5 && !fs.fwd10 && !fs.fwd20)) return "";

    const renderStatRow = (label, s) => {
      if (!s || s.n === 0) {
        return `<div class="fs-row"><span class="fs-label">${label}</span><span class="fs-empty">Không đủ data</span></div>`;
      }
      const winCls = s.winRate >= 0.5 ? "up" : "down";
      const avgCls = s.avg >= 0 ? "up" : "down";
      const avgSign = s.avg >= 0 ? "+" : "";
      const bestSign = s.best >= 0 ? "+" : "";
      const worstSign = s.worst >= 0 ? "+" : "";
      return `
        <div class="fs-row">
          <span class="fs-label">${label}</span>
          <span class="fs-cell pct ${avgCls}">${avgSign}${s.avg.toFixed(1)}%</span>
          <span class="fs-cell pct ${winCls}">${(s.winRate * 100).toFixed(0)}%</span>
          <span class="fs-cell">[${worstSign}${s.worst.toFixed(0)}, ${bestSign}${s.best.toFixed(0)}]</span>
        </div>
      `;
    };

    const headerRow = `
      <div class="fs-row fs-header">
        <span class="fs-label">Horizon</span>
        <span class="fs-cell">Avg ret</span>
        <span class="fs-cell">Win rate</span>
        <span class="fs-cell">Range</span>
      </div>
    `;

    // Sample size note
    const sampleN = fs.fwd5?.n || fs.fwd10?.n || fs.fwd20?.n || 0;
    const sampleTooSmall = sampleN < 3;
    const sampleNote = sampleTooSmall
      ? `<span class="fs-warn fs-warn-strong">⛔ Sample n=${sampleN} — chỉ ${sampleN} lần lịch sử, KHÔNG phải pattern thống kê. Win rate hiển thị KHÔNG có ý nghĩa.</span>`
      : sampleN < 10
      ? `<span class="fs-warn">⚠️ Sample nhỏ (${sampleN}) — độ tin cậy thấp</span>`
      : sampleN < 30
      ? `<span class="fs-warn">⚠️ Sample vừa (${sampleN}) — chỉ là gợi ý</span>`
      : `<span class="fs-info">Sample n=${sampleN}</span>`;

    // Get sector for pool button
    const meta = getStockMeta(r.symbol);
    const sector = meta?.sector;
    const canPool = sector && sector !== "khác";

    return `
      <div class="an-card full-width ${sampleTooSmall ? 'fs-card-muted' : ''}">
        <div class="an-title">📊 Dự đoán dựa lịch sử (cùng setup RSI)</div>
        <div class="fs-bucket">Setup hiện tại: <b>${fs.bucketLabel}</b> · ${sampleNote}</div>
        <div class="fs-table ${sampleTooSmall ? 'fs-table-muted' : ''}">
          ${headerRow}
          ${renderStatRow("5 phiên",  fs.fwd5)}
          ${renderStatRow("10 phiên", fs.fwd10)}
          ${renderStatRow("20 phiên", fs.fwd20)}
        </div>
        ${canPool ? `
          <div class="fs-pool-action">
            <button class="link-btn" id="fs-pool-btn" data-symbol="${r.symbol}" data-sector="${sector}" data-bucket="${fs.currentBucket}">
              🔍 Mở rộng sample: pool stats từ peers cùng ngành
            </button>
          </div>
          <div id="fs-pool-result"></div>
        ` : ""}
        <div class="fs-disclaimer">
          ⚠️ Quá khứ KHÔNG đảm bảo tương lai. Đây là <b>thống kê mô tả</b> từ history — không phải prediction.
          Chỉ dùng làm 1 trong nhiều input quyết định.
        </div>
      </div>
    `;
  }

  // Bind T+ trigger watch button (after analyze render with T+ context)
  // No-op — kept for backward compat with existing call sites.
  // Watch button click giờ handle qua event delegation (bind once globally).
  function bindTplusWatchBtn() {
    // Intentionally empty — handler ở document-level delegation init.
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

  // Bind pool button after analyze rendered
  function bindForwardStatsPoolBtn() {
    const btn = document.getElementById("fs-pool-btn");
    const result = document.getElementById("fs-pool-result");
    if (!btn || !result) return;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Đang fetch peers...";
      const sym = btn.dataset.symbol;
      const sector = btn.dataset.sector;
      const bucket = btn.dataset.bucket;
      try {
        const pool = await computePoolForwardStats(sym, sector, bucket);
        if (!pool) {
          result.innerHTML = `<div class="fs-empty">Không pool được — không có peer trong ngành.</div>`;
          return;
        }
        const renderRow = (label, s) => {
          if (!s || s.n === 0) return `<div class="fs-row"><span class="fs-label">${label}</span><span class="fs-empty">Không có match</span></div>`;
          const winCls = s.winRate >= 0.5 ? "up" : "down";
          const avgCls = s.avg >= 0 ? "up" : "down";
          const avgSign = s.avg >= 0 ? "+" : "";
          const bestSign = s.best >= 0 ? "+" : "";
          const worstSign = s.worst >= 0 ? "+" : "";
          return `<div class="fs-row">
            <span class="fs-label">${label}</span>
            <span class="fs-cell pct ${avgCls}">${avgSign}${s.avg.toFixed(1)}%</span>
            <span class="fs-cell pct ${winCls}">${(s.winRate * 100).toFixed(0)}%</span>
            <span class="fs-cell">[${worstSign}${s.worst.toFixed(0)}, ${bestSign}${s.best.toFixed(0)}]</span>
          </div>`;
        };
        const totalN = pool.fwd5?.n || 0;
        result.innerHTML = `
          <div class="fs-pool-section">
            <div class="fs-pool-title">📊 Pool stats từ ${pool.peerCount} peers cùng ngành (sample n=${totalN})</div>
            <div class="fs-table">
              <div class="fs-row fs-header">
                <span class="fs-label">Horizon</span>
                <span class="fs-cell">Avg ret</span>
                <span class="fs-cell">Win rate</span>
                <span class="fs-cell">Range</span>
              </div>
              ${renderRow("5 phiên", pool.fwd5)}
              ${renderRow("10 phiên", pool.fwd10)}
              ${renderRow("20 phiên", pool.fwd20)}
            </div>
            <div class="fs-pool-note">💡 Pool tăng sample size nhưng mất mã-specific traits. So sánh với stats riêng để hiểu mã này có bias gì khác sector.</div>
          </div>
        `;
      } catch (e) {
        result.innerHTML = `
          <div class="fs-empty">
            ⚠️ Lỗi fetch: ${e.message}
            <button class="link-btn fs-retry-btn">Thử lại</button>
          </div>
        `;
        const retry = result.querySelector(".fs-retry-btn");
        if (retry) retry.addEventListener("click", () => {
          btn.style.display = "";
          btn.disabled = false;
          btn.textContent = "Xem pool peer cùng ngành";
          result.innerHTML = "";
          btn.click();
        });
      } finally {
        if (!result.querySelector(".fs-retry-btn")) btn.style.display = "none";
      }
    });
  }

  // ── Action card (rút gọn) ──
  // Verdict badge đã cover quyết định cho user CHƯA giữ → không duplicate ở đây.
  // Chỉ giữ "Nếu đang giữ" (managing position là context khác) + 1 warning.
  // Inject SL number + TP1 (khi applicable) để actionable ngay, user không phải tự tính.
  function renderActionCard(r) {
    const sl = r.stopLoss ? `SL <b>${fp(r.stopLoss)}</b>. ` : "";
    const { tp1 } = computeTpTargets(r);
    let holdAction, warning;

    if (r.score >= 4) {
      const tpHint = tp1 ? `Canh chốt 1/3 quanh <b>${fp(tp1)}</b>. ` : "";
      holdAction = `Có thể tilt buy 30-50% (KHÔNG all-in). ${sl}${tpHint}`;
      warning = "Edge T+ ~3-5%/cơ hội — không chắc thắng. Tuân thủ SL kỷ luật.";
    } else if (r.score >= 2) {
      holdAction = `Giữ, KHÔNG bán panic. ${sl}Theo dõi xem có lên ≥4 không.`;
      warning = "Setup khá phổ biến — đừng over-trade tín hiệu yếu.";
    } else if (r.score >= -1) {
      holdAction = `Giữ position. ${sl}ĐỪNG panic do score trung tính.`;
      warning = "Phần lớn thời gian app sẽ trung tính — đó là bình thường.";
    } else if (r.score >= -3) {
      holdAction = `Review thesis. ${sl}Phá hỗ trợ + vol xác nhận → giảm size kỷ luật.`;
      warning = "Đừng để loss cascade — cắt lỗ trước khi cảm xúc thắng.";
    } else {
      holdAction = `Cân nhắc <b>cắt lỗ / giảm tỷ trọng</b>. ${sl}Đặc biệt nếu fundamentals xấu đi.`;
      warning = "Check news/scandal/báo cáo xấu — có thể là 'falling knife'.";
    }

    return `
      <div class="an-card full-width action-card" style="border-left-color: ${r.recColor}">
        <div class="action-hold">
          <span class="action-label">Nếu đang giữ:</span>
          <span class="action-text">${holdAction}</span>
        </div>
        <div class="action-warning">⚠️ ${warning}</div>
      </div>
    `;
  }

  function row(label, value, tip, valueStyle) {
    if (tip) {
      const safeTip = tip.replace(/"/g, "&quot;");
      const safeLabel = label.replace(/"/g, "&quot;");
      return `
        <div class="an-row">
          <span class="label has-tip" data-tip-title="${safeLabel}" data-tip-body="${safeTip}">
            ${label} <span class="info-icon">i</span>
          </span>
          <span class="value" style="${valueStyle || ""}">${value}</span>
        </div>`;
    }
    return `
      <div class="an-row">
        <span class="label">${label}</span>
        <span class="value" style="${valueStyle || ""}">${value}</span>
      </div>`;
  }

  function signedPct(v) {
    if (v === null || v === undefined) return "--";
    return (v >= 0 ? "+" : "") + v.toFixed(1) + "%";
  }

  function perfPills(perf) {
    if (!perf) return "";
    const labels = { "1t": "1t", "1th": "1th", "3th": "3th", "1n": "1n" };
    const pill = (lbl, v) => {
      if (v === null || v === undefined) return `<span class="perf-pill"><span class="lbl">${lbl}</span>--</span>`;
      const color = v >= 0 ? "#4CAF50" : "#ff4444";
      const sign = v >= 0 ? "+" : "";
      return `<span class="perf-pill"><span class="lbl">${lbl}</span><span style="color:${color}">${sign}${v.toFixed(1)}%</span></span>`;
    };
    return `
      <div class="an-row">
        <span class="label has-tip" data-tip-title="Hiệu suất" data-tip-body="Thay đổi giá theo các khoảng thời gian: 1 tuần, 1 tháng, 3 tháng, 1 năm.">Hiệu suất <span class="info-icon">i</span></span>
        <span class="perf-pills">
          ${pill("1t", perf["1t"])}
          ${pill("1th", perf["1th"])}
          ${pill("3th", perf["3th"])}
          ${pill("1n", perf["1n"])}
        </span>
      </div>`;
  }

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

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
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

  function fmtTimeShort(ts) {
    const d = new Date(ts);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) {
      return d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" }) +
      " " + d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
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
  // ── VN trading session + holidays (shared logic) ──
  // Format YYYY-MM-DD. Cập nhật theo lịch nghỉ chính thức + ngày bù.
  // KEEP IN SYNC với stock-pwa-bot/worker.js (worker dùng duplicate cho cron skip).
  const VN_HOLIDAYS = new Set([
    // 2025
    "2025-01-01",
    "2025-01-28", "2025-01-29", "2025-01-30", "2025-01-31", "2025-02-03", // Tết AL 2025
    "2025-04-07", // Giỗ Tổ
    "2025-04-30", "2025-05-01",
    "2025-09-02",
    // 2026
    "2026-01-01",
    "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", // Tết AL (Mùng 1=17/2)
    "2026-04-27", // Giỗ Tổ
    "2026-04-30", "2026-05-01",
    "2026-09-02",
    // 2027
    "2027-01-01",
    "2027-02-08", "2027-02-09", "2027-02-10", "2027-02-11", "2027-02-12", // Tết AL (Mùng 1=6/2/27)
    "2027-04-15", // Giỗ Tổ approx
    "2027-04-30", "2027-05-01",
    "2027-09-02",
  ]);

  function vnDateString(d = new Date()) {
    const vn = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
    const y = vn.getFullYear();
    const m = String(vn.getMonth() + 1).padStart(2, "0");
    const dd = String(vn.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }

  function isVnHoliday(d = new Date()) {
    return VN_HOLIDAYS.has(vnDateString(d));
  }

  function nextVnHoliday(maxDays = 5) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const ms = 24 * 3600 * 1000;
    let nearest = null;
    for (const h of VN_HOLIDAYS) {
      const d = new Date(h + "T00:00:00");
      const diff = Math.round((d - today) / ms);
      if (diff >= 0 && diff <= maxDays && (!nearest || diff < nearest.daysAway)) {
        nearest = { date: h, daysAway: diff };
      }
    }
    return nearest;
  }

  function isMarketOpenNow() {
    const vn = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
    const day = vn.getDay();
    if (day === 0 || day === 6) return false;
    if (isVnHoliday(vn)) return false;
    const min = vn.getHours() * 60 + vn.getMinutes();
    if (min >= 540 && min <= 690) return true;
    if (min >= 780 && min <= 885) return true;
    return false;
  }

  // Session state với countdown — phục vụ Today Briefing
  // VN trading: 9:00-11:30 (sáng) + 13:00-14:45 (chiều), Mon-Fri (skip holiday)
  function getSessionInfo() {
    const vn = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
    const day = vn.getDay();
    const min = vn.getHours() * 60 + vn.getMinutes();
    if (day === 0 || day === 6) {
      return { state: "weekend", label: "Cuối tuần", icon: "🌴", color: "#888", countdown: null };
    }
    if (isVnHoliday(vn)) {
      return { state: "holiday", label: "Nghỉ lễ — TT đóng cửa", icon: "🎉", color: "#FF9800", countdown: null };
    }
    if (min < 540) {
      return {
        state: "pre", label: "Phiên sáng mở trong", icon: "🌅", color: "#FF9800",
        countdown: 540 - min, hint: "Chuẩn bị plan ATO",
      };
    }
    if (min >= 540 && min <= 690) {
      return {
        state: "morning", label: "Phiên sáng — còn", icon: "🟢", color: "#4CAF50",
        countdown: 690 - min, hint: "Đang giao dịch",
      };
    }
    if (min > 690 && min < 780) {
      return {
        state: "lunch", label: "Nghỉ trưa — phiên chiều mở trong", icon: "🍱", color: "#FF9800",
        countdown: 780 - min,
      };
    }
    if (min >= 780 && min <= 885) {
      return {
        state: "afternoon", label: "Phiên chiều — còn", icon: "🟢", color: "#4CAF50",
        countdown: 885 - min, hint: "Đang giao dịch",
      };
    }
    return {
      state: "post", label: "Phiên đã đóng — chuẩn bị mai", icon: "🌙", color: "#888",
      countdown: null,
    };
  }

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

  function getGreeting() {
    const h = new Date().getHours();
    if (h < 5) return "Khuya rồi";
    if (h < 12) return "Chào buổi sáng";
    if (h < 14) return "Chào buổi trưa";
    if (h < 18) return "Chào buổi chiều";
    if (h < 22) return "Chào buổi tối";
    return "Khuya rồi";
  }

  function fmtFullDate(d = new Date()) {
    const days = ["Chủ nhật", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7"];
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return `${days[d.getDay()]}, ${dd}/${mm}/${d.getFullYear()}`;
  }

  function buildTodayActions(regime, tplusCount) {
    const dow = new Date().getDay();
    const isWeekend = dow === 0 || dow === 6;
    const open = isMarketOpenNow();
    const actions = [];

    // Trading state
    if (isWeekend) {
      actions.push({ icon: "🌴", text: "Cuối tuần — TTCK đóng cửa. Có thể review tracker hoặc plan tuần sau." });
    } else if (open) {
      if (tplusCount > 0) {
        actions.push({ icon: "⚡", text: `Đang trong giờ giao dịch — có <b>${tplusCount} setup T+</b> chất lượng. Check tab Lướt sóng T+.` });
      } else {
        actions.push({ icon: "💤", text: "Trong giờ giao dịch nhưng không có setup T+ chất lượng. Đợi cơ hội rõ hơn." });
      }
    } else {
      actions.push({ icon: "💤", text: "Ngoài giờ giao dịch hôm nay. Plan cho phiên kế nếu cần." });
    }

    // Regime advisory
    if (regime) {
      if (regime.regime === "BEAR" || regime.regime === "BEAR_WEAK") {
        actions.push({ icon: "⚠️", text: `Thị trường <b>${regime.label}</b> — T+ rủi ro cao, threshold đã auto bump lên ≥5.0. Pick chọn lọc kỹ.` });
      } else if (regime.regime === "BULL") {
        actions.push({ icon: "🚀", text: `Thị trường <b>${regime.label}</b> — uptrend rõ, các setup mean-reversion có thể là nhịp pull back ngắn.` });
      }
    }

    return actions;
  }

  // ── Market outlook composer ──
  // Reuse cached data (regime, T+ picks). Không trigger heavy scan.
  function computeMarketOutlook(regime, tplusCache) {
    const out = {
      // Layer 1: Index state
      l1: {
        regime: regime?.regime || null,
        regimeLabel: regime?.label || "--",
        regimeColor: regime?.color || "#888",
        currentValue: regime?.currentValue,
        ret1m: regime?.ret1m,
        ret3m: regime?.ret3m,
        distMa200: regime?.distMa200,
        distMa50: regime?.distMa50,
        atrPct: regime?.atrPct,
        ma50Above200: (regime?.ma50 != null && regime?.ma200 != null) ? regime.ma50 > regime.ma200 : null,
      },
      // Layer 2: Breadth proxy (từ scans gần đây)
      l2: {
        tplusEligible: tplusCache?.eligibleCount,
        tplusTotal: tplusCache?.allCount,
        tplusAge: tplusCache?.timestamp ? Math.round((Date.now() - tplusCache.timestamp) / 60000) : null, // phút
      },
      // Layer 3: Money flow + sector
      l3: {
        sectorBreakdown: null,
        flagActivation: null,
      },
      hint: "",
    };

    // L3: aggregate sector counts từ T+ picks (proxy money flow + leadership)
    if (tplusCache?.picks?.length) {
      const sectorCount = {};
      const flagCount = { bearTrap: 0, sellPressure: 0, lowSessionLiq: 0 };
      let bullishPicks = 0, sumDayChange = 0;
      for (const p of tplusCache.picks) {
        const sec = p.sector || "khác";
        sectorCount[sec] = (sectorCount[sec] || 0) + 1;
        const f = p.flags || {};
        if (f.bearTrap) flagCount.bearTrap++;
        if (f.sellPressure) flagCount.sellPressure++;
        if (f.lowSessionLiq) flagCount.lowSessionLiq++;
        const dc = p.factors?.dayChange ?? 0;
        sumDayChange += dc;
        if (dc > 0) bullishPicks++;
      }
      out.l3.sectorBreakdown = Object.entries(sectorCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([s, c]) => ({ sector: s, count: c }));
      out.l3.flagActivation = flagCount;
      out.l3.bullishPicksRatio = tplusCache.picks.length > 0 ? bullishPicks / tplusCache.picks.length : 0;
      out.l3.avgDayChange = tplusCache.picks.length > 0 ? sumDayChange / tplusCache.picks.length * 100 : 0;
    }

    // L4: tactical hint composite
    out.hint = composeTacticalHint(out);

    return out;
  }

  function composeTacticalHint(out) {
    const parts = [];
    const regime = out.l1.regime;
    const flagAct = out.l3.flagActivation;

    // Holiday near
    const holiday = nextVnHoliday(7);
    const holidayWarn = holiday && holiday.daysAway > 0 && holiday.daysAway <= 3;

    if (regime === "BEAR" || regime === "BEAR_WEAK") {
      parts.push("📉 Market <b>BEAR</b> — hạn chế bắt đáy. T+ cần threshold cao + Confirmed entry.");
    } else if (regime === "BULL" || regime === "BULL_WEAK") {
      parts.push("📈 Market <b>BULL</b> — môi trường thuận lợi cho T+ swing trading.");
    } else if (regime === "RANGE") {
      parts.push("⚡ Market <b>Đi ngang</b> — môi trường lý tưởng cho T+ mean-reversion.");
    }

    // Flag activation pattern
    if (flagAct) {
      const totalRisky = flagAct.bearTrap + flagAct.sellPressure + flagAct.lowSessionLiq;
      const totalPicks = (out.l2.tplusEligible || 0);
      if (totalPicks > 0 && totalRisky / totalPicks > 0.6) {
        parts.push("⚠️ <b>Đa số picks T+ có risk flag</b> — thị trường đang dump nhiều, ưu tiên Confirmed entry.");
      }
    }

    if (holidayWarn) {
      parts.push(`📅 Còn <b>${holiday.daysAway} phiên</b> tới nghỉ lễ — review portfolio cash ratio, T+ hold qua nghỉ rủi ro gap.`);
    }

    // Cash ratio reminder (cho user có portfolio)
    try {
      const cash = window.__SSI_PORTFOLIO__?.loadCash?.() ?? 0;
      const holdings = window.__SSI_PORTFOLIO__?.currentHoldings?.() ?? [];
      let totalMarket = 0;
      for (const h of holdings) {
        const a = portfolioAnalysisCache[h.symbol];
        if (a?.current) totalMarket += h.qty * a.current * 1000;
      }
      const nav = totalMarket + cash;
      if (nav > 0 && holidayWarn) {
        const cashPct = (cash / nav) * 100;
        if (cashPct < 10) {
          parts.push(`💸 Portfolio cash <b>${cashPct.toFixed(0)}%</b> — không đủ dự phòng nếu thị trường gap sau lễ.`);
        }
      }
    } catch {}

    return parts.length > 0 ? parts.join("<br>") : "Đang tổng hợp tín hiệu...";
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

  // ── Sector comparison table (multi-timeframe) ──
  function renderSectorComparisonTable(snapshot) {
    if (!snapshot?.sectorStats || snapshot.sectorStats.length === 0) return "";

    // Sort by avg 1W desc
    const sorted = [...snapshot.sectorStats].sort((a, b) => b.avg1w - a.avg1w);

    const rows = sorted.map((s) => {
      const dayCls = s.avgDay >= 0 ? "up" : "down";
      const daySign = s.avgDay >= 0 ? "+" : "";
      const w1Cls = s.avg1w >= 0 ? "up" : "down";
      const w1Sign = s.avg1w >= 0 ? "+" : "";
      const m1Cls = s.avg1m >= 0 ? "up" : "down";
      const m1Sign = s.avg1m >= 0 ? "+" : "";
      return `
        <div class="sct-row" data-sector="${s.sector}">
          <span class="sct-name">${sectorLabel(s.sector)}</span>
          <span class="sct-count">${s.count}</span>
          <span class="sct-pct pct ${dayCls}">${daySign}${s.avgDay.toFixed(2)}%</span>
          <span class="sct-pct pct ${w1Cls}">${w1Sign}${s.avg1w.toFixed(2)}%</span>
          <span class="sct-pct pct ${m1Cls}">${m1Sign}${s.avg1m.toFixed(2)}%</span>
        </div>
      `;
    }).join("");

    const headerRow = `
      <div class="sct-row sct-header">
        <span class="sct-name">Sector</span>
        <span class="sct-count">N</span>
        <span class="sct-pct">Today</span>
        <span class="sct-pct">1W</span>
        <span class="sct-pct">1M</span>
      </div>
    `;

    return `
      <div class="snap-section">
        <div class="snap-title">📋 Sector comparison (click để drill-down)</div>
        <div class="sct-table">
          ${headerRow}
          ${rows}
        </div>
      </div>
    `;
  }

  // ── Market snapshot section: sector heat + leaders + distribution + 52W ──
  function renderMarketSnapshotSection(snapshot) {
    if (!snapshot) {
      return `
        <div class="home-card snap-card">
          <div class="home-card-title">
            🚀 Sector heat & Mã dẫn dắt
            <button class="home-card-action" id="snap-load-btn" title="Quét universe">↻ Quét</button>
          </div>
          <div class="home-card-empty">Chưa có data — bấm ↻ để scan toàn HOSE+HNX (~5 phút, foreign flow skip cho speed).</div>
        </div>
      `;
    }

    const ageMin = Math.round((Date.now() - snapshot.timestamp) / 60000);
    const ageTxt = ageMin < 60 ? `${ageMin} phút trước` : `${Math.round(ageMin / 60)}h trước`;

    // Sector heat: top 3 + bottom 2 by avg 1W
    const sectorTop = snapshot.sectorStats.slice(0, 3);
    const sectorBottom = snapshot.sectorStats.slice(-2).reverse();
    const sectorHtml = `
      <div class="snap-section">
        <div class="snap-title">🔥 Sector heat (1W return)</div>
        <div class="snap-sectors">
          ${sectorTop.map((s) => {
            const cls = s.avg1w >= 0 ? "up" : "down";
            const sign = s.avg1w >= 0 ? "+" : "";
            return `<div class="snap-sector-row snap-up" data-sector="${s.sector}">
              <span class="snap-sector-name">${sectorLabel(s.sector)}</span>
              <span class="snap-sector-pct pct ${cls}">${sign}${s.avg1w.toFixed(2)}%</span>
              <span class="snap-sector-count">${s.count} mã</span>
            </div>`;
          }).join("")}
          ${sectorBottom.length > 0 ? `<div class="snap-divider"></div>` : ""}
          ${sectorBottom.map((s) => {
            const cls = s.avg1w >= 0 ? "up" : "down";
            const sign = s.avg1w >= 0 ? "+" : "";
            return `<div class="snap-sector-row snap-down" data-sector="${s.sector}">
              <span class="snap-sector-name">${sectorLabel(s.sector)}</span>
              <span class="snap-sector-pct pct ${cls}">${sign}${s.avg1w.toFixed(2)}%</span>
              <span class="snap-sector-count">${s.count} mã</span>
            </div>`;
          }).join("")}
        </div>
      </div>
    `;

    // Leaders & laggards
    const leadersHtml = `
      <div class="snap-section">
        <div class="snap-title">🚀 Top 5 mã dẫn dắt (1W)</div>
        <div class="snap-stocks">
          ${snapshot.leaders.map((s) => {
            const cls = s.ret1w >= 0 ? "up" : "down";
            const sign = s.ret1w >= 0 ? "+" : "";
            const dayCls = (s.dayChange ?? 0) >= 0 ? "up" : "down";
            const daySign = (s.dayChange ?? 0) >= 0 ? "+" : "";
            return `<div class="snap-stock-row" data-symbol="${s.symbol}">
              <span class="snap-stock-sym">${s.symbol}</span>
              <span class="snap-stock-sector">${sectorLabel(s.sector)}</span>
              <span class="snap-stock-1w pct ${cls}">${sign}${s.ret1w.toFixed(1)}%</span>
              <span class="snap-stock-day pct ${dayCls}">${daySign}${(s.dayChange ?? 0).toFixed(2)}% hôm nay</span>
            </div>`;
          }).join("")}
        </div>
      </div>
    `;

    const laggardsHtml = snapshot.laggards.length > 0 ? `
      <div class="snap-section">
        <div class="snap-title">📉 Top 3 mã yếu (1W)</div>
        <div class="snap-stocks">
          ${snapshot.laggards.map((s) => {
            const cls = "down";
            const sign = "";
            const dayCls = (s.dayChange ?? 0) >= 0 ? "up" : "down";
            const daySign = (s.dayChange ?? 0) >= 0 ? "+" : "";
            return `<div class="snap-stock-row snap-stock-weak" data-symbol="${s.symbol}">
              <span class="snap-stock-sym">${s.symbol}</span>
              <span class="snap-stock-sector">${sectorLabel(s.sector)}</span>
              <span class="snap-stock-1w pct ${cls}">${sign}${s.ret1w.toFixed(1)}%</span>
              <span class="snap-stock-day pct ${dayCls}">${daySign}${(s.dayChange ?? 0).toFixed(2)}% hôm nay</span>
            </div>`;
          }).join("")}
        </div>
      </div>
    ` : "";

    // Foreign flow leaders
    const ffHtml = snapshot.ffLeaders.length > 0 ? `
      <div class="snap-section">
        <div class="snap-title">💰 Top 3 NN gom mạnh (5 phiên)</div>
        <div class="snap-stocks">
          ${snapshot.ffLeaders.map((s) => {
            const billions = (s.netForeign5d / 1e9).toFixed(1);
            return `<div class="snap-stock-row" data-symbol="${s.symbol}">
              <span class="snap-stock-sym">${s.symbol}</span>
              <span class="snap-stock-sector">${sectorLabel(s.sector)}</span>
              <span class="snap-stock-ff up">+${billions} tỷ</span>
            </div>`;
          }).join("")}
        </div>
      </div>
    ` : "";

    // Breadth quick line
    const b = snapshot.breadth;
    const breadthHtml = `
      <div class="snap-breadth">
        🌡️ Breadth: <b>${b.upToday}/${b.total}</b> mã tăng hôm nay (${b.upTodayPct.toFixed(0)}%)
        · Tuần: ${b.upWeek}/${b.total} (${b.upWeekPct.toFixed(0)}%)
        · 52W: <b class="up">${b.newHighs} đỉnh</b> / <b class="down">${b.newLows} đáy</b>
      </div>
    `;

    // Distribution stats today (histogram bars)
    const dist = snapshot.distribution || {};
    const distTotal = b.total || 1;
    const distEntries = [
      { key: "strong_down", label: "≤ -5%", color: "#ff3030", count: dist.strong_down || 0 },
      { key: "down", label: "-5% to -2%", color: "#ff6347", count: dist.down || 0 },
      { key: "mild_down", label: "-2% to 0%", color: "#ff9999", count: dist.mild_down || 0 },
      { key: "flat", label: "≈ 0%", color: "#888888", count: dist.flat || 0 },
      { key: "mild_up", label: "0% to +2%", color: "#90ee90", count: dist.mild_up || 0 },
      { key: "up", label: "+2% to +5%", color: "#4caf50", count: dist.up || 0 },
      { key: "strong_up", label: "≥ +5%", color: "#1b8a3a", count: dist.strong_up || 0 },
    ];
    const maxDist = Math.max(...distEntries.map((e) => e.count), 1);
    const distBars = distEntries.map((e) => {
      const pct = (e.count / maxDist) * 100;
      return `
        <div class="dist-bar-row">
          <span class="dist-label">${e.label}</span>
          <div class="dist-bar-track">
            <div class="dist-bar-fill" style="width:${pct}%; background:${e.color}"></div>
          </div>
          <span class="dist-count">${e.count}</span>
        </div>
      `;
    }).join("");
    const distHtml = `
      <div class="snap-section">
        <div class="snap-title">📊 Phân bố biến động hôm nay (${distTotal} mã)</div>
        <div class="snap-dist">${distBars}</div>
      </div>
    `;

    // Volume surge list
    const surges = snapshot.volSurges || [];
    const surgesHtml = surges.length > 0 ? `
      <div class="snap-section">
        <div class="snap-title">⚡ Volume surge (vol ≥ 2× TB)</div>
        <div class="snap-stocks">
          ${surges.map((s) => {
            const dayCls = (s.dayChange ?? 0) >= 0 ? "up" : "down";
            const daySign = (s.dayChange ?? 0) >= 0 ? "+" : "";
            return `<div class="snap-stock-row" data-symbol="${s.symbol}">
              <span class="snap-stock-sym">${s.symbol}</span>
              <span class="snap-stock-sector">${sectorLabel(s.sector)}</span>
              <span class="snap-stock-vol">${(s.volRatio || 0).toFixed(1)}×</span>
              <span class="snap-stock-day pct ${dayCls}">${daySign}${(s.dayChange ?? 0).toFixed(2)}%</span>
            </div>`;
          }).join("")}
        </div>
      </div>
    ` : "";

    // 52W high list
    const at52H = snapshot.at52wHigh || [];
    const high52wHtml = at52H.length > 0 ? `
      <div class="snap-section">
        <div class="snap-title">🚀 Đang ở đỉnh 52W (${at52H.length})</div>
        <div class="snap-stocks">
          ${at52H.map((s) => {
            const cls = (s.ret1w ?? 0) >= 0 ? "up" : "down";
            const sign = (s.ret1w ?? 0) >= 0 ? "+" : "";
            return `<div class="snap-stock-row" data-symbol="${s.symbol}">
              <span class="snap-stock-sym">${s.symbol}</span>
              <span class="snap-stock-sector">${sectorLabel(s.sector)}</span>
              <span class="snap-stock-1w pct ${cls}">${sign}${(s.ret1w ?? 0).toFixed(1)}% 1W</span>
            </div>`;
          }).join("")}
        </div>
      </div>
    ` : "";

    // 52W low list
    const at52L = snapshot.at52wLow || [];
    const low52wHtml = at52L.length > 0 ? `
      <div class="snap-section">
        <div class="snap-title">📉 Đang ở đáy 52W (${at52L.length})</div>
        <div class="snap-stocks">
          ${at52L.map((s) => {
            return `<div class="snap-stock-row snap-stock-weak" data-symbol="${s.symbol}">
              <span class="snap-stock-sym">${s.symbol}</span>
              <span class="snap-stock-sector">${sectorLabel(s.sector)}</span>
              <span class="snap-stock-1w pct down">${(s.ret1w ?? 0).toFixed(1)}% 1W</span>
            </div>`;
          }).join("")}
        </div>
      </div>
    ` : "";

    const universeLabel = `HOSE+HNX (~${b.total} mã)`;

    const comparisonHtml = renderSectorComparisonTable(snapshot);
    const trendingHtml = renderTrendingLists(snapshot);
    const rotationHtml = renderSectorRotation(snapshot);

    return `
      <div class="home-card snap-card">
        <div class="home-card-title">
          🚀 Sector heat & Mã dẫn dắt
          <button class="home-card-action" id="snap-load-btn" title="Refresh ${ageTxt}">↻</button>
        </div>
        ${universeToggle}
        ${breadthHtml}
        ${distHtml}
        ${rotationHtml}
        ${sectorHtml}
        ${comparisonHtml}
        ${leadersHtml}
        ${laggardsHtml}
        ${trendingHtml}
        ${surgesHtml}
        ${high52wHtml}
        ${low52wHtml}
        ${ffHtml}
        <div class="mo-disclaimer">Universe: ${universeLabel} · Cập nhật ${ageTxt}</div>
      </div>
    `;
  }

  // ── Trending / momentum scanner (Phase 3) ──
  function renderTrendingLists(snapshot) {
    const t = snapshot?.trending || {};
    const cm20 = t.crossMa20 || [];
    const bo = t.breakouts || [];
    const rev = t.reversals || [];
    if (cm20.length === 0 && bo.length === 0 && rev.length === 0) return "";

    const renderList = (title, items, formatter) => {
      if (items.length === 0) return "";
      return `
        <div class="snap-section">
          <div class="snap-title">${title} (${items.length})</div>
          <div class="snap-stocks">
            ${items.map(formatter).join("")}
          </div>
        </div>
      `;
    };

    const cm20Html = renderList("📈 Đang vào uptrend (cross MA20 + vol)", cm20, (s) => {
      const dayCls = (s.dayChange ?? 0) >= 0 ? "up" : "down";
      const daySign = (s.dayChange ?? 0) >= 0 ? "+" : "";
      return `<div class="snap-stock-row" data-symbol="${s.symbol}">
        <span class="snap-stock-sym">${s.symbol}</span>
        <span class="snap-stock-sector">${sectorLabel(s.sector)}</span>
        <span class="snap-stock-vol">${(s.volRatio || 0).toFixed(1)}×</span>
        <span class="snap-stock-day pct ${dayCls}">${daySign}${(s.dayChange ?? 0).toFixed(2)}%</span>
      </div>`;
    });

    const boHtml = renderList("🚀 Phá đỉnh 52W gần đây", bo, (s) => {
      const dayCls = (s.dayChange ?? 0) >= 0 ? "up" : "down";
      const daySign = (s.dayChange ?? 0) >= 0 ? "+" : "";
      const w1Cls = (s.ret1w ?? 0) >= 0 ? "up" : "down";
      const w1Sign = (s.ret1w ?? 0) >= 0 ? "+" : "";
      return `<div class="snap-stock-row" data-symbol="${s.symbol}">
        <span class="snap-stock-sym">${s.symbol}</span>
        <span class="snap-stock-sector">${sectorLabel(s.sector)}</span>
        <span class="snap-stock-1w pct ${w1Cls}">${w1Sign}${(s.ret1w ?? 0).toFixed(1)}% 1W</span>
        <span class="snap-stock-day pct ${dayCls}">${daySign}${(s.dayChange ?? 0).toFixed(2)}%</span>
      </div>`;
    });

    const revHtml = renderList("🔄 Reversal candidates (RSI<30 + bounce)", rev, (s) => {
      const dayCls = (s.dayChange ?? 0) >= 0 ? "up" : "down";
      const daySign = (s.dayChange ?? 0) >= 0 ? "+" : "";
      return `<div class="snap-stock-row" data-symbol="${s.symbol}">
        <span class="snap-stock-sym">${s.symbol}</span>
        <span class="snap-stock-sector">${sectorLabel(s.sector)}</span>
        <span class="snap-stock-vol">RSI ${(s.rsi14 || 0).toFixed(0)}</span>
        <span class="snap-stock-day pct ${dayCls}">${daySign}${(s.dayChange ?? 0).toFixed(2)}%</span>
      </div>`;
    });

    return `${cm20Html}${boHtml}${revHtml}`;
  }

  // ── Sector rotation 4 quadrants ──
  function renderSectorRotation(snapshot) {
    const r = snapshot?.sectorRotation;
    if (!r) return "";
    const total = r.leading.length + r.improving.length + r.lagging.length + r.weakening.length;
    if (total === 0) return "";

    const renderQuadrant = (label, icon, items, color, desc) => {
      const itemsHtml = items.length > 0
        ? items.map((s) => {
            const cls = (s.rel1w ?? 0) >= 0 ? "up" : "down";
            const sign = (s.rel1w ?? 0) >= 0 ? "+" : "";
            return `<div class="rot-sector" data-sector="${s.sector}">
              <span class="rot-sec-name">${sectorLabel(s.sector)}</span>
              <span class="rot-sec-rel pct ${cls}">${sign}${(s.rel1w ?? 0).toFixed(1)}%</span>
            </div>`;
          }).join("")
        : `<div class="rot-empty">—</div>`;
      return `
        <div class="rot-quadrant" style="border-color:${color}55">
          <div class="rot-q-head" style="color:${color}">${icon} ${label}</div>
          <div class="rot-q-desc">${desc}</div>
          <div class="rot-q-list">${itemsHtml}</div>
        </div>
      `;
    };

    const ret1m = snapshot.vniRet1m ?? 0;
    const ret1w = snapshot.vniRet1w ?? 0;
    const indexHint = `VN-Index: 1W ${ret1w >= 0 ? "+" : ""}${ret1w.toFixed(2)}% · 1M ${ret1m >= 0 ? "+" : ""}${ret1m.toFixed(2)}%`;

    return `
      <div class="snap-section">
        <div class="snap-title">🔄 Sector rotation (relative vs VN-Index)</div>
        <div class="rot-hint">${indexHint} · X = 1M rel · Y = 1W rel (momentum)</div>
        <div class="rot-grid">
          ${renderQuadrant("Improving", "📈", r.improving, "#FF9800", "Yếu vs index nhưng momentum đảo chiều — watchlist")}
          ${renderQuadrant("Leading", "🏆", r.leading, "#4CAF50", "Mạnh + momentum tốt — focus")}
          ${renderQuadrant("Lagging", "📉", r.lagging, "#ff5722", "Yếu + momentum yếu — tránh")}
          ${renderQuadrant("Weakening", "⚠️", r.weakening, "#FFC107", "Mạnh nhưng momentum yếu — cẩn thận TP")}
        </div>
      </div>
    `;
  }

  // T+ trigger check: throttle 1 lần/3 phút
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

    // Market snapshot (sector heat + leaders + distribution + 52W) — load cache
    let snapshot = null;
    try {
      const snapCached = JSON.parse(localStorage.getItem("market_snapshot_full_v1") || "null");
      if (snapCached?.data) snapshot = snapCached.data;
    } catch {}
    const snapshotHtml = renderMarketSnapshotSection(snapshot);

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

    // 2. T+ opportunities preview
    if (tplusCached && tplusCached.picks && tplusCached.picks.length > 0) {
      const top3 = tplusCached.picks.slice(0, 3);
      html += `
        <div class="home-card home-card-clickable" data-target-tab="ranking" data-target-mode="tplus">
          <div class="home-card-title">⚡ Cơ hội T+ (${tplusCached.picks.length} mã)</div>
          ${top3.map((p, i) => `
            <div class="home-pick-row">
              <span class="home-pick-rank">#${i + 1}</span>
              <span class="home-pick-symbol">${p.symbol}</span>
              <span class="home-pick-score">+${p.score.toFixed(1)}</span>
              <span class="home-pick-tags">${(p.reasons || []).slice(0, 2).join(", ")}</span>
            </div>
          `).join("")}
          <div class="home-card-cta">Xem đầy đủ →</div>
        </div>
      `;
    } else {
      html += `
        <div class="home-card home-card-clickable" data-target-tab="ranking" data-target-mode="tplus">
          <div class="home-card-title">⚡ Cơ hội T+</div>
          <div class="home-card-empty">Chưa có data hoặc không có setup chất lượng. Tap để quét.</div>
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

    // Tracker summary (T+ only) — show recent snapshot picks preview
    const tracker = RANKING.loadTracker();
    const tplusSnaps = tracker.tplus?.length || 0;
    if (tplusSnaps > 0) {
      const lastSnap = tracker.tplus[tracker.tplus.length - 1];
      const lastDate = new Date(lastSnap.date);
      const daysAgo = Math.floor((Date.now() - lastDate.getTime()) / (24 * 3600 * 1000));
      const daysAgoLabel = daysAgo === 0 ? "hôm nay" : daysAgo === 1 ? "hôm qua" : `${daysAgo}d trước`;
      const lastDateStr = lastDate.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" });
      const picksPreview = (lastSnap.picks || []).slice(0, 5).map((p) =>
        `<span class="tracker-pick-pill">${p.symbol}<small>+${p.score?.toFixed(1) ?? "?"}</small></span>`
      ).join("");
      const morePicks = (lastSnap.picks?.length || 0) > 5 ? `<span class="tracker-pick-pill tracker-pick-more">+${lastSnap.picks.length - 5}</span>` : "";

      html += `
        <div class="home-card home-card-clickable" data-target-tab="ranking" data-target-tracker="1">
          <div class="home-card-title">📊 Lịch sử khuyến nghị T+ <small>(${tplusSnaps} snapshots)</small></div>
          <div class="tracker-last-row">
            <span class="tracker-last-date">📅 ${lastDateStr} (${daysAgoLabel}) · ${lastSnap.picks?.length || 0} mã</span>
          </div>
          <div class="tracker-picks-preview">${picksPreview}${morePicks}</div>
          <div class="home-card-cta">Xem performance đầy đủ →</div>
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
        if (card.dataset.targetTracker) {
          setTimeout(() => {
            const trackerHeader = document.getElementById("tracker-header");
            if (trackerHeader) trackerHeader.click();
          }, 100);
        }
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

    // Market snapshot scan button — always full universe now
    const snapBtn = document.getElementById("snap-load-btn");
    if (snapBtn) {
      snapBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        snapBtn.disabled = true;
        const oldText = snapBtn.textContent;
        snapBtn.textContent = "0/?";
        try {
          await RANKING.loadMarketSnapshot({
            useCache: false,
            universe: "full",
            onProgress: (done, total) => {
              snapBtn.textContent = `${done}/${total}`;
            },
          });
          renderHome(); // re-render with new data
        } catch (err) {
          snapBtn.textContent = oldText;
          snapBtn.disabled = false;
          alert("Lỗi quét: " + err.message);
        }
      });
    }

    // Stock rows in snapshot → navigate to analyze
    container.querySelectorAll(".snap-stock-row").forEach((row) => {
      row.addEventListener("click", () => {
        const sym = row.dataset.symbol;
        if (!sym) return;
        switchTab("analyze");
        const input = document.getElementById("symbol-input");
        if (input) input.value = sym;
        clearAnalyzeContext();
        analyzeSymbol(sym);
      });
    });

    // Sector rows (heat + comparison table) → open sector detail modal
    container.querySelectorAll("[data-sector]").forEach((row) => {
      row.addEventListener("click", () => {
        const sec = row.dataset.sector;
        if (!sec || !snapshot) return;
        openSectorDetail(sec, snapshot);
      });
    });
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
      vnindexChartInstance = window.LightweightCharts.createChart(container, {
        width: chartWidth,
        height: 220,
        layout: { background: { color: "transparent" }, textColor: "#a0a0b0", fontSize: 10 },
        grid: {
          vertLines: { color: "rgba(255,255,255,0.04)" },
          horzLines: { color: "rgba(255,255,255,0.04)" },
        },
        rightPriceScale: { borderColor: "rgba(255,255,255,0.1)" },
        timeScale: { borderColor: "rgba(255,255,255,0.1)", timeVisible: false },
        crosshair: { mode: 0 },
      });
      const series = vnindexChartInstance.addCandlestickSeries({
        upColor: "#4CAF50", downColor: "#ff5722",
        borderUpColor: "#4CAF50", borderDownColor: "#ff5722",
        wickUpColor: "#4CAF50", wickDownColor: "#ff5722",
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

  // Render home initially + re-render when switching to home tab
  renderHome();
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
  // ── RANKING TAB ──
  // ════════════════════════════════════════════════════
  let rankingState = {
    mode: "tplus",  // chỉ còn T+ — DCA đã removed
    tplus: { picks: [], topN: 10, loaded: false },
    loading: false,
  };

  function curState() {
    return rankingState.tplus;
  }

  // Market regime hint cho T+ tab (mapping regime → đề xuất hành động)
  async function renderRegimeHint() {
    const banner = $("regime-hint-banner");
    if (!banner) return;
    try {
      const regime = await RANKING.getMarketRegime();
      if (!regime) { banner.style.display = "none"; return; }
      const r = regime.regime;
      let advice, color;
      if (r === "BULL" || r === "BULL_WEAK") {
        advice = `${regime.label} — ưu tiên breakout / pullback. Mean-rev cũng OK.`;
        color = "#4CAF50";
      } else if (r === "BEAR" || r === "BEAR_WEAK") {
        advice = `${regime.label} — <b>hạn chế bắt đáy</b>. Setup cần threshold cao + Confirmed entry.`;
        color = "#ff5722";
      } else {
        advice = `${regime.label} — phù hợp mean-reversion (môi trường lý tưởng cho T+).`;
        color = "#FF9800";
      }
      banner.innerHTML = `📊 <b>Market: ${regime.label}</b> — ${advice.replace(`${regime.label} — `, "")}`;
      banner.style.borderColor = `${color}55`;
      banner.style.background = `${color}15`;
      banner.style.color = color;
      banner.style.display = "block";
    } catch {
      banner.style.display = "none";
    }
  }

  function renderHolidayBanner() {
    const banner = $("holiday-banner");
    if (!banner) return;
    const h = nextVnHoliday(5);
    if (!h) {
      banner.style.display = "none";
      return;
    }
    const niceDate = new Date(h.date + "T00:00:00")
      .toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" });
    if (h.daysAway === 0) {
      banner.innerHTML = `📅 Hôm nay <b>${niceDate}</b> là ngày nghỉ lễ — TT đóng cửa.`;
    } else {
      banner.innerHTML = `⚠️ <b>${h.daysAway} ngày nữa nghỉ lễ ${niceDate}</b> — T+ hold qua nghỉ rủi ro gap mở cửa. Cân nhắc giảm size, đóng vị thế trước, hoặc tránh mở mới.`;
    }
    banner.style.display = "block";
  }

  // ── Mid-term (Rà soát Trung hạn) — Phase 4 migration ──
  // Replace T+ swing scan với Base Breakout pattern (Phase 1 verified Sharpe +1.13).
  // Pattern persist server-side qua EOD cron → app chỉ fetch /mid-term-picks.

  const MID_TERM_DEFAULT_SIZE_VND = 10_000_000;  // 10M VND default (Phase 1 winner)
  const MID_TERM_SIZE_KEY = "stock_pwa_midterm_size_vnd";
  let midTermPicksCache = [];

  function loadMidTermSize() {
    try {
      const v = parseFloat(localStorage.getItem(MID_TERM_SIZE_KEY));
      return isFinite(v) && v > 0 ? v : MID_TERM_DEFAULT_SIZE_VND;
    } catch { return MID_TERM_DEFAULT_SIZE_VND; }
  }

  function saveMidTermSize(vnd) {
    try { localStorage.setItem(MID_TERM_SIZE_KEY, String(vnd)); } catch {}
  }

  function renderSizingHelper() {
    const el = $("midterm-sizing-helper");
    if (!el) return;
    const size = loadMidTermSize();
    el.innerHTML = `
      <div class="sizing-row">
        <label>💰 Vốn/pick:</label>
        <input type="number" id="midterm-size-input" value="${Math.round(size / 1e6)}" min="1" step="1">
        <span class="sizing-unit">triệu VND</span>
        <small class="sizing-hint">Backtest: 10M/signal → +29.8%/năm</small>
      </div>`;
    const inp = document.getElementById("midterm-size-input");
    if (inp) {
      inp.addEventListener("change", (e) => {
        const v = parseFloat(e.target.value) * 1e6;
        if (isFinite(v) && v > 0) {
          saveMidTermSize(v);
          renderMidTermPicks(midTermPicksCache);
        }
      });
    }
  }

  function renderMidTermCard(p, sizeVnd) {
    const entryPrice = parseFloat(p.entry_price);
    const initSL = parseFloat(p.init_sl_price);
    const peakPrice = p.peak_price ? parseFloat(p.peak_price) : null;
    // entry_price in nghìn VND. sizeVnd in VND. shares = sizeVnd / (entry × 1000)
    const rawShares = sizeVnd / (entryPrice * 1000);
    const shares = Math.max(100, Math.round(rawShares / 100) * 100);  // VN lot size = 100
    const actualCost = shares * entryPrice * 1000;

    const signalDate = p.signal_date;
    const signalDt = new Date(signalDate);
    const todayDt = new Date();
    const daysSince = Math.floor((todayDt - signalDt) / (24 * 3600 * 1000));
    const maxHold = p.max_hold_days || 30;

    let status, statusCls;
    if (peakPrice && peakPrice > entryPrice) {
      const peakRet = ((peakPrice - entryPrice) / entryPrice * 100).toFixed(1);
      status = `📈 Peak +${peakRet}%`;
      statusCls = "status-profit";
    } else if (daysSince === 0) {
      status = "🆕 Mới";
      statusCls = "status-new";
    } else {
      status = `⏳ ${daysSince}d`;
      statusCls = "status-hold";
    }

    const trailStopPrice = peakPrice ? (peakPrice * 0.9) : null;

    const buyZoneMax = entryPrice * 1.02;
    return `
      <div class="midterm-card verdict-strong">
        <div class="mt-card-head">
          <div class="mt-symbol">${p.symbol}</div>
          <div class="mt-status ${statusCls}">${status}</div>
        </div>
        <div class="verdict-line verdict-strong">
          <span class="verdict-text">🟢 STRONG BUY</span>
          <span class="verdict-bt">Backtest: Win 52% · Sharpe 1.13 · avg +6.95%/trade</span>
        </div>
        <div class="mt-prices">
          <div class="mt-price-row">
            <span class="mt-label">Entry:</span>
            <span class="mt-value">${entryPrice.toFixed(2)}k <small>(${signalDate})</small></span>
          </div>
          <div class="mt-price-row">
            <span class="mt-label">Buy zone tối đa:</span>
            <span class="mt-value">≤ ${buyZoneMax.toFixed(2)}k <small>(cap +2% gap)</small></span>
          </div>
          <div class="mt-price-row">
            <span class="mt-label">⛔ Init SL:</span>
            <span class="mt-value mt-sl">${initSL.toFixed(2)}k <small>(−10%)</small></span>
          </div>
          ${peakPrice ? `
          <div class="mt-price-row">
            <span class="mt-label">📈 Peak:</span>
            <span class="mt-value mt-peak">${peakPrice.toFixed(2)}k</span>
          </div>
          <div class="mt-price-row">
            <span class="mt-label">📊 Trail stop:</span>
            <span class="mt-value mt-trail">${trailStopPrice.toFixed(2)}k <small>(−10% từ peak)</small></span>
          </div>` : ""}
        </div>
        <div class="mt-sizing">
          <b>${shares.toLocaleString("vi-VN")} CP</b> × ${entryPrice.toFixed(2)}k = <b>${(actualCost / 1e6).toFixed(2)}M VND</b>
        </div>
        <div class="mt-plan">
          <div class="mt-plan-row">📅 Hold tối đa T+${maxHold} (~${Math.round(maxHold * 1.4)} ngày)</div>
          <div class="mt-plan-row">🎯 Bán khi: trail 10% từ peak / SL −10% / T+${maxHold} timeout</div>
          <div class="mt-plan-row"><small>Pattern: tích lũy &lt;${p.base_range_pct ? p.base_range_pct.toFixed(1) : '10'}% × 30 phiên + break + vol ${p.vol_ratio_at_signal ? p.vol_ratio_at_signal.toFixed(1) : '1.5+'}× TB20</small></div>
        </div>
        ${daysSince > 0 ? `<div class="mt-days-held"><small>📊 ${daysSince}/${maxHold} phiên hold</small></div>` : ""}
      </div>`;
  }

  // Render 1 FBO card (Climax T+5 schema)
  function renderFBOCard(p, sizeVnd) {
    const entryPrice = parseFloat(p.entry_price);
    const target = parseFloat(p.target_price);
    const nnBn = p.nn_net_5d_bn != null ? parseFloat(p.nn_net_5d_bn) : null;
    const rawShares = sizeVnd / (entryPrice * 1000);
    const shares = Math.max(100, Math.round(rawShares / 100) * 100);
    const actualCost = shares * entryPrice * 1000;

    const signalDate = p.signal_date;
    const signalDt = new Date(signalDate);
    const todayDt = new Date();
    const daysSince = Math.floor((todayDt - signalDt) / (24 * 3600 * 1000));

    let status, statusCls;
    if (daysSince === 0) {
      status = "🆕 Mới"; statusCls = "status-new";
    } else if (daysSince <= 5) {
      status = `⏳ T+${daysSince}`; statusCls = "status-hold";
    } else {
      status = `⏰ Quá T+5`; statusCls = "status-expired";
    }

    const slPrice = entryPrice * 0.92;
    const buyZoneMax = entryPrice * 1.02;

    return `
      <div class="midterm-card fbo-card verdict-strong">
        <div class="mt-card-head">
          <div class="mt-symbol">${p.symbol} <span class="fbo-badge">🌊 FBO</span></div>
          <div class="mt-status ${statusCls}">${status}</div>
        </div>
        <div class="verdict-line verdict-strong">
          <span class="verdict-text">🟢 STRONG BUY</span>
          <span class="verdict-bt">Backtest: Win 71% · Sharpe 1.42 (sample n=14 ⚠️)</span>
        </div>
        <div class="mt-prices">
          <div class="mt-price-row">
            <span class="mt-label">Entry signal:</span>
            <span class="mt-value">${entryPrice.toFixed(2)}k <small>(${signalDate})</small></span>
          </div>
          <div class="mt-price-row">
            <span class="mt-label">Buy zone tối đa:</span>
            <span class="mt-value">≤ ${buyZoneMax.toFixed(2)}k <small>(cap +2% gap)</small></span>
          </div>
          <div class="mt-price-row">
            <span class="mt-label">🎯 Target +3%:</span>
            <span class="mt-value mt-peak">${target.toFixed(2)}k</span>
          </div>
          <div class="mt-price-row">
            <span class="mt-label">⛔ SL −8%:</span>
            <span class="mt-value mt-sl">${slPrice.toFixed(2)}k</span>
          </div>
          ${nnBn != null ? `
          <div class="mt-price-row">
            <span class="mt-label">NN 5d:</span>
            <span class="mt-value mt-peak">+${nnBn.toFixed(1)} tỷ <small>✓ Foreign confirm</small></span>
          </div>` : ""}
        </div>
        <div class="mt-sizing">
          <b>${shares.toLocaleString("vi-VN")} CP</b> × ${entryPrice.toFixed(2)}k = <b>${(actualCost / 1e6).toFixed(2)}M VND</b>
        </div>
        <div class="card-warnings">
          <div class="card-warn-row">⚠️ FBO sample backtest còn nhỏ (n=14), size 50% Base Breakout</div>
          <div class="card-warn-row">ℹ️ R:R cap 0.38 looks bad — reality: avg actual +1.28%/trade (Win 71% → break-even ngay với +1.2% avg)</div>
        </div>
        <div class="mt-plan">
          <div class="mt-plan-row">📅 Hold T+3 đến T+5 phiên</div>
          <div class="mt-plan-row">🎯 Bán nếu hit target +3% / SL −8% / T+5 timeout</div>
          <div class="mt-plan-row"><small>Pattern: drop -5% + day green + RSI<50 + NN net 5d > 0 (institutional confirm)</small></div>
        </div>
      </div>`;
  }

  let fboPicksCache = [];
  let climaxPicksCache = [];
  let momentumPicksCache = [];

  // Backtest baseline per Climax tier (verified 7.4y)
  const TIER_BACKTEST_SHORT = {
    Premium: { win: 61, sharpe: 1.90, label: "💎 Premium", desc: "Climax + NN mua → strongest" },
    Elite:   { win: 61, sharpe: 1.71, label: "⚡ Elite",   desc: "Climax + VNI correction regime" },
    A:       { win: 56, sharpe: 0.67, label: "🟢 Tier A",  desc: "Climax strict (drop -7% + vol >2× + RSI <35)" },
    B:       { win: 56, sharpe: 0.70, label: "🔵 Tier B",  desc: "Climax relaxed (drop -5% + vol >2× + RSI <50)" },
    Momentum:{ win: 60, sharpe: 0.60, label: "🚀 Momentum",desc: "Strength continuation" },
  };

  // Verdict logic — rule-based per tier + foreign flow
  function climaxVerdict(tier, nnBn) {
    const bt = TIER_BACKTEST_SHORT[tier];
    if (!bt) return { level: "unknown", text: "Tier không xác định", warnings: [] };
    const warnings = [];
    let level, text;
    if (tier === "Premium") {
      level = "strong"; text = "🟢 STRONG BUY";
    } else if (tier === "Elite") {
      level = "buy"; text = "🟡 BUY";
    } else if (tier === "A") {
      if (nnBn != null && nnBn > 0) {
        level = "buy"; text = "🟡 BUY";
      } else if (nnBn != null && nnBn < -5) {
        level = "caution"; text = "⚠️ CONSIDER";
        warnings.push(`Foreign bán mạnh (${nnBn.toFixed(1)} tỷ 5d) → institutional KHÔNG xác nhận`);
      } else {
        level = "buy"; text = "🟡 BUY";
      }
    } else if (tier === "B") {
      level = "caution"; text = "⚠️ CONSIDER";
      warnings.push("Tier B = baseline relax, size nhỏ hơn Tier A");
      if (nnBn != null && nnBn < 0) {
        warnings.push(`Foreign bán (${nnBn.toFixed(1)} tỷ 5d) → caution`);
      }
    }
    // R:R cap explain — nhiều user lo target 3% / SL 8% bất cân đối.
    // Reality: nhiều trade exit force T+5 ở giá GIỮA cap, không hit limit.
    // Backtest avg actual khác R:R cap appearance.
    if (bt && bt.win < 70) {
      warnings.push(
        `R:R cap = 0.38 (looks bad). Reality: nhiều trade exit force T+5 ở giá giữa cap → backtest avg +${bt.win === 56 ? "0.81" : bt.win === 61 ? "2.05" : "?"}%/trade (verified).`
      );
    }
    return { level, text, warnings, bt };
  }

  // Render 1 Climax tier card (T+5 schema, similar to FBO)
  function renderClimaxCard(p, sizeVnd) {
    const entryPrice = parseFloat(p.entry_price);
    const target = parseFloat(p.target_price);
    const tier = p.tier || "?";
    const nnBn = p.nn_net_5d_bn != null ? parseFloat(p.nn_net_5d_bn) : null;
    const rawShares = sizeVnd / (entryPrice * 1000);
    const shares = Math.max(100, Math.round(rawShares / 100) * 100);
    const actualCost = shares * entryPrice * 1000;
    const signalDate = p.signal_date;
    const signalDt = new Date(signalDate);
    const todayDt = new Date();
    const daysSince = Math.floor((todayDt - signalDt) / (24 * 3600 * 1000));

    let status, statusCls;
    if (daysSince === 0) {
      status = "🆕 Mới"; statusCls = "status-new";
    } else if (daysSince <= 5) {
      status = `⏳ T+${daysSince}`; statusCls = "status-hold";
    } else {
      status = `⏰ Quá T+5`; statusCls = "status-expired";
    }

    const verdict = climaxVerdict(tier, nnBn);
    const tierLabel = verdict.bt?.label || tier;
    const slPrice = entryPrice * 0.92;
    const buyZoneMax = entryPrice * 1.02;  // cap +2% gap
    const entryRet = nnBn;  // placeholder

    // NN context badge
    let nnContext = "";
    if (nnBn != null) {
      if (nnBn > 5) nnContext = "✓ Foreign mua mạnh";
      else if (nnBn > 0) nnContext = "✓ Foreign mua nhẹ";
      else if (nnBn > -5) nnContext = "− Foreign bán nhẹ";
      else nnContext = "⚠️ Foreign bán MẠNH";
    }

    return `
      <div class="midterm-card climax-card-mt tier-${tier.toLowerCase()} verdict-${verdict.level}">
        <div class="mt-card-head">
          <div class="mt-symbol">${p.symbol} <span class="climax-tier-pill">${tierLabel}</span></div>
          <div class="mt-status ${statusCls}">${status}</div>
        </div>
        <div class="verdict-line verdict-${verdict.level}">
          <span class="verdict-text">${verdict.text}</span>
          <span class="verdict-bt">Backtest: Win ${verdict.bt?.win}% · Sharpe ${verdict.bt?.sharpe}</span>
        </div>
        <div class="mt-prices">
          <div class="mt-price-row">
            <span class="mt-label">Entry signal:</span>
            <span class="mt-value">${entryPrice.toFixed(2)}k <small>(${signalDate})</small></span>
          </div>
          <div class="mt-price-row">
            <span class="mt-label">Buy zone tối đa:</span>
            <span class="mt-value">≤ ${buyZoneMax.toFixed(2)}k <small>(cap +2% gap)</small></span>
          </div>
          <div class="mt-price-row">
            <span class="mt-label">🎯 Target +3%:</span>
            <span class="mt-value mt-peak">${target.toFixed(2)}k</span>
          </div>
          <div class="mt-price-row">
            <span class="mt-label">⛔ SL −8%:</span>
            <span class="mt-value mt-sl">${slPrice.toFixed(2)}k</span>
          </div>
          ${nnBn != null ? `
          <div class="mt-price-row">
            <span class="mt-label">NN 5d:</span>
            <span class="mt-value ${nnBn >= 0 ? "mt-peak" : "mt-sl"}">${nnBn >= 0 ? "+" : ""}${nnBn.toFixed(1)} tỷ <small>${nnContext}</small></span>
          </div>` : ""}
        </div>
        <div class="mt-sizing">
          <b>${shares.toLocaleString("vi-VN")} CP</b> × ${entryPrice.toFixed(2)}k = <b>${(actualCost / 1e6).toFixed(2)}M VND</b>
        </div>
        ${verdict.warnings.length > 0 ? `
        <div class="card-warnings">
          ${verdict.warnings.map((w) => `<div class="card-warn-row">⚠️ ${w}</div>`).join("")}
        </div>` : ""}
        <div class="mt-plan">
          <div class="mt-plan-row">📅 Hold T+3 đến T+5 phiên</div>
          <div class="mt-plan-row">🎯 Bán nếu hit target +3% / SL −8% / T+5 timeout</div>
          <div class="mt-plan-row"><small>${verdict.bt?.desc || "Vol Climax Bounce"}</small></div>
        </div>
      </div>`;
  }

  // Render Momentum tier card (T+20 trailing)
  function renderMomentumCard(p, sizeVnd) {
    const entryPrice = parseFloat(p.entry_price);
    const target = parseFloat(p.target_price);
    const rawShares = sizeVnd / (entryPrice * 1000);
    const shares = Math.max(100, Math.round(rawShares / 100) * 100);
    const actualCost = shares * entryPrice * 1000;
    const signalDate = p.signal_date;
    const signalDt = new Date(signalDate);
    const todayDt = new Date();
    const daysSince = Math.floor((todayDt - signalDt) / (24 * 3600 * 1000));

    let status, statusCls;
    if (daysSince === 0) { status = "🆕 Mới"; statusCls = "status-new"; }
    else if (daysSince <= 20) { status = `⏳ T+${daysSince}`; statusCls = "status-hold"; }
    else { status = `⏰ Quá T+20`; statusCls = "status-expired"; }

    const initSL = entryPrice * 0.92;
    return `
      <div class="midterm-card momentum-card-mt">
        <div class="mt-card-head">
          <div class="mt-symbol">${p.symbol} <span class="momentum-pill">🚀 Momentum</span></div>
          <div class="mt-status ${statusCls}">${status}</div>
        </div>
        <div class="mt-prices">
          <div class="mt-price-row">
            <span class="mt-label">Entry:</span>
            <span class="mt-value">${entryPrice.toFixed(2)}k <small>(${signalDate})</small></span>
          </div>
          <div class="mt-price-row">
            <span class="mt-label">Init SL:</span>
            <span class="mt-value mt-sl">${initSL.toFixed(2)}k <small>(−8%)</small></span>
          </div>
          <div class="mt-price-row">
            <span class="mt-label">Expected:</span>
            <span class="mt-value mt-peak">${target.toFixed(2)}k <small>(+3.5%)</small></span>
          </div>
        </div>
        <div class="mt-sizing">
          <b>${shares.toLocaleString("vi-VN")} CP</b> × ${entryPrice.toFixed(2)}k = <b>${(actualCost / 1e6).toFixed(2)}M VND</b>
        </div>
        <div class="mt-plan">
          <div class="mt-plan-row">📅 Hold T+20 max, trailing 7% từ peak</div>
          <div class="mt-plan-row"><small>Pattern: Strength Continuation (MA stack + consolidation + vol confirm)</small></div>
        </div>
      </div>`;
  }

  function renderMidTermPicks(picks) {
    const content = $("ranking-content");
    if (!content) return;
    midTermPicksCache = picks || [];
    renderSizingHelper();

    // Fetch FBO + Climax + Momentum picks parallel (non-blocking)
    fetchFBOPicks(false).then((fboPicks) => {
      fboPicksCache = fboPicks || [];
      renderFBOSection();
    }).catch(() => {});
    fetchClimaxAndMomentumPicks(false).then(({ climax, momentum }) => {
      climaxPicksCache = climax || [];
      momentumPicksCache = momentum || [];
      renderClimaxAndMomentumSections();
    }).catch(() => {});

    if (!picks || picks.length === 0) {
      content.innerHTML = `
        <div class="empty-state ranking-intro">
          <div class="empty-icon">📭</div>
          <h2>Hôm nay không có Base Breakout</h2>
          <p>Pattern selective — đa số ngày 0-2 picks (fire rate ~80/năm = 0.3/ngày).</p>
          <p>Bot quét full 1411 mã EOD lúc 14:50 VN (T2-T6).</p>
          <p><small>📊 Backtest Sharpe +1.13 — không phải money printer, edge realistic.</small></p>
          <button class="btn-primary" id="ranking-load-btn">🔄 Quét full 1411 mã ngay</button>
        </div>
        <div id="fbo-section"></div>
        <div id="climax-section"></div>
        <div id="momentum-section"></div>`;
      return;
    }

    const sizeVnd = loadMidTermSize();
    const cards = picks.map((p) => renderMidTermCard(p, sizeVnd)).join("");
    content.innerHTML = `
      <div class="midterm-picks-header">
        <span class="midterm-count"><b>${picks.length}</b> mã active</span>
        <span class="midterm-sub">Pattern Base Breakout · trail 10% từ peak</span>
      </div>
      <div class="midterm-picks-grid">${cards}</div>
      <div id="fbo-section"></div>
      <div id="climax-section"></div>
      <div id="momentum-section"></div>`;
  }

  function renderClimaxAndMomentumSections() {
    const sizeVnd = loadMidTermSize();
    const climaxSlot = document.getElementById("climax-section");
    if (climaxSlot) {
      if (!climaxPicksCache.length) {
        climaxSlot.innerHTML = "";
      } else {
        const cards = climaxPicksCache.map((p) => renderClimaxCard(p, sizeVnd)).join("");
        climaxSlot.innerHTML = `
          <div class="fbo-section-header climax-section-header">
            <h3>🔻 Bắt đáy T+ — Vol Climax Bounce</h3>
            <span class="fbo-section-sub">${climaxPicksCache.length} mã · drop sâu + vol spike + bounce confirm</span>
          </div>
          <div class="midterm-picks-grid">${cards}</div>`;
      }
    }
    const momSlot = document.getElementById("momentum-section");
    if (momSlot) {
      if (!momentumPicksCache.length) {
        momSlot.innerHTML = "";
      } else {
        const cards = momentumPicksCache.map((p) => renderMomentumCard(p, sizeVnd)).join("");
        momSlot.innerHTML = `
          <div class="fbo-section-header momentum-section-header">
            <h3>🚀 Momentum Swing — Strength Continuation</h3>
            <span class="fbo-section-sub">${momentumPicksCache.length} mã · trend mạnh + MA stack</span>
          </div>
          <div class="midterm-picks-grid">${cards}</div>`;
      }
    }
  }

  function renderFBOSection() {
    const slot = document.getElementById("fbo-section");
    if (!slot) return;
    if (!fboPicksCache.length) {
      slot.innerHTML = "";
      return;
    }
    const sizeVnd = loadMidTermSize();
    const cards = fboPicksCache.map((p) => renderFBOCard(p, sizeVnd)).join("");
    slot.innerHTML = `
      <div class="fbo-section-header">
        <h3>🌊 Bắt đáy ngắn hạn T+5 — Foreign-Backed Oversold</h3>
        <span class="fbo-section-sub">${fboPicksCache.length} mã · Backtest Sharpe +1.42 (sample nhỏ n=14)</span>
      </div>
      <div class="midterm-picks-grid">${cards}</div>`;
  }

  async function fetchMidTermPicks(forceFresh = false) {
    const r = await fetch("https://stock-pwa-bot.qngnhat.workers.dev/mid-term-picks", {
      cache: forceFresh ? "no-store" : "default",
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const json = await r.json();
    return json.picks || [];
  }

  // FBO picks fetched từ /active-picks (climax_active_picks table), filter tier='FBO'
  async function fetchFBOPicks(forceFresh = false) {
    const r = await fetch("https://stock-pwa-bot.qngnhat.workers.dev/active-picks", {
      cache: forceFresh ? "no-store" : "default",
    });
    if (!r.ok) return [];
    const json = await r.json();
    return (json.picks || []).filter((p) => p.tier === "FBO");
  }

  // Climax + Momentum picks (T+5 short-term Bắt đáy + T+20 Momentum)
  async function fetchClimaxAndMomentumPicks(forceFresh = false) {
    const r = await fetch("https://stock-pwa-bot.qngnhat.workers.dev/active-picks", {
      cache: forceFresh ? "no-store" : "default",
    });
    if (!r.ok) return { climax: [], momentum: [] };
    const json = await r.json();
    const picks = json.picks || [];
    return {
      climax: picks.filter((p) => ["A", "B", "Elite", "Premium"].includes(p.tier)),
      momentum: picks.filter((p) => p.tier === "Momentum"),
    };
  }

  async function triggerMidTermQuickScan() {
    // Public endpoint: scan 45 mã large+mid cap subset, persist matches.
    const r = await fetch("https://stock-pwa-bot.qngnhat.workers.dev/mid-term-quick-scan", {
      method: "POST",
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  }

  // Full 1411 mã scan: PWA-driven chunked loop. Init scan state, then call
  // /scan-full-step lặp lại cho đến khi done (~41 chunks × ~5s = ~3-5 phút).
  // onProgress callback nhận {offset, total, climax, momentum, base_breakout}.
  async function triggerFullScan(onProgress) {
    const BASE = "https://stock-pwa-bot.qngnhat.workers.dev";
    // 1. Init scan state
    const initRes = await fetch(`${BASE}/scan-full-init`, { method: "POST" });
    if (!initRes.ok) throw new Error(`Init failed HTTP ${initRes.status}`);
    const initState = await initRes.json();
    if (onProgress) onProgress({ ...initState, current_offset: 0, base_breakout_count: 0 });

    // 2. Loop chunks until completed
    let safetyCounter = 0;
    while (safetyCounter < 100) {  // max 100 iterations (3500 mã, safety)
      safetyCounter++;
      const stepRes = await fetch(`${BASE}/scan-full-step`, { method: "POST" });
      const state = await stepRes.json().catch(() => ({}));
      if (onProgress) onProgress(state);
      if (state.stuck && state.error) {
        throw new Error(`Scan stuck: ${state.error}`);
      }
      if (!stepRes.ok) throw new Error(`Step failed HTTP ${stepRes.status}: ${state.error || "?"}`);
      if (state.completed) return state;
    }
    throw new Error("Scan loop exceeded safety limit");
  }

  function showRankingIntro() {
    // Phase 4 update: auto-load picks instead of static intro. Intro only shown
    // briefly while initial fetch happening, then replaced by renderMidTermPicks.
    const content = $("ranking-content");
    if (!content) return;
    content.innerHTML = `
      <div class="ranking-loading">
        <div class="spinner"></div>
        <div>Đang tải picks Rà soát Trung hạn...</div>
      </div>`;
    renderSizingHelper();
    // Trigger load immediately (auto)
    loadRanking(false);
  }

  async function loadRanking(forceFresh = false) {
    if (rankingState.loading) return;
    rankingState.loading = true;

    const content = $("ranking-content");
    content.innerHTML = `
      <div class="ranking-loading">
        <div class="spinner"></div>
        <div id="ranking-progress">Đang tải picks Rà soát Trung hạn...</div>
      </div>
    `;

    // Phase 4 migration: fetch mid-term picks từ worker (Base Breakout pattern,
    // pre-scanned EOD). KHÔNG còn client-side scan T+ swing.
    try {
      const picks = await fetchMidTermPicks(forceFresh);
      renderMidTermPicks(picks);
      updateMidTermMeta(picks);
    } catch (e) {
      content.innerHTML = `<div class="error"><h3>Lỗi tải picks</h3><p>${e.message}</p><button class="btn-primary" id="ranking-load-btn">Thử lại</button></div>`;
    } finally {
      rankingState.loading = false;
    }
  }

  function updateMidTermMeta(picks) {
    const meta = $("ranking-meta");
    if (!meta) return;
    const now = new Date();
    const time = now.toLocaleString("vi-VN", {
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    meta.textContent = `Cập nhật ${time} · ${picks.length} pick active · hold ~1 tháng · trail 10%`;
  }

  function updateRankingMeta(result) {
    const meta = $("ranking-meta");
    const date = new Date(result.timestamp);
    const time = date.toLocaleString("vi-VN", {
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    const cacheTxt = result.fromCache ? " (từ cache)" : "";
    const climaxCount = result.climaxCount || 0;
    meta.textContent = `Cập nhật ${time}${cacheTxt} · Đã quét ${result.allCount} mã · ${climaxCount} match Bắt đáy T+`;
  }

  // ════════════════════════════════════════════════════
  // ── PAPER TRACKER (T+ only) ──
  // ════════════════════════════════════════════════════
  function getTrackerTab() {
    return "tplus";
  }

  function setTrackerTab() {
    // no-op (chỉ T+, không còn switch)
  }

  function renderTrackerSection() {
    const section = $("tracker-section");
    if (!section) return;
    const tracker = RANKING.loadTracker();
    const tplusCount = tracker.tplus?.length || 0;
    if (tplusCount === 0) {
      section.style.display = "none";
      return;
    }
    section.style.display = "block";
  }

  function fmtDateShort(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "2-digit" });
  }

  function daysSince(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    return Math.floor(ms / (24 * 3600 * 1000));
  }

  async function refreshTracker() {
    const btn = $("tracker-refresh-btn");
    const content = $("tracker-content");
    btn.disabled = true;
    btn.textContent = "Đang tải...";
    content.innerHTML = `<div class="loading"><div class="spinner"></div><div>Fetch lịch sử giá để tính stats...</div></div>`;

    try {
      const tracker = RANKING.loadTracker();
      const allSyms = new Set();
      for (const s of tracker.tplus || []) {
        for (const p of s.picks) allSyms.add(p.symbol);
      }
      // Fetch 90 ngày OHLC để compute peak/MDD/TP/SL outcome
      const histories = await RANKING.fetchPicksHistory([...allSyms], 90);
      const prices = {};
      for (const sym in histories) {
        const h = histories[sym];
        if (h?.closes?.length) prices[sym] = h.closes[h.closes.length - 1];
        else prices[sym] = null;
      }
      lastTrackerData = { tracker, prices, histories };
      renderTrackerContent(tracker, prices, histories);
    } catch (e) {
      content.innerHTML = `
        <div class="error">
          <p>⚠️ Lỗi: ${e.message}</p>
          <button class="btn-primary retry-btn">Thử lại</button>
        </div>
      `;
      const retryBtn = content.querySelector(".retry-btn");
      if (retryBtn) retryBtn.addEventListener("click", () => refreshTracker());
    } finally {
      btn.disabled = false;
      btn.textContent = "Cập nhật giá hiện tại";
    }
  }

  // ── Per-pick stats: walk OHLC từ snap.date → compute peak/MDD/outcome ──
  // T+ TP/SL match backtest spec + plan giao dịch app recommend:
  //   SL  = -8% (worst case; real plan dùng max(-8%, 2×ATR) — đây dùng -8% fixed)
  //   TP1 = +5% (target 1 — thường về MA20 ~5-7%)
  //   TP2 = +12% (target 2 — kháng cự ~10-18%)
  // DCA: hold dài hơn, không hard TP/SL — chỉ track cur ret + peak/MDD.
  function computePickStats(pick, snapDate, history, mode) {
    if (!history || !history.closes?.length || !pick.entryPrice) return null;
    const snapTs = Math.floor(new Date(snapDate).getTime() / 1000);
    const startIdx = history.times.findIndex((t) => t >= snapTs);
    if (startIdx < 0) return null;

    const entry = pick.entryPrice;
    const tp1Px = entry * 1.05;
    const tp2Px = entry * 1.12;
    const slPx  = entry * 0.92;

    let peakRet = 0, peakDay = 0, mddRet = 0, mddDay = 0;
    let outcome = null; // {kind, day}

    for (let i = startIdx; i < history.closes.length; i++) {
      const day = i - startIdx;
      const close = history.closes[i];
      const high  = history.highs?.[i] ?? close;
      const low   = history.lows?.[i]  ?? close;

      const closeRet = (close - entry) / entry;
      if (closeRet > peakRet) { peakRet = closeRet; peakDay = day; }
      if (closeRet < mddRet)  { mddRet  = closeRet; mddDay  = day; }

      // Outcome detection (only T+ — DCA không hard SL/TP)
      if (mode === "tplus" && !outcome) {
        if (low <= slPx) outcome = { kind: "sl", day };
        else if (high >= tp2Px) outcome = { kind: "tp2", day };
        else if (high >= tp1Px) outcome = { kind: "tp1", day };
      }
    }

    const lastIdx = history.closes.length - 1;
    const curPrice = history.closes[lastIdx];
    const curRet = (curPrice - entry) / entry;
    const daysHeld = lastIdx - startIdx;

    // Status badge: outcome hoặc "expired" (T+ > 10 ngày không hit) hoặc "holding"
    let status;
    if (outcome) {
      status = outcome;
    } else if (mode === "tplus" && daysHeld > 10) {
      status = { kind: "expired", day: daysHeld };
    } else {
      status = { kind: "holding", day: daysHeld };
    }

    return { entry, curPrice, curRet, daysHeld, peakRet, peakDay, mddRet, mddDay, status };
  }

  function renderPickRow(r, mode) {
    const p = r.pick;
    const stats = r.stats;
    const sectorChip = p.sector ? `<span class="pick-sector-chip">${sectorLabel(p.sector)}</span>` : "";
    const scoreChip = p.score != null ? `<span class="pick-score-chip">${p.score >= 0 ? "+" : ""}${p.score.toFixed(2)}</span>` : "";

    if (!stats) {
      return `
        <details class="tracker-pick-row tracker-pick-noinfo">
          <summary>
            <span class="pick-sym">${p.symbol}</span>
            <span class="pick-noinfo-txt">— không đủ data</span>
            ${sectorChip}${scoreChip}
          </summary>
        </details>
      `;
    }

    const retCls = stats.curRet >= 0 ? "up" : "down";
    const retSign = stats.curRet >= 0 ? "+" : "";
    const peakCls = stats.peakRet >= 0 ? "up" : "down";
    const peakSign = stats.peakRet >= 0 ? "+" : "";
    const mddSign = stats.mddRet >= 0 ? "+" : "";
    const reasonsHtml = (p.reasons && p.reasons.length)
      ? `<div class="pick-reasons">${p.reasons.slice(0, 4).map((rr) => `<span class="pick-reason-chip">${rr}</span>`).join("")}</div>`
      : "";

    return `
      <details class="tracker-pick-row">
        <summary>
          <span class="pick-sym">${p.symbol}</span>
          <span class="pick-prices">${fp(stats.entry)} → ${fp(stats.curPrice)}</span>
          <span class="pick-ret pct ${retCls}">${retSign}${(stats.curRet * 100).toFixed(2)}%</span>
          <span class="pick-days">[${stats.daysHeld}d]</span>
          ${statusBadge(stats.status)}
        </summary>
        <div class="tracker-pick-detail">
          <div class="pick-detail-row">
            ${sectorChip}${scoreChip}
            <span class="pick-detail-cell">Peak: <b class="${peakCls}">${peakSign}${(stats.peakRet * 100).toFixed(1)}%</b> (day ${stats.peakDay})</span>
            <span class="pick-detail-cell">MDD: <b class="down">${mddSign}${(stats.mddRet * 100).toFixed(1)}%</b> (day ${stats.mddDay})</span>
          </div>
          ${reasonsHtml}
        </div>
      </details>
    `;
  }

  function statusBadge(status) {
    if (!status) return "";
    const map = {
      tp1: { icon: "🎯", txt: "TP1", cls: "stat-tp1" },
      tp2: { icon: "🎯🎯", txt: "TP2", cls: "stat-tp2" },
      sl:  { icon: "🚨", txt: "SL", cls: "stat-sl" },
      expired: { icon: "⏰", txt: "Hết hold", cls: "stat-exp" },
      holding: { icon: "⏳", txt: "Holding", cls: "stat-hold" },
    };
    const m = map[status.kind] || { icon: "?", txt: status.kind, cls: "" };
    return `<span class="pick-status ${m.cls}" title="day ${status.day}">${m.icon} ${m.txt}${status.day != null ? ` ${status.day}d` : ""}</span>`;
  }

  // ── T+ accuracy aggregator: tổng hợp tất cả picks T+ all-time ──
  function computeTplusAccuracyStats(tracker, prices) {
    const tplusSnaps = tracker.tplus || [];
    if (tplusSnaps.length === 0) return null;

    // Flatten all picks across snapshots
    const allPicks = [];
    for (const snap of tplusSnaps) {
      const days = daysSince(snap.date);
      for (const p of snap.picks) {
        const cur = prices[p.symbol];
        if (cur == null || !p.entryPrice) continue;
        const ret = (cur - p.entryPrice) / p.entryPrice;
        allPicks.push({
          symbol: p.symbol,
          sector: p.sector || "khác",
          score: p.score,
          ret,
          days,
          entry: p.entryPrice,
          cur,
          snapDate: snap.date,
        });
      }
    }
    if (allPicks.length === 0) return null;

    const n = allPicks.length;
    const wins = allPicks.filter((p) => p.ret > 0).length;
    const losses = allPicks.filter((p) => p.ret < 0).length;
    const winRate = wins / n;
    const avgRet = allPicks.reduce((s, p) => s + p.ret, 0) / n;
    const sortedByRet = [...allPicks].sort((a, b) => b.ret - a.ret);

    // Hit target/SL counters
    const hitTp1 = allPicks.filter((p) => p.ret >= 0.10).length; // +10%
    const hitTp2 = allPicks.filter((p) => p.ret >= 0.18).length; // +18%
    const hitSl  = allPicks.filter((p) => p.ret <= -0.08).length; // -8%

    // Distribution buckets
    const dist = {
      strongUp: allPicks.filter((p) => p.ret >= 0.10).length,
      modUp:    allPicks.filter((p) => p.ret >= 0.03 && p.ret < 0.10).length,
      flat:     allPicks.filter((p) => p.ret > -0.03 && p.ret < 0.03).length,
      modDown:  allPicks.filter((p) => p.ret > -0.10 && p.ret <= -0.03).length,
      strongDown: allPicks.filter((p) => p.ret <= -0.10).length,
    };

    // Top 3 winners + Top 3 losers
    const topWinners = sortedByRet.slice(0, 3);
    const topLosers = sortedByRet.slice(-3).reverse();

    return {
      n, wins, losses, winRate, avgRet,
      hitTp1, hitTp2, hitSl,
      dist,
      topWinners, topLosers,
    };
  }

  function renderTplusAccuracyCard(stats) {
    if (!stats) return "";

    const winRatePct = (stats.winRate * 100).toFixed(0);
    const winCls = stats.winRate >= 0.5 ? "up" : "down";
    const avgCls = stats.avgRet >= 0 ? "up" : "down";
    const avgSign = stats.avgRet >= 0 ? "+" : "";

    const tp1Pct = ((stats.hitTp1 / stats.n) * 100).toFixed(0);
    const tp2Pct = ((stats.hitTp2 / stats.n) * 100).toFixed(0);
    const slPct = ((stats.hitSl / stats.n) * 100).toFixed(0);

    const distMax = Math.max(...Object.values(stats.dist), 1);
    const distRow = (label, count, color) => {
      const pct = (count / distMax) * 100;
      const sharePct = ((count / stats.n) * 100).toFixed(0);
      return `
        <div class="acc-dist-row">
          <span class="acc-dist-label">${label}</span>
          <div class="acc-dist-track">
            <div class="acc-dist-fill" style="width:${pct}%; background:${color}"></div>
          </div>
          <span class="acc-dist-count">${count} (${sharePct}%)</span>
        </div>
      `;
    };

    const winnersHtml = stats.topWinners.map((p) => {
      const sign = p.ret >= 0 ? "+" : "";
      const cls = p.ret >= 0 ? "up" : "down";
      return `<li><b>${p.symbol}</b> <span class="pct ${cls}">${sign}${(p.ret * 100).toFixed(1)}%</span> <span class="acc-pick-meta">(${fmtDateShort(p.snapDate)} · ${p.days}d)</span></li>`;
    }).join("");

    const losersHtml = stats.topLosers.map((p) => {
      const sign = p.ret >= 0 ? "+" : "";
      const cls = p.ret >= 0 ? "up" : "down";
      return `<li><b>${p.symbol}</b> <span class="pct ${cls}">${sign}${(p.ret * 100).toFixed(1)}%</span> <span class="acc-pick-meta">(${fmtDateShort(p.snapDate)} · ${p.days}d)</span></li>`;
    }).join("");

    // Backtest reference
    const refLine = `Backtest 2018-2024 (T+ score≥4 hold 10 phiên): win 52.3%, avg +0.32%`;

    return `
      <div class="tracker-accuracy-card">
        <div class="acc-title">📊 Tổng hợp accuracy T+ (live tracker)</div>

        <div class="acc-overview-grid">
          <div class="acc-stat">
            <div class="acc-stat-label">Total picks</div>
            <div class="acc-stat-value">${stats.n}</div>
            <div class="acc-stat-sub">${stats.wins} wins / ${stats.losses} losses</div>
          </div>
          <div class="acc-stat">
            <div class="acc-stat-label">Win rate</div>
            <div class="acc-stat-value pct ${winCls}">${winRatePct}%</div>
            <div class="acc-stat-sub">vs backtest 52%</div>
          </div>
          <div class="acc-stat">
            <div class="acc-stat-label">Avg return</div>
            <div class="acc-stat-value pct ${avgCls}">${avgSign}${(stats.avgRet * 100).toFixed(2)}%</div>
            <div class="acc-stat-sub">vs backtest +0.3%</div>
          </div>
        </div>

        <div class="acc-section">
          <div class="acc-section-title">🎯 Hit target / SL</div>
          <div class="acc-targets">
            <span>TP1 (+10%): <b class="up">${stats.hitTp1}/${stats.n} (${tp1Pct}%)</b></span>
            <span>TP2 (+18%): <b class="up">${stats.hitTp2}/${stats.n} (${tp2Pct}%)</b></span>
            <span>SL (-8%): <b class="down">${stats.hitSl}/${stats.n} (${slPct}%)</b></span>
          </div>
        </div>

        <div class="acc-section">
          <div class="acc-section-title">📊 Phân bố P&L</div>
          ${distRow("≥ +10% (TP zone)", stats.dist.strongUp, "#1b8a3a")}
          ${distRow("+3% to +10%", stats.dist.modUp, "#4caf50")}
          ${distRow("± 3% (flat)", stats.dist.flat, "#888")}
          ${distRow("-3% to -10%", stats.dist.modDown, "#ff7043")}
          ${distRow("≤ -10% (SL zone)", stats.dist.strongDown, "#ff3030")}
        </div>

        <div class="acc-grid-2col">
          <div class="acc-section">
            <div class="acc-section-title">🚀 Top 3 winners</div>
            <ul class="acc-pick-list">${winnersHtml}</ul>
          </div>
          <div class="acc-section">
            <div class="acc-section-title">📉 Top 3 losers</div>
            <ul class="acc-pick-list">${losersHtml}</ul>
          </div>
        </div>

        <div class="acc-disclaimer">
          ${refLine}.<br>
          ${stats.winRate >= 0.5 ? "✅ App đang track ngang/trên backtest baseline." : "⚠️ Win rate dưới baseline — có thể do small sample, market regime, hoặc app rules cần tune."}
          Sample size hiện ${stats.n} — sample <30 chỉ là gợi ý, không phải verdict.
        </div>
      </div>
    `;
  }

  function renderTrackerContent(tracker, prices, histories) {
    const content = $("tracker-content");
    let html = "";

    // T+ accuracy summary card
    const accStats = computeTplusAccuracyStats(tracker, prices);
    if (accStats) html += renderTplusAccuracyCard(accStats);

    const rawArr = tracker.tplus || [];
    if (rawArr.length > 0) {
      // Group snapshots theo ngày (local) — multi-snap cùng ngày → keep latest
      const byDate = new Map();
      for (const s of rawArr) {
        const dKey = new Date(s.date).toLocaleDateString("vi-VN");
        const existing = byDate.get(dKey);
        if (!existing || new Date(s.date) > new Date(existing.date)) {
          byDate.set(dKey, s);
        }
      }
      const arr = [...byDate.values()].sort((a, b) => new Date(b.date) - new Date(a.date));
      const dupNote = arr.length < rawArr.length
        ? ` <small class="tracker-dup-note">(${rawArr.length} snapshots → ${arr.length} ngày, gộp dup)</small>`
        : "";
      html += `<div class="tracker-mode-block"><div class="tracker-mode-title">⚡ T+ Snapshots (${arr.length} ngày)${dupNote}</div>`;

      for (const snap of arr) {
        const days = daysSince(snap.date);
        // Compute per-pick stats với historical OHLC
        const rows = snap.picks.map((p) => {
          const stats = histories
            ? computePickStats(p, snap.date, histories[p.symbol], "tplus")
            : null;
          if (!stats) {
            return { pick: p, ret: null, stats: null };
          }
          return { pick: p, ret: stats.curRet, stats };
        });
        const validRows = rows.filter((r) => r.ret !== null);
        const avgRet = validRows.length
          ? validRows.reduce((a, b) => a + b.ret, 0) / validRows.length
          : null;
        const winCount = validRows.filter((r) => r.ret > 0).length;

        // Aggregate stats per snapshot (T+ TP/SL)
        let aggBadges = "";
        if (validRows.length > 0) {
          const counts = { tp1: 0, tp2: 0, sl: 0, expired: 0, holding: 0 };
          for (const r of validRows) {
            const k = r.stats?.status?.kind;
            if (k && counts[k] != null) counts[k]++;
          }
          const parts = [];
          if (counts.tp2) parts.push(`🎯🎯 ${counts.tp2}`);
          if (counts.tp1) parts.push(`🎯 ${counts.tp1}`);
          if (counts.sl)  parts.push(`🚨 ${counts.sl}`);
          if (counts.expired) parts.push(`⏰ ${counts.expired}`);
          if (counts.holding) parts.push(`⏳ ${counts.holding}`);
          if (parts.length) aggBadges = `<div class="tracker-snap-aggbadges">${parts.join(" · ")}</div>`;
        }

        const aggClass = avgRet == null ? "" : avgRet >= 0 ? "up" : "down";
        const aggSign = avgRet == null || avgRet < 0 ? "" : "+";

        html += `
          <div class="tracker-snap">
            <div class="tracker-snap-head">
              <span class="tracker-snap-date">${fmtDateShort(snap.date)} (${days}d)</span>
              ${snap.regime ? `<span class="tracker-snap-regime">${snap.regime}</span>` : ""}
              ${avgRet != null
                ? `<span class="tracker-snap-agg pct ${aggClass}">TB ${aggSign}${(avgRet * 100).toFixed(2)}% · ${winCount}/${validRows.length}</span>`
                : `<span class="tracker-snap-agg">--</span>`}
            </div>
            ${aggBadges}
            <div class="tracker-snap-picks-rich">
              ${rows.map((r) => renderPickRow(r, "tplus")).join("")}
            </div>
          </div>
        `;
      }
      html += "</div>";
    }

    if (!html) {
      content.innerHTML = `<div class="empty-state ranking-intro"><p>Chưa có snapshot T+ nào.</p></div>`;
    } else {
      content.innerHTML = html;
    }
  }

  // Track latest tracker fetch result để re-render
  let lastTrackerData = null;

  // Toggle tracker body
  document.addEventListener("click", (e) => {
    if (e.target.closest("#tracker-header")) {
      const body = $("tracker-body");
      const icon = $("tracker-toggle-icon");
      const open = body.style.display !== "none";
      body.style.display = open ? "none" : "block";
      icon.textContent = open ? "▼" : "▲";
      if (!open) refreshTracker(); // auto-fetch on open
    }
  });

  // Bind tracker buttons
  document.addEventListener("click", (e) => {
    if (e.target && e.target.id === "tracker-refresh-btn") refreshTracker();
    if (e.target && e.target.id === "tracker-clear-btn") {
      if (confirm("Xóa toàn bộ lịch sử khuyến nghị?")) {
        RANKING.clearTracker();
        renderTrackerSection();
        $("tracker-content").innerHTML = "";
      }
    }
  });

  // Render tracker section on init (show/hide based on whether snapshots exist)
  renderTrackerSection();

  // ── Vol Climax Bounce section render ──
  // Cross-validated 8.5 năm: win 58.9%, avg +1.07%/trade, sharpe 0.92.
  // Pattern hiếm (~38 lệnh/năm) — không phải ngày nào cũng có signal.
  // Next trading day skipping Sat/Sun (không cover VN holiday — minor edge case)
  function addTradingDays(date, n) {
    const d = new Date(date);
    let added = 0;
    while (added < n) {
      d.setDate(d.getDate() + 1);
      const dow = d.getDay();
      if (dow !== 0 && dow !== 6) added++;
    }
    return d;
  }

  // Đếm số phiên (weekday) giữa 2 ngày, EXCLUSIVE both ends.
  // tradingDaysBetween("2026-05-12", today=2026-05-14) = 1 (chỉ T4 13/05 ở giữa)
  // Dùng cho T+ position: signal day = T+0, hôm sau = T+1, ...
  function tradingDaysBetween(fromDateStr, toDate) {
    const start = new Date(fromDateStr);
    const end = new Date(toDate);
    // Strip time
    start.setHours(0, 0, 0, 0);
    end.setHours(0, 0, 0, 0);
    if (end <= start) return 0;
    let count = 0;
    const d = new Date(start);
    while (d < end) {
      d.setDate(d.getDate() + 1);
      const dow = d.getDay();
      if (dow !== 0 && dow !== 6) count++;
    }
    return count;
  }
  function fmtDM(d) {
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
  }

  // Per-tier sizing (Kelly approximate dựa trên Sharpe backtest).
  // Higher Sharpe = bigger size justified by better risk-adjusted edge.
  // Reference Sharpe: Premium 1.90 · Elite 1.71 · A 1.09 (ATR) · Momentum 0.60 · B 0.70
  const SIZE_PCT_PER_TIER = {
    "Premium":  0.20,   // 20% NAV — best edge
    "Elite":    0.18,
    "A":        0.15,
    "B":        0.10,
    "Momentum": 0.12,   // Hold lâu hơn nên size nhỏ hơn A
  };

  function getTierSizePct(tier) {
    return SIZE_PCT_PER_TIER[tier] ?? 0.10;
  }

  function computeClimaxPlan(p) {
    const cur = p.currentPrice;
    const entryMax = cur * 1.02;
    const entryMin = cur * 0.99;
    const entryMid = (entryMax + entryMin) / 2;
    // SL close-based -8% (backtest cho thấy SL intraday -4% destroy edge —
    // mã vừa rơi 7%+ thường retest đáy → false trigger). Close-only -8% safe.
    const sl = entryMid * 0.92;
    const target = entryMid * 1.03; // target +3% từ entry (early exit threshold)

    const today = new Date();
    // T+ convention VN: T+0 = entry day (mua ATO/ATC), T+h = h phiên sau
    const t1 = addTradingDays(today, 1); // entry day
    const t3 = addTradingDays(today, 4); // T+0 + 3 phiên = entry day + 3 = T+3
    const t4 = addTradingDays(today, 5);
    const t5 = addTradingDays(today, 6); // force exit

    // Per-tier sizing: Premium 20% > Elite 18% > A 15% > Momentum 12% > B 10%
    const effectiveTier = p.is_premium ? "Premium" : (p.tier || "B");
    const sizePct = getTierSizePct(effectiveTier);

    // Size hint từ NAV
    let sizeQty = null, sizeValue = null, nav = null;
    try {
      const cash = window.__SSI_PORTFOLIO__?.loadCash?.() ?? 0;
      const holdings = window.__SSI_PORTFOLIO__?.currentHoldings?.() ?? [];
      let totalMarket = 0;
      for (const h of holdings) {
        const a = portfolioAnalysisCache?.[h.symbol];
        if (a?.current) totalMarket += h.qty * a.current * 1000;
      }
      nav = totalMarket + cash;
      if (nav > 0 && entryMid > 0) {
        const targetVnd = nav * sizePct;
        sizeQty = Math.floor(targetVnd / (entryMid * 1000));
        sizeValue = sizeQty * entryMid * 1000;
      }
    } catch {}

    return { cur, entryMax, entryMin, entryMid, sl, target, t1, t3, t4, t5,
             sizeQty, sizeValue, sizePct, effectiveTier, nav };
  }

  function renderTrendTierSection(picks) {
    // Trend tier: HH/HL với trailing stop. Backtest cross-val Sharpe 0.76.
    // Win 47% nhưng PF 1.68 (trailing capture big winners).
    let html = `
      <div class="climax-section trend-tier-section">
        <div class="climax-header">
          <h3 class="climax-title">
            📈 Trend tier (HH/HL)
            <span class="climax-badge">${picks.length} mã</span>
          </h3>
          <div class="climax-subtitle">
            Mã 3 higher highs + 3 higher lows + vol confirm + uptrend.
            Hold tối đa <b>T+10</b> với trailing stop <b>6%</b> từ peak. Backtest: Win 45%, Sharpe 0.75, PF 1.44.
            <b>Đặc tính</b>: Win &lt; 50% nhưng PF &gt; 1.3 — winners lớn nhờ trailing capture trend.
          </div>
        </div>
        <div class="watch-tier-list">
    `;
    for (const p of picks.slice(0, 10)) {
      html += `
        <div class="watch-tier-card trend-tier-card" data-symbol="${p.symbol}">
          <div class="watch-tier-row1">
            <span class="watch-tier-symbol">📈 ${p.symbol}</span>
            <span class="watch-tier-sector">${sectorLabel(p.sector)}</span>
            <span class="watch-tier-met up">+${p.ret3d.toFixed(1)}% 3p</span>
          </div>
          <div class="watch-tier-row2">
            <span class="watch-tier-stat">@ ${p.currentPrice.toFixed(2)}</span>
            <span class="watch-tier-stat">Vol ${p.volRatio.toFixed(1)}×</span>
            <span class="watch-tier-stat">MA20 ${p.ma20.toFixed(2)}</span>
            <span class="watch-tier-stat">MA50 ${p.ma50.toFixed(2)}</span>
          </div>
          <div class="watch-tier-missing">
            🎯 Plan: Init SL ${p.planInitSL.toFixed(2)} (-6% entry) · Trailing ${p.planTrailPct}% từ peak · Force exit T+${p.planMaxHold}. Expected ~${p.planExpectedExit.toFixed(2)} (+4% avg).
          </div>
        </div>
      `;
    }
    html += `</div></div>`;
    return html;
  }

  function renderEventTierSection(picks) {
    // Event tier: vol anomaly / gap / thrust = proxy news event.
    // INFORMATIONAL only — edge KHÔNG verify backtest standalone.
    let html = `
      <div class="climax-section event-tier-section">
        <div class="climax-header">
          <h3 class="climax-title">
            📰 Sự kiện / Event tier
            <span class="climax-badge">${picks.length} mã</span>
          </h3>
          <div class="climax-subtitle event-tier-warning">
            ⚠️ <b>Experimental — KHÔNG phải buy signal.</b> Detect "động tĩnh bất thường"
            (vol >3×, gap >2.5%, thrust ±4%). Có thể là tin tức/sự kiện — cần research thêm.
            Backtest standalone Pattern này đã FAIL (Sharpe âm).
          </div>
        </div>
        <div class="watch-tier-list">
    `;
    for (const p of picks.slice(0, 10)) {
      const dirIcon = p.direction === "up" ? "📈" : "📉";
      const dirCls = p.direction === "up" ? "up" : "down";
      html += `
        <div class="watch-tier-card event-tier-card" data-symbol="${p.symbol}">
          <div class="watch-tier-row1">
            <span class="watch-tier-symbol">${dirIcon} ${p.symbol}</span>
            <span class="watch-tier-sector">${sectorLabel(p.sector)}</span>
            <span class="watch-tier-met ${dirCls}">${p.ret1d >= 0 ? "+" : ""}${p.ret1d.toFixed(1)}%</span>
          </div>
          <div class="watch-tier-row2">
            ${p.events.map((e) => `<span class="watch-tier-stat event-tag">${e}</span>`).join("")}
            <span class="watch-tier-stat">@ ${p.currentPrice.toFixed(2)}</span>
          </div>
          <div class="watch-tier-missing">Sự kiện bất thường — search news mã này trước khi trade.</div>
        </div>
      `;
    }
    html += `</div></div>`;
    return html;
  }

  function renderWatchTierSection(picks) {
    // Watch tier: mã 3/4 conditions met (gần Tier B). KHÔNG phải buy signal.
    // Compact list, label rõ "monitor only".
    let html = `
      <div class="climax-section watch-tier-section">
        <div class="climax-header">
          <h3 class="climax-title">
            🔍 Đang theo dõi (Watch tier)
            <span class="climax-badge">${picks.length} mã</span>
          </h3>
          <div class="climax-subtitle watch-tier-warning">
            ⚠️ <b>Monitor only — KHÔNG phải buy signal.</b> Mã fail 1/4 conditions của Tier B.
            Edge chưa verify backtest. Cân nhắc tự research thêm trước khi vào lệnh.
          </div>
        </div>
        <div class="watch-tier-list">
    `;
    for (const p of picks.slice(0, 10)) {
      const missingText = p.missing.length > 0 ? `Còn thiếu: ${p.missing.join(", ")}` : "Gần đủ";
      const ret3dCls = p.ret3d < 0 ? "down" : "up";
      html += `
        <div class="watch-tier-card" data-symbol="${p.symbol}">
          <div class="watch-tier-row1">
            <span class="watch-tier-symbol">${p.symbol}</span>
            <span class="watch-tier-sector">${sectorLabel(p.sector)}</span>
            <span class="watch-tier-met">${p.metCount}/4 ✓</span>
          </div>
          <div class="watch-tier-row2">
            <span class="watch-tier-stat ${ret3dCls}">3p: ${p.ret3d > 0 ? "+" : ""}${p.ret3d.toFixed(1)}%</span>
            <span class="watch-tier-stat">Vol ${p.volRatio.toFixed(1)}×</span>
            <span class="watch-tier-stat">RSI ${p.rsi.toFixed(0)}</span>
            <span class="watch-tier-stat">@ ${p.currentPrice.toFixed(2)}</span>
          </div>
          <div class="watch-tier-missing">${missingText}</div>
        </div>
      `;
    }
    html += `</div></div>`;
    return html;
  }

  function renderMomentumSwingSection(picks, totalCount) {
    const today = new Date();
    let html = `
      <div class="climax-section momentum-section">
        <div class="climax-header">
          <h3 class="climax-title">
            🚀 Momentum Swing
            <span class="climax-tier-badge tier-Momentum">⚡ Bull regime</span>
            <span class="climax-badge">${totalCount} mã</span>
          </h3>
          <div class="climax-subtitle">
            Strong uptrend + consolidation + vol confirm — Win 55%, Sharpe 1.04, PF 2.44 (backtest 8.5y bull)
          </div>
        </div>
        <div class="climax-list">
    `;

    picks.forEach((p, i) => {
      const isWatched = RANKING.isInWatchlist(p.symbol);
      const cur = p.cur;
      // Swing plan: entry T+1 LO ≤ cur × 1.02. Trailing 7% from peak, init SL -8%.
      // Hold up to T+30 với trail. No fixed target — bám trend.
      const entryMax = cur * 1.02;
      const entryMin = cur * 0.98;
      const initSL = cur * 0.92;
      const trailFromPeakPct = 7;
      const expectedReturn = cur * 1.035; // avg +3.5% per backtest

      const t1 = addTradingDays(today, 1);
      const t10 = addTradingDays(today, 11);
      const t20 = addTradingDays(today, 21);
      const t30 = addTradingDays(today, 31);

      html += `
        <div class="climax-card-v2 momentum-card" data-symbol="${p.symbol}" data-rank="${i + 1}">
          <div class="climax-card-header">
            <div class="climax-card-title">
              <span class="climax-rank">#${i + 1}</span>
              <span class="pick-symbol">${p.symbol}</span>
              <span class="pick-sector">${sectorLabel(p.sector)}</span>
              <button class="pick-watchlist ${isWatched ? 'active' : ''}" data-symbol="${p.symbol}">
                ${isWatched ? '★' : '☆'}
              </button>
            </div>
            <div class="climax-card-stats">
              <span class="climax-cur">Giá now <b>${fp(cur)}</b></span>
              <span class="climax-stat">Vol ${p.volRatio.toFixed(1)}×</span>
              <span class="climax-stat">RSI ${p.rsi.toFixed(0)}</span>
              <span class="climax-stat">MA20 ${fp(p.ma20)}</span>
            </div>
          </div>

          <div class="momentum-timeline">
            <div class="climax-tl-step climax-tl-active">
              <div class="climax-tl-dot">📅</div>
              <div class="climax-tl-date">${fmtDM(t1)}</div>
              <div class="climax-tl-action">MUA</div>
            </div>
            <div class="climax-tl-line"></div>
            <div class="climax-tl-step">
              <div class="climax-tl-dot">📈</div>
              <div class="climax-tl-date">${fmtDM(t10)}</div>
              <div class="climax-tl-action">TRAIL +5-10%</div>
            </div>
            <div class="climax-tl-line"></div>
            <div class="climax-tl-step">
              <div class="climax-tl-dot">🎯</div>
              <div class="climax-tl-date">${fmtDM(t20)}</div>
              <div class="climax-tl-action">Avg exit</div>
            </div>
            <div class="climax-tl-line"></div>
            <div class="climax-tl-step">
              <div class="climax-tl-dot">🏁</div>
              <div class="climax-tl-date">${fmtDM(t30)}</div>
              <div class="climax-tl-action">Max hold</div>
            </div>
          </div>

          <div class="climax-boxes">
            <div class="climax-box climax-box-buy">
              <div class="climax-box-label">🟢 MUA ${fmtDM(t1)}</div>
              <div class="climax-box-price">Limit ≤ <b>${fp(entryMax)}</b></div>
              <div class="climax-box-hint">Min ${fp(entryMin)} · cap +2%</div>
            </div>
            <div class="climax-box climax-box-sl">
              <div class="climax-box-label">🔴 SL ban đầu</div>
              <div class="climax-box-price"><b>${fp(initSL)}</b></div>
              <div class="climax-box-hint">-8% từ entry · close-only check daily</div>
            </div>
            <div class="climax-box climax-box-momentum-trail">
              <div class="climax-box-label">🎯 TRAILING -${trailFromPeakPct}%</div>
              <div class="climax-box-price">Bám đỉnh, exit khi rớt ${trailFromPeakPct}%</div>
              <div class="climax-box-hint">
                Hold ~20 phiên · expected exit ~${fp(expectedReturn)} (+3.5%)<br>
                Force exit T+30 (${fmtDM(t30)}) nếu chưa trigger trail
              </div>
            </div>
          </div>

          <details class="climax-orders">
            <summary>📋 Checklist đặt lệnh SSI (Momentum Swing — DIFFERENT từ Climax T+)</summary>
            <div class="climax-orders-body">
              <div class="order-step">
                <div class="order-step-head">
                  <span class="order-step-num">1</span>
                  <b>Đặt MUA</b>
                  <span class="order-when">sáng <b>${fmtDM(t1)}</b> trước <b>8:45</b></span>
                </div>
                <ul class="order-step-detail">
                  <li>SSI iBoard → <b>Lệnh thường</b> → <b>LO</b> mua</li>
                  <li>Giá: <b>${fp(entryMax)}</b> (limit max, min ${fp(entryMin)})</li>
                  <li>KL: <b>10% NAV/lệnh</b> (size nhỏ hơn Climax do hold lâu hơn)</li>
                </ul>
              </div>

              <div class="order-step">
                <div class="order-step-head">
                  <span class="order-step-num">2</span>
                  <b>Trailing stop daily</b>
                  <span class="order-when">mỗi ngày <b>14:25-14:30</b>, từ T+3 trở đi</span>
                </div>
                <ul class="order-step-detail">
                  <li>Mỗi ngày track <b>đỉnh cao nhất</b> kể từ entry (close-based)</li>
                  <li>Tính trail SL = <b>peak × 0.93</b> (-7% từ đỉnh) HOẶC <b>entry × 0.92</b> (init SL) — lấy cái nào CAO hơn</li>
                  <li><b>Nếu close ≤ trail SL</b> → đặt <b>Lệnh thường ATC bán toàn bộ</b></li>
                  <li>Else → hold tiếp</li>
                  <li>⚠️ KHÔNG dùng SSI Trailing Stop (kích hoạt intraday — rớt qua wick)</li>
                </ul>
              </div>

              <div class="order-step">
                <div class="order-step-head">
                  <span class="order-step-num">3</span>
                  <b>Force exit T+30</b>
                  <span class="order-when">sáng <b>${fmtDM(t30)}</b> trước <b>14:25</b></span>
                </div>
                <ul class="order-step-detail">
                  <li>Nếu chưa trigger trail stop sau ~30 phiên → bán force ATC</li>
                  <li>Pattern decay — momentum không còn ý nghĩa sau 30+ phiên</li>
                </ul>
              </div>

              <div class="order-note">
                💡 <b>Khác Climax T+</b>: hold dài hơn (~20 phiên vs T+5), không target cố định, dùng trailing.<br>
                💡 <b>Size 10% NAV</b> (vs 15% cho Climax) vì variance lớn hơn — max 1-2 lệnh đồng thời.<br>
                💡 <b>Khi VNI chuyển correction</b> (ret20 < -5%) → cân nhắc cắt sớm Momentum, focus Climax Elite.
              </div>
            </div>
          </details>
        </div>
      `;
    });

    html += `
        </div>
        <div class="climax-plan-hint">
          ⚠️ Momentum Swing trade trong bull regime. Khi VNI chuyển correction → strategy này edge yếu (Win 28-35%) — chốt sớm rồi switch sang Climax Elite. Đừng all-in.
        </div>
      </div>
    `;
    return html;
  }

  function renderClimaxBounceSection(picks, totalCount, opts = {}) {
    const tierLabel = opts.tier === "Premium" ? "Best edge (NN confirmed)"
      : opts.tier === "Elite" ? "Edge cao nhất"
      : opts.tier === "A" ? "Edge cao"
      : opts.tier === "B" ? "Edge vừa" : null;
    const tierIcon = opts.tier === "Premium" ? "💎"
      : opts.tier === "Elite" ? "⚡" : "";
    const tierBadge = opts.tier
      ? `<span class="climax-tier-badge tier-${opts.tier}">${tierIcon} ${opts.tier} · ${tierLabel}</span>`
      : "";
    const subtitle = opts.tier === "Premium"
      ? "Climax + nước ngoài mua ròng 5 phiên — Win 61%, Sharpe 1.90 (backtest 7.4y)"
      : opts.tier === "Elite"
      ? "Climax pattern + VNI correction regime — Win 61%, Sharpe 1.71 (institutional grade)"
      : opts.tier === "A"
      ? "Strict: drop >7% + vol >2× + RSI <35 — Win 56%, Sharpe 0.67"
      : opts.tier === "B"
      ? "Relax: drop >5% + vol >2× + RSI <50 — Win 56%, Sharpe 0.70"
      : "Mã vừa rơi mạnh có lực mua xác nhận — hold 3 phiên (T+3.5)";

    let html = `
      <div class="climax-section">
        <div class="climax-header">
          <h3 class="climax-title">🔻 Bắt đáy T+ ${tierBadge} <span class="climax-badge">${totalCount} mã</span></h3>
          <div class="climax-subtitle">${subtitle}</div>
        </div>
        <div class="climax-list">
    `;
    picks.forEach((p, i) => {
      const isWatched = RANKING.isInWatchlist(p.symbol);
      const plan = computeClimaxPlan(p);
      const t1Label = fmtDM(plan.t1);
      const t3Label = fmtDM(plan.t3);
      const t4Label = fmtDM(plan.t4);
      const t5Label = fmtDM(plan.t5);
      const sizePctTxt = (plan.sizePct * 100).toFixed(0);
      const sizeHtml = plan.sizeQty
        ? `<div class="climax-size">💰 <b>${plan.sizeQty.toLocaleString("vi-VN")} cp</b> (~${fmtMoney(plan.sizeValue)}, ${sizePctTxt}% NAV · ${plan.effectiveTier} sizing)</div>`
        : `<div class="climax-size climax-size-fallback">💰 Size khuyến nghị: <b>${sizePctTxt}% NAV/lệnh</b> (${plan.effectiveTier} tier — cập nhật cash trong Portfolio để có số CP cụ thể)</div>`;

      // C2 Sector concentration warning
      const sectorExp = getSectorExposureForPick(p.sector, plan.sizePct);
      const sectorWarnHtml = sectorExp.critical
        ? `<div class="climax-sector-warn climax-sector-critical">🚫 <b>${sectorLabel(p.sector)}</b> đã ${sectorExp.current.toFixed(0)}% NAV · pick này sẽ đẩy lên ${sectorExp.afterPick.toFixed(0)}%. <u>KHÔNG nên trade</u> — quá tập trung.</div>`
        : sectorExp.warn
        ? `<div class="climax-sector-warn">⚠️ <b>${sectorLabel(p.sector)}</b> đã ${sectorExp.current.toFixed(0)}% NAV · pick này sẽ đẩy lên ${sectorExp.afterPick.toFixed(0)}%. Cân nhắc giảm size hoặc skip.</div>`
        : "";

      html += `
        <div class="climax-card-v2" data-symbol="${p.symbol}" data-rank="${i + 1}">
          <div class="climax-card-header">
            <div class="climax-card-title">
              <span class="climax-rank">#${i + 1}</span>
              <span class="pick-symbol">${p.symbol}</span>
              <span class="pick-sector">${sectorLabel(p.sector)}</span>
              <button class="pick-watchlist ${isWatched ? 'active' : ''}" data-symbol="${p.symbol}" title="${isWatched ? 'Bỏ khỏi watchlist' : 'Thêm vào watchlist'}">
                ${isWatched ? '★' : '☆'}
              </button>
            </div>
            <div class="climax-card-stats">
              <span class="climax-cur">Giá now <b>${fp(plan.cur)}</b></span>
              <span class="climax-stat down">3p: ${p.ret3d.toFixed(1)}%</span>
              <span class="climax-stat">Vol ${p.volRatio.toFixed(1)}×</span>
              <span class="climax-stat">RSI ${p.rsi.toFixed(0)}</span>
            </div>
          </div>

          <div class="climax-timeline">
            <div class="climax-tl-step climax-tl-active">
              <div class="climax-tl-dot">📅</div>
              <div class="climax-tl-date">${t1Label}</div>
              <div class="climax-tl-action">MUA</div>
            </div>
            <div class="climax-tl-line"></div>
            <div class="climax-tl-step">
              <div class="climax-tl-dot">💰</div>
              <div class="climax-tl-date">${t3Label}</div>
              <div class="climax-tl-action">BÁN nếu +3%</div>
            </div>
            <div class="climax-tl-line"></div>
            <div class="climax-tl-step">
              <div class="climax-tl-dot">⏳</div>
              <div class="climax-tl-date">${t4Label}</div>
              <div class="climax-tl-action">EXTENSION</div>
            </div>
            <div class="climax-tl-line"></div>
            <div class="climax-tl-step">
              <div class="climax-tl-dot">🏁</div>
              <div class="climax-tl-date">${t5Label}</div>
              <div class="climax-tl-action">BÁN FORCE</div>
            </div>
          </div>

          ${sectorWarnHtml}

          <div class="climax-boxes">
            <div class="climax-box climax-box-buy">
              <div class="climax-box-label">🟢 MUA ${t1Label}</div>
              <div class="climax-box-price">Limit ≤ <b>${fp(plan.entryMax)}</b></div>
              <div class="climax-box-hint">Min ${fp(plan.entryMin)} · cap +2% nếu gap up</div>
              ${sizeHtml}
            </div>

            <div class="climax-box climax-box-sl">
              <div class="climax-box-label">🔴 CẮT nếu close dưới</div>
              <div class="climax-box-price"><b>${fp(plan.sl)}</b></div>
              <div class="climax-box-hint">-8% từ entry · KHÔNG cắt intraday (chỉ check ATC)</div>
            </div>

            <div class="climax-box climax-box-sell">
              <div class="climax-box-label">🟢 BÁN T+3 → T+5 ATC</div>
              <div class="climax-box-price">Target <b>${fp(plan.target)}</b> (+3%)</div>
              <div class="climax-box-hint">
                <b>${t3Label}</b>: ATC nếu giá ≥ ${fp(plan.target)} · else hold<br>
                <b>${t4Label}</b>: ATC nếu giá ≥ ${fp(plan.target)} · else hold<br>
                <b>${t5Label}</b>: ATC force (regardless)
              </div>
            </div>
          </div>

          <details class="climax-orders">
            <summary>📋 Checklist đặt lệnh SSI iBoard (click mở)</summary>
            <div class="climax-orders-body">
              <div class="order-step">
                <div class="order-step-head">
                  <span class="order-step-num">1</span>
                  <b>Đặt MUA</b>
                  <span class="order-when">tối <b>${fmtDM(new Date())}</b> hoặc sáng <b>${t1Label}</b> trước <b>8:45</b></span>
                </div>
                <ul class="order-step-detail">
                  <li>SSI iBoard → menu <b>Lệnh thường</b> <span class="ssi-term" data-term="LENH_THUONG">?</span></li>
                  <li>Loại lệnh: <b>LO</b> <span class="ssi-term" data-term="LO">?</span> — <u>không dùng ATO</u> <span class="ssi-term" data-term="ATO">?</span> để tránh gap up khớp giá xấu</li>
                  <li>Giá: <b>${fp(plan.entryMax)}</b> (limit max ${fp(plan.entryMax)}, tối thiểu ${fp(plan.entryMin)})</li>
                  <li>Khối lượng: <b>${plan.sizeQty ? plan.sizeQty.toLocaleString("vi-VN") + " cp" : `≈${sizePctTxt}% NAV / giá entryMax`}</b> (${plan.effectiveTier} tier · ${sizePctTxt}% NAV)</li>
                  <li>Hiệu lực: trong ngày <b>${t1Label}</b> · không khớp → tự huỷ cuối phiên</li>
                </ul>
              </div>

              <div class="order-step">
                <div class="order-step-head">
                  <span class="order-step-num">2</span>
                  <b>Đặt BÁN target +3%</b>
                  <span class="order-when">ngay sau khi lệnh mua khớp (sáng <b>${t1Label}</b> sau 9:15)</span>
                </div>
                <ul class="order-step-detail">
                  <li>SSI iBoard → menu <b>GTD</b> <span class="ssi-term" data-term="GTD">?</span> (lệnh treo nhiều ngày)</li>
                  <li>Lệnh: <b>GTD bán</b> giá <b>${fp(plan.target)}</b></li>
                  <li>Khối lượng: <b>toàn bộ số CP vừa mua</b></li>
                  <li>Hạn hiệu lực: <b>${t5Label}</b> (~7 ngày) — cover từ ${t3Label} đến ${t5Label}</li>
                  <li>Mỗi sáng SSI tự đẩy lại lệnh, giá chạm là khớp — không cần đặt lại mỗi ngày</li>
                  <li>Cách 2 (nếu không quen GTD): mỗi sáng ${t3Label}/${t4Label}/${t5Label} đặt <b>Lệnh thường loại LO bán ${fp(plan.target)}</b> mới (LO chỉ hiệu lực 1 ngày)</li>
                </ul>
              </div>

              <div class="order-step">
                <div class="order-step-head">
                  <span class="order-step-num">3</span>
                  <b>Check CẮT LỖ close-only</b>
                  <span class="order-when">mỗi ngày <b>14:25-14:30</b> từ ${t1Label} đến ${t5Label}</span>
                </div>
                <ul class="order-step-detail">
                  <li>Mở app SSI, xem giá hiện tại (gần ATC)</li>
                  <li><b>Nếu giá ≤ ${fp(plan.sl)}</b> → menu <b>Lệnh thường</b> → loại <b>ATC</b> <span class="ssi-term" data-term="ATC">?</span> bán toàn bộ</li>
                  <li>Nếu giá &gt; ${fp(plan.sl)} → KHÔNG làm gì, hold tiếp</li>
                  <li class="ssi-warn">⚠️ <u>TUYỆT ĐỐI KHÔNG dùng</u>:
                    <b>Stop</b> <span class="ssi-term ssi-term-bad" data-term="STOP">?</span>,
                    <b>Stop Limit</b> <span class="ssi-term ssi-term-bad" data-term="STOP_LIMIT">?</span>,
                    <b>Trailing Stop</b> <span class="ssi-term ssi-term-bad" data-term="TRAILING">?</span>,
                    <b>OCO</b> <span class="ssi-term ssi-term-bad" data-term="OCO">?</span>,
                    <b>Stop Loss/Take Profit</b> <span class="ssi-term ssi-term-bad" data-term="SLTP">?</span>
                    — tất cả trigger intraday, phá rule close-only</li>
                </ul>
              </div>

              <div class="order-step">
                <div class="order-step-head">
                  <span class="order-step-num">4</span>
                  <b>Đặt BÁN force T+5</b>
                  <span class="order-when">sáng <b>${t5Label}</b> trước <b>14:25</b></span>
                </div>
                <ul class="order-step-detail">
                  <li>Chỉ làm <b>nếu bước 2 (GTD target) chưa khớp</b></li>
                  <li>SSI iBoard → menu <b>Lệnh thường</b></li>
                  <li>Loại lệnh: <b>ATC</b> bán (khớp tại giá đóng cửa)</li>
                  <li>Khối lượng: <b>toàn bộ số CP còn lại</b></li>
                  <li>Sau đó nhớ <b>huỷ lệnh GTD</b> ở bước 2 để tránh treo lệnh hớ</li>
                </ul>
              </div>

              <div class="order-note">
                💡 <b>Phí SSI mặc định</b>: mua 0.15-0.25%, bán 0.15-0.25% + thuế bán 0.1% = round-trip ~0.4-0.6%. Backtest đã trừ 0.4%.<br>
                💡 <b>Nếu mua không khớp</b> sáng ${t1Label} (giá mở cửa > ${fp(plan.entryMax)}) → <b>bỏ trade này</b>, không đuổi giá.
              </div>

              <details class="ssi-glossary">
                <summary>📖 Giải thích thuật ngữ SSI (click mở)</summary>
                <dl class="ssi-glossary-list">
                  <dt id="g-LENH_THUONG">Lệnh thường</dt>
                  <dd>Menu đầu tiên trong SSI iBoard. Chứa các loại LO / ATO / ATC / MP tuỳ theo giờ giao dịch. Đây là loại lệnh dùng nhiều nhất.</dd>

                  <dt id="g-LO">LO — Lệnh giới hạn (Limit Order)</dt>
                  <dd>Đặt giá cụ thể, ví dụ "bán 43.04". Chỉ khớp khi có người mua/bán đối ứng ở giá ≥/≤ giá đặt. Không khớp cuối phiên → tự huỷ.</dd>

                  <dt id="g-ATO">ATO — At The Opening</dt>
                  <dd>Khớp tại giá <b>mở cửa</b> phiên (9:00-9:15). Đặt trước 9:15. Rủi ro: gap up → khớp giá rất cao. <u>Không dùng cho strategy này</u>.</dd>

                  <dt id="g-ATC">ATC — At The Closing</dt>
                  <dd>Khớp tại giá <b>đóng cửa</b> phiên (14:30-14:45). Đặt trước 14:25. Dùng khi cần thoát chắc chắn tại close (cắt lỗ, force T+5).</dd>

                  <dt id="g-MP">MP — Market Price</dt>
                  <dd>Bán/mua ngay theo giá thị trường hiện hành. Khớp tức thì nhưng giá có thể xấu nếu thanh khoản mỏng.</dd>

                  <dt id="g-GTD">GTD — Good Till Date ⭐ DÙNG</dt>
                  <dd>Giống LO nhưng <b>hiệu lực nhiều ngày</b> (chọn ngày hết hạn). Mỗi sáng SSI tự đẩy lại lệnh. Hoàn hảo cho "đặt bán target rồi quên đi tới khi khớp".</dd>

                  <dt id="g-STOP" class="bad">Stop — Lệnh dừng ❌ KHÔNG dùng</dt>
                  <dd>Khi giá chạm mức X → đặt lệnh MP. <b>Trigger intraday</b> — sẽ cắt lỗ trên wick (giá rớt nhanh xuyên SL rồi hồi). Backtest đã verify: intraday SL destroy edge.</dd>

                  <dt id="g-STOP_LIMIT" class="bad">Stop Limit ❌ KHÔNG dùng</dt>
                  <dd>Giống Stop nhưng kích hoạt LO thay vì MP. Vẫn intraday → vẫn destroy edge.</dd>

                  <dt id="g-TRAILING" class="bad">Trailing Stop ❌ KHÔNG dùng</dt>
                  <dd>Stop loss "bám theo" giá: giá lên thì mức cắt tự nâng. Intraday → cắt sớm trên rung lắc. Không phù hợp pattern mean-reversion.</dd>

                  <dt id="g-OCO" class="bad">OCO — One Cancels Other ❌ KHÔNG dùng</dt>
                  <dd>Đặt 2 lệnh cùng lúc (vd TP +3% OR SL -8%), khớp 1 thì cái kia huỷ. Vấn đề: stop part vẫn intraday → phá rule close-only.</dd>

                  <dt id="g-SLTP" class="bad">Stop Loss / Take Profit ❌ KHÔNG dùng</dt>
                  <dd>Lệnh combo vừa có SL vừa có TP. Cả 2 trigger intraday → SL part destroy edge.</dd>
                </dl>
              </details>
            </div>
          </details>
        </div>
      `;
    });
    html += `
        </div>
        <div class="climax-plan-hint">
          ⚠️ Pattern hiếm, năm 2023 fail. KHÔNG all-in. Max 2-3 lệnh đồng thời. Backtest win 59-63% → vẫn có 3-4/10 lệnh thua — kỷ luật stop loss close-only.
        </div>
      </div>
    `;
    return html;
  }

  // Phase 4 migration: renderRanking → renderMidTermPicks(cache).
  // Old T+ swing renderRanking body kept below (unreachable) for reference.
  function renderRanking() {
    renderMidTermPicks(midTermPicksCache);
  }

  function _renderRankingLegacy_DORMANT() {
    const content = $("ranking-content");
    const s = curState();
    sectorExposureCache = null;  // recompute fresh per render
    // Trigger drawdown fetch (non-blocking; render uses whatever's cached)
    fetchDrawdownStatus().then(() => {
      // Re-render after data arrives if any tier paused
      if (drawdownStatus && Object.values(drawdownStatus).some((t) => t.isPaused || t.consecLosses >= 2)) {
        const banner = document.getElementById("drawdown-banner-slot");
        if (banner) banner.innerHTML = buildDrawdownBanner();
      }
    });
    const premium = s.lastResult?.climaxPremium || [];
    const tierA = s.lastResult?.climaxTierA || [];
    const tierB = s.lastResult?.climaxTierB || [];
    const elite = s.lastResult?.climaxElite || [];
    const countPremium = s.lastResult?.climaxCountPremium || 0;
    const countA = s.lastResult?.climaxCountA || 0;
    const countB = s.lastResult?.climaxCountB || 0;
    const countElite = s.lastResult?.climaxCountElite || 0;
    const totalCount = countPremium + countA + countB;
    const isEliteRegime = s.lastResult?.isEliteRegime || false;
    const vniRegime = s.lastResult?.vniRegime || "neutral";
    const vniRet20 = s.lastResult?.vniRet20;

    // ── VN-Index regime banner ──
    const regimeBanner = vniRet20 != null ? (() => {
      if (vniRegime === "correction") {
        return `
          <div class="vni-regime-banner regime-correction">
            ⚡ <b>Thị trường đang correction</b> (VN-Index 20 phiên: ${vniRet20.toFixed(1)}%) —
            Vol Climax có edge CAO hôm nay. Mọi match đều là <b>Tier Elite</b>.
            <div class="vni-regime-sub">Win 61% · Sharpe 1.71 (backtest 8.5y)</div>
          </div>`;
      } else if (vniRegime === "bull") {
        return `
          <div class="vni-regime-banner regime-bull">
            🐂 <b>Thị trường bull</b> (VN-Index 20 phiên: +${vniRet20.toFixed(1)}%) —
            Climax pattern <u>edge thấp hơn</u> trong bull market.
            <div class="vni-regime-sub">Backtest: bull market Win 36% (KÉM), correction Win 61% (TỐT)</div>
          </div>`;
      } else {
        return `
          <div class="vni-regime-banner regime-neutral">
            ⚖️ <b>Thị trường neutral</b> (VN-Index 20 phiên: ${vniRet20 >= 0 ? "+" : ""}${vniRet20.toFixed(1)}%) — Climax pattern edge bình thường.
          </div>`;
      }
    })() : "";

    // Style filter — load BEFORE stats banner so banner adapts to selected style
    const style = loadStyle();
    const showBottom = style === "all" || style === "bottom";
    const showMomentum = style === "all" || style === "momentum";
    const showEvent = style === "all" || style === "event";
    const showWatch = style === "all" || style === "bottom";  // Watch ≈ bắt đáy

    // Get count per style
    const momentumCount = s.lastResult?.momentumCount || 0;
    const trendCount = s.lastResult?.trendCount || 0;
    const eventCount = s.lastResult?.eventCount || 0;
    const watchCount = s.lastResult?.watchCount || 0;

    // ── Stats + expectation banner ──
    // Adapt theo style đang chọn
    let statsHtml = "";
    if (showBottom && (style === "bottom" || style === "all")) {
      statsHtml = isEliteRegime ? `
        <div class="tplus-stats">
          <span class="tplus-stats-line">
            ⚡ <b>${countElite}</b> Tier Elite — climax matches + VNI correction regime
          </span>
        </div>
        <div class="tplus-expectation-banner tplus-banner-elite">
          <div class="tplus-exp-title">⚡ Bắt đáy T+ ELITE · climax + thị trường correction</div>
          <div class="tplus-exp-body">
            Backtest 8.5y: Win <b>61.2%</b>, Avg <b>+2.05%</b>/trade, Sharpe <b>1.71</b><br>
            So với baseline (không filter regime): Win 56%, Avg +0.81%, Sharpe 0.70
          </div>
          <div class="tplus-exp-warning">
            ⚠️ Hold T+3 → T+5 (target +3%, SL close -8%). Size <b>15% NAV/lệnh</b>. Max <b>2-3 lệnh</b> đồng thời.
          </div>
        </div>
      ` : `
        <div class="tplus-stats">
          <span class="tplus-stats-line">
            💎 <b>${countPremium}</b> Premium · 🔻 <b>${countA}</b> Tier A · <b>${countB}</b> Tier B — tổng <b>${totalCount}</b> mã
          </span>
        </div>
        <div class="tplus-expectation-banner">
          <div class="tplus-exp-title">🔻 Bắt đáy T+ · 3-tier system</div>
          <div class="tplus-exp-body">
            💎 <b>Premium</b>: Climax + NN net mua 5d > 0 → Win <b>61%</b>, Sharpe <b>1.90</b> (best edge)<br>
            🔻 <b>Tier A</b>: drop >7% + vol >2× + RSI <35 → Win 56%, Sharpe 0.67<br>
            🔵 <b>Tier B</b>: drop >5% + vol >2× + RSI <50 → Win 56%, Sharpe 0.70
          </div>
          <div class="tplus-exp-warning">
            ⚠️ Hold T+3 → T+5 ATC (target +3%, force T+5). Size <b>15-20% NAV/Premium</b>, <b>10-15%</b> Tier A, <b>10%</b> Tier B. Max <b>2-3 lệnh</b>.
          </div>
        </div>
      `;
    }
    if (showMomentum && style === "momentum") {
      statsHtml = `
        <div class="tplus-stats">
          <span class="tplus-stats-line">
            🚀 <b>${momentumCount}</b> Strength Cont · 📈 <b>${trendCount}</b> Trend HH/HL
          </span>
        </div>
        <div class="tplus-expectation-banner">
          <div class="tplus-exp-title">🚀 Đà tăng · 2-algorithm system</div>
          <div class="tplus-exp-body">
            🚀 <b>Strength Continuation</b>: MA stack perfect + consolidation + vol → Win 60%, Sharpe 0.60 (~127/năm)<br>
            📈 <b>Trend HH/HL</b>: 3 higher highs/lows + vol + uptrend → Win 45%, Sharpe 0.75, PF 1.44 (~140/năm)
          </div>
          <div class="tplus-exp-warning">
            ⚠️ Trend: hold T+10 trailing 6% từ peak. Strength: hold T+20 trail 7%. Size <b>10-12% NAV/lệnh</b>. Win &lt;50% nhưng PF cao.
          </div>
        </div>
      `;
    }
    if (showEvent && style === "event") {
      statsHtml = `
        <div class="tplus-stats">
          <span class="tplus-stats-line">
            📰 <b>${eventCount}</b> Event picks
          </span>
        </div>
        <div class="tplus-expectation-banner">
          <div class="tplus-exp-title">📰 Sự kiện / Event tier</div>
          <div class="tplus-exp-body">
            Detect "động tĩnh bất thường" — vol >3× TB20 OR gap >2.5% OR thrust ±4%.
            Có thể là tin tức/sự kiện company.
          </div>
          <div class="tplus-exp-warning">
            ⚠️ <b>Experimental</b> — backtest standalone FAIL (Sharpe âm). Chỉ INFORMATIONAL — cần research news ngoài app trước khi trade.
          </div>
        </div>
      `;
    }

    const drawdownSlot = `<div id="drawdown-banner-slot">${buildDrawdownBanner()}</div>`;

    // Empty state — only show when style-relevant sections all empty
    const hasContent = (
      (showBottom && (totalCount > 0 || watchCount > 0)) ||
      (showMomentum && (momentumCount > 0 || trendCount > 0)) ||
      (showEvent && eventCount > 0)
    );
    if (!hasContent) {
      let emptyMsg = "";
      if (style === "momentum") {
        emptyMsg = `
          <p><b>Không có mã match Đà tăng hôm nay.</b></p>
          <p>Strength Continuation cần uptrend perfect + vol confirm + consolidation. Trend HH/HL cần 3 higher highs/lows + uptrend + vol > 1.2×.</p>
          <p>Trong consolidation/bear market các pattern này hiếm fire — chuyển sang Bắt đáy hoặc đợi.</p>`;
      } else if (style === "event") {
        emptyMsg = `
          <p><b>Không có sự kiện bất thường hôm nay.</b></p>
          <p>Đợi mã có vol > 3× / gap > 2.5% / thrust ±4%.</p>`;
      } else if (style === "bottom") {
        emptyMsg = `
          <p><b>Không có mã match Bắt đáy T+ hôm nay (Premium/Tier A/B + Watch).</b></p>
          <p>Pattern Climax hiếm trong bull market. Chuyển sang Đà tăng hoặc đợi correction.</p>`;
      } else {
        emptyMsg = `
          <p><b>Không có mã match bất kỳ pattern nào hôm nay.</b></p>
          <p>Pattern hiếm — nhiều ngày sẽ empty. App vẫn auto check 14:50 EOD.</p>`;
      }
      content.innerHTML = drawdownSlot + regimeBanner + statsHtml + `
        <div class="empty-state ranking-intro">
          <div class="empty-icon">💤</div>
          ${emptyMsg}
          <p><small>App vẫn auto check lại mỗi 14:50 EOD và gửi Telegram khi có pattern fire.</small></p>
        </div>
      `;
      return;
    }

    let html = drawdownSlot + regimeBanner + statsHtml;

    // Bắt đáy tiers (Premium/Elite/A/B)
    if (showBottom) {
      if (countPremium > 0) {
        html += renderClimaxBounceSection(premium, countPremium, { tier: "Premium" });
      }
      if (isEliteRegime && countElite > 0) {
        html += renderClimaxBounceSection(elite, countElite, { tier: "Elite" });
      } else {
        if (countA > 0) html += renderClimaxBounceSection(tierA, countA, { tier: "A" });
        if (countB > 0) html += renderClimaxBounceSection(tierB, countB, { tier: "B" });
      }
    }

    // Tier Momentum Swing — chỉ render khi bull/neutral regime
    if (showMomentum) {
      const momentumPicks = s.lastResult?.momentumPicks || [];
      if (s.lastResult?.isMomentumRegime && momentumCount > 0) {
        html += renderMomentumSwingSection(momentumPicks, momentumCount);
      }
      // Trend tier: HH/HL continuation, trailing stop exit
      const trendPicks = s.lastResult?.trendTier || [];
      if (trendPicks.length > 0) {
        html += renderTrendTierSection(trendPicks);
      }
    }

    // Event tier — vol anomaly / gap / thrust (informational)
    if (showEvent) {
      const eventPicks = s.lastResult?.eventTier || [];
      if (eventPicks.length > 0) {
        html += renderEventTierSection(eventPicks);
      }
    }

    // Watch tier — mã near signal (monitor only, NOT buy signal)
    if (showWatch) {
      const watchTier = s.lastResult?.watchTier || [];
      if (watchTier.length > 0) {
        html += renderWatchTierSection(watchTier);
      }
    }

    content.innerHTML = html;

    // Watch tier cards — click to open analyze
    content.querySelectorAll(".watch-tier-card").forEach((card) => {
      card.addEventListener("click", () => {
        const sym = card.dataset.symbol;
        if (!sym) return;
        analyzeContext = null;
        analyzeContextPick = null;
        analyzeContextRank = null;
        switchTab("analyze");
        const input = document.getElementById("symbol-input");
        if (input) input.value = sym;
        analyzeSymbol(sym);
      });
    });

    // Climax card V2 — click header to open analyze
    content.querySelectorAll(".climax-card-v2 .climax-card-title").forEach((header) => {
      header.addEventListener("click", (e) => {
        if (e.target.closest(".pick-watchlist")) return;
        const card = header.closest(".climax-card-v2");
        const sym = card?.dataset.symbol;
        if (!sym) return;
        analyzeContext = null;
        analyzeContextPick = null;
        analyzeContextRank = null;
        switchTab("analyze");
        const input = document.getElementById("symbol-input");
        if (input) input.value = sym;
        analyzeSymbol(sym);
      });
    });

    // SSI term chip click → open glossary + scroll to term definition
    content.querySelectorAll(".ssi-term").forEach((chip) => {
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        const term = chip.dataset.term;
        if (!term) return;
        const card = chip.closest(".climax-card-v2");
        if (!card) return;
        const glossary = card.querySelector("details.ssi-glossary");
        const ordersDetails = card.querySelector("details.climax-orders");
        if (ordersDetails) ordersDetails.open = true;
        if (glossary) glossary.open = true;
        const target = card.querySelector(`#g-${CSS.escape(term)}`);
        if (target) {
          target.scrollIntoView({ behavior: "smooth", block: "center" });
          target.classList.add("glossary-highlight");
          setTimeout(() => target.classList.remove("glossary-highlight"), 2000);
        }
      });
    });

    // Watchlist buttons binding
    content.querySelectorAll(".pick-watchlist").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const sym = btn.dataset.symbol;
        const added = RANKING.toggleWatchlist(sym);
        btn.classList.toggle("active", added);
        btn.textContent = added ? "★" : "☆";
        btn.title = added ? "Bỏ khỏi watchlist" : "Thêm vào watchlist";
      });
    });
  }

  function factorTag(name, z, isStrong) {
    const labels = {
      ma200Quality: "Trên MA200",
      lowDrawdown: "Ít DD",
      momentum6m: "Đà 6t",
      trendConsistency: "Trend đều",
      liquidity: "Thanh khoản",
      foreignFlow60d: "NN gom",
    };
    const cls = isStrong ? "tag-strong" : "tag-weak";
    return `<span class="factor-tag ${cls}">${labels[name] || name}</span>`;
  }

  function sectorLabel(sector) {
    const map = {
      bank: "Ngân hàng", realestate: "BĐS", retail: "Bán lẻ",
      consumer: "Tiêu dùng", industrial: "Công nghiệp", energy: "Năng lượng",
      utility: "Tiện ích", tech: "Công nghệ", broker: "Chứng khoán",
      pharma: "Dược", other: "Khác",
    };
    return map[sector] || sector;
  }

  // Style toggle (Phong cách quét) — filter which tiers to show
  // Persist trong localStorage. Default 'all'.
  const STYLE_KEY = "tplus_style_v1";
  function loadStyle() {
    return localStorage.getItem(STYLE_KEY) || "all";
  }
  function saveStyle(style) {
    localStorage.setItem(STYLE_KEY, style);
  }
  // Phase 4: style toggle removed (chỉ Base Breakout pattern). Init intro:
  setTimeout(() => showRankingIntro(), 0);

  // Refresh button: trigger FULL 1411 mã chunked scan + progress bar UI + reload
  let lastScanSummary = null;
  $("ranking-refresh").addEventListener("click", async () => {
    const btn = $("ranking-refresh");
    btn.disabled = true;
    btn.classList.add("spinning");
    const content = $("ranking-content");
    const startTime = Date.now();
    content.innerHTML = `
      <div class="ranking-loading">
        <div class="spinner"></div>
        <div id="full-scan-progress">Khởi tạo scan full 1411 mã...</div>
        <div class="full-scan-progress-bar"><div class="full-scan-progress-fill" id="full-scan-fill" style="width:0%"></div></div>
        <div id="full-scan-stats" style="color:#888;margin-top:4px;font-size:12px">Climax: 0 · Momentum: 0 · Base Breakout: 0</div>
        <small style="color:#888;margin-top:4px">Estimated ~3-5 phút. Đừng đóng tab.</small>
      </div>`;
    try {
      const finalState = await triggerFullScan((state) => {
        const offset = state.current_offset || 0;
        const total = state.total_universe || 1411;
        const pct = total > 0 ? Math.min(100, (offset / total) * 100) : 0;
        const progressEl = document.getElementById("full-scan-progress");
        const fillEl = document.getElementById("full-scan-fill");
        const statsEl = document.getElementById("full-scan-stats");
        if (progressEl) progressEl.textContent = state.completed
          ? `✅ Scan xong! ${offset}/${total} mã.`
          : `Đang quét... ${offset}/${total} mã (${pct.toFixed(0)}%)`;
        if (fillEl) fillEl.style.width = pct + "%";
        if (statsEl) statsEl.innerHTML =
          `Climax: <b>${state.climax_count || 0}</b> · ` +
          `Momentum: <b>${state.momentum_count || 0}</b> · ` +
          `Base Breakout: <b style="color:#FFC107">${state.base_breakout_count || 0}</b>`;
      });
      lastScanSummary = finalState;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`[full-scan] done in ${elapsed}s: climax=${finalState.climax_count}, momentum=${finalState.momentum_count}, base_breakout=${finalState.base_breakout_count}, fbo=${finalState.fbo_count}`);
      await loadRanking(true);
      const bb = finalState.base_breakout_count || 0;
      const fbo = finalState.fbo_count || 0;
      const cl = finalState.climax_count || 0;
      const mo = finalState.momentum_count || 0;
      const total = bb + fbo + cl + mo;
      const banner = document.createElement("div");
      banner.className = "scan-summary-banner";
      banner.innerHTML = `
        ✅ <b>Scan full 1411 mã xong</b> (${elapsed}s) →
        <b style="color:#FFC107">${total} match</b> tổng
        · 🔍 Base Breakout: <b>${bb}</b>
        · 🌊 FBO: <b>${fbo}</b>
        · 🔻 Climax: <b>${cl}</b>
        · 🚀 Momentum: <b>${mo}</b>
        · ⏱️ ${new Date().toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}`;
      content.insertBefore(banner, content.firstChild);
    } catch (e) {
      content.innerHTML = `<div class="error"><h3>Lỗi scan</h3><p>${e.message}</p><button class="btn-primary" id="ranking-load-btn">Thử lại</button></div>`;
    } finally {
      btn.disabled = false;
      btn.classList.remove("spinning");
    }
  });

  // "Tải lại" button (in empty state or anywhere) — same action as refresh:
  // trigger server quick-scan + reload picks.
  document.addEventListener("click", (e) => {
    if (e.target && e.target.id === "ranking-load-btn") {
      $("ranking-refresh").click();  // delegate to refresh handler
    }
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

  // Cache để render không tính lại mỗi card
  let sectorExposureCache = null;
  function getSectorExposureForPick(sector, picksSizePct) {
    if (!sectorExposureCache) sectorExposureCache = computeSectorExposure();
    const curPct = sectorExposureCache.exposurePct[sector] || 0;
    const afterPick = curPct + picksSizePct * 100;
    return {
      current: curPct,
      afterPick,
      warn: afterPick > 50,
      critical: afterPick > 70,
    };
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

  function fmtMoney(vnd) {
    if (vnd === null || vnd === undefined || isNaN(vnd)) return "0đ";
    const sign = vnd < 0 ? "-" : "";
    const abs = Math.abs(vnd);
    // Treat near-whole VND as whole (avoid float artifacts like 484000.0000001)
    const rounded = Math.round(abs);
    const isEffectivelyWhole = Math.abs(abs - rounded) < 0.001;
    const display = isEffectivelyWhole ? rounded : abs;
    return sign + display.toLocaleString("vi-VN", {
      minimumFractionDigits: 0,
      maximumFractionDigits: isEffectivelyWhole ? 0 : 3,
    }) + "đ";
  }

  function fmtPriceK(price) {
    // Price in k-VND (display) — full precision, trim trailing zeros
    if (!price || isNaN(price)) return "--";
    return price.toLocaleString("vi-VN", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 4,
    });
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

    hdChartInstance = window.LightweightCharts.createChart(cur, {
      width: cur.clientWidth,
      height: 220,
      layout: {
        background: { color: "#0f0f1e" },
        textColor: "#a0a0b0",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: "#1f1f2e" },
        horzLines: { color: "#1f1f2e" },
      },
      rightPriceScale: { borderColor: "#2a2a3e" },
      timeScale: { borderColor: "#2a2a3e", timeVisible: false, secondsVisible: false },
      crosshair: { mode: 1 },
    });

    const candleSeries = hdChartInstance.addCandlestickSeries({
      upColor: "#4CAF50", downColor: "#ff4444",
      borderUpColor: "#4CAF50", borderDownColor: "#ff4444",
      wickUpColor: "#4CAF50", wickDownColor: "#ff4444",
    });
    candleSeries.setData(candles);

    // MA20 overlay
    const ma20Pts = computeSMASeries(data.closes, data.times, 20).filter((p) => p.value !== null);
    if (ma20Pts.length) {
      const ma20Line = hdChartInstance.addLineSeries({
        color: "#888", lineWidth: 1, title: "MA20",
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

    // Fetch parallel: trade log + Climax + Mid-term active picks (verdict full picture)
    const [trades, midTermPicks] = await Promise.all([
      fetchTradeLog(true),
      fetchMidTermPicks(true).catch(() => []),
      fetchActiveClimaxPicks(true).catch(() => {}),
    ]);
    const climaxCount = activeClimaxPicks?.size || 0;
    const midTermCount = Array.isArray(midTermPicks) ? midTermPicks.length : 0;
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
