# Lỗi nằm ở EXIT, không nằm ở entry

Script: `run_exit_vs_entry.py` · Số thô: `2026-10-16_exit_vs_entry.txt`
Universe thanh khoản ≥3tỷ/phiên (185 mã), data tới 2026-10-16, cost 0.4% round-trip.

## Vì sao đo cái này

5 đợt đo ngày 2026-10-16 (climax, strong leaders, momentum ×4) đều lòi ra cùng một dấu
hiệu không liên quan tới entry: **hold ngắn + target +3% thì âm, hold dài + trailing thì
dương**, bất kể pattern là gì. Rõ nhất là cùng một entry HH/HL: exit mean-reversion ra
−0.12% (`run_momentum_extra` P3), exit trailing ra +1.69% (`run_momentum_trailing`).

Nên tách hẳn 2 biến: 3 entry × 2 exit, cùng universe / window / cost.
Exit "BOT" = `CLASSICAL_EXIT` đang chạy prod: SL 8% close, TP 3% từ D+3, max hold 5.

## 2024-nay: đổi exit thì cả 3 entry đảo dấu

| entry | exit | n | Win% | Avg | p | hold | **%/ngày** | Sharpe |
|---|---|---|---|---|---|---|---|---|
| climax Tier B (bot) | **BOT** | 140 | 50.0% | −0.78% | 0.282 | 3.2 | **−0.247%** | −0.81 |
| climax Tier B (bot) | TRAIL | 138 | 52.9% | +1.88% | 0.089 | 12.7 | **+0.148%** | +0.65 |
| HH/HL + uptrend | **BOT** | 1518 | 48.3% | −0.12% | 0.469 | 4.2 | **−0.029%** | −0.14 |
| HH/HL + uptrend | TRAIL | 1499 | 46.0% | +1.69% | **<0.001** | 14.2 | **+0.118%** | +0.53 |
| Strength Continuation | **BOT** | 121 | 49.6% | +0.47% | 0.316 | 4.5 | **+0.106%** | +0.69 |
| Strength Continuation | TRAIL | 121 | 53.7% | +2.76% | **0.007** | 17.7 | **+0.156%** | +0.93 |

TRAIL = SL ban đầu 8%, trailing 10% từ peak, max hold 20.
Cột `%/ngày` là avg chia số phiên giữ — trailing giữ vốn lâu hơn 4x nên avg/lệnh không so
trực tiếp được. **Kể cả sau khi chuẩn hoá theo thời gian giữ vốn, trailing vẫn thắng cả 3/3.**

## 2018-2023: ngược lại — exit của bot ĐÚNG ở regime đó

| entry | exit | Avg | hold | %/ngày | Sharpe |
|---|---|---|---|---|---|
| climax Tier B | **BOT** | +1.57% | 3.4 | **+0.454%** | **+1.34** |
| climax Tier B | TRAIL | +2.60% | 10.7 | +0.243% | +0.85 |

Trên mỗi đồng-ngày vốn, exit nhanh của bot **hơn hẳn** trailing ở 2018-2023 (Sharpe 1.34 vs 0.85).
Câu chuyện nhất quán: hồi đó nhịp hồi dốc và nhanh → chốt +3% là tối ưu. Từ 2024 cú hồi
nhanh không còn trả tiền, chỉ cái đuôi theo trend mới trả.

## Hệ quả: kết luận "climax đã chết" cần sửa lại

Đo trước (`2026-10-16_climax_edge_decay.md`) kết luận climax hết edge từ 2024. Chính xác hơn:
**climax + exit của bot đã chết. Climax + trailing thì chưa** (+1.88%/lệnh, +0.148%/ngày,
Sharpe 0.65 — p=0.089, chưa significant nhưng dương ở cả 2 regime).

`CLASSICAL_EXIT` chặn lãi ở +3% trong khi để lỗ chạy tới −8%: payoff ratio âm, chỉ sống
được nếu win rate rất cao. Win rate thực tế 50%. Khớp luôn với sổ live: 19 lệnh +0.96%/lệnh
nhưng **toàn bộ lãi dồn vào 2 mã** — tiền nằm ở đuôi phải, và exit đang cắt đúng cái đuôi đó.

## Việc đáng làm (chưa làm)

1. Worker **đã có** trailing tier (`initSlPct=10, trailPct=10, maxHold=30`). Thay đổi thật
   sự là **route pick climax sang trailing exit** thay vì `CLASSICAL_EXIT`, không phải sửa detector.
2. Trước khi ship: **sim mức portfolio** (`src/portfolio.py`, `rebalance.py`) với giới hạn
   5 vị thế đồng thời + T+2.5. Hold 20 phiên × 5 slot = số lệnh thực nhận ít hơn nhiều so
   với thống kê per-trade ở trên → per-trade tốt không tự động thành account tốt.
3. Entry tốt nhất ở regime hiện tại là **Strength Continuation + trailing** (Sharpe 0.93,
   p=0.007) — bot đã có `detectStrengthContinuation` sẵn. Nhưng n=121/2.8 năm trên 185 mã.
   Cell đáng tin nhất về cỡ mẫu là HH/HL + trailing (n=1499, p<0.001).

## Giới hạn

Thống kê per-trade, 1 vị thế/lệnh, không mô hình hoá vị thế chồng nhau / sizing / T+2.5.
Universe 185 mã thanh khoản, rộng hơn 35 mã bot đang scan.
