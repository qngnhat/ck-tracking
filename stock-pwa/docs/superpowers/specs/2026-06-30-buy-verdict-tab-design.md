# 2026-06-30 — Tab "Nên mua?" (Buy Verdict) cho màn phân tích mã

> **CẬP NHẬT 2026-07-01 (PIVOT sau backtest):** Ý tưởng "chấm điểm nên mua + dự báo %"
> đã bị **backtest bác bỏ**. Walk-forward trên 20 mã VN (14k+ phiên):
> - Verdict 4-trụ: bias cao → forward THẤP nhất (đảo ngược, no edge).
> - Pullback-in-uptrend detector: cũng không hơn baseline (+1.07% vs +1.30%).
> - Lọc pullback theo lịch sử từng mã: vẫn ≈ baseline.
> Kết luận: chỉ báo kỹ thuật thuần KHÔNG dự báo được forward return trên data VN
> (khớp ghi chú Phase 1.4 của codebase). → Tab đổi thành **MÔ TẢ trạng thái kỹ thuật
> khách quan** (`describeState`), KHÔNG phán mua/bán, KHÔNG số %. Thống kê lịch sử
> (`computeSetupForwardReturn`) giữ lại làm THAM KHẢO có disclaimer. Phần dưới là thiết
> kế gốc; đọc kèm ghi chú này.

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

**Làm lại từ đầu — không kế thừa backtest cũ.** Verdict tự xây logic mới hoàn toàn.
- GIỮ: chỉ số thô từ `r` (RSI/MA/MACD/ADX/BB/Stoch/MFI/volRatio/foreignFlow/giá/
  support-resistance) — đây là toán thuần, không phải sản phẩm backtest.
- BỎ, KHÔNG dùng: `score`, `reasons`, `recommendation/recLevel/recColor`,
  `forwardStats`, `stockProfile.multipliers`, `buyZoneLow/High` (đều gắn scoring Phase 1.x).
- Dự báo % **tự tính mới**, setup-based (xem dưới), KHÔNG đụng `forwardStats` cũ.

## Approach

Toàn bộ dữ liệu cần thiết **đã có sẵn** trong object `r = ANALYSIS.analyze(...)`
(lastAnalysisResult). KHÔNG fetch thêm request nào. Tab "Nên mua?" chỉ là một
**lớp tổng hợp + trình bày** trên dữ liệu đã tính.

Các trường **thô** của `r` sẽ tiêu thụ (KHÔNG dùng score/reasons/forwardStats cũ):
- Xu hướng/chart: `trendDir`, `ma20/50/200`, `distMA*`, `adx`, `adxStrength`
- Momentum: `rsi`, `macd`, `stoch`, `bbPos`, `posIn52w`
- Volume: `volRatio`, `mfi`
- Khối ngoại: `foreignFlow`, `foreignTrend`
- Vùng giá: `support`, `resistance`, `stopLoss`, `atr`
- Dữ liệu giá thô: `currentData.closes/highs/lows/volumes` (để tự tính forward-return)

Lưu ý: verdict cần cả mảng giá lịch sử (`closes`/`highs`/...) để tự quét setup.
Trong app.js, mảng này có sẵn ở `currentData` (cùng object đã feed cho `analyze`).

### Verdict layer (logic mới, thuần tổng hợp)

Một hàm `computeBuyVerdict(r)` gom 4 trụ thành **điểm thiên hướng 0–100**:

1. **Xu hướng (chart)** — trendDir + vị trí so MA50/MA200 + ADX strength
2. **Động lượng giá** — RSI/Stoch/MACD/BB/vị trí 52w
3. **Dòng tiền (volume + NN)** — volRatio, MFI, foreignTrend
4. **Rủi ro (trừ điểm)** — flags.sellPressure / deepDowntrend / bearTrap / lowVol

Mỗi trụ ra điểm con + danh sách lý do (tái dùng style `reasons` sẵn có). Tổng hợp
thành **"Nghiêng mua N%"** / **"Trung tính"** / **"Nghiêng tránh N%"** — KHÔNG dùng
chữ "MUA/BÁN".

### Dự báo biên độ % — setup-based forward-return (TỰ TÍNH MỚI)

Hàm mới `computeSetupForwardReturn(closes, highs, lows, volumes)`. Logic:

1. **Setup signature hôm nay** = 4 chiều rời rạc hoá:
   - Vị trí so MA50: `above` / `below`
   - RSI bucket: `<30` / `30-45` / `45-55` / `55-70` / `>70`
   - ADX tier: `weak(<20)` / `forming(20-25)` / `strong(>25)`
   - Vol tier (so SMA20 vol): `low(<0.8x)` / `normal` / `high(>1.5x)`
2. **Quét lịch sử** mã (toàn bộ nến trừ 20 phiên cuối — cần forward window):
   tại mỗi phiên i tính signature của nó, đếm số chiều khớp với signature hôm nay.
   Nhận phiên nếu **match ≥ 3/4 chiều**.
3. Với các phiên khớp, đo forward return ở mốc **5/10/20 phiên**:
   `(close[i+k] - close[i]) / close[i] * 100`.
4. Trả về median + p25 + p75 + **n (số mẫu)** cho từng mốc.

**Fallback khi n < 5** (setup quá hiếm): dùng **ATR-projection** —
biên độ `±k·atrPct·√k_phiên`, lệch theo bias verdict; đánh dấu rõ
"ít mẫu lịch sử (n=X), dùng ước lượng biến động (ATR)".

Hiển thị: *"Trong quá khứ, khi {mã} ở setup tương tự (n=N phiên), sau 5/10/20 phiên
giá thường đi: median X% (dải p25..p75)."*
Nếu `closes.length < 50` → ẩn block, ghi "không đủ dữ liệu lịch sử".

### Trình bày (tab "Nên mua?")

- **Header verdict**: badge thiên hướng (màu theo mức) + 1 câu tóm tắt.
- **Dự báo forward**: bảng 5/10/20 phiên (median + dải + n mẫu).
- **4 trụ**: mỗi trụ 1 dòng điểm + lý do gọn (tái dùng chip style).
- **Vùng hành động**: mục tiêu = kháng cự gần / stop = hỗ trợ (đã có trong `r`),
  tính %tới-target và %tới-stop. KHÔNG dùng `buyZoneLow/High` cũ.
- **Disclaimer**: nhắc đây là thống kê kỹ thuật, không phải khuyến nghị mua/bán;
  forward stats là phân phối lịch sử, không đảm bảo tương lai.

## Components

- `index.html`: thêm 1 nút tab `data-mode="verdict"` + 1 div content
  `#analysis-tab-verdict` (display:none mặc định).
- `app.js`:
  - `getAnalysisTabDefault` / `setAnalysisTab`: thêm `"verdict"` vào danh sách mode.
  - `renderAnalysis(r)`: render verdict tab (lazy — chỉ build khi tab được mở lần đầu,
    theo đúng pattern tab "Kỹ thuật" hiện tại).
  - `computeBuyVerdict(r)`: tổng hợp điểm 4 trụ → {bias, score 0-100, pillars[], reasons[]}.
    Logic mới, KHÔNG đọc `r.score/reasons/recommendation`.
  - `computeSetupForwardReturn(closes, highs, lows, volumes)`: dự báo setup-based (mới).
  - `renderVerdictTabContent(r)`: build HTML từ verdict + forward-return + vùng giá.
- `analysis.js`: **không đổi** (chỉ đọc chỉ số thô + mảng giá; không thêm/sửa hàm).

## Data flow

```
analyzeSymbol(sym)
  → ANALYSIS.analyze() → r (đã có forwardStats, flags, foreignFlow, ...)
  → renderAnalysis(r) lưu lastAnalysisResult = r
  → user bấm tab "Nên mua?"
  → setAnalysisTab("verdict") → lazy build:
       computeBuyVerdict(r)
       computeSetupForwardReturn(currentData.closes, highs, lows, volumes)
       → renderVerdictTabContent(r) → innerHTML
```

## Error handling

- `closes.length < 50` → ẩn block dự báo, hiện ghi chú thiếu dữ liệu lịch sử.
- setup match n < 5 → fallback ATR-projection, đánh dấu "ít mẫu".
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
- KHÔNG fetch thêm request.
- KHÔNG kế thừa score/reasons/recommendation/forwardStats/multipliers/buyZone cũ.
- KHÔNG phán MUA/BÁN cứng.
- Tab = đọc chỉ số thô + 1 hàm verdict + 1 hàm forward-return mới + 1 hàm render.
