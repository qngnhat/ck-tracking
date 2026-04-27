# ck_tracking — Stock Analyzer cho TTCK Việt Nam

Bộ tools phân tích chứng khoán Việt Nam, gồm:

1. **[stock-pwa/](stock-pwa/)** — Progressive Web App (PWA) chạy trên mobile/desktop. Phân tích kỹ thuật + cơ bản, ranking T+ và DCA, paper trading tracker.
2. **[backtest/](backtest/)** — Python backtest framework để validate logic trước khi ship lên app. Đã chạy nhiều phase, kết quả lưu trong `backtest/results/`.

Chi tiết roadmap + tiến độ: [stock-pwa/plan.md](stock-pwa/plan.md).

---

## stock-pwa — Web app

PWA chạy ở [https://stock-pwa.qngnhat.workers.dev](https://stock-pwa.qngnhat.workers.dev) (deployed via Cloudflare Workers, auto-deploy từ branch `main`).

**Login Google** + sync data đa thiết bị qua Supabase (free tier).

### Tính năng chính

#### 🏠 Trang chủ (default)

Dashboard adaptive — thấy ngay "hôm nay nên làm gì":
- Greeting theo giờ trong ngày (sáng/trưa/chiều/tối)
- Market regime VN-Index (BULL/BEAR/RANGE)
- Việc nên làm hôm nay (đổi theo: cuối tuần / giờ giao dịch / đầu-cuối tháng / regime)
- Top 3 cơ hội T+ + Top 5 DCA (từ cache)
- Tracker performance summary
- Quick search

#### 📊 Phân tích 1 mã

Search mã (autocomplete 1700+ mã VN từ VNDirect API) hoặc click từ Top picks/Home:
- Score tổng hợp 0-14, label "Setup tốt/khá/trung tính/yếu/cảnh báo"
- **Hành động đề xuất** per level — phân biệt "đang giữ mã" vs "chưa giữ"
- Chart candlestick + MA20/MA50, 4 resolution (Tuần/Ngày/1h/1p), auto-refresh trong giờ giao dịch
- 8 chỉ báo kỹ thuật: RSI, MACD, Bollinger, MA20/50/200, ADX, ATR, Stochastic, MFI
- Cơ bản: P/E, P/B, ROE, ROA, EPS, BVPS, Beta
- Khối ngoại: net 5/10/20 phiên + tần suất + room còn lại
- Vùng giá: kháng cự, hỗ trợ, 52w high/low
- Phân tích chi tiết bằng văn (auto-generate ~7-8 câu)
- Tooltip giải thích cho mỗi chỉ báo

#### 🏆 Top picks — Ranking 2 chế độ

**📈 DCA dài hạn** — universe 58 mã (VN30 + Extended diversifier):
- Score từ 6 yếu tố (cross-sectional z-score): MA200 quality, low drawdown, momentum 6m, trend Sharpe, liquidity, foreign flow 60d
- Sector cap max 2 mã/ngành
- Top 5 / 10 / 15 toggle
- Cache 24h, refresh manual
- **Backtest validated**: Top 15 monthly rebalance = +285% / 8 năm vs Equal-Weight 55 +249% (out-of-sample test pass)

**⚡ T+ ngắn hạn** — universe top 120 mã theo market cap (động):
- Score focus mean-reversion: RSI<25/30, BB lower, MFI<20, Stoch oversold cross, volume spike, MACD turn positive, NN reversal
- Threshold ≥ 4.0 (auto bump lên ≥ 5.0 trong bear regime)
- Cache 1h
- **Backtest validated**: setup score≥4 win rate 61%, avg +3.3%/lệnh trên test set 2023-2026

**Click pick** → mở Phân tích chi tiết với **context card** giải thích vì sao đó là DCA pick / T+ setup.

**📊 Lịch sử khuyến nghị (Paper Tracker)**:
- Tự động snapshot DCA picks 1 lần/tháng + T+ picks 1 lần/ngày khi load fresh
- Click "Cập nhật giá" → fetch giá hiện tại, tính return per pick + aggregate
- So sánh thực tế vs backtest expectation

### Dữ liệu

Tất cả từ **VNDirect public API** (miễn phí, ổn định):
- `dchart-api.vndirect.com.vn/dchart/history` — OHLCV (TradingView format)
- `api-finfo.vndirect.com.vn/v4/ratios` — fundamentals snapshot
- `api-finfo.vndirect.com.vn/v4/foreigns` — foreign trading daily
- `api-finfo.vndirect.com.vn/v4/stocks` — danh sách mã listed (cho autocomplete)

### Stack

- **Frontend**: vanilla JS (no framework), CSS Grid, PWA (service worker, manifest)
- **Chart**: [Lightweight Charts](https://www.tradingview.com/lightweight-charts/) của TradingView
- **Hosting**: Cloudflare Workers (auto-deploy từ branch `main`)
- **Auth + DB**: Supabase (Google OAuth + Postgres + Row Level Security)
- **Cache**: localStorage primary (DCA 24h, T+ 1h, regime 1h, universe list 7 ngày), DB write-through cho user data (watchlist, alerts, tracker)

---

## backtest — Python framework

Validate mọi logic trước khi ship lên PWA. Pattern: nếu backtest thất bại → không ship feature đó (eg Phase 2 calibrate scoring đã skip vì backtest cho thấy combined system underperform B&H).

### Setup

```bash
cd backtest
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### Chạy backtest

```bash
# Fetch data 8 năm cho 58 mã
python fetch_all.py

# Phase 1.3 — single signal backtest
python run_phase1_3.py

# Phase 1.4 — combined scoring
python run_phase1_4.py

# Phase 4 — DCA ranking
python run_phase4_dca.py

# Phase 4b — T+ ranking
python run_phase4b_tplus.py
```

Results lưu ở `backtest/results/` (CSV + Markdown reports + PNG equity curves).

### Modules

```
backtest/src/
├── data_fetch.py    # VNDirect API wrappers
├── load_data.py     # Load + merge + compute indicators
├── indicators.py    # 8 chỉ báo kỹ thuật (port từ analysis.js)
├── signals.py       # 21 signal definitions cho Phase 1.3
├── backtest.py      # Trade-level engine + summary stats + baseline
├── scoring.py       # Port scoring system từ analysis.js
├── strategy.py      # Long/flat strategy simulator
├── portfolio.py     # Aggregator + benchmarks + metrics
├── dca_score.py     # DCA factor + z-score + filters
├── tplus_score.py   # T+ score (mean-reversion focus)
├── rebalance.py     # Top-N rebalance engine với sector cap
└── sectors.py       # Sector mapping (CORE_VN30 + EXTENDED)
```

---

## Universe management

**Last reviewed: 2026-04-27** (sau VN30 rebalance Q1).

**CORE 30** = VN30 actual constituents (fetched live):
```bash
curl 'https://api-finfo.vndirect.com.vn/v4/stocks?q=indexCode:VN30&size=50' \
  -H 'User-Agent: Mozilla/5.0' | jq '[.data[].code] | sort'
```

**EXTENDED 28** = mid-cap diversifier theo ngành (manual).

**T+ universe expansion**: top 120 mã theo market cap (động, fetch qua `/v4/ratios?ratioCode=MARKETCAP`).

Update workflow khi VN30 rebalance (mỗi 3 tháng):
1. Run `curl` ở trên để lấy VN30 actual
2. So với `CORE_VN30` trong [stock-pwa/ranking.js](stock-pwa/ranking.js), [backtest/src/sectors.py](backtest/src/sectors.py), [backtest/universe.txt](backtest/universe.txt) — sửa diff
3. Re-run `python fetch_all.py` nếu có mã mới

---

## Verdict & Caveats

**Backtest verdict trên 8 năm data (2018-2026, out-of-sample test 2023-26):**
- ❌ Combined scoring system trong tab Phân tích **THUA** equal-weight buy-and-hold +51% vs +249% (chỉ tốt cho risk reduction, không tạo alpha)
- ✅ DCA Top 15 monthly rebalance **BEAT** baseline: CAGR 17.8% vs 16.4% baseline
- ✅ T+ score ≥ 4.0 có edge: win rate 61%, avg +3.3%/lệnh

**Limitations (đọc trước khi dùng):**
- Backtest dựa trên data lịch sử — quá khứ ≠ tương lai
- Survivorship bias: universe không có mã đã hủy niêm yết
- Sample size moderate: DCA chỉ ~91 rebalance events trong 8 năm
- Cost giả định 0.4% RT — thực tế broker hiện tại 0.15-0.2% buy + 0.1% tax sell
- **Forward test 3-6 tháng** (qua Paper Tracker) là cần thiết để verify

**App này là decision support tool, KHÔNG phải lệnh giao dịch.** Quyết định cuối cùng là của bạn.

---

## License

Personal project. No license, do whatever you want.
