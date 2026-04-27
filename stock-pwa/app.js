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
    return n.toLocaleString("vi-VN", { maximumFractionDigits: 2 });
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

    root.innerHTML = contextHtml + `
      <!-- Header card -->
      <div class="an-card full-width">
        <div class="an-head">
          <div class="an-symbol">${r.symbol}</div>
          <div class="an-price-row">
            <span class="an-price">${fp(r.current)}</span>
            <span class="pct ${changeClass}">${changeSign}${r.dayChange.toFixed(2)}%</span>
          </div>
        </div>
        <div class="an-recommend-big" style="color:${r.recColor}">${r.recommendation}</div>
        <div class="an-reasons">${r.reasons.map((x) => `• ${x}`).join("<br>") || "Không có tín hiệu rõ"}</div>
        ${buyZoneHtml}
        ${row("Stop loss", fp(r.stopLoss),
          "Mức giá cắt lỗ đề xuất: dựa trên max(2×ATR, hỗ trợ -3%). Nếu giá phá xuống, khả năng cao xu hướng đã thay đổi, nên thoát vị thế để hạn chế thua lỗ.",
          "color:#ff9800;font-weight:600")}
      </div>

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

  function renderTplusContextCard(pick, rank, r) {
    const reasons = pick.reasons || [];
    const f = pick.factors || {};
    const cur = f.currentPrice || r.current;

    // Stop loss: max(2*ATR below, -8%)
    const slFromAtr = r.atr ? cur - 2 * r.atr : null;
    const slFromPct = cur * 0.92;
    const slFinal = slFromAtr ? Math.max(slFromAtr, slFromPct) : slFromPct;
    const slPct = ((slFinal - cur) / cur) * 100;

    const targets = [];
    if (r.ma20 && r.ma20 > cur) {
      const upPct = ((r.ma20 - cur) / cur) * 100;
      targets.push(`Mục tiêu 1: <b>${fp(r.ma20)}</b> (hồi về MA20, +${upPct.toFixed(1)}%)`);
    }
    if (r.resistance && r.resistance > cur) {
      const upPct = ((r.resistance - cur) / cur) * 100;
      targets.push(`Mục tiêu 2: <b>${fp(r.resistance)}</b> (kháng cự gần, +${upPct.toFixed(1)}%)`);
    }

    const rankTxt = rank ? `Pick #${rank}` : "";

    return `
      <div class="an-card context-card context-tplus">
        <div class="context-header">
          <span class="context-icon">⚡</span>
          <div>
            <div class="context-title">T+ ${rankTxt} · Score ${pick.score >= 0 ? "+" : ""}${pick.score.toFixed(2)}</div>
            <div class="context-subtitle">Cơ hội mean-reversion ngắn hạn</div>
          </div>
        </div>
        <div class="context-section">
          <div class="context-section-title">Tín hiệu đang fire</div>
          <ul class="context-bullets">${reasons.map((rr) => `<li><b>${rr}</b></li>`).join("")}</ul>
        </div>
        <div class="context-section">
          <div class="context-section-title">Plan giao dịch</div>
          <ul class="context-bullets">
            <li>Vùng vào: <b>~${fp(cur)}</b> (giá hiện tại)</li>
            <li>Stop loss: <b>${fp(slFinal)}</b> (${slPct.toFixed(1)}%) — max của -8% và 2×ATR</li>
            ${targets.map((t) => `<li>${t}</li>`).join("")}
            <li>Hold: <b>15-30 phiên</b></li>
            <li>Exit khi: RSI hồi &gt;50 HOẶC đạt mục tiêu HOẶC dính SL</li>
          </ul>
        </div>
        <div class="context-disclaimer">
          ⚠️ Mean-reversion có thể fail nếu thị trường tiếp tục giảm. Backtest test set 2023-2026: setup score≥4 win rate <b>61%</b>, avg <b>+3.3%/lệnh</b> — nhưng 4/10 lệnh thua, cần tuân thủ stop loss.
        </div>
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
  let currentTab = "analyze";

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
    document.getElementById("ranking-load-btn").addEventListener("click", () => loadRanking());
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
      card.addEventListener("click", () => {
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
    if (e.target && e.target.id === "ranking-load-btn") loadRanking();
  });

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
