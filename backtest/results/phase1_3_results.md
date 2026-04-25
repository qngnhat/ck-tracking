# Phase 1.3 — Single Signal Backtest Results

## Setup
- **Universe**: 55 mã liquid VN, 8 ngành
- **Period**: 2018-01-02 → 2026-04-24 (~8 năm, ~113k bars)
- **Train**: 2018 → 2022-12-31 (68k rows)
- **Test (out-of-sample)**: 2023-01-01 → nay (45k rows)
- **Hold periods**: 5 / 10 / 20 phiên
- **Cost giả định**: 0.4% round-trip (commission + tax + slippage)
- **Entry rule**: signal ở ngày T → mua giá mở cửa T+1 → bán giá đóng cửa T+1+N

## Top findings

### 1. ✅ RSI mean-reversion là signal mạnh nhất trên test set
**rsi_below_25**, hold 20 ngày:
- Test: **win rate 74.9%, avg return +7.05%, Sharpe 0.675**
- Baseline: 51.6%, +1.08%, Sharpe ~0.1
- **Edge: +5.97% per trade**

Đây là kết quả rõ rệt nhất trong toàn bộ backtest. Khi RSI(14) một mã rớt xuống dưới 25 (rất quá bán), mua giữ 20 ngày → 3 trên 4 lần thắng, lợi nhuận trung bình 7%.

**rsi_below_30** (ngưỡng kinh điển): hold 20 ngày → win rate 66.5%, avg +4.39%, Sharpe 0.444. Vẫn rất tốt nhưng edge thấp hơn ngưỡng 25.

### 2. ⚠️ Regime change rõ rệt giữa Train (2018-22) và Test (2023-26)

**Train top signals** (2018-22): trend-following dominate
1. `adx_trend_up_30`: Sharpe 0.211 (hold 20)
2. `above_ma200`: Sharpe 0.206
3. `adx_trend_up_25`: Sharpe 0.182

**Test top signals** (2023-26): mean-reversion dominate
1. `rsi_below_25`: Sharpe 0.675 (hold 20) ← gấp 3 lần train winner
2. `rsi_below_30`: Sharpe 0.444
3. `rsi_oversold_cross`: Sharpe 0.331
4. `bb_lower_touch`: Sharpe 0.287
5. `mfi_oversold_20`: Sharpe 0.285

→ Thị trường 2018-22 có trend rõ (bull 2020-21, crash 2022) → trend signals work.
→ Thị trường 2023-26 choppy/sideways → mean-reversion bounces work tốt hơn.

**Implication:** Một hệ scoring tĩnh không phù hợp với cả 2 regime. Cần regime detection (Phase 5).

### 3. ❌ MACD signals KHÔNG có edge

| Signal | Train Sharpe (h=20) | Test Sharpe (h=20) |
|---|---|---|
| `macd_golden_cross` | 0.057 | 0.057 |
| `macd_hist_turn_pos` | 0.057 | 0.057 |
| Edge vs baseline | -0.32% | -0.52% |

MACD cross không add value — gần như random entry. Nên drop hoặc giảm trọng số mạnh.

### 4. ⚠️ Foreign flow signals yếu hơn kỳ vọng

| Signal | Test Sharpe (h=20) | Edge |
|---|---|---|
| `nn_buying_6_of_10` | 0.156 | +0.51% |
| `nn_buying_8_of_10` | 0.154 | +0.46% |
| `nn_strong_buy_5b` | 0.116 | +0.15% |
| `nn_buy_after_sell` | 0.088 | -0.18% |

Có edge nhỏ nhưng không nổi bật. Volume lớn (10k+ trades) tạo statistical confidence, nhưng magnitude per-trade thấp. Có thể NN flow hoạt động tốt hơn khi **kết hợp** với signal khác chứ không đứng riêng.

### 5. Hold period càng dài, edge càng rõ
Với hầu hết signals, Sharpe tăng theo hold:
- `rsi_below_25`: 0.424 (h=5) → 0.417 (h=10) → 0.675 (h=20)
- `bb_lower_touch`: 0.175 (h=5) → 0.213 (h=10) → 0.287 (h=20)

→ Cost (0.4%) chiếm tỉ trọng lớn ở hold ngắn. Hold 20 ngày phù hợp cho signal-based strategy.

### 6. Volume spike là noise nhiều hơn signal
- `volume_spike_2x`/`3x`: edge ~0.3-0.6%, không nổi bật
- Có thể work tốt khi combine với direction (vd volume spike + giá tăng)

---

## Bảng đầy đủ — Test set, hold = 20 days (sorted by Sharpe)

| Signal | N | Win% | Avg% | Sharpe | Edge% |
|---|---:|---:|---:|---:|---:|
| **rsi_below_25** | 434 | **74.9** | **7.05** | **0.675** | **+5.97** |
| **rsi_below_30** | 1303 | **66.5** | **4.39** | **0.444** | **+3.31** |
| rsi_oversold_cross | 504 | 61.9 | 3.13 | 0.331 | +2.04 |
| bb_lower_touch | 2218 | 58.6 | 2.84 | 0.287 | +1.76 |
| mfi_oversold_20 | 1154 | 56.9 | 2.91 | 0.285 | +1.83 |
| rsi_bounce | 505 | 60.0 | 2.31 | 0.262 | +1.23 |
| adx_trend_starting | 754 | 56.4 | 2.07 | 0.195 | +0.99 |
| bb_lower_bounce | 1118 | 54.5 | 1.50 | 0.160 | +0.42 |
| nn_buying_6_of_10 | 12240 | 53.2 | 1.59 | 0.156 | +0.51 |
| volume_spike_2x | 2549 | 51.4 | 1.66 | 0.154 | +0.58 |
| nn_buying_8_of_10 | 4132 | 52.4 | 1.54 | 0.154 | +0.46 |
| adx_trend_up_30 | 7670 | 52.5 | 1.68 | 0.148 | +0.60 |
| volume_spike_3x | 544 | 47.1 | 1.42 | 0.128 | +0.34 |
| nn_strong_buy_5b | 10617 | 51.2 | 1.23 | 0.116 | +0.15 |
| adx_trend_up_25 | 11235 | 51.2 | 1.26 | 0.114 | +0.18 |
| nn_buy_after_sell | 8171 | 50.9 | 0.91 | 0.088 | -0.18 |
| stoch_oversold_cross | 1396 | 50.3 | 0.78 | 0.082 | -0.30 |
| above_ma200 | 27383 | 49.6 | 0.78 | 0.080 | -0.30 |
| macd_hist_turn_pos | 1760 | 50.2 | 0.56 | 0.057 | -0.52 |
| macd_golden_cross | 1760 | 50.2 | 0.56 | 0.057 | -0.52 |
| ma_golden_cross | 457 | 51.0 | 0.41 | 0.046 | -0.67 |

---

## Kết luận tạm thời

**Scenario hiện tại: A (beat baseline) — có edge thật, nhưng không như app đang weight**

Một số signal CÓ edge thực sự:
- ✅ **RSI < 25** — strong mean-reversion edge
- ✅ **RSI < 30** — vẫn tốt, ngưỡng nhẹ hơn
- ✅ **BB lower touch + MFI oversold** — confirm thêm cho oversold setup
- ✅ **ADX trend** — có edge trên train, giảm trên test (regime dependent)

Một số signal KHÔNG có edge:
- ❌ **MACD cross** — nên drop hoặc weight = 0
- ❌ **NN flow đứng riêng** — yếu, có thể cần kết hợp
- ❌ **Volume spike** — không thấy edge rõ

**Hệ scoring hiện tại của PWA cần điều chỉnh** (Phase 2):
- Tăng trọng số RSI oversold (+3 thay vì +2)
- Giảm trọng số MACD (xuống 0 hoặc 0.5)
- Trọng số trend (ADX, MA200) giữ nguyên nhưng có điều kiện regime
- NN flow giữ làm yếu tố confirm, không phải primary signal
- Add BB lower touch và MFI oversold làm signal mới

## Tiếp theo (Phase 1.4)
Test combined scoring system hiện tại của PWA — nhóm các signal lại theo logic +1/+2 hiện hành, simulate full strategy "MUA MẠNH → buy, KHÔNG NÊN MUA → sell". So với buy-and-hold VN-Index để biết toàn hệ có work không.

Sau đó sang Phase 2 để re-weight dựa trên kết quả này.
