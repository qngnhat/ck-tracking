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
      const [data, fundamentals, foreignFlow] = await Promise.all([
        ANALYSIS.fetchHistory(symbol, "D", 250),
        ANALYSIS.fetchFundamentals(symbol).catch(() => null),
        ANALYSIS.fetchForeignFlow(symbol).catch(() => null),
      ]);
      currentData = data;
      chartData = data; // daily = same as analysis by default
      currentSymbol = symbol;
      const r = ANALYSIS.analyze(symbol, data, { fundamentals, foreignFlow });
      renderAnalysis(r);
      renderChart();
      updateStatus();
      saveHistory(symbol);
      window.scrollTo({ top: 0, behavior: "smooth" });
      startAutoRefresh();
    } catch (err) {
      showError(`Lỗi tải dữ liệu: ${err.message}`);
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
    if (container) container.innerHTML = `<div class="chart-loading">Đang tải ${RESOLUTIONS[resolution].label}...</div>`;

    try {
      chartData = await ANALYSIS.fetchHistory(currentSymbol, resolution, RESOLUTIONS[resolution].days);
      renderChart();
      lastUpdated = new Date();
      updateStatus();
    } catch (e) {
      if (container) container.innerHTML = `<div class="chart-loading">Lỗi: ${e.message}</div>`;
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

    chartInstance = window.LightweightCharts.createChart(container, {
      width: container.clientWidth,
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

  function showError(msg) {
    $("analysis-root").innerHTML = `
      <div class="error">
        <h3>⚠️ ${msg}</h3>
        <p>Kiểm tra lại mã cổ phiếu hoặc kết nối mạng.</p>
        <button class="btn-primary" onclick="document.getElementById('symbol-input').focus()">Thử lại</button>
      </div>
    `;
  }

  // ── Render analysis ──
  function renderAnalysis(r) {
    const root = $("analysis-root");
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

    // Context card (DCA/T+ pick explanation)
    let contextHtml = "";
    if (analyzeContext === "dca" && analyzeContextPick) {
      contextHtml = renderDcaContextCard(analyzeContextPick, analyzeContextRank, r);
    } else if (analyzeContext === "tplus" && analyzeContextPick) {
      contextHtml = renderTplusContextCard(analyzeContextPick, analyzeContextRank, r);
    }

    const inWatchlist = RANKING.isInWatchlist(r.symbol);
    const meta = getStockMeta(r.symbol) || { name: "", floor: "", sector: null };
    const companyParts = [];
    if (meta.name) companyParts.push(escapeHtml(meta.name));
    if (meta.sector) companyParts.push(sectorLabel(meta.sector));
    if (meta.floor) companyParts.push(meta.floor);
    const companyLine = companyParts.length
      ? `<div class="an-company-line">${companyParts.join(" · ")}</div>`
      : "";
    root.innerHTML = contextHtml + `
      <!-- Header card -->
      <div class="an-card full-width">
        <button class="watchlist-toggle ${inWatchlist ? 'active' : ''}" id="watchlist-toggle" data-symbol="${r.symbol}" title="${inWatchlist ? 'Bỏ khỏi watchlist' : 'Thêm vào watchlist'}">
          ${inWatchlist ? '★' : '☆'}
        </button>
        <div class="an-head">
          <div class="an-symbol">${r.symbol}</div>
          ${companyLine}
          <div class="an-price-row">
            <span class="an-price">${fp(r.current)}</span>
            <span class="pct ${changeClass}">${changeSign}${r.dayChange.toFixed(2)}%</span>
          </div>
        </div>
        <div class="an-recommend-big" style="color:${r.recColor}">${r.recommendation}</div>
        ${analyzeContext === "tplus" ? "" : renderVerdictBadge(r.score, r.flags)}
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
        ⚠️ "Setup tốt/khá/yếu" là <b>chỉ báo chất lượng kỹ thuật</b>, KHÔNG phải tín hiệu mua/bán. Backtest 8 năm cho thấy hệ scoring tổng hợp này chỉ tốt để đánh giá rủi ro (drawdown thấp), không sinh alpha so với buy-and-hold cả universe. Để chọn mã đầu tư, dùng tab <b>Top picks → DCA</b> (đã validate beat baseline). Quyết định cuối cùng là của bạn.
      </div>
    `;

    // Bind tooltip taps
    root.querySelectorAll(".label.has-tip").forEach((el) => {
      el.addEventListener("click", () => {
        showTooltip(el.dataset.tipTitle, el.dataset.tipBody);
      });
    });

    // Bind chart resolution buttons
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
  }

  function clearAnalyzeContext() {
    analyzeContext = null;
    analyzeContextPick = null;
    analyzeContextRank = null;
  }

  // ── Context cards (when navigating from DCA/T+ ranking) ──
  function renderDcaContextCard(pick, rank, r) {
    const f = pick.factors || {};
    const bullets = [];

    if (f.ma200Quality != null) {
      const pct = (f.ma200Quality * 100).toFixed(0);
      const quality = f.ma200Quality >= 0.8 ? "rất ổn định" : f.ma200Quality >= 0.5 ? "ổn định" : "đang yếu";
      bullets.push(`Trên MA200 <b>${pct}%</b> thời gian (252 phiên) — trend dài hạn ${quality}`);
    }
    if (f.lowDrawdown != null) {
      const dd = (f.lowDrawdown * 100).toFixed(1);
      const safety = Math.abs(f.lowDrawdown) < 0.2 ? "rất an toàn" : Math.abs(f.lowDrawdown) < 0.35 ? "vừa phải" : "có biến động";
      bullets.push(`Max drawdown 252 ngày: <b>${dd}%</b> — ${safety}`);
    }
    if (f.momentum6m != null) {
      const m = (f.momentum6m * 100).toFixed(1);
      const sign = f.momentum6m >= 0 ? "+" : "";
      const desc = f.momentum6m > 0.2 ? "đà tăng tốt" : f.momentum6m > 0 ? "đà tăng nhẹ" : "đi ngang/giảm";
      bullets.push(`Hiệu suất 6 tháng: <b>${sign}${m}%</b> — ${desc}`);
    }
    if (f.trendConsistency != null) {
      bullets.push(`Trend Sharpe (252d): <b>${f.trendConsistency.toFixed(3)}</b> — đo độ đều đặn của xu hướng`);
    }
    if (f.avgTurnover != null) {
      const billions = (f.avgTurnover / 1e9).toFixed(1);
      bullets.push(`Thanh khoản TB 20 phiên: <b>${billions} tỷ/ngày</b>`);
    }
    if (f.foreignFlow60d != null && Math.abs(f.foreignFlow60d) > 0.1) {
      const positive = f.foreignFlow60d > 0;
      bullets.push(
        positive
          ? `Khối ngoại đang <span style="color:#4CAF50"><b>gom ròng</b></span> trong 60 phiên — smart money tích lũy`
          : `Khối ngoại đang <span style="color:#ff4444"><b>xả ròng</b></span> trong 60 phiên — cảnh báo`
      );
    }

    const rankTxt = rank ? `Pick #${rank}` : "";

    return `
      <div class="an-card context-card context-dca">
        <div class="context-header">
          <span class="context-icon">📈</span>
          <div>
            <div class="context-title">DCA ${rankTxt} · Score ${pick.score >= 0 ? "+" : ""}${pick.score.toFixed(2)}</div>
            <div class="context-subtitle">Khuyến nghị tích lũy dài hạn</div>
          </div>
        </div>
        <div class="context-section">
          <div class="context-section-title">Tại sao mã này hợp DCA</div>
          <ul class="context-bullets">${bullets.map((b) => `<li>${b}</li>`).join("")}</ul>
        </div>
        <div class="context-section">
          <div class="context-section-title">Đề xuất hành động</div>
          <ul class="context-bullets">
            <li>Mua đều với các mã top khác — không tập trung 1 mã</li>
            <li>Rebalance đầu tháng: bán nếu rớt khỏi top, mua mã mới vào</li>
            <li>Sector cap đã áp dụng (max 2 mã/ngành) → đã diversify</li>
            <li>Không cần stop loss chặt — DCA giữ lâu, chấp nhận drawdown ngắn hạn</li>
          </ul>
        </div>
        <div class="context-disclaimer">
          📊 Backtest 8 năm: chiến lược DCA Top 15 đạt CAGR <b>17.8%</b> (vs Equal-Weight 55: 16.4%, VN-Index: 7.9%).
        </div>
      </div>
    `;
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

  // ── Verdict + Risk chips (decision layer) ──
  // Verdict: 3 loại Spec Buy / Watchlist / Avoid dựa thuần trên score
  // Risk chips: dựa trên flags object (bearTrap/lowVol/deepDowntrend) — render
  // riêng để user biết WHY cần chú ý dù verdict nói "Buy".
  function getVerdict(score) {
    if (score === null || score === undefined || isNaN(score)) return null;
    if (score < 2) return { tag: "Avoid", color: "#ff4444", icon: "🔴",
      desc: "Tránh — chờ tín hiệu đảo chiều rõ" };
    if (score >= 4) return { tag: "Spec Buy", color: "#4CAF50", icon: "🟢",
      desc: "Có thể vào (spec nhỏ). Thận trọng: ưu tiên chờ xác nhận." };
    return { tag: "Watchlist", color: "#FF9800", icon: "🟡",
      desc: "Chờ confluence rõ hơn HOẶC trigger đảo chiều" };
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
    if (flags.bearTrap) chips.push({ label: "⚠️ Bắt dao rơi", color: "#ff5722" });
    if (flags.lowVol) chips.push({ label: "Vol thấp", color: "#ff9800" });
    if (flags.deepDowntrend) chips.push({ label: "Downtrend mạnh", color: "#ff9800" });
    if (chips.length === 0) return "";
    return `<div class="risk-chips">${chips.map((c) =>
      `<span class="risk-chip" style="border-color:${c.color}55;color:${c.color}">${c.label}</span>`
    ).join("")}</div>`;
  }

  function renderVerdictBadge(score, flags) {
    const v = getVerdict(score);
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

  function renderTplusContextCard(pick, rank, r) {
    const reasons = pick.reasons || [];
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
    const tp1Note = tp1UseMa ? "hồi về MA20" : "Mục tiêu gần (~10%)";
    const tp2Note = tp2UseRes ? "kháng cự gần" : "Mục tiêu tối đa (~18%)";
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

    // Verdict + risk chips (dùng pick.flags từ ranking, fallback r.flags từ analyze)
    const flags = pick.flags || r.flags || {};
    const verdictHtml = renderVerdictBadge(pick.score ?? r.score, flags);

    const rankTxt = rank ? `Pick #${rank}` : "";

    return `
      <div class="an-card context-card context-tplus">
        ${verdictHtml}
        <div class="context-header">
          <span class="context-icon">⚡</span>
          <div>
            <div class="context-title">T+ ${rankTxt} · Score ${pick.score >= 0 ? "+" : ""}${pick.score.toFixed(2)}${volHtml}</div>
            <div class="context-subtitle">${subtitle}</div>
          </div>
        </div>
        <div class="context-section">
          <div class="context-section-title">Tín hiệu đang fire</div>
          <ul class="context-bullets">${reasons.map((rr) => `<li><b>${rr}</b></li>`).join("")}</ul>
        </div>
        <div class="context-section">
          <div class="context-section-title">Plan giao dịch</div>
          <ul class="context-bullets">
            <li><b>Aggressive entry</b>: vào vùng <b>${fp(aggLow)} – ${fp(aggHigh)}</b> (current ±2%) — <i>scale-in từng phần, không all-in</i></li>
            <li><b>Confirmed entry</b>: chờ <b>nến rút chân</b> HOẶC <b>volume ≥ 1.5× avg</b> — giá vào cao hơn 2-5% nhưng giảm false signal</li>
            <li>Stop loss: <b>${fp(slFinal)}</b> (${slPct.toFixed(1)}%) — max của -8% và 2×ATR</li>
            ${targets.map((t) => `<li>${t}</li>`).join("")}
            <li>Hold: <b>15-30 phiên</b></li>
            <li>Exit khi: RSI hồi &gt;50 HOẶC đạt mục tiêu HOẶC dính SL</li>
          </ul>
        </div>
        <div class="context-disclaimer">
          ⚠️ Mean-reversion có thể fail nếu thị trường tiếp tục giảm. Backtest 2023-2026: score≥4 win rate <b>61%</b>, avg <b>+3.3%/lệnh</b> — 4/10 lệnh thua, tuân thủ SL.
        </div>
      </div>
    `;
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
      warning = "ĐỪNG bỏ DCA định kỳ vì 1 setup. Edge ~3-5%/cơ hội — không chắc thắng.";
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
  let currentTab = "home";

  function switchTab(tab) {
    if (tab === currentTab) return;
    currentTab = tab;
    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
    document.querySelectorAll(".tab-content").forEach((el) => {
      el.classList.toggle("active", el.classList.contains("tab-" + tab));
    });
  }

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

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
  function isMarketOpenNow() {
    const vn = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
    const day = vn.getDay();
    if (day === 0 || day === 6) return false;
    const min = vn.getHours() * 60 + vn.getMinutes();
    if (min >= 540 && min <= 690) return true;
    if (min >= 780 && min <= 885) return true;
    return false;
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

  function buildTodayActions(regime, dcaCount, tplusCount, lastDcaSnap) {
    const now = new Date();
    const dom = now.getDate();
    const dow = now.getDay();
    const isWeekend = dow === 0 || dow === 6;
    const open = isMarketOpenNow();
    const actions = [];

    // Trading state
    if (isWeekend) {
      actions.push({ icon: "🌴", text: "Cuối tuần — TTCK đóng cửa. Có thể review tracker hoặc plan tuần sau." });
    } else if (open) {
      if (tplusCount > 0) {
        actions.push({ icon: "⚡", text: `Đang trong giờ giao dịch — có <b>${tplusCount} setup T+</b> chất lượng. Check Top picks → T+.` });
      } else {
        actions.push({ icon: "💤", text: "Trong giờ giao dịch nhưng không có setup T+ chất lượng. Đợi cơ hội rõ hơn." });
      }
    } else {
      actions.push({ icon: "💤", text: "Ngoài giờ giao dịch hôm nay. Plan cho phiên kế nếu cần." });
    }

    // DCA timing
    if (!isWeekend && dom <= 5) {
      const lastSnapDate = lastDcaSnap ? new Date(lastDcaSnap.date) : null;
      const sameMonth = lastSnapDate &&
        lastSnapDate.getMonth() === now.getMonth() &&
        lastSnapDate.getFullYear() === now.getFullYear();
      if (!sameMonth) {
        actions.push({ icon: "🔄", text: "<b>Đầu tháng</b> — đến lúc rebalance DCA. Mở Top picks → DCA, so list mới với portfolio hiện tại." });
      } else {
        actions.push({ icon: "✅", text: "Đã có DCA snapshot tháng này — tốt." });
      }
    } else if (dom >= 28) {
      actions.push({ icon: "📅", text: "Cuối tháng — chuẩn bị cho rebalance DCA tuần tới." });
    }

    // Regime advisory
    if (regime) {
      if (regime.regime === "BEAR" || regime.regime === "BEAR_WEAK") {
        actions.push({ icon: "⚠️", text: `Thị trường <b>${regime.label}</b> — T+ rủi ro cao, threshold đã auto bump lên ≥5.0. Tập trung DCA quality.` });
      } else if (regime.regime === "BULL") {
        actions.push({ icon: "🚀", text: `Thị trường <b>${regime.label}</b> — uptrend rõ, các setup mean-reversion có thể là nhịp pull back ngắn.` });
      }
    }

    return actions;
  }

  async function renderHome() {
    const container = $("home-container");
    if (!container) return;

    // 1. Greeting card (immediate)
    const greeting = getGreeting();
    const dateStr = fmtFullDate();

    // Get cached data (no fresh fetch on home)
    let regime = null;
    try {
      const cached = JSON.parse(localStorage.getItem("vnindex_regime_v1") || "null");
      regime = cached?.data || null;
    } catch {}

    let dcaCached = null, tplusCached = null;
    try {
      dcaCached = JSON.parse(localStorage.getItem("dca_top_picks_v1") || "null")?.data;
      tplusCached = JSON.parse(localStorage.getItem("tplus_top_picks_v1") || "null")?.data;
    } catch {}

    const tracker = RANKING.loadTracker();
    const lastDcaSnap = tracker.dca?.[tracker.dca.length - 1] || null;
    const lastTplusSnap = tracker.tplus?.[tracker.tplus.length - 1] || null;

    const actions = buildTodayActions(
      regime,
      dcaCached?.eligibleCount || 0,
      tplusCached?.eligibleCount || 0,
      lastDcaSnap
    );

    const watchlist = RANKING.loadWatchlist();
    const watchlistCount = watchlist.length;

    let html = `
      <div class="home-greeting">
        <div class="home-greeting-text">${greeting}</div>
        <div class="home-date">${dateStr}</div>
      </div>

      <!-- Hôm nay nên làm -->
      <div class="home-card">
        <div class="home-card-title">📋 Hôm nay nên làm</div>
        <ul class="home-actions">
          ${actions.map((a) => `<li><span class="home-action-icon">${a.icon}</span><span>${a.text}</span></li>`).join("")}
        </ul>
      </div>
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

    // 3. DCA top picks preview
    if (dcaCached && dcaCached.picks && dcaCached.picks.length > 0) {
      const top5 = dcaCached.picks.slice(0, 5);
      html += `
        <div class="home-card home-card-clickable" data-target-tab="ranking" data-target-mode="dca">
          <div class="home-card-title">📈 Top 5 mã DCA</div>
          ${top5.map((p, i) => `
            <div class="home-pick-row">
              <span class="home-pick-rank">#${i + 1}</span>
              <span class="home-pick-symbol">${p.symbol}</span>
              <span class="home-pick-sector">${sectorLabel(p.sector)}</span>
              <span class="home-pick-score">+${p.score.toFixed(2)}</span>
            </div>
          `).join("")}
          <div class="home-card-cta">Xem đầy đủ →</div>
        </div>
      `;
    } else {
      html += `
        <div class="home-card home-card-clickable" data-target-tab="ranking" data-target-mode="dca">
          <div class="home-card-title">📈 Top picks DCA</div>
          <div class="home-card-empty">Chưa load. Tap để xem ranking đầy đủ.</div>
        </div>
      `;
    }

    // 4. Tracker summary
    const dcaSnaps = tracker.dca?.length || 0;
    const tplusSnaps = tracker.tplus?.length || 0;
    if (dcaSnaps + tplusSnaps > 0) {
      html += `
        <div class="home-card home-card-clickable" data-target-tab="ranking" data-target-tracker="1">
          <div class="home-card-title">📊 Tracker performance</div>
          <div class="home-tracker-row">
            <div class="home-tracker-item">
              <div class="home-tracker-num">${dcaSnaps}</div>
              <div class="home-tracker-label">DCA snapshots</div>
            </div>
            <div class="home-tracker-item">
              <div class="home-tracker-num">${tplusSnaps}</div>
              <div class="home-tracker-label">T+ snapshots</div>
            </div>
          </div>
          <div class="home-card-cta">Xem performance →</div>
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

    // Bind clickable cards
    container.querySelectorAll(".home-card-clickable").forEach((card) => {
      card.addEventListener("click", () => {
        const targetTab = card.dataset.targetTab;
        if (targetTab) switchTab(targetTab);
        if (card.dataset.targetMode) {
          // Switch ranking mode after tab switch
          setTimeout(() => switchRankingMode(card.dataset.targetMode), 50);
        }
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

    // Watchlist refresh button + auto load if cache fresh
    const wlRefresh = document.getElementById("watchlist-refresh-home");
    if (wlRefresh) {
      wlRefresh.addEventListener("click", (e) => {
        e.stopPropagation();
        loadWatchlistInHome(true);
      });
      // Auto load if cache exists
      try {
        const cached = JSON.parse(localStorage.getItem("watchlist_data_v1") || "null");
        if (cached && Date.now() - cached.timestamp < 30 * 60 * 1000) {
          renderWatchlistInHome(cached.data);
        }
      } catch {}
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
    } catch (e) {
      wrap.innerHTML = `<div class="home-card-empty">Lỗi: ${e.message}</div>`;
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
  const originalSwitchTab = switchTab;
  // Re-render home on returning to it (data may be cached now)
  document.addEventListener("click", (e) => {
    if (e.target.matches?.('.tab-btn[data-tab="home"]')) {
      setTimeout(renderHome, 50);
    }
  });

  // ════════════════════════════════════════════════════
  // ── RANKING TAB ──
  // ════════════════════════════════════════════════════
  let rankingState = {
    mode: "dca",  // "dca" | "tplus"
    dca: { picks: [], topN: 10, loaded: false },
    tplus: { picks: [], topN: 10, loaded: false },
    loading: false,
  };

  function curState() {
    return rankingState[rankingState.mode];
  }

  // ── Holiday banner: cảnh báo nghỉ lễ VN cho T+ ──
  // Format YYYY-MM-DD, ngày đầu của cluster nghỉ
  const VN_HOLIDAYS = [
    "2026-04-30", // 30/4
    "2026-05-01", // 1/5 (cluster 30/4-1/5, có thể kéo dài qua weekend)
    "2026-09-02", // Quốc khánh
    "2027-01-01", // Tết DL
    "2027-02-15", // Tết ÂL (mùng 1, dự kiến)
  ];

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

  function renderHolidayBanner(mode) {
    const banner = $("holiday-banner");
    if (!banner) return;
    if (mode !== "tplus") {
      banner.style.display = "none";
      return;
    }
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

  function switchRankingMode(mode) {
    if (mode === rankingState.mode) return;
    rankingState.mode = mode;
    document.querySelectorAll(".mode-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === mode);
    });

    // Update title + disclaimer
    const title = $("ranking-title");
    const disc = $("ranking-disclaimer");
    if (mode === "dca") {
      title.textContent = "Top mã DCA";
      disc.textContent = "⚠️ DCA cập nhật 24h, rebalance đầu tháng. Chỉ là tín hiệu kỹ thuật, không phải lời khuyên đầu tư.";
    } else {
      title.textContent = "Top mã T+";
      disc.textContent = "⚠️ T+ cập nhật mỗi giờ trong giờ giao dịch. Setup hiếm, có thể không có mã nào hôm nay. Hold 15-30 phiên, stop loss -8%.";
    }

    // Update topN button state
    const tn = curState().topN;
    document.querySelectorAll("#seg-topn .seg-btn").forEach((b) => {
      b.classList.toggle("active", parseInt(b.dataset.n, 10) === tn);
    });

    // Holiday warning (T+ only)
    renderHolidayBanner(mode);

    // Render or show intro
    if (curState().loaded) {
      renderRanking();
      // Try to update meta from cache info if available
    } else {
      showRankingIntro();
    }
  }

  function showRankingIntro() {
    const mode = rankingState.mode;
    const content = $("ranking-content");
    if (mode === "dca") {
      content.innerHTML = `
        <div class="empty-state ranking-intro">
          <div class="empty-icon">📈</div>
          <h2>Khuyến nghị DCA dài hạn</h2>
          <p>Bảng xếp hạng top mã đáng tích lũy hàng tháng, dựa trên 6 yếu tố kỹ thuật + dòng tiền khối ngoại. Backtest 8 năm cho thấy chiến lược này vượt buy-and-hold cả universe.</p>
          <button class="btn-primary" id="ranking-load-btn">Tải bảng xếp hạng</button>
        </div>
      `;
    } else {
      content.innerHTML = `
        <div class="empty-state ranking-intro">
          <div class="empty-icon">⚡</div>
          <h2>Cơ hội T+ (lướt sóng ngắn hạn)</h2>
          <p>Quét universe tìm setup confluence: RSI&lt;25 + BB lower + MFI&lt;20 + volume catalyst đồng thời. Hold 15-30 phiên.</p>
          <p style="color:#4CAF50;margin-top:8px;font-size:11px"><b>Backtest validated:</b> setup chất lượng (score≥4) có win rate 61%, avg +3.3%/lệnh trên test set 2023-2026.</p>
          <p style="color:#FF9800;margin-top:8px"><b>Lưu ý:</b> setup T+ chất lượng rất hiếm — có thể 0 mã nhiều ngày liên tiếp. Đó là tính năng, không phải bug — kỷ luật không trade khi không có cơ hội rõ.</p>
          <button class="btn-primary" id="ranking-load-btn">Quét cơ hội T+</button>
        </div>
      `;
    }
    document.getElementById("ranking-load-btn").addEventListener("click", () => {
      RANKING.clearCache();
      loadRanking(true);
    });
  }

  async function loadRanking(forceFresh = false) {
    if (rankingState.loading) return;
    rankingState.loading = true;

    const mode = rankingState.mode;
    const content = $("ranking-content");
    content.innerHTML = `
      <div class="ranking-loading">
        <div class="spinner"></div>
        <div id="ranking-progress">Đang tải dữ liệu 0/55...</div>
      </div>
    `;

    try {
      const loader = mode === "dca" ? RANKING.loadTopPicks : RANKING.loadTopPicksTPlus;
      const result = await loader({
        topN: 15,
        sectorCap: 2,
        useCache: !forceFresh,
        onProgress: (done, total) => {
          const el = document.getElementById("ranking-progress");
          if (el) el.textContent = `Đang tải ${done}/${total} mã...`;
        },
      });

      const s = curState();
      s.picks = result.picks;
      s.loaded = true;
      s.lastResult = result;
      renderRanking();
      updateRankingMeta(result);

      // Auto-snapshot for paper tracker
      if (result.picks.length > 0 && !result.fromCache) {
        const tracker = RANKING.loadTracker();
        if (RANKING.shouldSnapshot(mode, tracker)) {
          RANKING.takeSnapshot(mode, result.picks, result.regime);
        }
      }
      renderTrackerSection();
    } catch (e) {
      content.innerHTML = `<div class="error"><h3>Lỗi tải dữ liệu</h3><p>${e.message}</p><button class="btn-primary" onclick="document.getElementById('ranking-refresh').click()">Thử lại</button></div>`;
    } finally {
      rankingState.loading = false;
    }
  }

  function updateRankingMeta(result) {
    const meta = $("ranking-meta");
    const date = new Date(result.timestamp);
    const time = date.toLocaleString("vi-VN", {
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    const cacheTxt = result.fromCache ? " (từ cache)" : "";
    meta.textContent = `Cập nhật ${time}${cacheTxt} · ${result.eligibleCount}/${result.allCount} mã đủ điều kiện`;
  }

  // ════════════════════════════════════════════════════
  // ── PAPER TRACKER ──
  // ════════════════════════════════════════════════════
  function renderTrackerSection() {
    const section = $("tracker-section");
    if (!section) return;
    const tracker = RANKING.loadTracker();
    const totalSnaps = (tracker.dca?.length || 0) + (tracker.tplus?.length || 0);
    if (totalSnaps === 0) {
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
    content.innerHTML = `<div class="loading"><div class="spinner"></div><div>Fetch giá hiện tại...</div></div>`;

    try {
      const tracker = RANKING.loadTracker();
      const allSyms = new Set();
      for (const m of ["dca", "tplus"]) {
        for (const s of tracker[m] || []) {
          for (const p of s.picks) allSyms.add(p.symbol);
        }
      }
      const prices = await RANKING.fetchCurrentPrices([...allSyms]);
      renderTrackerContent(tracker, prices);
    } catch (e) {
      content.innerHTML = `<div class="error">Lỗi: ${e.message}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = "Cập nhật giá hiện tại";
    }
  }

  function renderTrackerContent(tracker, prices) {
    const content = $("tracker-content");
    let html = "";

    for (const mode of ["dca", "tplus"]) {
      const arr = (tracker[mode] || []).slice().reverse();  // newest first
      if (arr.length === 0) continue;
      const modeLabel = mode === "dca" ? "📈 DCA Snapshots" : "⚡ T+ Snapshots";
      html += `<div class="tracker-mode-block"><div class="tracker-mode-title">${modeLabel} (${arr.length})</div>`;

      for (const snap of arr) {
        const days = daysSince(snap.date);
        // Compute returns
        const rows = snap.picks.map((p) => {
          const cur = prices[p.symbol];
          if (cur == null || !p.entryPrice) {
            return { symbol: p.symbol, ret: null, cur, entry: p.entryPrice };
          }
          const ret = (cur - p.entryPrice) / p.entryPrice;
          return { symbol: p.symbol, ret, cur, entry: p.entryPrice };
        });
        const validRows = rows.filter((r) => r.ret !== null);
        const avgRet = validRows.length
          ? validRows.reduce((a, b) => a + b.ret, 0) / validRows.length
          : null;
        const winCount = validRows.filter((r) => r.ret > 0).length;

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
            <div class="tracker-snap-picks">
              ${rows.map((r) => {
                if (r.ret == null) {
                  return `<span class="tracker-pick"><b>${r.symbol}</b> --</span>`;
                }
                const cls = r.ret >= 0 ? "up" : "down";
                const sign = r.ret >= 0 ? "+" : "";
                return `<span class="tracker-pick"><b>${r.symbol}</b> <span class="pct ${cls}">${sign}${(r.ret * 100).toFixed(1)}%</span></span>`;
              }).join("")}
            </div>
          </div>
        `;
      }
      html += "</div>";
    }

    if (!html) {
      content.innerHTML = `<div class="empty-state ranking-intro"><p>Chưa có snapshot nào.</p></div>`;
    } else {
      content.innerHTML = html;
    }
  }

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

  function renderRanking() {
    const content = $("ranking-content");
    const s = curState();
    const picks = s.picks.slice(0, s.topN);
    const mode = rankingState.mode;

    if (picks.length === 0) {
      const msg = mode === "tplus"
        ? "Không có setup T+ nào đủ chất lượng hôm nay. Đó là chuyện bình thường — đừng ép vào lệnh khi không có cơ hội rõ. Quay lại sau hoặc thử ngày khác."
        : "Không có mã nào đủ điều kiện trong top hiện tại.";
      content.innerHTML = `<div class="empty-state ranking-intro"><div class="empty-icon">${mode === "tplus" ? "💤" : "⚠️"}</div><p>${msg}</p></div>`;
      return;
    }

    let html = '<div class="picks-list">';
    picks.forEach((p, i) => {
      const f = p.factors;
      const dayChangeClass = f.dayChange >= 0 ? "up" : "down";
      const dayChangeSign = f.dayChange >= 0 ? "+" : "";

      let tagsHtml = "";
      if (mode === "dca") {
        // For DCA: top 3 z-scores as strong, bottom 2 as weak
        const factorList = RANKING.FACTOR_NAMES
          .map((fn) => ({ name: fn, z: f[fn + "_z"] }))
          .filter((x) => x.z !== null && !isNaN(x.z))
          .sort((a, b) => b.z - a.z);
        const topFactors = factorList.slice(0, 3).map((x) => factorTag(x.name, x.z, true)).join("");
        const weakFactors = factorList.slice(-2).filter((x) => x.z < 0)
          .map((x) => factorTag(x.name, x.z, false)).join("");
        tagsHtml = topFactors + weakFactors;
      } else {
        // For T+: show reasons from score
        tagsHtml = (p.reasons || []).map((r) =>
          `<span class="factor-tag tag-strong">${r}</span>`
        ).join("");
      }

      const isWatched = RANKING.isInWatchlist(p.symbol);
      html += `
        <div class="pick-card" data-symbol="${p.symbol}" data-rank="${i + 1}">
          <div class="pick-rank">#${i + 1}</div>
          <div class="pick-main">
            <div class="pick-row1">
              <span class="pick-symbol">${p.symbol}</span>
              <span class="pick-sector">${sectorLabel(p.sector)}</span>
              <span class="pick-score">${p.score >= 0 ? "+" : ""}${p.score.toFixed(2)}</span>
            </div>
            <div class="pick-row2">
              <span class="pick-price">${fp(f.currentPrice)}</span>
              <span class="pct ${dayChangeClass}">${dayChangeSign}${(f.dayChange * 100).toFixed(2)}%</span>
            </div>
            <div class="pick-tags">${tagsHtml}</div>
          </div>
          <button class="pick-watchlist ${isWatched ? 'active' : ''}" data-symbol="${p.symbol}" title="${isWatched ? 'Bỏ khỏi watchlist' : 'Thêm vào watchlist'}">
            ${isWatched ? '★' : '☆'}
          </button>
          <div class="pick-cta">›</div>
        </div>
      `;
    });
    html += "</div>";

    // Allocation hint (different for DCA vs T+)
    if (mode === "dca") {
      html += `
        <div class="allocation-hint">
          💡 Mua đều ${s.topN} mã trên, rebalance đầu tháng — bán mã rớt khỏi top, mua mã mới vào. Sector cap 2 mã/ngành để tránh concentrate.
        </div>
      `;
    } else {
      html += `
        <div class="allocation-hint">
          ⚡ Hold ~15-30 phiên. Stop loss <b>-8%</b> hoặc 2× ATR. Exit khi RSI hồi &gt;50 hoặc đạt mục tiêu kháng cự.
        </div>
      `;
    }

    content.innerHTML = html;

    content.querySelectorAll(".pick-card").forEach((card) => {
      card.addEventListener("click", (e) => {
        // Skip if clicked watchlist button (handled separately)
        if (e.target.closest(".pick-watchlist")) return;
        const sym = card.dataset.symbol;
        const rank = parseInt(card.dataset.rank, 10);
        const pick = picks.find((p) => p.symbol === sym);
        analyzeContext = mode;
        analyzeContextPick = pick;
        analyzeContextRank = rank;
        switchTab("analyze");
        const input = document.getElementById("symbol-input");
        if (input) input.value = sym;
        analyzeSymbol(sym);
      });
    });

    // Bind quick-add watchlist buttons
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

  // Top-N selector
  document.querySelectorAll("#seg-topn .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#seg-topn .seg-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      curState().topN = parseInt(btn.dataset.n, 10);
      if (curState().picks.length > 0) renderRanking();
    });
  });

  // Mode toggle (DCA / T+)
  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchRankingMode(btn.dataset.mode));
  });

  $("ranking-refresh").addEventListener("click", () => {
    RANKING.clearCache();
    loadRanking(true);
  });

  // Initial intro load button (delegated since it may be re-rendered)
  document.addEventListener("click", (e) => {
    if (e.target && e.target.id === "ranking-load-btn") {
      RANKING.clearCache();
      loadRanking(true);
    }
  });

  // ════════════════════════════════════════════════════
  // ── PORTFOLIO TAB ──
  // ════════════════════════════════════════════════════
  const PORTFOLIO = window.__SSI_PORTFOLIO__;
  let editingTxId = null;
  // Cache analysis results per symbol khi render holdings
  const portfolioAnalysisCache = {};
  let dcaTopSymbols = new Set();

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
    const side = document.querySelector("#tx-side-toggle .seg-btn.active")?.dataset.side || "buy";
    const gross = qty * price * 1000;
    const summary = $("tx-summary");
    if (!summary) return;
    if (!qty || !price) {
      summary.textContent = "";
      return;
    }
    if (side === "buy") {
      const total = gross + feeVnd;
      const newCash = PORTFOLIO.loadCash() - total;
      summary.innerHTML = `Tổng: <b>${fmtMoney(total)}</b> · Cash sau khi mua: <b>${fmtMoney(newCash)}</b>`;
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
    ["tx-quantity", "tx-price", "tx-fee"].forEach((id) => {
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
  function buildHoldingActionPlan(holding, ana, inDcaTop) {
    const cur = ana.current;
    const avg = holding.avg_cost;
    const qty = holding.qty;
    const pnlPct = avg > 0 ? ((cur - avg) / avg) * 100 : 0;
    const score = ana.score ?? 0;
    const items = [];

    // 1. Cut-loss level: max(2*ATR below current, -8% from avg cost)
    const slFromAtr = ana.atr ? cur - 2 * ana.atr : null;
    const slFromAvg = avg * 0.92; // -8% from cost basis
    const stopCandidates = [slFromAtr, ana.support, slFromAvg].filter((x) => x && x > 0);
    const stopLoss = stopCandidates.length ? Math.max(...stopCandidates.filter((x) => x < cur)) : slFromAvg;
    const stopPct = avg > 0 ? ((stopLoss - avg) / avg) * 100 : 0;

    // 2. Take-profit zones (if profitable)
    if (pnlPct > 0) {
      const tp1 = avg * 1.10; // +10%
      const tp2 = avg * 1.20; // +20%
      const tp3 = ana.resistance && ana.resistance > cur ? ana.resistance : avg * 1.30;
      items.push({
        kind: "tp",
        title: "🎯 Vùng chốt lời",
        rows: [
          [`TP1 (+10%)`, fp(tp1), cur >= tp1 ? "Đã chạm — cân nhắc bán 1/3" : `Còn ${(((tp1 - cur) / cur) * 100).toFixed(1)}%`],
          [`TP2 (+20%)`, fp(tp2), cur >= tp2 ? "Đã chạm — cân nhắc bán 1/3" : `Còn ${(((tp2 - cur) / cur) * 100).toFixed(1)}%`],
          [`TP3 (kháng cự)`, fp(tp3), cur >= tp3 ? "Đã chạm — cân nhắc bán phần còn lại" : `Còn ${(((tp3 - cur) / cur) * 100).toFixed(1)}%`],
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

    // 4. Add zone (only if score good + in DCA top + not too profitable)
    if (score >= 4 && inDcaTop && pnlPct < 15) {
      const buyZoneLow = ana.buyZoneLow ?? cur * 0.97;
      const buyZoneHigh = ana.buyZoneHigh ?? cur * 1.01;
      items.push({
        kind: "add",
        title: "📈 Vùng mua thêm (nếu muốn tăng tỷ trọng)",
        rows: [
          [`Vùng giá`, `${fp(buyZoneLow)} – ${fp(buyZoneHigh)}`, ""],
          [`Lý do`, `Setup score ${score}, còn trong DCA top`, ""],
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

    const inDcaTop = dcaTopSymbols.has(symbol);
    const action = ana && holding ? PORTFOLIO.recommendAction(holding, ana, inDcaTop) : null;
    const plan = ana && holding && qty > 0 ? buildHoldingActionPlan(holding, ana, inDcaTop) : null;

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

  // ── Portfolio render ──
  async function renderPortfolio() {
    const container = $("portfolio-content");
    const empty = $("portfolio-empty");
    if (!container || !empty) return;

    bindTxModal();
    bindCashModal();

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
    `;

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

    // Load DCA top picks (cached) for "in-top" check
    try {
      const cached = JSON.parse(localStorage.getItem("dca_top_picks_v1") || "null");
      if (cached?.data?.picks) {
        dcaTopSymbols = new Set(cached.data.picks.map((p) => p.symbol));
      }
    } catch {}

    // Fetch current price + analysis for each holding (parallel)
    const enriched = await Promise.all(
      holdings.map(async (h) => {
        try {
          // Use cached if available
          if (!portfolioAnalysisCache[h.symbol] ||
              Date.now() - portfolioAnalysisCache[h.symbol]._ts > 30 * 60 * 1000) {
            const data = await ANALYSIS.fetchHistory(h.symbol, "D", 250);
            const r = ANALYSIS.analyze(h.symbol, data, {});
            portfolioAnalysisCache[h.symbol] = { ...r, _ts: Date.now() };
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

        const inDcaTop = dcaTopSymbols.has(h.symbol);
        const action = ana ? PORTFOLIO.recommendAction(h, ana, inDcaTop) : null;
        const setupLabel = ana?.recommendation || "--";
        const setupColor = ana?.recColor || "#888";

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
            <div class="holding-actions-row">
              <button class="link-btn holding-analyze">Phân tích</button>
              <button class="link-btn holding-add-tx">+ Giao dịch</button>
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
        card.querySelector(".holding-add-tx")?.addEventListener("click", () => {
          // Open modal pre-filled with symbol
          openTxModal();
          $("tx-symbol").value = sym;
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

  // ── Init ──
  renderHistory();
  ensureStockList();

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
