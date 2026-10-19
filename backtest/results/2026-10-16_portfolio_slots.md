# Sửa thì sao, không sửa thì sao — đo ở mức tài khoản

Script: `run_portfolio_slots.py` · Số thô: `2026-10-16_portfolio_slots.txt`
5 slot, mỗi lệnh = equity/5 lúc vào, T+2 (không bán trước 2 phiên, tiền bán về sau 2 phiên),
cost 0.4% round-trip. Data tới 2026-10-16.

## 2024-nay (2.8 năm)

| kế hoạch | Total | CAGR | Sharpe | MaxDD | lệnh |
|---|---|---|---|---|---|
| **A. KHÔNG SỬA** (climax + exit bot, 35 mã) | +1.48% | **+0.54%** | 0.13 | −6.5% | 16 |
| **B. chỉ đổi exit** (climax + trail) | +3.88% | **+1.40%** | 0.28 | −6.4% | 13 |
| C. B + mở universe 185 mã | −19.08% | −7.42% | −0.83 | −28.0% | 56 |
| D. C + thêm Strength Continuation | +0.53% | +0.19% | 0.12 | −32.7% | 116 |
| E. HH/HL + trail | +12.70% | +4.45% | 0.32 | −44.8% | 191 |
| **VN-Index buy & hold** | **+50.74%** | **+16.09%** | **0.91** | **−18.1%** | 1 |

## Và lợi thế của B không đứng vững

Nhiều signal hơn slot trống thì phải chọn — kết quả phụ thuộc luật chọn đó. CAGR 2024-nay:

| kế hoạch | vol_ratio↓ | rsi↑ | ret_3d↑ |
|---|---|---|---|
| A. KHÔNG SỬA | +0.54% | +0.12% | −0.77% |
| **B. đổi exit** | **+1.40%** | **−1.04%** | **−1.87%** |
| C | −7.42% | −5.95% | −7.69% |
| D | +0.19% | +1.00% | −0.67% |
| E | +4.45% | −2.35% | −2.46% |

**Per-trade nói đổi exit hơn hẳn; mức tài khoản thì lợi thế đó tan vào nhiễu.** Lý do: A chỉ
nhận 16 lệnh / 2.8 năm, B 13 lệnh — đường vốn do một nhúm lệnh quyết định, nên đổi luật chọn
là đổi dấu. Không có cơ sở để ship B.

## 2018-2023 thì các chiến lược này THẮNG index

| kế hoạch | Total | CAGR | MaxDD |
|---|---|---|---|
| A. KHÔNG SỬA | +19.21% | +3.00% | **−6.8%** |
| B. đổi exit | +25.73% | +3.92% | −15.6% |
| D | +81.13% | +10.50% | −33.4% |
| E | +112.43% | +13.50% | −36.0% |
| VN-Index buy & hold | +13.47% | +2.15% | **−45.3%** |

Và ở đây độ nhạy luật chọn **ổn định** (E: +13.5/+18.3/+17.0%). Tức các pattern này không
phải rác — chúng thắng rõ ở 2018-2023, chủ yếu nhờ **ít drawdown** (A −6.8% vs index −45.3%).

## Kết luận

Trong regime hiện tại, bot với tư cách **công cụ phân bổ vốn** bị chi phối hoàn toàn bởi việc
mua và giữ index: +0.5%/năm vs +16%/năm, mà index còn ít drawdown hơn (−18% vs −28…−45% của
các biến thể nhiều lệnh). Sửa exit **không** cứu được: lợi thế không robust.

Cảnh báo về cách đọc: 2024-nay là **một** mẫu bull mạnh (VNI +50%/2.8 năm). Chiến lược nằm
tiền mặt 95% thời gian thì thua buy&hold trong bull gần như là tất yếu. Giá trị thật của
signal nằm ở chỗ **chặn drawdown**, và điều đó thấy rõ ở 2018-2023 (chứa cú sập 2022).

## Giới hạn

Equal-weight 5 slot, không sizing theo volatility, không chốt từng phần, không trượt giá
ngoài 0.4%. Luật chọn khi thiếu slot chỉ test 3 biến thể. Một thị trường, hai window.
