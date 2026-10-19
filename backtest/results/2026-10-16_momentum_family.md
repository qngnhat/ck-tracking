# Họ momentum trên regime 2024-nay — 1 sống, 3 chết

Số thô: `2026-10-16_momentum_family.txt` (4 script momentum), `2026-10-16_strong_leaders.txt`.
Universe thanh khoản ≥3tỷ (185 mã) trừ Strong Leaders (655 mã). Data tới 2026-10-16.
Đã sửa 4 script momentum: window cuối hardcode `2026-05-13` → `2026-10-16` (nếu không sửa
thì chúng bỏ qua đúng 5 tháng mới fetch).

## CHẾT

**Momentum Acceleration** (`run_momentum_acceleration`) — 6 biến thể, 2024-nay âm gần hết
(v1 −0.33%, v3 −0.70%, v5 −0.42%), biến thể khá nhất v4 cũng chỉ +0.09%/Sharpe 0.16. Và
đều tệ hơn 2018-2023 → suy giảm, không phải noise.

**MACD cross / 60d-high breakout / vol expansion** (`run_momentum_extra` P1/P2/P4) — âm ở
**cả hai** window. MACD cross 2024-nay −0.65%, win 41.8%. Không phải chết vì regime, mà là
chưa bao giờ sống.

**Strong Leaders** (`run_strong_leaders`, 655 mã, grid 36 biến thể) — best Sharpe = **0.039**,
pass criteria của chính script là >0.3. Tệ hơn: `min_score` 4.0 và 7.0 ra **n gần y hệt nhau**
(2058 vs 2052 ở top=3) → ngưỡng score không bind, top-N quyết định hết. Score hầu như không
có quan hệ đơn điệu với kết quả. So cùng hold 10 phiên, score hơn random +0.51%/lệnh
(n≈6700) — có tín hiệu, nhưng Sharpe ~0 nên không giao dịch được một mình.

## SỐNG

**Strength Continuation** (`run_momentum_relax` — MA5>MA20>MA50>MA200, range<2.5, vol>1.5,
green, RSI 50-70) — gần như là pattern duy nhất **không** suy giảm:

| biến thể | 2018-2023 | 2024-nay |
|---|---|---|
| v1_original | +0.50% · win 58.3% | **+0.81% · win 60.5%** |
| v6 RSI 45-75 | +0.51% · win 59.0% | **+0.83% · win 59.9%** |
| v2 vol>1.2 | +0.69% | +0.63% |

Tần suất thấp (14-34 lệnh/năm). Bot **đã có** `detectStrengthContinuation`.

**HH/HL + trailing exit** (`run_momentum_trailing`) — n lớn nhất trong tất cả:
2024-nay hold 20/trail 10% = +1.69%/lệnh, Sharpe 0.53, PF 1.44, n=1499.

## Điểm chung lộ ra giữa 4 lần chạy

Cùng entry HH/HL: exit mean-reversion (`extra` P3) −0.12% vs exit trailing +1.69%.
Strong Leaders hold 5→10→15 phiên: −0.52% → +0.05% → +0.45%, đơn điệu.
Tức là **biến quyết định là exit/thời gian giữ, không phải entry** → đo riêng ở
`2026-10-16_exit_vs_entry.md`.
