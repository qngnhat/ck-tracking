// ═══════════════════════════════════════
// Buy verdict + market outlook — scoring & decision helpers.
// Bayesian win-prob, TP targets, hold profile, risk chips, tactical hint.
// ═══════════════════════════════════════
window.__SSI_VERDICT_UI__ = (function () {
  "use strict";

  const { fp } = window.__SSI_FMT__;
  const { nextVnHoliday, isMarketOpenNow } = window.__SSI_MARKET__;

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

  return { estimateHoldProfile, computeTpTargets, computeBayesianWinProb, getVerdict, getVolatilityLabel, renderRiskChips, renderActionCard, computeMarketOutlook, composeTacticalHint, buildTodayActions };
})();
