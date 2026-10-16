# Market-health gate — KHÔNG biến thành hard block

Script: `run_market_health_gate.py` · Output thô: `2026-10-16_market_health_gate.txt`
Dữ liệu: 2018-01-02 → 2026-05-13, 35 mã `VOL_CLIMAX_UNIVERSE`, exit classical (SL 8% / TP 3% từ D+3 / max hold 5).

## Kết luận: giữ nguyên dạng banner mềm. Không chặn pick.

`computeMarketHealth` được thêm sau đợt backtest 06/2026 nên chưa qua framework này.
Nó đang chỉ in cảnh báo. Câu hỏi là có nên siết thành chặn hẳn không — **không nên.**

| Tier B, 8.4y | n | Win% | Avg | Sharpe | PF |
|---|---|---|---|---|---|
| baseline (hiện tại) | 82 | 63.4% | +1.67% | 1.58 | 1.55 |
| chặn `weak` | 43 | 62.8% | +1.90% | 1.60 | 1.58 |
| **cohort bị chặn** | **39** | **64.1%** | **+1.41%** | **1.54** | **1.52** |

Cắt 48% số lệnh để đổi lấy +0.23%/lệnh và +0.02 Sharpe — trong khi **nhóm lệnh bị cắt
vẫn đang lãi** (+1.41%/lệnh, win 64%). Cổng không tách được tốt khỏi xấu.

Tier A còn tệ hơn: chặn `weak` làm avg tụt +1.35% → +1.18%, Sharpe 1.25 → 1.01, còn
nhóm bị vứt đi thì +1.51% / Sharpe 1.53 — tức là **chặn nhầm đúng nhóm tốt hơn**.

## Vì sao: breadth gần như trùng với chính signal

`weak` chỉ chiếm **14.6%** số phiên, nhưng ôm **49%** signal climax (Tier A 27/55, Tier B 39/82)
— over-represent 3.3 lần. Hiển nhiên khi nghĩ lại: climax là bắt oversold trong nhịp bán,
nên phiên có signal gần như luôn là phiên breadth xấu. Lọc theo breadth = lọc theo chính
điều kiện đã sinh ra signal.

Giai đoạn 2024-2026 chặn `weak` chỉ còn **3/26 lệnh (12%)** và lỗ −1.70%/lệnh. Siết cổng
ở thị trường hiện tại gần như tắt bot.

## Ngưỡng 0.5 / 0.6 là số tuỳ ý

Quét ngưỡng `weak` (Tier B, 8.4y): **0.4 / 0.5 / 0.6 cho kết quả y hệt nhau** (n=43, avg +1.90%).
Vế `VNI < MA50` mới là vế quyết định, breadth gần như không bind trong dải đó. Chỉnh con số
này không có tác dụng gì — đừng tốn thời gian tinh chỉnh.

## Bẫy: "chỉ vào lúc ok" trông rất đẹp — n = 8

Tier B 87.5% win, +6.07%/lệnh. Nhưng **n=8 trên 8.4 năm**, 7 cái nằm ở 2018-2023, cái duy
nhất ở 2024-2026 lỗ −9.60%. Đây là data mining, không phải phát hiện.

## Phát hiện phụ quan trọng hơn cả cái gate: signal đang bào mòn

| | 2018-2023 | 2024-2026 |
|---|---|---|
| Tier A baseline | +2.08%/lệnh | +0.25%/lệnh |
| Tier B baseline | +2.27%/lệnh | +0.37%/lệnh |

Khớp với kết quả live (19 lệnh, +0.96%/lệnh). Edge của climax suy giảm rõ rệt ở regime gần
đây, và đó mới là thứ đáng điều tra tiếp — không phải tinh chỉnh cổng health.
