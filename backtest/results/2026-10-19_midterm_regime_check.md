# Base Breakout: kiểm tra regime + mức tài khoản (2026-10-19)

Script: `run_midterm_regime_check.py` (reuse `run_midterm_phase1.simulate_trailing`
+ `run_portfolio_slots.simulate_portfolio`). Config đo = đúng hằng số live trong
`worker.js`: `max_hold=30`, `trail=10%`, `init_sl=10%`. Universe = median turnover
60d ≥ 5 tỷ → 164 mã. Data tới 2026-10-16. 634 lần signal nổ toàn kỳ.

## Kết luận ngắn

Khác climax: **Base Breakout không decay.** Dương ở mọi cửa sổ, p ≤ 0.009, và
2024-nay còn **tốt hơn** 2018-2023. Đây là pattern đáng tin nhất của bot hiện nay.

Nhưng con số `+29.8%/năm` trong message là **không đạt được**, vì nó đo với giả định
không giới hạn số lệnh mở cùng lúc. Với 5 slot, 184–234 signal bị bỏ lỡ vì hết slot.

## Per-trade, đúng config live

| cửa sổ | n | Win% | avg | p | hold | Sharpe | PF |
|---|---|---|---|---|---|---|---|
| 2018-2023 out-sample | 355 | 47.0% | +1.59% | 0.009 | 25.0 | +0.44 | 1.49 |
| 2024-nay | 268 | 47.4% | **+3.26%** | 0.000 | 25.6 | +0.70 | 1.98 |
| 2025-nay (cửa sổ bot quảng cáo) | 118 | 48.3% | +5.94% | 0.001 | 23.8 | +1.00 | 2.53 |
| toàn kỳ | 633 | 47.7% | +2.43% | 0.000 | 25.3 | +0.59 | 1.75 |

Win rate ~47-48% ở mọi cửa sổ, **không phải 52%** như message nói. Pattern này thắng
bằng biên độ lãi (PF 1.75–2.53), không bằng tần suất thắng.

So với số bot đang quảng cáo cho cùng cửa sổ 2025-26: Win 51.9%→**48.3%**,
Sharpe 1.13→**1.00**, PF 2.82→**2.53**, avg +6.95%→**+5.94%**. Lệch xuống đều, vì
data giờ dài thêm 5 tháng so với lúc đo lần đầu.

## Mức tài khoản: 5 slot, T+2, cost 0.4%

### 2018-2023
| | Total | CAGR | Vol | Sharpe | MaxDD | %Pos |
|---|---|---|---|---|---|---|
| Base Breakout 5 slot | +100.39% | **+12.40%** | 18.84% | **0.709** | −22.13% | 34.76% |
| VN-Index buy&hold | +13.47% | +2.15% | 20.35% | 0.207 | −45.26% | 56.48% |

124 lệnh thực nhận, Win 51.6%, avg +3.02%, hold 25.9 phiên, **234 signal bỏ lỡ**.

### 2024-nay
| | Total | CAGR | Vol | Sharpe | MaxDD | %Pos |
|---|---|---|---|---|---|---|
| Base Breakout 5 slot | +24.59% | +8.34% | 13.21% | 0.672 | −18.35% | 46.53% |
| VN-Index buy&hold | +50.74% | **+16.09%** | 18.29% | **0.908** | −18.11% | 54.40% |

85 lệnh thực nhận, Win 34.1%, avg +1.81%, hold 24.0 phiên, **184 signal bỏ lỡ**.

### Độ nhạy với luật chọn khi thiếu slot (CAGR)

| cửa sổ | vol_ratio↓ | rsi↑ | ret_3d↑ |
|---|---|---|---|
| 2018-2023 | +12.40% | +11.72% | +11.52% |
| 2024-nay | +8.34% | +6.78% | +13.21% |

**Đây là điểm khác climax quan trọng nhất.** Climax đổi luật chọn thì CAGR đảo dấu
(+1.40% / −1.04% / −1.87%). Base Breakout giữ dương ở cả 6 ô, biên 6.8–13.2%. Nghĩa
là edge nằm ở pattern, không nằm ở việc may mắn chọn đúng lệnh.

## Việc phải sửa trong `worker.js`

1. `+29.8%/năm trên 200M vốn` — số này đến từ `run_midterm_portfolio_100shares.py`,
   docstring của nó ghi rõ *"Unlimited cash, no concurrent position cap"*. Với 5 slot
   thực tế: **+12.4%/năm (2018-23)** và **+8.3%/năm (2024-nay)**. Phải thay.
2. `Win 52%` → **48%**. `Sharpe 1.13` → **1.00**. `PF 2.82` → **2.53**.
3. 2024-nay Base Breakout **thua VN-Index** (CAGR 8.34% vs 16.09%, Sharpe 0.672 vs
   0.908) dù %Pos chỉ 46.5% — tức là nó chỉ nằm trong thị trường nửa thời gian. Giá
   trị vẫn là kiểm soát drawdown ở regime xấu (2018-23: −22% vs −45%), giống kết luận
   climax. Message không nên hứa outperform.

## Ghi chú phương pháp

- `filter_universe()` lọc thanh khoản bằng median turnover từ 2024 trở đi rồi áp cho
  cả giai đoạn trước → có look-ahead nhẹ ở cửa sổ 2018-2023. Giữ nguyên để so sánh
  được với số gốc mà bot đang quảng cáo.
- Per-trade dùng `DEFAULT_COST_RT`, portfolio dùng 0.2%/chiều — lệch nhỏ, không đổi
  kết luận.
