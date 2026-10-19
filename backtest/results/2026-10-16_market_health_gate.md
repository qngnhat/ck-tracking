# Market-health gate — KHÔNG biến thành hard block

Script: `run_market_health_gate.py` · Số thô: `2026-10-16_market_health_gate.txt`
Data: 2018-01-02 → 2026-10-16 (đã refresh), 35 mã `VOL_CLIMAX_UNIVERSE`,
exit classical (SL 8% / TP 3% từ D+3 / max hold 5).

## Kết luận: giữ nguyên dạng banner mềm. Không chặn pick.

`computeMarketHealth` được thêm sau đợt backtest 06/2026 nên chưa qua framework này.
Nó đang chỉ in cảnh báo. Câu hỏi là có nên siết thành chặn hẳn không — **không nên.**

| Tier B, toàn kỳ | n | Win% | Avg | Sharpe |
|---|---|---|---|---|
| baseline (hiện tại) | 85 | 61.2% | +1.41% | 1.34 |
| chặn `weak` | 44 | 61.4% | +1.76% | 1.49 |
| **cohort bị chặn** | **41** | **61.0%** | **+1.03%** | **1.11** |

Cắt 48% số lệnh để đổi lấy +0.35%/lệnh — trong khi **nhóm lệnh bị cắt vẫn đang lãi**
(+1.03%/lệnh, win 61%). Cổng không tách được tốt khỏi xấu, nó chỉ cắt bừa một nửa.

Tier A: baseline +1.08% (n=57) vs chặn `weak` +1.18% (n=28), Sharpe 1.00 → 1.01 — chênh
bằng 0, còn nhóm bị vứt đi thì +0.97%. Chặn hay không chặn là như nhau.

## Vì sao: breadth gần như trùng với chính signal

`weak` chỉ chiếm **14.8%** số phiên, nhưng ôm **48%** signal climax (Tier B 41/85, Tier A 29/57)
— over-represent hơn 3 lần. Hiển nhiên khi nghĩ lại: climax là bắt oversold trong nhịp bán,
nên phiên có signal gần như luôn là phiên breadth xấu. Lọc theo breadth = lọc theo chính
điều kiện đã sinh ra signal.

Giai đoạn 2024-nay chặn `weak` chỉ còn **4/29 lệnh (14%)**. Siết cổng ở thị trường hiện tại
gần như tắt bot.

## Ngưỡng 0.5 / 0.6 là số tuỳ ý

Quét ngưỡng `weak` (Tier B, toàn kỳ): **0.5 và 0.6 cho kết quả y hệt nhau** (n=44, +1.76%),
0.4 lệch 1 lệnh. Vế `VNI < MA50` mới là vế quyết định, breadth gần như không bind trong dải
đó. Chỉnh con số này không có tác dụng gì — đừng tốn thời gian tinh chỉnh.

## Bẫy: "chỉ vào lúc ok" trông rất đẹp — n = 9

Tier B 77.8% win, +4.94%/lệnh. Nhưng **n=9 trên 8.7 năm**, 7 cái nằm ở 2018-2023, 2 cái ở
2024-nay đều lỗ (−6.88%). Đây là data mining, không phải phát hiện.

## Quan trọng hơn cả cái gate: cỡ mẫu quá nhỏ

Baseline Tier B toàn kỳ: n=85, t=1.43, **p=0.154** — không phân biệt được với 0. Mọi tinh
chỉnh trên 85 lệnh là fit noise. Đo tiếp trên universe rộng → `2026-10-16_climax_edge_decay.md`:
pattern CÓ thật ở 2018-2023 (n=1843, p<0.001) và ĐÃ chết từ 2024 (n=705, CI95 chặn trên +0.47%).
