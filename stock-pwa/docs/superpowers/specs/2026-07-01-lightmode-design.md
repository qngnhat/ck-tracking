# 2026-07-01 — Lightmode cho Stock PWA

## Context

App hiện tại chỉ có dark mode. Toàn bộ màu **hardcode**: `style.css` 8082 dòng,
80 hex distinct, 943 lần dùng hex, 422 rgba, **0 CSS variable**. Ngoài ra app.js/
index.html còn 138 màu hardcode — phần lớn là config 4 chart lightweight-charts
(vẽ canvas, KHÔNG ăn CSS), số còn lại là inline style động (badge màu theo verdict/
setup/session).

Mục tiêu: thêm lightmode user tự bật/tắt, không phá dark mode hiện tại, không đổi
layout/logic.

## Decisions (đã chốt)

- **Trigger**: nút toggle 🌙/☀️ trong app + lưu localStorage. Không auto theo OS.
- **CSS**: semantic token đầy đủ ở `:root` (dark = default), `body[data-theme="light"]`
  override token. Map ~940 chỗ hex → `var(--token)` theo NGỮ CẢNH selector.
- **Chart**: 1 helper JS đọc token đang hiệu lực (getComputedStyle) → config chart;
  redraw/re-apply khi đổi theme. 1 nguồn màu duy nhất = CSS token.
- **Palette light**: trắng-xám sạch (#fff / #f5f6f8...), text đậm, border xám nhạt,
  accent cyan chỉnh đậm đủ contrast, tăng-xanh/giảm-đỏ chỉnh readable (WCAG AA).

## Approach

### Tầng theme (nguồn sự thật duy nhất)

- `:root` chứa toàn bộ token màu, giá trị = palette DARK hiện tại (nên dark không đổi
  một pixel).
- `body[data-theme="light"] { ... }` override đúng các token đó sang palette light.
- JS: `data-theme` trên `<body>` là state duy nhất. localStorage key `theme_pref`
  ∈ {`"dark"`,`"light"`}, mặc định `"dark"` (giữ hành vi cũ khi chưa từng chọn).

### Bảng token (~22 token, gom từ 80 hex)

Nhóm theo ngữ nghĩa (giá trị dark → light):

| Token | Ý nghĩa | Dark | Light |
|---|---|---|---|
| `--bg` | nền app | #0f0f1e | #f5f6f8 |
| `--bg-deep` | nền sâu hơn (chart, dropdown) | #0a0a14 | #eceef2 |
| `--surface` | card/panel | #1a1a2e | #ffffff |
| `--surface-2` | panel nhấn (header grad, regime) | #16213e | #f0f2f6 |
| `--surface-3` | hover/active nhẹ | #20203a | #e7eaf0 |
| `--border` | viền chính | #2a2a3e | #d8dce4 |
| `--border-dim` | viền mờ | #1f1f2e | #e4e7ee |
| `--text` | text chính | #fff / #e0e0e0 | #1a1d26 |
| `--text-dim` | text phụ | #ccc / #aaa | #4a4f5c |
| `--text-mute` | text mờ (#888 chủ đạo) | #888 | #7a8090 |
| `--text-faint` | rất mờ (#666/#555) | #666 | #9aa0ad |
| `--accent` | cyan thương hiệu | #00d2ff | #0090c0 |
| `--accent-soft` | cyan nhạt (line, icon) | #4dd0e1 | #2bb3d4 |
| `--pos` | tăng/xanh lá | #4caf50 | #14883b |
| `--pos-soft` | xanh nhạt | #81c784 | #43a35f |
| `--neg` | giảm/đỏ | #ff4444 / #ef5350 | #d32f2f |
| `--neg-soft` | đỏ nhạt | #ff8a80 | #e06055 |
| `--warn` | cam cảnh báo | #ff9800 | #c77700 |
| `--warn-soft` | cam nhạt/vàng | #ffb74d / #ffc107 | #d99a2b |
| `--info` | xanh dương | #2196f3 | #1976d2 |
| `--purple` | tím (cloud/setup) | #9c27b0 | #8e24aa |
| `--shadow` | đổ bóng | rgba(0,0,0,.3) | rgba(20,30,60,.10) |

rgba(...) semi-transparent: nếu là biến thể của 1 token (vd `rgba(0,210,255,.1)` =
accent mờ) → đổi sang `rgba(var(--accent-rgb), .1)` bằng cách thêm token `-rgb`
(chỉ cho vài màu cần alpha động: accent, pos, neg, warn). Còn rgba đen/trắng
overlay giữ nguyên hoặc map `--shadow`/`--overlay`.

### Chart theme helper (app.js)

- `getChartTheme()`: đọc `getComputedStyle(document.body)` các token cần cho chart
  (`--bg-deep`→background, `--text-mute`→textColor, `--pos`/`--neg`→candle,
  `--accent`→MA20, `--warn-soft`→MA50, `--neg`→MA200, `--border-dim`→grid...).
  Trả object dùng lại cho cả 4 chart.
- 4 site `createChart` thay literal bằng `getChartTheme()`.
- Khi toggle theme: gọi lại `applyTheme()` → mỗi chart instance còn sống
  (`chartInstance`, `technicalChartInstance`, `vnindexChartInstance`, `hdChartInstance`)
  `.applyOptions({layout,grid})` + series `.applyOptions({color/up/down})`. Instance
  null thì bỏ qua; chart dựng lại lần sau tự đọc theme mới.

### Inline style động (badge verdict/setup/session)

Các chỗ `style="background:${v.color}22"` dùng màu do JS tính — không phải token
theme, nên **giữ nguyên** (chúng là màu ngữ nghĩa của dữ liệu, hợp cả 2 theme trên
nền tương phản). Không đụng. Chỉ token nền/text/border của app mới chuyển.

### Toggle UI

- index.html: thêm nút `<button id="theme-btn" class="theme-btn">` cạnh bell-btn/
  auth-btn trong `.app-header-row`. Icon đổi 🌙↔☀️ theo theme.
- app.js: `initTheme()` chạy khi load — đọc localStorage, set `data-theme`, gắn
  click handler → toggle, lưu, `applyTheme()` (đổi icon + redraw chart).

## Components

- `style.css`:
  - `:root { --bg: #0f0f1e; ... }` — bảng token (dark default).
  - `body[data-theme="light"] { --bg: #f5f6f8; ... }` — override.
  - ~940 hex literal → `var(--token)` theo ngữ cảnh, làm THEO CỤM section
    (header / tab / regime / card / chart-panel / modal / verdict / watchlist / ...),
    mỗi cụm review riêng, KHÔNG sed mù toàn file.
- `index.html`: 1 nút `#theme-btn` trong header.
- `app.js`:
  - `initTheme()` + `applyTheme()` + click handler (thêm vào flow init sẵn có).
  - `getChartTheme()` helper; 4 chart site dùng nó; redraw trong `applyTheme()`.

## Data flow

```
load
  → initTheme(): pref = localStorage.theme_pref ?? "dark"
                 body.dataset.theme = pref; đổi icon nút
user bấm #theme-btn
  → pref = (hiện tại==="light") ? "dark" : "light"
  → body.dataset.theme = pref; localStorage.theme_pref = pref
  → applyTheme(): đổi icon + với mỗi chart instance sống → applyOptions(getChartTheme())
CSS token tự đổi qua body[data-theme] → toàn app repaint (không cần JS đụng DOM khác)
```

## Error handling

- localStorage lỗi (private mode) → try/catch, fallback dark, không crash.
- Chart instance null (tab chưa mở) → skip trong applyTheme; lần dựng sau đọc theme mới.
- Token thiếu / getComputedStyle rỗng → getChartTheme có default dark literal làm fallback.
- Màu lẻ bị sót (còn dark ở light) → chấp nhận vá tiếp; không block. Nhưng mục tiêu
  cụm-review là phủ hết nhóm nền/text/border/accent.

## Testing

- `node -c app.js` pass sau sửa (syntax).
- Grep guard: sau convert, đếm hex literal còn lại trong `style.css` phải giảm mạnh
  và các hex còn lại chỉ nằm trong định nghĩa token `:root` / `[data-theme=light]`
  (hoặc màu ngữ nghĩa cố ý giữ). Ghi lại danh sách hex còn sót để soi.
- Manual (USER làm, env này không có Chrome): bật/tắt theme trên từng tab
  (Portfolio, phân tích mã 3 tab, chart kỹ thuật, watchlist, modal) — kiểm không có
  trắng-trên-trắng / chart lệch nền.

## Scope (YAGNI)

- KHÔNG auto theo OS (chỉ toggle tay).
- KHÔNG đụng inline badge màu-dữ-liệu (verdict/setup/session).
- KHÔNG refactor layout/logic; chỉ tách màu ra token + toggle.
- KHÔNG thêm theme thứ 3 / custom accent.
