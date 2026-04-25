# Phase 1.4 — Combined Scoring System Backtest

## Setup
- Port toàn bộ logic scoring từ [stock-pwa/analysis.js](../../stock-pwa/analysis.js) sang Python (vectorized).
- Score range thực tế: **-8 đến +7** trên dữ liệu thật.
- Mapping recommendation:
  - `STRONG_BUY` (≥4): 7,5% bars
  - `BUY` (≥2): 19,5% bars
  - `HOLD` (-1..1): 45,7% bars
  - `AVOID` (-3..-2): 20,6% bars
  - `SELL` (<-3): 6,7% bars
- 3 strategy variants test:
  - `BUY (entry=2, exit=0)` — long từ score≥2, exit khi <0 (hysteresis)
  - `BUY tight (entry=2, exit=2)` — không hysteresis, churn cao
  - `STRONG_BUY only (entry=4, exit=2)` — chỉ chọn signal mạnh nhất
- Cost: 0.4% round-trip
- Aggregation: equal-weight 55 mã, mỗi mã chiếm 1/55 portfolio (cash khi flat)

---

## Kết quả

### TRAIN period (2018-2022)
| Strategy | Total | CAGR | Sharpe | MaxDD | %Pos days |
|---|---:|---:|---:|---:|---:|
| VN-Index B&H | +1.14% | +0.23% | 0.116 | **-45.3%** | 56.0% |
| **Equal-Weight 55 B&H** | **+84.5%** | **+13.1%** | **0.649** | -46.3% | 58.6% |
| BUY (entry=2, exit=0) | +18.0% | +3.4% | 0.459 | **-16.1%** | 55.6% |
| BUY tight | -0.3% | -0.1% | 0.018 | -17.6% | 52.6% |
| STRONG_BUY only | +5.1% | +1.0% | 0.353 | -5.8% | 45.4% |

### TEST period (2023-2026, out-of-sample)
| Strategy | Total | CAGR | Sharpe | MaxDD |
|---|---:|---:|---:|---:|
| VN-Index B&H | +77.5% | +19.2% | **1.060** | -18.1% |
| **Equal-Weight 55 B&H** | **+81.9%** | **+20.1%** | 1.009 | -21.1% |
| BUY (entry=2, exit=0) | +25.2% | +7.1% | 0.942 | **-6.8%** |
| BUY tight | +9.6% | +2.9% | 0.551 | -8.4% |
| STRONG_BUY only | +8.7% | +2.6% | 0.838 | -3.6% |

### FULL PERIOD (2018-2026)
| Strategy | Total | CAGR | Sharpe | MaxDD |
|---|---:|---:|---:|---:|
| VN-Index B&H | +86.1% | +7.9% | 0.479 | -45.3% |
| **Equal-Weight 55 B&H** | **+249.3%** | **+16.4%** | **0.799** | -46.3% |
| BUY (entry=2, exit=0) | +51.4% | +5.2% | 0.680 | **-16.1%** |
| BUY tight | +11.2% | +1.3% | 0.256 | -17.6% |
| STRONG_BUY only | +14.5% | +1.7% | 0.563 | -6.3% |

---

## Verdict: Scenario B+ (huề/dưới baseline, nhưng có lý do)

### ❌ Hệ scoring hiện tại **THUA Equal-Weight 55-stock B&H** rất nhiều
- Best variant (BUY): **+51% trong 8 năm** vs **+249% nếu chỉ buy & hold cả 55 mã**
- Tệ hơn gấp 5 lần về total return
- CAGR 5.2% vs 16.4% — chênh hơn 3x

### ✅ Nhưng có 2 thành tựu phòng vệ
- **Max drawdown -16%** vs B&H **-46%** → hệ scoring thực sự bảo vệ vốn khi thị trường crash (đặc biệt 2022)
- **Sharpe 0.680** ngang B&H 0.799 — risk-adjusted gần ngang
- Phù hợp cho **nhà đầu tư sợ drawdown lớn**

### Tại sao thua nhiều về absolute return?
**Cash drag là vấn đề chính:**
- Trung bình chỉ **18 trên 55 mã** đang long mỗi ngày → 2/3 vốn nằm im trong cash
- Strategy ở trạng thái long khoảng **27%** thời gian
- Trong 73% thời gian còn lại, miss hết upside của thị trường

**Nguyên do sâu hơn:**
- Score ≥ 2 yêu cầu nhiều signal cùng dương → quá khắt khe
- Mean-reversion signals (RSI<25) — winner thực sự từ Phase 1.3 — **chỉ được +2 điểm trong 14 nhóm signal** → diluted bởi các signal khác
- Trend signals (ADX, MA200, MA crossover) — trọng số tương đương — kéo strong-mean-reversion entries về phía HOLD

### Win rate per-trade thấp
- BUY variant: 50.4% win rate, avg ret +0.47% per trade
- Hầu như không có edge trên trade-level
- Nhưng nhờ exit kịp thời ở downturn → equity curve smoother

---

## So sánh strategy variants

| | BUY (e=2,x=0) | BUY tight | STRONG_BUY only |
|---|---|---|---|
| Total ret (full) | +51% | +11% | +15% |
| Max DD | -16% | -18% | **-6%** |
| Sharpe | **0.68** | 0.26 | 0.56 |
| # trades | 5127 | 11133 | 2654 |
| Avg hold (days) | 7.4 | 2.2 | 4.4 |
| Avg trade ret | +0.47% | +0.06% | +0.29% |

**Best variant: BUY entry=2, exit=0 (hysteresis).** Tight (exit=2) bị churn liên tục — 11k trades trong 8 năm = 1400 trades/năm = quá nhiều cost. STRONG_BUY only quá hiếm trigger nên chỉ ~5 mã long/ngày trung bình.

---

## Implication cho Phase 2 (Calibrate)

### Cái phải sửa khẩn cấp
1. **Tăng trọng số mean-reversion signals**
   - RSI < 25: tăng từ +2 lên +4 (Phase 1.3 cho thấy đây là winner duy nhất với edge rõ rệt)
   - BB lower touch: tăng từ +1 lên +2
   - MFI <20: tăng từ +1 lên +2

2. **Giảm trọng số signal không có edge**
   - MACD positive: từ +1 → 0 (drop hẳn — Phase 1.3 cho thấy không add value)
   - Stochastic oversold cross: giảm từ +1 → 0.5
   - 52w position low: giữ nguyên (tương đương mean-reversion)

3. **Lower entry threshold**
   - Nếu vẫn dùng tổng score, có thể giảm entry từ ≥2 xuống ≥1 → tăng số ngày invested
   - Hoặc thay đổi mapping: score ≥ 1 = BUY, ≥ 3 = STRONG_BUY

4. **Regime adaptation**
   - Trong bull market (VN-Index trên MA200, đang tăng): scoring nghiêng về trend-following
   - Trong choppy/bear: scoring nghiêng về mean-reversion
   - Phase 1.3 đã cho thấy 2 regime cần 2 set rules khác nhau

### Câu hỏi mở (cho user quyết định)
> **Mục tiêu của tool là gì?**
> - **A.** Beat thị trường về absolute return → cần redesign scoring lớn (Phase 2 + 3)
> - **B.** Bảo vệ vốn khỏi drawdown lớn (sleep well at night) → hệ hiện tại đã đạt: -16% vs -46% market crash
> - **C.** Vừa beat vừa low-risk → khó nhất, cần regime detection + machine learning
>
> Câu trả lời sẽ define hướng đi Phase 2.

---

## Equity curve charts

3 charts saved tại `results/`:
- `phase1_4_equity_train.png` — 2018-2022
- `phase1_4_equity_test.png` — 2023-2026
- `phase1_4_equity_full.png` — full period

Charts dùng log scale để thấy rõ sự khác biệt CAGR.

---

## Recommendation: Tiếp tục project nhưng theo hướng nào?

Dựa trên kết quả:

**Tao recommend kết hợp:**
1. **Đối với app PWA hiện tại** (decision support): tiếp tục dùng nhưng **giảm kỳ vọng**. App hữu ích để:
   - Phân tích nhanh 1 mã (overview indicators)
   - Cảnh báo "TRÁNH MUA" / "KHÔNG NÊN MUA" khi vào vùng nguy hiểm — đây là điểm mạnh thật sự
   - **KHÔNG dùng "MUA MẠNH" như cơ sở duy nhất để vào lệnh** — hãy combine với đánh giá riêng
2. **Phase 2**: vẫn nên làm — cụ thể là **giảm complexity**. Bỏ MACD, tăng trọng số RSI<25, đơn giản hóa scoring để focus vào 4-5 signal có edge thật.
3. **Phase 4 (ranking T+/DCA)**: vẫn xứng đáng làm vì đó là use case khác — chọn mã trong số nhiều mã, không phải định thời điểm vào/ra.
4. **Realistic baseline**: cho user lựa chọn — DCA 1tr/tuần đều đặn vào E1VFVN30/FUEVFVND có thể là chiến lược tốt nhất cho 95% retail. Tool này hữu ích cho 5% còn lại muốn timing.

---

**Bottom line:** Hệ scoring hiện tại không phải vô dụng (Sharpe 0.68, MaxDD -16% là tốt), nhưng **nó cản trở upside** trong bull market. Phase 2 phải làm cho rõ trade-off "yield vs safety" và để user chọn mode phù hợp với khẩu vị rủi ro.
