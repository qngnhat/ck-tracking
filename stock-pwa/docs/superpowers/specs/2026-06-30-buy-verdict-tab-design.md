# 2026-06-30 — Tab "Nên mua?" (Buy Verdict) cho màn phân tích mã

## Context

Tab Rà soát (quét cả rổ VN100) đã bị strip và **tạm gác lại**. Hướng mới: thay vì
quét toàn rổ, đào sâu **phân tích từng mã**. Khi user mở 1 mã, ngoài 2 tab sẵn có
("Tổng quan" + "Kỹ thuật"), thêm tab thứ 3 **"Nên mua?"** đánh giá:
chart / giá / volume / khối ngoại (NN) → kết luận xu hướng nghiêng tăng hay giảm,
và **ước lượng biên độ % dự kiến** trong tương lai gần (5/10/20 phiên).

Bài học quan trọng từ code cũ (analysis.js ~line 907): backtest Phase 1.4 cho thấy
combined scoring **underperform** buy-and-hold, nên team đã bỏ nhãn cứng "MUA/BÁN",
đổi sang "Setup". Thiết kế này **tôn trọng bài học đó**: không phán MUA/BÁN dứt khoát,
mà trình bày dưới dạng **xác suất thiên hướng + dải % thống kê + disclaimer**.

## Approach

Toàn bộ dữ liệu cần thiết **đã có sẵn** trong object `r = ANALYSIS.analyze(...)`
(lastAnalysisResult). KHÔNG fetch thêm request nào. Tab "Nên mua?" chỉ là một
**lớp tổng hợp + trình bày** trên dữ liệu đã tính.

Các trường `r` sẽ tiêu thụ:
- Xu hướng/chart: `trendDir`, `ma20/50/200`, `distMA*`, `adx`, `adxStrength`
- Momentum: `rsi`, `macd`, `stoch`, `bbPos`, `posIn52w`
- Volume: `volRatio`, `mfi`
- Khối ngoại: `foreignFlow`, `foreignTrend`
- Vùng giá: `support`, `resistance`, `buyZoneLow/High`, `stopLoss`
- Rủi ro: `flags` (sellPressure, deepDowntrend, bearTrap, lowVol, ...)
- **Dự báo %**: `forwardStats` (forward return median/mean/p25/p75 ở mốc 5/10/20
  phiên, lấy từ các phiên lịch sử có cùng RSI bucket với hôm nay)

### Verdict layer (logic mới, thuần tổng hợp)

Một hàm `computeBuyVerdict(r)` gom 4 trụ thành **điểm thiên hướng 0–100**:

1. **Xu hướng (chart)** — trendDir + vị trí so MA50/MA200 + ADX strength
2. **Động lượng giá** — RSI/Stoch/MACD/BB/vị trí 52w
3. **Dòng tiền (volume + NN)** — volRatio, MFI, foreignTrend
4. **Rủi ro (trừ điểm)** — flags.sellPressure / deepDowntrend / bearTrap / lowVol

Mỗi trụ ra điểm con + danh sách lý do (tái dùng style `reasons` sẵn có). Tổng hợp
thành **"Nghiêng mua N%"** / **"Trung tính"** / **"Nghiêng tránh N%"** — KHÔNG dùng
chữ "MUA/BÁN".

### Dự báo biên độ %

Lấy thẳng từ `r.forwardStats`. Hiển thị: *"Trong quá khứ, khi {mã} ở trạng thái RSI
tương tự ({bucketLabel}), sau 5/10/20 phiên giá thường đi: median X% (dải p25..p75)."*
Kèm số mẫu (n) để user biết độ tin cậy. Nếu `forwardStats == null` (mã mới, <50 nến)
→ ẩn block dự báo, ghi rõ "không đủ dữ liệu lịch sử".

### Trình bày (tab "Nên mua?")

- **Header verdict**: badge thiên hướng (màu theo mức) + 1 câu tóm tắt.
- **Dự báo forward**: bảng 5/10/20 phiên (median + dải + n mẫu).
- **4 trụ**: mỗi trụ 1 dòng điểm + lý do gọn (tái dùng chip style).
- **Vùng hành động**: buy zone / stop-loss / kháng cự gần (đã có trong `r`).
- **Disclaimer**: nhắc đây là thống kê kỹ thuật, không phải khuyến nghị mua/bán;
  forward stats là phân phối lịch sử, không đảm bảo tương lai.

## Components

- `index.html`: thêm 1 nút tab `data-mode="verdict"` + 1 div content
  `#analysis-tab-verdict` (display:none mặc định).
- `app.js`:
  - `getAnalysisTabDefault` / `setAnalysisTab`: thêm `"verdict"` vào danh sách mode.
  - `renderAnalysis(r)`: render verdict tab (lazy — chỉ build khi tab được mở lần đầu,
    theo đúng pattern tab "Kỹ thuật" hiện tại).
  - `computeBuyVerdict(r)`: hàm tổng hợp điểm 4 trụ → {bias, score, pillars[], reasons[]}.
  - `renderVerdictTabContent(r)`: build HTML từ verdict + forwardStats + vùng giá.
- `analysis.js`: **không đổi** (mọi dữ liệu đã có; forwardStats đã tính sẵn).

## Data flow

```
analyzeSymbol(sym)
  → ANALYSIS.analyze() → r (đã có forwardStats, flags, foreignFlow, ...)
  → renderAnalysis(r) lưu lastAnalysisResult = r
  → user bấm tab "Nên mua?"
  → setAnalysisTab("verdict") → lazy build:
       computeBuyVerdict(r) → renderVerdictTabContent(r) → innerHTML
```

## Error handling

- `forwardStats == null` → ẩn block dự báo, hiện ghi chú thiếu dữ liệu.
- `foreignFlow == null` → trụ dòng tiền chỉ dùng volRatio/MFI, ghi "không có dữ liệu NN".
- Mã ETF / thiếu indicator → từng trụ tự bỏ qua component null (giống `analyze` hiện tại).
- Không thêm network call → không có failure mode mạng mới.

## Testing

Manual qua PWA: mở vài mã đại diện —
- mã uptrend mạnh (vd FPT) → kỳ vọng nghiêng mua, forward dương.
- mã downtrend (mã đang giảm) → nghiêng tránh, flags rủi ro hiện.
- mã mới/ít dữ liệu → block dự báo ẩn gọn, không vỡ layout.
Kiểm tra `node -c app.js` pass sau khi sửa.

## Scope (YAGNI)

- KHÔNG khôi phục tab Rà soát / quét VN100 (gác lại).
- KHÔNG thêm scoring backtest mới, KHÔNG fetch thêm.
- KHÔNG phán MUA/BÁN cứng.
- Chỉ là 1 tab tổng hợp dữ liệu đã có + 1 hàm verdict + 1 hàm render.
