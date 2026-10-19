# Vol Climax đã hết edge từ 2024 — đo có đủ power

> **SỬA LẠI sau khi đo exit** (`2026-10-16_exit_vs_entry.md`): chính xác hơn là
> **climax + `CLASSICAL_EXIT` của bot** đã chết. Cùng entry climax đó mà đổi sang
> trailing exit thì 2024-nay ra +1.88%/lệnh (+0.148%/ngày, Sharpe 0.65) thay vì
> −0.78% (−0.247%/ngày). Phần dưới đo với exit hiện tại của bot.

Script: `run_climax_edge_decay.py` · Số thô: `2026-10-16_climax_edge_decay.txt`
Data: refresh tới 2026-10-16. Pattern Tier B, exit classical (SL 8% / TP 3% từ D+3 / max hold 5).

## Vì sao phải mở rộng universe

Đo cổng market-health (`2026-10-16_market_health_gate.md`) xong mới thấy vấn đề thật:
trên 35 mã bot scan, **n = 85 lệnh trong 8.7 năm**. Baseline toàn kỳ t=1.43 p=0.154 —
không phân biệt được với số 0. Ở cỡ mẫu đó mọi việc tinh chỉnh (ngưỡng cổng, tham số exit)
đều là fit noise. Nên chạy lại pattern y nguyên trên universe rộng để có power.

## Kết quả: pattern CÓ thật, và ĐÃ chết

| universe | kỳ | n | Win% | Avg | t | p | CI95 |
|---|---|---|---|---|---|---|---|
| 35 mã bot | 2018-2023 | 56 | 66.1% | +2.27% | +1.82 | 0.069 | [−0.18%, +4.72%] |
| 35 mã bot | 2024-nay | 29 | 51.7% | −0.25% | −0.16 | 0.875 | [−3.36%, +2.87%] |
| TK ≥3tỷ (185 mã) | 2018-2023 | 321 | 59.8% | +1.57% | +2.81 | **0.005** | [+0.47%, +2.66%] |
| TK ≥3tỷ (185 mã) | 2024-nay | 140 | 50.0% | −0.78% | −1.08 | 0.282 | [−2.21%, +0.64%] |
| 655 mã | 2018-2023 | 1843 | 51.8% | +0.95% | **+4.21** | **<0.001** | [+0.51%, +1.40%] |
| 655 mã | 2024-nay | 705 | 48.7% | −0.11% | −0.36 | 0.718 | [−0.68%, +0.47%] |

**2018-2023: edge thật.** n=1843, t=4.21, p<0.001. Không phải data mining.

**2024-nay: edge biến mất, và lần này KHÔNG phải "thiếu dữ liệu để kết luận".**
n=705 đủ để chặn trên: CI95 = [−0.68%, **+0.47%**]. Tức là kể cả ở đầu lạc quan nhất của
khoảng tin cậy, cái còn lại cũng dưới mức chi phí giao dịch. Win rate tụt về đúng 48.7% ≈ coin flip.

Hướng giống nhau ở cả 3 cỡ universe, và cỡ lớn nhất mới là estimate không thiên lệch —
35 mã là bộ chọn tay SAU khi xem kết quả, nên con số +1.41% của nó là selection effect.

## Hệ quả cho bot

1. **Không nâng cấp, không tinh chỉnh cái cổng health.** Vấn đề không nằm ở cổng
   (xem file gate), cũng không nằm ở ngưỡng hay exit. Nằm ở chính pattern.
2. **Kết quả live khớp.** 19 lệnh, +0.96%/lệnh, toàn bộ lãi dồn vào 2 mã — đúng với
   phân phối của một chiến lược có kỳ vọng ~0.
3. Mean-reversion bắt đáy chết từ 2024 → giả thuyết đối nghịch đáng đo là họ
   momentum/trend (`run_strong_leaders*.py`, `run_momentum_*.py` đã có sẵn trong repo,
   chạy lại trên window 2024-nay là biết).
