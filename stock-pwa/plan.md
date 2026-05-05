# Stock Analyzer PWA — Roadmap Tối Ưu cho TTCK Việt Nam

## Mục tiêu dài hạn
Chuyển Stock Analyzer từ **decision support tool dựa cảm tính** sang **tool có cơ sở dữ liệu thực tế**, được calibrate cho đặc thù TTCK Việt Nam, và có thể đo lường hiệu quả định kỳ.

---

## 📊 Tiến độ tổng quan (last updated: 2026-04-27)

| Phase | Status | Output |
|---|---|---|
| 1 — Backtest Framework | ✅ Done | 4 backtest reports trong `backtest/results/` |
| 2 — Calibrate scoring | ⚠️ Skipped (intentional) | Phase 1.4 cho thấy combined system underperform B&H → reframe label thay vì tinh chỉnh weight |
| 3 — Add features từ gap | Partial | A (regime) ✅, B-G chưa làm |
| 4 — Stock Ranking T+/DCA | ✅ Done + ship | Tab "Top picks" trong PWA, validate out-of-sample |
| 4b — T+ Validation | ✅ Done | Threshold bumped 2.0 → 4.0 dựa trên backtest |
| 5 — Continuous Validation | Partial | Paper tracker ✅, regime detection ✅, monthly cron chưa |

**Bonus features (ngoài plan ban đầu, đã ship):**
- ✅ Search autocomplete 1700+ mã VN
- ✅ Chart candlestick 4 resolution + auto-refresh
- ✅ Tooltips toàn bộ chỉ báo
- ✅ Responsive desktop 2-column grid
- ✅ Context cards (DCA/T+ pick → giải thích why)
- ✅ Universe Option C: VN30 actual + Extended (manual quarterly review)
- ✅ Reframe scoring: "MUA MẠNH" → "Setup tốt" (theo Phase 1.4 insight)
- ✅ RSI<25 weight bumped to +3 (theo Phase 1.3 winner)
- ✅ MACD weight dropped (no edge)
- ✅ Market regime widget VN-Index BULL/BEAR/RANGE
- ✅ T+ universe expansion (top 120 by market cap)
- ✅ Action card "Hành động đề xuất" per score level
- ✅ Home tab dashboard adaptive theo thời gian/ngày
- ✅ Watchlist + alert system (signal change detection, browser notification)
- ✅ Paper tracker (snapshot picks, verify performance vs hypothetical)
- ✅ Login Google OAuth qua Supabase + multi-device DB sync (RLS per user)
- ✅ Hosted on Cloudflare Workers (after hitting Netlify free tier)
- ✅ Portfolio Phase 1: nhập giao dịch (mua/bán), holdings, cash, P&L, action recommendation per holding
- ✅ Autocomplete cho input mã trong transaction modal (reuse cùng filterStocks logic)
- ✅ Company info trong analyze header (tên CTCK · ngành · sàn HOSE/HNX)
- ✅ fmtMoney hiện full VND (4.649.000đ) thay vì làm tròn (4.6 tr)
- ✅ Holding detail modal: vị thế + portfolio-specific action plan (TP zones, stop loss, vùng mua thêm) + tx history với edit/xóa per-row
- ✅ Cash card cả ô click được (thay vì chỉ icon ✎)
- ✅ Fix display bugs cho mã crash (KDC case): tách `support` (pivot thật, có thể null) khỏi `effectiveSupport` (anchor cho SL/buy-zone math) — Stop loss không còn nhảy lên ABOVE current
- ✅ Buy zone: chia 2 nhánh DCA pullback (anchor support+MA20) vs crashed (zone hẹp ±2-3%)
- ✅ T+ TP cap +7%/+12% (thay vì MA20/resistance có thể +25%) — khớp horizon T+ 1-3 phiên
- ✅ T+ entry: "Vùng quan sát ±2% + Trigger: nến rút chân/volume xác nhận" thay vì "vào ngay current"
- ✅ T+ subtitle context-aware: rơi mạnh ≥3% → "chờ xác nhận đảo chiều"
- ✅ T+ Risk badge từ ATR% (cao/vừa/thấp) — proxy biến động cho size lệnh
- ✅ Decision layer: Verdict badge (🟢 Spec Buy / 🟡 Watchlist / 🔴 Avoid) + Risk chips (Bắt dao rơi / Vol thấp / Downtrend mạnh) tách độc lập với Setup label
- ✅ `flags` object share giữa `analyze()` và `computeTPlusFactors` — thay grep `reasons.includes()` brittle bằng boolean fields
- ✅ T+ TP cap chỉnh từ +7/+12 → **+10/+18** (sát backtest stat: avg winner ~8.7%)
- ✅ T+ Entry 2 option: Aggressive scale-in (current ±2%) + Confirmed (chờ trigger nến/vol) — không ép user một hướng
- ✅ Đổi "Risk cao" → "Biến động cao — chia size 1/3" (ATR% là proxy biến động, không phải risk)
- ✅ Action card rút gọn: bỏ situation + newAction (đã được verdict cover), giữ "Nếu đang giữ" + 1-line warning
- ✅ `computeTpTargets(r)` helper share giữa T+ context + action card — nhất quán, có check `tp1 > current` + `tp2 > tp1` để tránh bug TP vô nghĩa
- ✅ TP wording: "Mục tiêu gần (~10%)" / "Mục tiêu tối đa (~18%)" — bỏ jargon "trần T+ realistic/stretch"
- ✅ Verdict desc tách câu: "Có thể vào (spec nhỏ). Thận trọng: ưu tiên chờ xác nhận." — giảm conflict với entry option
- ✅ Hold action có SL number + TP1 cụ thể — actionable ngay, user không phải tự cuộn xuống tìm
- ✅ `estimateHoldProfile(r)` — 4 preset (Bear trap / Bounce nhanh / Hồi chậm / Standard) thay 1 dòng cứng "Hold 5-15 phiên"
- ✅ `lowSessionLiq` flag (current price × vol < 2 tỷ) + chip "🐢 Kẹt hàng" — phát hiện mã vào dễ ra khó dù avg turnover OK
- ✅ **Decision layer rewrite**: hard/soft flag distinction → penalty ảnh hưởng VERDICT (không chỉ chip)
  - Hard: `bearTrap`, `lowSessionLiq` (1 cái → downgrade)
  - Soft: `lowVol`, `deepDowntrend` (≥2 mới downgrade)
  - Score≥4 + (hard≥1 || soft≥2) → Watchlist (thay vì Spec Buy)
  - Size hint embed vào verdict desc dynamic theo flagCount + ATR
  - Entry order theo flagCount: risk → Confirmed first
- ✅ Filter reasons khỏi chip duplicate trong T+ context
- ✅ Rank priority sub-label (#1 Ưu tiên cao / #2 Backup) trong ranking list
- ✅ Anti-FOMO line "❌ KHÔNG vào khi: gap down kèm vol tăng" trong Plan giao dịch (thêm "-DI mạnh hơn +DI" nếu bearTrap)
- ✅ TP wording probability hint: TP1 "khả năng cao", TP2 "cần thị trường thuận lợi"
- ✅ Market regime hint trong T+ tab dùng `getMarketRegime()`: BULL/BEAR/RANGE → action hint phù hợp
- ✅ **Portfolio holding decision engine (Commit C1)**: SL-aware action wording — không còn "Giữ" generic
  - Active SL = max(cost-based -8%, trailing SL ATR/support)
  - Distance to SL co giãn theo ATR (clamp 1-1.5%)
  - Tier 1: Đã thủng SL → "🚨 Đã thủng SL X.XX — nên cắt kỷ luật" (mềm hơn nếu dayChange > 0)
  - Tier 2: Sát SL (< nearPct) → "⚠️ Sát SL X.XX (còn Y%) — chuẩn bị action"
  - Tier 3: Score < 2 + đang lỗ → "Yếu — chưa có tín hiệu đảo chiều"
  - Action text mọi tier giờ inject SL number cụ thể
- ✅ Volume severity 2-tier: `flags.volCritical` (< 0.4×) chip "🚨 Vol cực thấp — khó có lực hồi" priority over "Vol thấp — thiếu xác nhận"
- ✅ Chip wording thêm hệ quả: "kẹt hàng — vào dễ ra khó", "vol thấp — thiếu xác nhận"
- ✅ **Commit C2 — Portfolio dashboard "tàn nhẫn"**:
  - Cash/Equity ratio dưới NAV: "Cổ X% · Cash Y%". Cảnh báo nếu cash < 10% trong 5 ngày trước holiday
  - "Xanh vỏ đỏ lòng" warning: nếu mã lỗ ngốn ≥ 80% lợi nhuận winners → banner cam
  - DCA preview trong tx modal: khi mua mã đã có holding → hiện avg cost mới (↓/↑) + KL mới
  - Nút "+ Bán {symbol}" cam (thay "+ Giao dịch") khi action priority = 1 + đang lỗ. Pre-fill side=sell khi click
  - Bỏ emoji prefix khỏi action.text (đã có trong action.icon → render double)
- ✅ **Bug fix vol catalyst direction**: vol cao + giá giảm = lực bán (phân phối), KHÔNG phải catalyst cho mean-rev
  - Trước: `volRatio > 1.5 → +1 score` bất kể chiều giá
  - Sau: phân biệt theo dayChange — chỉ +1 nếu dayChange ≥ -1% (buy/absorbtion); else không cộng + reason "lực bán"
  - Add `flags.sellPressure = volRatio > 1.5 && dayChange < -2` → hard flag → verdict downgrade
  - Risk chip "📉 Lực bán mạnh — vol cao + giá giảm"
  - KDC fix: score 5.5 → 4.5 + sellPressure flag → Watchlist (verdict đã đúng)
- ✅ **Phase 5 backtest kết quả: REJECT mode "Mã khỏe" trend-following swing**
  - Train sharpe 0.34 → OOS -0.04 (overfit catastrophic 111%)
  - Strategy underperform random pick + VN-Index B&H
  - Lessons: VN market range-dominant, trend-following simple rules no edge trên 58 DCA universe
  - "Backtest first" principle SAVED tao khỏi ship strategy lỗ
  - Files giữ làm reference: `backtest/src/strong_score.py`, `backtest/run_phase5_strong.py`
  - Plan + analysis: `/Users/qngnhat/OF1/plans/strong-mode-backtest-results.md`
- ✅ **Closed positions view** trong tab Danh mục
  - `renderClosedPositions()`: list mã đã đóng vị thế (qty=0 + realized != 0)
  - Header: tổng realized YTD + win rate, collapsible body
  - Per item: symbol, mua-bán date range + days held, qty + avg cost, realized P&L
- ✅ **Cash deployment hint contextual**:
  - Cash > 30% NAV + còn ≤ 7 phiên tới holiday → banner info "Cân nhắc hold cash qua lễ"
  - Brake re-deploy panic sau cắt lỗ
- ✅ **Position sizing auto** trong tx modal:
  - Compute NAV từ cash + market value holdings (cached analyses)
  - Max risk per trade = 2% NAV
  - SL distance từ analysis cache (clamp 3-15%) hoặc default 8%
  - Suggest "Size khuyến nghị: X cp (~Y, max 2% at risk, SL ~Z%)"
  - Cảnh báo nếu user nhập qty > size khuyến nghị
- ✅ **T+ distribution stats panel** trên đầu picks list:
  - Count Spec Buy / Watchlist split (verdict logic)
  - Top 4 risk flags activate counts: bearTrap, lowSessionLiq, sellPressure, etc.
  - Verify v46 patches behavior — distribution sane hay quá khắt khe
- ✅ **Market Outlook section trong tab Home** (4 layer):
  - **L1 — Index state**: regime + MA50/MA200 distance + 1M/3M return + ATR volatility
  - **L2 — Breadth proxy**: T+ eligible / DCA picks count, age cập nhật
  - **L3 — Money flow & Sector**: top 3 sector từ T+ picks, % bullish picks today, risk flags activation
  - **L4 — Tactical hint composite**: phân tích regime + flags + holiday + portfolio cash → action gợi ý
  - Reuse cached data (vnindex_regime + tplus + dca picks) — không trigger heavy scan
  - Disclaimer: "tổng hợp tín hiệu kỹ thuật, không phải lời khuyên đầu tư"
- ✅ **Market Snapshot section trên home** (sector heat + leaders + foreign flow):
  - `RANKING.loadMarketSnapshot()`: scan 58 DCA universe, compute per-mã 1W/1M return, dayChange, 52W high/low, foreign net buy 5d. Cache 1h.
  - 🔥 **Sector heat map**: top 3 + bottom 2 sector by avg 1W return (xanh/đỏ tier)
  - 🚀 **Leaders**: top 5 mã 1W return + dayChange today
  - 📉 **Laggards**: top 3 mã yếu nhất 1W
  - 💰 **Foreign flow leaders**: top 3 mã NN gom mạnh nhất 5 phiên (tỷ VND)
  - 🌡️ **Breadth quick line**: % mã tăng today/week, count 52W high/low
  - Click mã row → navigate analyze tab
  - Button ↻ scan với progress (X/58 mã)
- ✅ **Market Snapshot Phase 1 enhancement**:
  - **Universe toggle** DCA-58 (cache 1h) vs Full HOSE+HNX ~700 (cache 4h, foreign skip cho speed)
  - localStorage `snap_universe_pref` lưu lựa chọn user; auto-load cache theo pref
  - **Distribution histogram** today: 7 range bars (≤-5%, -5/-2%, -2/0%, ≈0%, 0/+2%, +2/+5%, ≥+5%) với count + color gradient
  - **Volume surge list**: top 8 mã vol ≥ 2× TB (catalyst signal)
  - **52W high list**: mã đang ở đỉnh 52W (+1W return)
  - **52W low list**: mã đang ở đáy 52W (cảnh báo phân phối)
  - All click-able → navigate analyze tab
- ✅ **Market Snapshot Phase 2 — sector deep dive + comparison table**:
  - **Sector detail modal**: click sector heat row → mở modal full-screen
    - Header summary: avg today/1W/1M, % mã tăng hôm nay
    - Sort bar: 1W / 1M / Today / Vol (click switch)
    - Stock table per sector: symbol, 52W flag, price, day%, 1W%, 1M%, vol×
    - Click stock row → navigate analyze tab
  - **Sector comparison table** trong home: list all sectors với multi-timeframe
    - Cột: Sector, N (count), Today, 1W, 1M (color-coded green/red)
    - Sorted by avg 1W desc, click row → drill-down modal
  - Reuse data từ snapshot (không scan thêm)
- ✅ **Market Snapshot Phase 3 — momentum scanner + sector rotation**:
  - **Pattern detection per stock** trong scan loop:
    - `crossMa20Up`: cross MA20 từ dưới lên + vol up
    - `breakout52w`: cross 52W high + dayChange tích cực
    - `reversalCandidate`: RSI<30 + dayChange > 1% + vol > avg
  - **3 trending lists**:
    - 📈 Đang vào uptrend (cross MA20)
    - 🚀 Phá đỉnh 52W gần đây
    - 🔄 Reversal candidates (oversold bouncing)
  - **Sector rotation 4-quadrant**:
    - Fetch VN-Index để compute relative perf
    - X-axis: sector_1M - vniRet1M (relative perf)
    - Y-axis: sector_1W - vniRet1W (momentum)
    - 4 buckets: 🏆 Leading (++), 📈 Improving (-+), 📉 Lagging (--), ⚠️ Weakening (+-)
    - Each quadrant: list sectors trong group + rel1W%
    - Click sector → drill-down modal
  - All compute from existing snapshot scan (no extra fetches except VNINDEX)
- ✅ **T+ Context Card UX rewrite — clarity over score**: user confused vì score cao + verdict downgraded mâu thuẫn visual
  - **BIG action banner** trên top: "✅ CÓ THỂ VÀO" / "⚠️ CHỜ XÁC NHẬN" / "🚫 KHÔNG VÀO" với border + bg color
  - **Action advice 1 dòng**: dynamic per verdict ("Đừng vào aggressive hôm nay — chờ trigger" cho Watchlist downgraded)
  - **Risk chips trong banner** (replace verdict-block riêng)
  - **De-emphasize rank line**: "T+ #1 · Score +5.50" giờ small + disclaimer "(rank theo confluence, không phải khuyến nghị mua)"
  - **🚨 "Tại sao chưa nên vào aggressive"** section (cam đỏ) cho Watchlist downgraded, list cụ thể từng risk flag
  - **✅ "Cân nhắc vào khi thấy ≥ 1 trong"** section (xanh) — list trigger để wait for: nến rút chân, vol confirm, +DI cross, BB bounce
  - **Plan giao dịch collapsible** (`<details>`) — Watchlist downgraded thì collapse default, Spec Buy thì expand
  - User giờ hiểu ngay layout: hôm nay nên làm gì, lý do, trigger để chờ
- ✅ **Forward stats card trong analyze tab — dự đoán dựa lịch sử**
  - User hỏi "tỷ lệ tăng/giảm tương lai bao nhiêu" — implement statistical historical (KHÔNG phải ML)
  - `computeForwardStats(closes)`: walk history, find days với RSI cùng bucket, compute 5/10/20 phiên forward returns
  - 7 bucket RSI: OS_extreme (<25) / OS_strong (25-30) / OS_mild (30-45) / neutral / OB_mild / OB_strong / OB_extreme
  - Per horizon: avg return, win rate, range [worst, best], median
  - Sample size warning: <10 → "độ tin cậy thấp", <30 → "chỉ là gợi ý", ≥30 → "Sample n=X"
  - Disclaimer mạnh: "Quá khứ KHÔNG đảm bảo tương lai. Đây là thống kê mô tả, không phải prediction"
  - Render giữa "Vùng giá & Hiệu suất" và "Phân tích chi tiết" trong analyze tab
- ✅ **Forward stats Phase 1.5: sector peer pooling**
  - Button "🔍 Mở rộng sample: pool stats từ peers cùng ngành" trong forward stats card
  - Click → fetch ~7 peers cùng sector (cache 1h), compute matches cho cùng RSI bucket
  - Display pool stats riêng để compare với mã đó: "Pool stats từ N peers (sample n=X)"
  - Tăng sample size từ 5-15 lên 50-100+ → reliability cao hơn cho rare buckets
  - Note: "Pool tăng sample nhưng mất mã-specific traits"
  - Export `ANALYSIS.computeForwardStats` để app.js consume per peer
- ⏳ **Phase 6 ML predictor planning**: draft `/Users/qngnhat/OF1/plans/ml-forward-predictor-plan.md`
  - Major project 18-27h, defer until backtest infra + user approve
  - Conservative approach: binary classification → walk-forward CV → 3 model candidates → OOS validate
  - Decision criteria: OOS accuracy ≥55%, Sharpe ≥0.3, train-OOS gap <10%
  - Reject path documented (theo Phase 5 Strong mode pattern)
- ✅ **Phase 6a — Bayesian win probability** (data-driven decision support):
  - Backtest analysis: `backtest/run_bayesian_flags.py`
  - 2492 trades T+ score≥4, hold 10 phiên, cross-section 58 mã DCA
  - Compute multipliers per flag: P(win | flag ON) / baseline
  - **SHOCK FINDING**: bearTrap (1.078), sellPressure (1.048), deepDowntrend (1.105) **POSITIVE multipliers** trong VN T+ — mean-rev work TỐT HƠN khi dip mạnh
  - Negatives: lowVol (0.908), volCritical (0.905), lowSessionLiq (0.638 — sample n=6 only)
  - By flag count: 0 flags 47% / 1 flag 51% / 2 flags 57% / 3 flags 60% — moderate flags ENHANCE win rate
  - Gemini/ChatGPT intuition "bearTrap = hard flag" SAI cho VN data → backtest first principle vindicated again
  - JS: `computeBayesianWinProb(score, flags)` → P(win) + breakdown
  - UI section trong T+ context: "📈 Bayesian win probability (data-driven)"
  - Display: "P(win 10 phiên) ≈ X% (baseline 52%)" + interpretation + collapsible breakdown
  - CAVEAT: cross-stock pooled, lowSessionLiq sample nhỏ, multipliers naive independent (flags correlated)
- ⏳ **Phase 6b (defer)**: Reconsider verdict logic vì backtest contradicts current "hard flag → downgrade"
  - Current verdict: bearTrap + sellPressure → Watchlist (downgrade)
  - Backtest: bearTrap + sellPressure → P(win) HIGHER, không phải lower
  - Cần user review Bayesian display 1-2 tuần → quyết định trust số liệu hay giữ verdict conservative
- ✅ **Forward stats sample-size fixes (PC1 case feedback)**:
  - User thấy PC1 hiện "100% win rate +20%" với sample n=1 → misread thành "kèo chắc thắng"
  - n < 3: card opacity 0.6, table grayscale 0.5, warn cực mạnh "⛔ chỉ N lần lịch sử, KHÔNG phải pattern thống kê"
  - Visual cue rõ user không trust mù
- ✅ **T+ eligibility diagnostic trong analyze tab**:
  - Khi user phân tích mã KHÔNG xuất hiện T+ pick → render panel giải thích lý do
  - Compute trong analyze.js: `avgTurnover20d`, `ret6m`
  - 3 checks:
    * avgTurnover20d < 5 tỷ → "Illiquid filter"
    * ret6m < -50% → "Falling knife filter"
    * score < 4 → "Chưa đủ confluence"
  - Panel cam cảnh báo: "Mã này có signal nhưng bị loại do hard rules — cẩn thận khi trade"
  - PC1 sẽ trigger filterIlliquid + có thể filterCrash

**Kết quả backtest chính:**
- ❌ Combined scoring (analysis tab): +51% / 8 năm vs Equal-Weight 55 +249% — underperform, dùng làm risk gauge thôi
- ✅ DCA Top 15 monthly: **+285% / CAGR 17.8% / Sharpe 0.82** vs EW55 +249%/0.80
- ✅ T+ score≥4: **win rate 61%, +3.3%/lệnh, Sharpe 0.32** trên test set 2023-2026

---

## Trạng thái hiện tại (đã thay đổi nhiều so với khi viết plan)

**Đã có (đầy đủ hơn plan ban đầu):**
- 8 chỉ báo kỹ thuật + tooltip giải thích
- Cơ bản: P/E, P/B, ROE, ROA, EPS, BVPS, Beta
- Khối ngoại: net 5/10/20 phiên + tần suất + room
- Scoring system reframed thành neutral labels
- Chart 4 resolution + auto-refresh
- **Top picks DCA/T+** với context cards
- **Paper trading tracker** (snapshot + verify)
- **Market regime widget** (BULL/BEAR/RANGE)
- **Home dashboard** adaptive
- **Backtest framework** đầy đủ (Python)

**Đã giải quyết (so với plan gốc):**
- ~~Không có backtest~~ → ✅ 4 backtest phases done
- ~~Trọng số tự bịa~~ → ✅ RSI+ bumped, MACD dropped (validated)
- ~~Không xét VN-Index state~~ → ✅ Regime widget + auto-adjust T+ threshold
- ~~Chỉ phân tích đơn lẻ~~ → ✅ Top picks ranking ship

**Còn thiếu (không critical):**
- So sánh P/E theo ngành (Phase 2.3) — skipped vì combined scoring underperform
- Multi-timeframe confirmation (Phase 3.B) — overkill cho daily strategy
- Volume profile (Phase 3.C) — phức tạp, marginal
- Risk metrics: beta hiển thị, max DD 1Y, position sizing — nice polish chưa làm
- Monthly auto re-backtest cron (Phase 5.1) — chỉ cần khi thấy drift

---

## Nguyên tắc chỉ đạo

1. **Validate trước, feature sau.** Không thêm chỉ báo/feature mới cho đến khi biết cái hiện tại có work không.
2. **Để data nói, không đoán.** Mọi thay đổi phải có justification từ backtest.
3. **Chấp nhận kết quả phũ.** Nếu backtest cho thấy hệ hiện tại thua buy-and-hold → phải gỡ bớt, không phải che giấu.
4. **Foundation > Features.** Build framework để test nhanh mỗi thay đổi, thay vì build UI đẹp.

---

## Giai đoạn 1 — Backtest Framework (1-2 tuần)

### 1.1. Mục tiêu
Đo được hiệu quả của từng signal riêng lẻ và combined scoring trên data TTCK VN lịch sử.

### 1.2. Tech stack đề xuất
- **Python 3 + Jupyter Notebook** (thích hợp cho data analysis, có pandas/numpy/matplotlib)
- Data source: VNDirect API (đã sẵn, format TradingView)
- Tránh: không build trong JS — làm chậm và debug khổ

### 1.3. Scope
- **Universe**: VN30 + VN Diamond + 30 mã liquid khác thuộc 5 ngành (finance, real estate, retail, industrial, utilities) = ~60 mã
- **Period**: 2018-01-01 đến nay (~7 năm, đủ dài để cover bull 2020-21, crash 2022, hồi phục 2023-24)
- **Resolution**: Daily
- **Benchmark**: VN-Index (buy & hold)

### 1.4. Deliverables
1. **Notebook 1 — `01_data_fetch.ipynb`**: fetch + cache OHLCV + fundamentals + foreign flow cho toàn bộ universe. Save ra parquet/csv.
2. **Notebook 2 — `02_indicators.ipynb`**: port analysis.js logic sang Python (RSI, MACD, BB, ADX, ATR, Stoch, MFI, MAs). Verify giá trị khớp với app PWA.
3. **Notebook 3 — `03_single_signal_backtest.ipynb`**: test từng signal đơn lẻ.
   - Ví dụ: mỗi lần RSI < 30, mua 1 unit, hold 5/10/20 ngày, bán. Tính avg return, win rate, Sharpe.
   - Làm tương tự cho: MACD cross, BB lower touch, ADX > 25 + +DI > -DI, NN mua 6+/10, P/E < 10, v.v.
   - Output: bảng xếp hạng signal nào có edge thực sự trên TTCK VN.
4. **Notebook 4 — `04_combined_scoring_backtest.ipynb`**: test hệ scoring hiện tại.
   - Rule: "MUA MẠNH"/"MUA" → buy 1 unit, hold đến khi "TRÁNH MUA"/"KHÔNG NÊN MUA" → sell.
   - Simulate trên toàn universe, tính portfolio return vs VN-Index.
   - Output: equity curve, total return, Sharpe, max drawdown, win rate.
5. **Report — `phase1_results.md`**: viết tay kết luận.

### 1.5. Success criteria
- Có số liệu cụ thể cho từng signal (không phải "RSI hoạt động tốt" mà là "RSI<30 + hold 10 ngày: win rate 54%, avg return +1.2%, Sharpe 0.6")
- Biết được combined scoring so với VN-Index buy-and-hold là hơn/huề/thua
- Xác định 3-5 signal yếu nhất để xem xét loại bỏ

### 1.6. Output kỳ vọng (3 kịch bản)
- **Scenario A (beat baseline)**: hệ thống có edge, tiếp tục sang Giai đoạn 2
- **Scenario B (huề baseline)**: bằng VN-Index → không đáng dùng TA phức tạp, đơn giản DCA ETF
- **Scenario C (thua baseline)**: phải gỡ bớt signal, đơn giản hóa hệ scoring

---

## Giai đoạn 2 — Calibrate theo Data (3-5 ngày)

### 2.1. Tuning thresholds
Dùng grid search trên backtest framework:
- RSI oversold: test {20, 25, 30, 35} — giá trị nào cho win rate cao nhất trên VN?
- ADX strong trend: test {20, 25, 30}
- P/E rẻ: không phải 1 số mà 1 ngưỡng **tương đối ngành** (percentile 20% của ngành)
- BB: giữ nguyên 20/2 (tiêu chuẩn) hay test 10/1.5, 30/2.5?

### 2.2. Reweight scoring
Dựa trên Sharpe ratio của từng signal trong Giai đoạn 1:
- Signal Sharpe > 0.8: weight ×2
- Signal Sharpe 0.4-0.8: weight ×1
- Signal Sharpe < 0.4: weight ×0 (drop)

### 2.3. Sector-aware valuation
- Map ~60 mã universe → 5-8 ngành chính (dùng VNDirect API `icbCode` hoặc tự map tay)
- Tính P/E, P/B, ROE trung vị + percentile theo ngành
- Thay ngưỡng "P/E < 10 rẻ" bằng "P/E ở percentile 20% của ngành"

### 2.4. Deliverable
- `05_threshold_tuning.ipynb`
- `06_sector_benchmarks.ipynb`
- Update `analysis.js` với ngưỡng/weight mới
- Re-run Giai đoạn 1 Notebook 4 để verify improvement

### 2.5. Success criteria
- Combined score Sharpe cải thiện ít nhất 20% so với version ban đầu
- Hoặc: đơn giản hóa được (bỏ 3+ signal mà vẫn giữ performance)

---

## Giai đoạn 3 — Thêm Feature dựa trên Gap (2-3 tuần)

**CHỈ làm sau khi Giai đoạn 1-2 hoàn thành.** Ưu tiên dựa trên gap từ backtest.

### Candidate features (xếp theo ROI ước tính)

**A. Market context filter (VN-Index regime)**
- **Logic**: không khuyến nghị MUA khi VN-Index trong downtrend rõ (giá dưới MA50 + MACD âm)
- **Expected impact**: giảm max drawdown đáng kể
- **Effort**: 1-2 ngày
- **Làm khi**: backtest cho thấy scoring hit nhiều false signal trong bear market

**B. Multi-timeframe confirmation**
- **Logic**: "MUA MẠNH" chỉ valid khi W + D + 1h cùng chiều tăng
- **Expected impact**: giảm false signal, tăng win rate (nhưng giảm số lượng trade)
- **Effort**: 2-3 ngày
- **Làm khi**: win rate của signal đơn lẻ thấp nhưng khi combine với higher timeframe thì cải thiện

**C. Volume profile (VAP)**
- **Logic**: thay swing-based S/R bằng volume-based. Point of Control (POC) là magnet.
- **Expected impact**: chất lượng vùng giá đề xuất mua tốt hơn
- **Effort**: 3-5 ngày
- **Làm khi**: backtest cho thấy stop-loss dựa trên support hiện tại hay bị hit

**D. Foreign flow sâu hơn**
- Tỷ lệ NN / tổng volume hôm nay
- Room NN còn lại (%sở hữu tối đa)
- Pattern detection: gom rải rác vs xả nhanh
- **Expected impact**: khai thác triệt để signal mạnh nhất của TTCK VN
- **Effort**: 3-5 ngày

**E. Risk metrics**
- Beta vs VN-Index
- Max drawdown 1 năm
- Sharpe ratio
- Position sizing dựa trên ATR (risk 1% NAV)
- **Expected impact**: tool chuyển từ "mua không" → "mua bao nhiêu"
- **Effort**: 2-3 ngày

**F. Price band proximity (VN-specific)**
- Khoảng cách tới trần/sàn (±7% HOSE, ±10% HNX)
- Pattern: liên tiếp chạm trần = pump; chạm sàn = distribution
- **Effort**: 1 ngày

**G. Dividend yield + ex-dividend date**
- DY hiển thị + cảnh báo ngày GDKHQ
- **Effort**: 1 ngày (nếu VNDirect có endpoint)

### Các feature KHÔNG nên làm (overkill / ROI thấp)
- LLM phân tích text (chi phí cao, thêm latency, output khó đo)
- Ichimoku Cloud (redundant với MA)
- Fibonacci tự động (chọn swing sai thì vô dụng)
- News/sentiment thật sự (cần API trả phí hoặc scrape phức tạp)

---

## Giai đoạn 4 — Stock Ranking & Screening (2-3 tuần)

### 4.1. Mục tiêu
Hiện app chỉ phân tích 1 mã do user nhập. Giai đoạn này thêm **bảng xếp hạng tự động** quét toàn bộ universe (~1700 mã VN) và đề xuất các mã đáng chú ý theo **2 mục đích khác nhau**:

1. **T+ trading (3-15 phiên)** — mã có signal kỹ thuật mạnh, momentum tốt, có catalyst
2. **DCA dài hạn (tháng-năm)** — mã chất lượng + định giá hợp lý + thanh khoản tốt

Đây là 2 hệ scoring **hoàn toàn riêng biệt**, vì 1 mã có thể đẹp cho T+ nhưng không đáng DCA, và ngược lại (vd: blue chip đi ngang ổn định hợp DCA nhưng không có sóng cho T+).

### 4.2. T+ Score (cho lướt sóng ngắn hạn)

**Trọng số cao:**
- RSI bounce: vừa từ <30 vọt lên >35 trong 1-2 phiên (signal đáy)
- MACD golden cross trong 5 phiên gần nhất + histogram dương tăng
- Stochastic %K cắt lên %D từ vùng <20
- ADX ≥ 25 + +DI > -DI (trend tăng được xác nhận)
- Volume hôm nay > 1.5x TB20 (catalyst, có dòng tiền vào)
- Foreign flow đảo chiều: 3 phiên liên tiếp NN mua sau chuỗi bán
- Giá vừa break above kháng cự gần nhất trong 5 phiên
- Còn room to run: khoảng cách tới kháng cự kế tiếp ≥ 5%

**Trọng số phụ:**
- Bollinger lower bounce (giá chạm BB dưới rồi quay lên)
- Mfi < 30 đang phục hồi
- Tỷ lệ NN/total volume hôm nay tăng đột biến

**Filter cứng (loại sớm để giảm noise):**
- Thanh khoản TB20 < 5 tỷ/ngày → loại
- Chạm sàn liên tiếp 2 phiên → loại (penny dump)
- Beta > 2.5 → loại (quá biến động, rủi ro lớn cho T+)

### 4.3. DCA Score (cho tích lũy dài hạn)

**Trọng số cao:**
- P/E ở percentile <30 của ngành (rẻ tương đối)
- P/B < 2 (hoặc < trung vị ngành nếu là bank/insurance)
- ROE > 15% và ổn định (đây cần dữ liệu fundamentals lịch sử, có thể skip nếu API thiếu)
- Dividend yield > 4%
- Giá ổn định quanh MA200, max drawdown 1 năm < 30%
- Foreign flow tích cực dài hạn: NN gom net trong 3-6 tháng
- Market cap > 10,000 tỷ (loại penny, chỉ blue/mid cap)
- Thanh khoản TB20 > 20 tỷ/ngày

**Trọng số phụ:**
- Beta < 1.2 (volatility kiểm soát được)
- Tăng trưởng EPS dương qua các quý gần (nếu có data)
- Sector phân bổ: phần thưởng cho mã thuộc ngành defensive (hàng tiêu dùng, tiện ích) — giảm rủi ro DCA

**Filter cứng:**
- Đang downtrend dài hạn (giá < MA200 và MA200 đang giảm) → loại
- Đã tăng > 100% trong 6 tháng qua → loại (quá nóng cho DCA mới)
- Pending corporate event: tách/gộp/phát hành lớn trong 30 ngày → loại

### 4.4. Sector cap & diversification
Top N của mỗi ranking phải có **giới hạn 2-3 mã/ngành** để không over-concentrate (ví dụ tránh tình huống top 10 toàn ngân hàng khi sector banking đang nóng).

### 4.5. UI / UX trong PWA

**Tab mới "🏆 Xếp hạng"** (bên cạnh tab phân tích hiện tại):
- 2 toggle: **T+** | **DCA**
- Bảng top 20-30 mã, mỗi dòng:
  - Mã + tên ngắn
  - Score 0-100 + bar visualization
  - Tags chính (vd "RSI bounce", "Volume surge", "P/E rẻ", "NN gom")
  - Giá hiện tại + % thay đổi 1 ngày / 1 tuần
  - Nút "Phân tích chi tiết" → mở panel hiện tại
- Filter: ngành (multiselect), sàn (HOSE/HNX/UPCOM), market cap range
- Sort: score / volume / change pct
- Auto-refresh trong giờ giao dịch (mỗi 5-10 phút thay vì 60s vì compute nặng hơn)

**Mobile UX:**
- Card layout thay vì table cho dễ đọc
- Pull-to-refresh
- Swipe trái → mở "Phân tích chi tiết"

### 4.6. Implementation

**Compute pipeline:**
1. Universe ~1700 mã quá lớn cho mobile compute → backend pre-compute mỗi 5-10 phút
2. Tận dụng VNDirect endpoints batch:
   - `/v4/stocks` — list toàn bộ mã + sector mapping
   - `/v4/stock_prices?q=date:today` — giá toàn thị trường 1 phiên (1 request)
   - `/v4/foreigns?q=tradingDate:today` — NN flow toàn thị trường 1 phiên
3. Lưu kết quả ranking ở Apps Script (Google Sheet) hoặc Supabase free tier
4. PWA chỉ fetch top N ranking (~50-100 dòng), không compute lại

**Thay thế đơn giản hơn (Phase 4a):**
- Hard-code ranking compute trong client JS, chấp nhận chậm 5-10s lần đầu load
- Cache localStorage 30 phút
- Universe giới hạn còn ~200 mã liquid (loại penny/illiquid sớm)
- Đủ tốt cho personal use, không cần backend

**Lựa chọn:** Bắt đầu với "Phase 4a" (client-side, đơn giản), nếu thực sự cần realtime + universe full thì mới setup backend.

### 4.7. Validation (CRITICAL)

Đây là tính năng bự nhất — **PHẢI backtest** trước khi rilease:

**Backtest T+ ranking:**
- Mỗi ngày trong 5 năm: lấy top 5 mã theo T+ score
- Mua đều (1 unit/mã) khi đóng cửa, hold 5/10/15 phiên, bán
- Đo: avg return per trade, win rate, max drawdown
- Benchmark: random pick 5 mã + buy-and-hold VN-Index
- Mục tiêu: avg return > VN-Index hold 5/10/15 ngày + Sharpe > 0.8

**Backtest DCA ranking:**
- Mỗi tháng trong 5 năm: lấy top 10 mã theo DCA score (tái cân bằng)
- Mua equal weight (10% mỗi mã), hold đến tháng sau, rebalance
- Đo: total return, Sharpe, max drawdown
- Benchmark: DCA VN30 ETF (E1VFVN30) đều
- Mục tiêu: vượt E1VFVN30 hoặc tệ nhất là không thua nhiều với drawdown thấp hơn

**Out-of-sample test bắt buộc:**
- Train + tune trên 2018-2022
- Test ranking trên 2023-2024 (chưa thấy trong tuning)
- Nếu performance giảm > 50% giữa train và test → ranking đang overfit, không dùng được

### 4.8. Rủi ro riêng của ranking feature

- **Selection bias / Goodhart's law:** Khi user theo top ranking đầu tư → mã đó lên tự động → ranking tự xác nhận chính nó (self-fulfilling, nhưng tạm thời). Cần đa dạng user mới có vấn đề này.
- **Universe drift:** Mã mới niêm yết / hủy niêm yết liên tục → cần update universe list định kỳ.
- **Compute cost:** Quét 1700 mã × 8-10 indicators / 5 phút trên mobile là không khả thi → bắt buộc giới hạn universe hoặc move sang backend.
- **Quá nhiều khuyến nghị:** Top 30 T+ mỗi ngày = quá nhiều lựa chọn cho user → có thể chỉ show top 5-10 với confidence cao nhất.

### 4.9. Deliverables Phase 4

1. `notebooks/07_t_plus_ranking.ipynb` — develop + backtest T+ score
2. `notebooks/08_dca_ranking.ipynb` — develop + backtest DCA score
3. `src/ranking.py` — production code cho 2 ranking system
4. `phase4_results.md` — kết quả backtest 2 ranking
5. UI component "Xếp hạng" trong PWA
6. Compute caching (client-side localStorage hoặc Apps Script backend)

---

## Giai đoạn 5 — Continuous Validation (định kỳ)

### 5.1. Monthly re-backtest
- Chạy lại toàn bộ backtest mỗi tháng với data mới nhất
- Detect drift: signal nào trước work giờ không work
- Re-calibrate nếu Sharpe suy giảm > 30%
- Áp dụng cho **cả 3 hệ**: scoring đơn lẻ, T+ ranking, DCA ranking

### 5.2. Paper trading
- Track các lần "MUA MẠNH" được sinh ra trong thực tế (sau Phase 2)
- Track top 5 T+ ranking mỗi ngày + top 10 DCA ranking mỗi tháng (sau Phase 4)
- Log vào Google Sheet hoặc DB: ngày, mã, giá, signal, giá sau 5/10/20 ngày
- So sánh với backtest → xác nhận không có look-ahead bias

### 5.3. Regime change detection
- Thị trường có 3 chế độ: bull / bear / ranging
- Theo dõi VN-Index MA200 + ADX để detect regime shift
- Scoring có thể cần thay đổi theo regime (bull: đánh momentum, bear: chỉ đánh mean reversion)
- T+ ranking đặc biệt nhạy với regime: bear market thì ngừng khuyến nghị T+, chỉ giữ DCA quality

---

## Rủi ro & Giả định

### Rủi ro
- **Backtest overfitting**: tune tham số quá kỹ trên data cũ → hoạt động kém trên tương lai. Giảm thiểu bằng train/test split (train 2018-2022, test 2023-2024).
- **Survivorship bias**: universe không bao gồm mã bị hủy niêm yết → kết quả quá đẹp. Khắc phục: bao gồm cả mã đã từng bị hủy.
- **Data quality**: VNDirect API có thể thiếu/lệch. Cross-check với Cafef/Vietstock nếu cần.
- **Kết quả thất vọng**: scoring có thể thua buy-and-hold → phải thừa nhận, không che giấu.
- **Look-ahead bias trong ranking**: tính score hôm nay dùng data hôm nay (close price) → khi backtest phải xử lý cẩn thận để mua vào ngày T+1, không phải T.
- **Concentration risk trong ranking**: top picks có thể tập trung 1 ngành đang nóng → phải có sector cap.

### Giả định
- Có thể fetch đủ 7 năm data từ VNDirect (họ thường giới hạn 10 năm, nên OK)
- API VNDirect stable (đã dùng trong app mấy tuần không down)
- Trader đủ kỷ luật follow signal (không cherry-pick)

---

## Tiến độ thực thi (đã cập nhật)

### ✅ Phase 1 — Backtest Framework (DONE 2026-04-25)
- [x] Setup Python env (pandas, numpy, matplotlib)
- [x] Folder `backtest/` với src + data + results
- [x] Phase 1.1: data fetch 58 mã × 8 năm (113k OHLCV rows)
- [x] Phase 1.2: 8 indicators ported, verified vs PWA
- [x] Phase 1.3: 21 single signals tested → **RSI<25 winner** (Sharpe 0.68)
- [x] Phase 1.4: combined scoring → **Scenario B+ (underperform B&H)**

**Kết luận Phase 1**: Hệ scoring tổng hợp THUA equal-weight B&H cả universe. Tốt cho risk reduction (max DD -16% vs market -46%) nhưng không sinh alpha.

### ⚠️ Phase 2 — SKIPPED (intentional)
**Decision sau Phase 1.4**: skip vì tinh chỉnh weights không fix được vấn đề căn bản (cash drag — strategy chỉ long 27% thời gian). Thay vì calibrate, đã làm:
- ✅ Reframe label "MUA MẠNH" → "Setup tốt" (neutral framing)
- ✅ RSI<25 weight bumped (+2 → +3)
- ✅ MACD weight dropped (no edge per Phase 1.3)
- ✅ Disclaimer chỉ rõ: dùng tab Top picks DCA cho actual investment

### ✅ Phase 4 — Stock Ranking (DONE 2026-04-26)
- [x] Phase 4 DCA: top-N monthly rebalance backtest → **+285% / 8 năm** (beat EW55)
- [x] Phase 4 UI: tab "Top picks" với DCA/T+ toggle
- [x] Phase 4b T+: validate ranking strategy
- [x] Phase 4b critical fix: threshold bumped 2.0 → 4.0 (2.0 không edge)
- [x] Context cards: click pick → analyze tab show "tại sao DCA" / "tại sao T+"
- [x] Universe management Option C: VN30 actual (Apr 2026) + Extended

### Phase 3 — Features (PARTIAL)
- [x] Phase 3.A — Market regime filter (VN-Index BULL/BEAR/RANGE widget) — Done 2026-04-27
- [ ] Phase 3.B — Multi-timeframe confirmation — skipped (overkill)
- [ ] Phase 3.C — Volume profile (VAP) — skipped (complex, marginal)
- [ ] Phase 3.D — Foreign flow deeper — current implementation đủ tốt
- [ ] Phase 3.E — Risk metrics (beta, position sizing) — chưa làm
- [ ] Phase 3.F — Price band proximity — chưa làm
- [ ] Phase 3.G — Dividend yield + ex-div — chưa làm

### Phase 5 — Continuous Validation (PARTIAL)
- [x] Phase 5.2 — Paper trading tracker (Done 2026-04-27)
- [x] Phase 5.3 — Regime detection (combined với Phase 3.A)
- [ ] Phase 5.1 — Monthly auto re-backtest cron — chưa làm, sẽ làm khi thấy drift

### Bonus phases (không trong plan gốc, đã làm)
- [x] T+ universe expansion: top 120 by market cap (động) — 2026-04-27
- [x] Action card "Hành động đề xuất" per score level — 2026-04-27
- [x] Home dashboard tab adaptive — 2026-04-27
- [x] Universe Option C (CORE_VN30 + EXTENDED tier) — 2026-04-27
- [x] Watchlist personal: ☆ toggle trong Phân tích + section Home + quick-add Top picks — 2026-04-27
- [x] Alert system: detect score crossing → bell + badge + alert panel + browser notification opt-in — 2026-04-27
- [x] T+ universe full HOSE+HNX (~700 mã, skip UPCOM penny) — 2026-04-27
- [x] Supabase Auth Phase A: Google OAuth + login UI + auth.js wrapper — 2026-04-27
- [x] Supabase Phase B: DB sync watchlist + alerts + alert_state + tracker. Migration logic local→DB lần đầu login. Multi-user clear logic (LAST_USER_KEY) — 2026-04-27
- [x] Supabase verified end-to-end: Google OAuth + watchlist write-through + multi-device sync — 2026-04-27
- [x] Migrate hosting Netlify → Cloudflare Workers (Netlify free tier hết quota). URL `stock-pwa.qngnhat.workers.dev`. Unlimited bandwidth + 500 builds/month — 2026-04-27
- [x] Portfolio Phase 1: tab "Danh mục" với transactions (buy/sell), holdings auto-compute (weighted avg, Option A), cash field, summary card, per-holding action recommendation, DB sync — 2026-04-27

### Tiếp theo (nếu cần)
**Verification (priority cao):**
- Forward test 3-6 tháng qua Paper Tracker → verify backtest expectations
- Spot check data accuracy vs TradingView/Cafef

**Polish (priority thấp):**
- Risk metrics card (beta, max DD 1Y, position sizing theo ATR)
- Foreign flow deeper analysis
- Backtest replay mode (pick date in past, see what app would have shown)
- Monthly re-backtest cron khi thấy live performance drift > 50% expected

---

## Metrics đo lường

### Cấp signal
- Win rate (% số trade thắng)
- Average return per trade (%)
- Average hold period
- Sharpe ratio (nếu treat như time series)

### Cấp combined strategy
- Total return vs VN-Index
- Sharpe ratio (annualized)
- Max drawdown
- Calmar ratio (return / max drawdown)
- Number of trades (càng ít càng giảm chi phí giao dịch)

### Cấp ranking (Phase 4)
**T+ ranking metrics:**
- Avg return per trade ở các horizon 5/10/15 phiên
- Win rate top-5 daily picks
- Hit rate signal "MUA" + giá thực sự tăng trong N ngày
- Max drawdown nếu run với risk 1% NAV/trade
- So với random pick + buy-and-hold benchmark

**DCA ranking metrics:**
- Total return của portfolio top-10 rebalance hàng tháng
- Sharpe ratio + max drawdown
- Tracking error vs E1VFVN30 (nếu chỉ baseline beat được ít, vẫn OK miễn drawdown thấp hơn)
- Diversification: HHI sector concentration (≤ 0.25 lý tưởng)

### Benchmark so sánh
1. Buy & hold VN-Index
2. Buy & hold VN30 ETF (E1VFVN30)
3. Buy & hold VN Diamond (FUEVFVND)
4. DCA đều đặn 1tr/tuần vào VN-Index (baseline chiến lược đơn giản nhất)
5. Random pick top 10 mã liquid (cho ranking)

---

## Kết luận

Cách tiếp cận này **tránh cái bẫy phổ biến** của các dự án TA cá nhân: cứ thêm indicator mà không bao giờ kiểm chứng. Chậm hơn trong ngắn hạn nhưng nếu theo đuổi nghiêm túc, kết quả cuối có thể là **tool thực sự dùng được** — chứ không phải đồ chơi đẹp mà hiệu quả không khác gì bấm đại.

Sau toàn bộ roadmap, app sẽ có **3 use cases** rõ ràng phục vụ 3 nhu cầu khác nhau:
1. **Phân tích sâu 1 mã** (Phase 1-3) — khi user đã biết muốn xem mã nào
2. **Xếp hạng mã T+ tốt nhất** (Phase 4) — khi user muốn lướt sóng ngắn hạn
3. **Xếp hạng mã DCA tốt nhất** (Phase 4) — khi user muốn tích lũy dài hạn

Mỗi tính năng phải pass backtest trước khi release.

Nếu kết quả Phase 1 thất bại → vẫn thắng, vì ít nhất tiết kiệm được thời gian build thêm features vô ích.
