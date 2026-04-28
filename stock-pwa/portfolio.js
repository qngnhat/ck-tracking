// ═══════════════════════════════════════
// Portfolio module — transactions + holdings + cash
// ═══════════════════════════════════════
//
// Storage pattern (same as watchlist):
//  - localStorage = source of truth cho sync reads
//  - DB write-through trên mỗi mutation (nếu logged in)
//  - On login: pull DB → replace local
//  - Holdings = computed on-the-fly from transactions (Option A:
//    weighted avg, sell giảm qty không đổi avg cost)

window.__SSI_PORTFOLIO__ = (function () {
  "use strict";

  const TX_KEY = "portfolio_tx_v1";
  const CASH_KEY = "portfolio_cash_v1";

  function _AUTH() { return window.__SSI_AUTH__; }
  function _isOnline() { return _AUTH() && _AUTH().isLoggedIn(); }

  // ── Transactions storage ──
  function loadTransactions() {
    try {
      const arr = JSON.parse(localStorage.getItem(TX_KEY) || "[]");
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }

  function saveTransactions(arr) {
    try { localStorage.setItem(TX_KEY, JSON.stringify(arr)); } catch {}
  }

  function loadCash() {
    try {
      const v = JSON.parse(localStorage.getItem(CASH_KEY) || "0");
      return typeof v === "number" ? v : 0;
    } catch { return 0; }
  }

  function saveCash(amount) {
    try { localStorage.setItem(CASH_KEY, JSON.stringify(amount)); } catch {}
  }

  // Compute cash delta cho 1 transaction. Trả về VND.
  // Buy: cash giảm = qty*price*1000 + fee*1000 (price/fee đều k-VND trong storage)
  // Sell: cash tăng = qty*price*1000 - fee*1000
  function txCashDelta(tx) {
    const qty = Number(tx.quantity) || 0;
    const price = Number(tx.price) || 0; // k-VND
    const feeK = Number(tx.fee) || 0; // k-VND
    const gross = qty * price * 1000;
    const feeVnd = feeK * 1000;
    if (tx.side === "buy") return -(gross + feeVnd);
    return gross - feeVnd; // sell
  }

  // ── Add transaction (write-through DB) ──
  // opts: { autoCash: bool } — true (default) auto-điều chỉnh cash theo tx
  async function addTransaction(tx, opts = {}) {
    const autoCash = opts.autoCash !== false;
    // tx: {symbol, side, quantity, price, fee?, trade_date?, notes?}
    const sym = tx.symbol.toUpperCase().trim();
    const local = loadTransactions();
    const id = crypto.randomUUID ? crypto.randomUUID() : `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tradeDate = tx.trade_date || new Date().toISOString();
    const entry = {
      id,
      symbol: sym,
      side: tx.side,
      quantity: Number(tx.quantity),
      price: Number(tx.price),
      fee: Number(tx.fee || 0),
      trade_date: tradeDate,
      notes: tx.notes || null,
    };
    local.push(entry);
    saveTransactions(local);

    if (_isOnline()) {
      const dbRow = await _AUTH().dbInsert("transactions", {
        symbol: sym,
        side: tx.side,
        quantity: entry.quantity,
        price: entry.price,
        fee: entry.fee,
        trade_date: tradeDate,
        notes: entry.notes,
      });
      // Replace temp id with DB id if got back
      if (dbRow && dbRow[0]?.id) {
        const idx = local.findIndex((t) => t.id === id);
        if (idx >= 0) {
          local[idx].id = dbRow[0].id;
          saveTransactions(local);
        }
      }
    }

    // Auto-adjust cash (mua trừ, bán cộng)
    if (autoCash) {
      const delta = txCashDelta(entry);
      if (delta !== 0) {
        await updateCash(loadCash() + delta);
      }
    }
    return entry;
  }

  async function deleteTransaction(id, opts = {}) {
    const autoCash = opts.autoCash !== false;
    const all = loadTransactions();
    const tx = all.find((t) => t.id === id);
    const local = all.filter((t) => t.id !== id);
    saveTransactions(local);
    if (_isOnline()) {
      await _AUTH().dbDelete("transactions", { eq: { id } }).catch(() => {});
    }
    // Reverse cash delta (mua đã trừ → cộng lại; bán đã cộng → trừ lại)
    if (autoCash && tx) {
      const reverseDelta = -txCashDelta(tx);
      if (reverseDelta !== 0) {
        await updateCash(loadCash() + reverseDelta);
      }
    }
    return true;
  }

  // Cộng thêm vào cash (deposit). Trả về số dư mới.
  async function depositCash(amountVnd) {
    const v = Number(amountVnd) || 0;
    if (v <= 0) return loadCash();
    return await updateCash(loadCash() + v);
  }

  async function updateCash(amount) {
    const v = Number(amount) || 0;
    saveCash(v);
    if (_isOnline()) {
      await _AUTH().dbUpsert("portfolio_meta", {
        cash: v,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" }).catch((e) => console.warn("[portfolio] cash:", e));
    }
    return v;
  }

  // ── Compute holdings from transactions (Option A) ──
  /**
   * Walk through transactions chronologically:
   *  - buy: avg_cost = (qty*avg_cost + buy_qty*buy_price + fee) / (qty + buy_qty)
   *  - sell: avg_cost UNCHANGED, qty -= sell_qty, realized_pnl += qty*(sell_price - avg_cost) - fee
   * Returns: array of {symbol, qty, avg_cost, cost_basis, realized_pnl,
   *   total_bought, total_sold, first_buy_date, last_tx_date}
   */
  function computeHoldings(transactions = null) {
    const txs = transactions || loadTransactions();
    const sorted = [...txs].sort((a, b) =>
      new Date(a.trade_date).getTime() - new Date(b.trade_date).getTime()
    );

    const holdings = {};

    for (const t of sorted) {
      const sym = t.symbol;
      if (!holdings[sym]) {
        holdings[sym] = {
          symbol: sym,
          qty: 0,
          avg_cost: 0,
          cost_basis: 0,
          realized_pnl: 0,
          total_bought: 0,
          total_sold: 0,
          first_buy_date: null,
          last_tx_date: null,
        };
      }
      const h = holdings[sym];
      const qty = Number(t.quantity);
      const price = Number(t.price);
      const fee = Number(t.fee || 0);

      if (t.side === "buy") {
        const newQty = h.qty + qty;
        const newCost = h.qty * h.avg_cost + qty * price + fee;
        h.avg_cost = newQty > 0 ? newCost / newQty : 0;
        h.qty = newQty;
        h.cost_basis = h.qty * h.avg_cost;
        h.total_bought += qty;
        if (!h.first_buy_date) h.first_buy_date = t.trade_date;
      } else {
        // sell — avg cost unchanged
        h.realized_pnl += qty * (price - h.avg_cost) - fee;
        h.qty = Math.max(0, h.qty - qty);
        h.cost_basis = h.qty * h.avg_cost;
        h.total_sold += qty;
      }
      h.last_tx_date = t.trade_date;
    }

    return Object.values(holdings);
  }

  /** Holdings hiện tại (qty > 0). */
  function currentHoldings() {
    return computeHoldings().filter((h) => h.qty > 0);
  }

  /** Tất cả mã từng giao dịch (kể cả đã bán hết). */
  function allHoldings() {
    return computeHoldings();
  }

  // ── DB sync helpers ──
  async function syncTransactionsFromDB() {
    if (!_isOnline()) return;
    const data = await _AUTH().dbSelect("transactions", {
      order: { column: "trade_date", ascending: true },
    });
    if (data) {
      const arr = data.map((d) => ({
        id: d.id,
        symbol: d.symbol,
        side: d.side,
        quantity: Number(d.quantity),
        price: Number(d.price),
        fee: Number(d.fee || 0),
        trade_date: d.trade_date,
        notes: d.notes,
      }));
      saveTransactions(arr);
    }
  }

  async function syncCashFromDB() {
    if (!_isOnline()) return;
    const data = await _AUTH().dbSelect("portfolio_meta");
    if (data && data.length > 0) {
      saveCash(Number(data[0].cash) || 0);
    }
  }

  async function migrateTransactionsToDB() {
    if (!_isOnline()) return;
    const local = loadTransactions();
    if (local.length === 0) return;
    // CRITICAL: skip if DB already has rows (else sync pulls them, then migrate re-inserts → dupe)
    const existing = await _AUTH().dbSelect("transactions", {}).catch(() => null);
    if (existing && existing.length > 0) {
      console.log("[portfolio] DB already has txs, skip migration");
      return;
    }
    const batch = local.map((t) => ({
      symbol: t.symbol,
      side: t.side,
      quantity: t.quantity,
      price: t.price,
      fee: t.fee,
      trade_date: t.trade_date,
      notes: t.notes,
    }));
    await _AUTH().dbInsert("transactions", batch).catch((e) =>
      console.warn("[portfolio] migrate tx:", e)
    );
  }

  async function migrateCashToDB() {
    if (!_isOnline()) return;
    const cash = loadCash();
    if (cash <= 0) return;
    // Skip if DB already has cash record (upsert would overwrite anyway, but be explicit)
    const existing = await _AUTH().dbSelect("portfolio_meta", {}).catch(() => null);
    if (existing && existing.length > 0) {
      console.log("[portfolio] DB already has cash, skip migration");
      return;
    }
    await _AUTH().dbUpsert("portfolio_meta", {
      cash,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" }).catch(() => {});
  }

  // Dedupe: remove transactions that have identical (symbol, side, qty, price, fee, trade_date, notes)
  // Used to clean up dupes caused by migration bug. Returns number of dupes removed.
  async function dedupeTransactions() {
    const local = loadTransactions();
    const seen = new Map(); // signature → first id seen
    const toKeep = [];
    const toDelete = [];
    for (const t of local) {
      const sig = `${t.symbol}|${t.side}|${t.quantity}|${t.price}|${t.fee || 0}|${t.trade_date}|${t.notes || ""}`;
      if (!seen.has(sig)) {
        seen.set(sig, t.id);
        toKeep.push(t);
      } else {
        toDelete.push(t.id);
      }
    }
    saveTransactions(toKeep);
    if (_isOnline() && toDelete.length > 0) {
      // Delete in DB serially (each respects RLS)
      for (const id of toDelete) {
        await _AUTH().dbDelete("transactions", { eq: { id } }).catch(() => {});
      }
    }
    return toDelete.length;
  }

  // Detect duplicate count without modifying anything
  function countDuplicateTransactions() {
    const local = loadTransactions();
    const seen = new Set();
    let count = 0;
    for (const t of local) {
      const sig = `${t.symbol}|${t.side}|${t.quantity}|${t.price}|${t.fee || 0}|${t.trade_date}|${t.notes || ""}`;
      if (seen.has(sig)) count++;
      else seen.add(sig);
    }
    return count;
  }

  // ── Action recommendation per holding (decision-grade, SL-aware) ──
  /**
   * Suggest action cho 1 holding dựa trên:
   *  - SL active = max(cost-based SL, trailing SL từ analysis)
   *  - Distance đến SL (co giãn theo ATR%)
   *  - Setup score + P&L
   *  - Có trong DCA top picks không
   * Returns: {priority, icon, text, color, slActive}
   */
  function recommendAction(holding, analysis, inDcaTop) {
    const pnlPct = holding.cost_basis > 0
      ? ((analysis.current * holding.qty - holding.cost_basis) / holding.cost_basis) * 100
      : 0;
    const score = analysis?.score ?? 0;
    const cur = analysis?.current ?? 0;

    // ── Active SL = max(cost-based -8%, trailing SL từ analysis) ──
    // Cả 2 luôn < current cho long; pick "tighter" (closer to current = max).
    // Guard: trailing SL có thể null/NaN → fallback -Infinity, dùng cost-SL.
    const slCost = holding.avg_cost * 0.92;
    const slTrail = isFinite(analysis?.stopLoss) ? analysis.stopLoss : -Infinity;
    const slActive = Math.max(slCost, slTrail);

    // Ngưỡng "sát SL" co giãn theo ATR — tránh báo quá sớm cho mã low-vol.
    // 0.8 × ATR%, clamp [1.0%, 1.5%]
    const atrPct = analysis?.atrPct ?? 1.5;
    const nearPct = Math.max(1.0, Math.min(1.5, 0.8 * atrPct));
    const distPct = slActive > 0 ? ((cur - slActive) / cur) * 100 : null;

    // ── Tier 1: Đã thủng SL (current ≤ slActive) ──
    if (cur > 0 && slActive > 0 && cur <= slActive) {
      const dayChg = analysis?.dayChange ?? 0;
      // Soft hơn nếu giá đang nhú lên trong phiên — cho space chờ hồi nhẹ
      const txt = dayChg > 0
        ? `Đã thủng SL ${slActive.toFixed(2)} — nên cắt kỷ luật. Có thể chờ nhịp hồi nhẹ để thoát giá tốt hơn.`
        : `Đã thủng SL ${slActive.toFixed(2)} — nên cắt kỷ luật, review thesis nếu giữ.`;
      return { priority: 1, icon: "🚨", color: "#ff4444", text: txt, slActive };
    }

    // ── Tier 2: Sát SL (< nearPct) ──
    if (distPct != null && distPct < nearPct) {
      return {
        priority: 1, icon: "⚠️", color: "#ff5722",
        text: `Sát SL ${slActive.toFixed(2)} (còn ${distPct.toFixed(1)}%) — chuẩn bị action nếu thủng.`,
        slActive,
      };
    }

    // ── Tier 3: Critical sell signals (score quá xấu) ──
    if (score < -3) {
      return {
        priority: 1, icon: "🚨", color: "#ff4444",
        text: `Setup xấu (score ${score.toFixed(1)}) — cân nhắc thoát vị thế. SL ${slActive.toFixed(2)}.`,
        slActive,
      };
    }
    if (pnlPct < -8 && score < 0) {
      return {
        priority: 1, icon: "⚠️", color: "#ff5722",
        text: `Lỗ ${pnlPct.toFixed(1)}% + Setup yếu — review thesis. SL ${slActive.toFixed(2)}.`,
        slActive,
      };
    }

    // ── Tier 4: Take profit signals ──
    if (pnlPct > 20 && score < 2) {
      return {
        priority: 2, icon: "💰", color: "#FF9800",
        text: `Lãi ${pnlPct.toFixed(1)}% + Setup không còn tích cực — cân nhắc TP một phần`,
        slActive,
      };
    }
    if (pnlPct > 30) {
      return {
        priority: 2, icon: "💰", color: "#FF9800",
        text: `Lãi ${pnlPct.toFixed(1)}% — cân nhắc TP 1/3`,
        slActive,
      };
    }

    // ── Tier 5: Add signals ──
    if (score >= 4 && inDcaTop) {
      return {
        priority: 3, icon: "📈", color: "#4CAF50",
        text: `Setup tốt + còn trong DCA top — có thể tilt buy. SL ${slActive.toFixed(2)}.`,
        slActive,
      };
    }

    // ── Tier 6: Score yếu + đang lỗ → "Yếu" thay vì "Trung tính" ──
    if (score < 2 && pnlPct < 0) {
      return {
        priority: 4, icon: "👀", color: "#FF9800",
        text: `Yếu — chưa có tín hiệu đảo chiều. SL ${slActive.toFixed(2)}, theo dõi vùng hỗ trợ.`,
        slActive,
      };
    }

    // ── Tier 7: Caution (score thấp, P&L positive) ──
    if (score >= -3 && score < 0) {
      return {
        priority: 4, icon: "👀", color: "#FF9800",
        text: `Setup yếu — theo dõi vùng hỗ trợ. SL ${slActive.toFixed(2)}.`,
        slActive,
      };
    }

    // ── Tier 8: Removed from DCA top (sau 30 phiên) ──
    if (!inDcaTop && holding.first_buy_date) {
      const daysHeld = (Date.now() - new Date(holding.first_buy_date).getTime()) / 86400000;
      if (daysHeld > 30) {
        return {
          priority: 4, icon: "🔄", color: "#FF9800",
          text: "Không còn trong DCA top — cân nhắc thay thế khi rebalance",
          slActive,
        };
      }
    }

    // ── Tier 9 default: hold (P&L hint) ──
    return {
      priority: 5, icon: "✓", color: "#4CAF50",
      text: pnlPct > 0
        ? `Giữ. Lãi ${pnlPct.toFixed(1)}%. SL ${slActive.toFixed(2)}.`
        : pnlPct < 0
        ? `Giữ. Lỗ ${pnlPct.toFixed(1)}%. SL ${slActive.toFixed(2)}.`
        : `Giữ. Trung tính. SL ${slActive.toFixed(2)}.`,
      slActive,
    };
  }

  return {
    loadTransactions,
    loadCash,
    addTransaction,
    deleteTransaction,
    updateCash,
    depositCash,
    computeHoldings,
    currentHoldings,
    allHoldings,
    recommendAction,
    // DB sync
    syncTransactionsFromDB,
    syncCashFromDB,
    migrateTransactionsToDB,
    migrateCashToDB,
    // Maintenance
    dedupeTransactions,
    countDuplicateTransactions,
  };
})();
