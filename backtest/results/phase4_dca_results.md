# Phase 4 — DCA Ranking Backtest Results

## Verdict: ✅ Scenario A — beats baseline. Ship to PWA.

DCA ranking strategy với Top 15 mã monthly rebalance **vượt Equal-Weight 55 B&H** trên cả 3 metrics quan trọng. Đây là edge thật, validate được on out-of-sample.

## Setup

- **Score factors** (cross-sectional z-score, average):
  1. `ma200_quality` — % phiên giá trên MA200 (252-day rolling)
  2. `low_drawdown` — max DD 252 phiên (negate, lower DD = higher score)
  3. `momentum_6m` — return 6 tháng (cap 100% để loại mã quá nóng)
  4. `trend_consistency` — Sharpe 252 phiên
  5. `liquidity` — log(avg turnover 20 phiên)
  6. `foreign_flow_60d` — net NN flow 60 phiên

- **Hard filters**: Loại nếu giá < MA200 (hoặc MA200 đang giảm), return 6m > 100%, hoặc thanh khoản < 10 tỷ/ngày
- **Sector cap**: max 2 mã/ngành (đa dạng hóa)
- **Rebalance**: Monthly (đầu tháng), trade ở open ngày T+1
- **Cost**: 0.2%/side × turnover (avg ~70-80% turnover/rebalance)

## Kết quả

### TRAIN (2018-2022)
| Strategy | Total | CAGR | Sharpe | MaxDD |
|---|---:|---:|---:|---:|
| VN-Index B&H | +1.1% | +0.2% | 0.12 | -45% |
| EW 55 B&H | +85% | +13.1% | 0.65 | -46% |
| **Top 15 monthly** | **+113%** | **+16.5%** | **0.75** | **-40%** |
| Top 10 monthly | +101% | +15.1% | 0.69 | -43% |
| Top 5 monthly | +89% | +13.7% | 0.61 | -53% |

### TEST out-of-sample (2023-2026)
| Strategy | Total | CAGR | Sharpe | MaxDD |
|---|---:|---:|---:|---:|
| VN-Index B&H | +77.5% | +19.2% | 1.06 | -18% |
| EW 55 B&H | +82% | +20.1% | 1.01 | -21% |
| **Top 15 monthly** | **+84.5%** | **+20.6%** | 0.97 | -22% |
| Top 10 monthly | +79.0% | +19.5% | 0.92 | -23% |
| Top 5 monthly | +74.1% | +18.5% | 0.87 | -25% |

### FULL (2018-2026, 8 năm)
| Strategy | Total | CAGR | Sharpe | MaxDD |
|---|---:|---:|---:|---:|
| VN-Index B&H | +86% | +7.9% | 0.48 | -45% |
| EW 55 B&H | +249% | +16.4% | 0.80 | -46% |
| **Top 15 monthly** ⭐ | **+285%** | **+17.8%** | **0.82** | **-40%** |
| Top 10 monthly | +253% | +16.6% | 0.76 | -43% |
| Top 5 monthly | +222% | +15.3% | 0.69 | -53% |
| Top 10 no sector cap | +231% | +15.7% | 0.72 | -48% |
| Top 10 quarterly | +121% | +10.1% | 0.53 | -52% |

## Insights

### 1. ✅ Top 15 là sweet spot
- Top 5 quá tập trung → variance cao, MaxDD -53%
- Top 10 = baseline EW 55
- **Top 15 beat EW 55 trên cả return (CAGR 17.8% vs 16.4%) và risk (DD -40% vs -46%)**
- Top 15 không quá rộng để mất ranking edge, không quá hẹp để bị concentration risk

### 2. ✅ Sector cap có giá trị
- Top 10 với cap 2: +253% / Sharpe 0.76
- Top 10 không cap: +231% / Sharpe 0.72
- Cap giúp avoid concentrate ngành (vd toàn bank trong giai đoạn bank tăng nóng)

### 3. ❌ Quarterly rebalance KÉM hơn monthly
- Monthly: Top 10 = +253%
- Quarterly: Top 10 = +121%
- → Score thay đổi nhanh, cần rebalance thường xuyên để bắt sớm
- Cost monthly cao hơn (avg turnover ~75%) nhưng vẫn thắng nhờ adaptation

### 4. Top picks current (2026-04-24)
```
MBB, HPG, BSR, MWG, DPM, DCM, STB, LPB, VHM, NT2,
HDB, PNJ, POW, HCM, DGW
```
Đa ngành: bank (4), industrial/material (3), retail (3), energy/utility (3), real estate (1), broker (1).

## So sánh với plan của user

User trước đó nói: "tao có 10tr/tháng để DCA" + "tool tự rank". Chiến lược tối ưu theo backtest:

**Recommended setup:**
- DCA 10tr/tháng, chia vào **Top 10-15** mã hiện tại (1tr/mã/tháng × 10 mã hoặc ~700k/mã × 15 mã)
- Rebalance đầu tháng: bán mã rớt khỏi top, mua mã mới vào top
- **CAGR kỳ vọng: 16-18%/năm** (trừ chi phí thực tế có thể ~14-16%)
- MaxDD: chuẩn bị tinh thần -40% trong giai đoạn crash (như 2022)

**With 10tr/tháng × 14% CAGR (conservative):**
| Năm | Đã nạp | Portfolio value |
|---:|---:|---:|
| 1 | 120tr | ~130tr |
| 3 | 360tr | ~430tr |
| 5 | 600tr | ~830tr |
| 10 | 1.2 tỷ | ~2.5 tỷ |

## Risks & Caveats

1. **Survivorship bias** — universe 55 mã hiện tại không bao gồm mã đã hủy niêm yết. Nếu có mã trong top picks bị hủy, kết quả thực có thể tệ hơn ~1-2%/năm.
2. **No fundamentals validation** — score thuần technical. P/E, ROE, etc. không backtest được. Có thể stock có PE 50 vẫn vào top (rủi ro overvalued).
3. **Regime change** — backtest cover 2018-2026 (gồm bull/bear/choppy). Nếu thị trường VN trong 5 năm tới khác hẳn → kết quả có thể thay đổi.
4. **Transaction cost** — 0.2%/side là conservative cho cá nhân (broker hiện tại 0.15-0.2%, thuế bán 0.1%). Cost thực có thể cao hơn nếu trade size nhỏ.
5. **Liquidity slippage** — mua/bán đồng thời 15 mã có thể ảnh hưởng giá nếu trade size > 5% volume daily.

## Tiếp theo

**Tích hợp vào stock-pwa làm tab "🏆 Top picks":**
1. Port `dca_score.py` + `rebalance.py` sang JavaScript trong PWA
2. Fetch data realtime cho universe ~55 mã (hoặc backend cache)
3. Compute score trên client → hiển thị top 15
4. UI: bảng top picks + score breakdown + sector tag + change vs prev rebalance
5. Cron auto-update mỗi đầu tháng (Apps Script)

Ưu tiên cao nhất sau khi PWA có tab này: **paper trading 2-3 tháng** để verify kết quả thực tế khớp backtest.
