# Lightmode Implementation Plan

> **STATUS 2026-07-01 — DONE.** 8 task hoàn tất, mỗi task review clean.
> Kết quả: 943 hex hardcode → **8 hex literal còn lại** (chỉ cam/salmon/gold đặc thù,
> cố ý giữ vì không có token khớp). Coverage ~99%.
> Tokens thực tế (nhiều hơn plan gốc do phát sinh khi convert): base palette +
> `--chart-ma200, --accent-panel, --surface-deep, --purple-soft, --neutral, --gold, --warn-deep`.
> Light palette đã tune contrast WCAG: text-faint/accent/warn/gold chỉnh đậm đạt ≥3 (UI) — ≥4.3 (body).
> 4 chart canvas đọc token qua getChartTheme(), redraw khi toggle. Toggle 🌙/☀️ + localStorage `theme_pref`.
> **CHƯA làm (việc của user):** mở PWA bật/tắt theme trên từng tab để duyệt layout bằng mắt
> (env không có Chrome — chỉ verify được token/contrast/cú pháp bằng script, không render thật).
> Chi tiết tiến độ: `.superpowers/sdd/progress.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm lightmode user tự bật/tắt cho Stock PWA, không phá dark mode, không đổi layout/logic.

**Architecture:** Đặt toàn bộ màu vào tầng CSS token ở `:root` (giá trị = palette dark hiện tại → dark không đổi). `body[data-theme="light"]` override token sang palette light. JS quản `data-theme` trên `<body>` + localStorage, và 1 helper đọc token để config 4 chart canvas (redraw khi đổi theme).

**Tech Stack:** Vanilla JS PWA (IIFE, no build), CSS custom properties, lightweight-charts.

## Global Constraints

- KHÔNG dùng framework/build step. Sửa trực tiếp `style.css`, `app.js`, `index.html`.
- Dark mode phải giữ NGUYÊN pixel-for-pixel: token `:root` = đúng hex dark hiện tại.
- localStorage key theme: `theme_pref` ∈ {`"dark"`,`"light"`}, default `"dark"`.
- KHÔNG đụng inline style màu-dữ-liệu trong app.js (`style="background:${v.color}..."`) — đó là màu ngữ nghĩa của data, giữ nguyên.
- Mọi thao tác localStorage bọc try/catch, fallback dark.
- Bảng token cố định (dùng chung mọi task) — copy verbatim:

```
:root {
  --bg: #0f0f1e;        --bg-deep: #0a0a14;
  --surface: #1a1a2e;   --surface-2: #16213e;   --surface-3: #20203a;
  --border: #2a2a3e;    --border-dim: #1f1f2e;
  --text: #e0e0e0;      --text-strong: #ffffff;
  --text-dim: #cccccc;  --text-mute: #888888;   --text-faint: #666666;
  --accent: #00d2ff;    --accent-soft: #4dd0e1;
  --pos: #4caf50;       --pos-soft: #81c784;
  --neg: #ff4444;       --neg-soft: #ff8a80;
  --warn: #ff9800;      --warn-soft: #ffb74d;
  --info: #2196f3;      --purple: #9c27b0;
  --accent-rgb: 0,210,255;  --pos-rgb: 76,175,80;
  --neg-rgb: 255,68,68;     --warn-rgb: 255,152,0;
  --shadow: rgba(0,0,0,0.3);
}
body[data-theme="light"] {
  --bg: #f5f6f8;        --bg-deep: #eceef2;
  --surface: #ffffff;   --surface-2: #f0f2f6;   --surface-3: #e7eaf0;
  --border: #d8dce4;    --border-dim: #e4e7ee;
  --text: #1a1d26;      --text-strong: #0d0f16;
  --text-dim: #3a3f4c;  --text-mute: #6a7080;   --text-faint: #9aa0ad;
  --accent: #0090c0;    --accent-soft: #2bb3d4;
  --pos: #14883b;       --pos-soft: #43a35f;
  --neg: #d32f2f;       --neg-soft: #e06055;
  --warn: #c77700;      --warn-soft: #d99a2b;
  --info: #1976d2;      --purple: #8e24aa;
  --accent-rgb: 0,144,192;  --pos-rgb: 20,136,59;
  --neg-rgb: 211,47,47;     --warn-rgb: 217,119,43;
  --shadow: rgba(20,30,60,0.10);
}
```

### Quy tắc map hex → token (dùng cho mọi task convert CSS)

Thay `#hex` literal trong body CSS bằng `var(--token)` theo NGỮ CẢNH property, KHÔNG sed mù:

| Hex nguồn (và họ hàng) | Property điển hình | → token |
|---|---|---|
| #0f0f1e, #14142a, #15152a, #16162a, #1a1a3a | background nền app/deep | `var(--bg)` / `var(--bg-deep)` (chỗ tối nhất) |
| #0a0a14, #000 | nền sâu nhất | `var(--bg-deep)` |
| #1a1a2e | background card/panel | `var(--surface)` |
| #16213e, #0f3460, #1d2a4d, #243660, #1a4a7a | panel nhấn/gradient | `var(--surface-2)` |
| #20203a, #16213e(hover) | hover/active nhẹ | `var(--surface-3)` |
| #2a2a3e, #444, #333 | border chính | `var(--border)` |
| #1f1f2e | border/grid mờ | `var(--border-dim)` |
| #fff, #e0e0e0, #d8d8d8 | color text mạnh | `var(--text-strong)` / `var(--text)` |
| #ccc, #ddd, #d0d0d0, #d5d5d5, #eee, #bbb | text phụ | `var(--text-dim)` |
| #aaa, #888, #999, #aab, #a0a0b0 | text mờ chủ đạo | `var(--text-mute)` |
| #666, #555, #777, #222 | text rất mờ | `var(--text-faint)` |
| #00d2ff, #00bcd4 | accent cyan | `var(--accent)` |
| #4dd0e1, #4fc3f7, #29b6f6, #64b5f6, #81d4fa, #80deea | cyan/blue nhạt | `var(--accent-soft)` |
| #4caf50, #66bb6a, #f44336-xanh? no | xanh tăng | `var(--pos)` |
| #81c784, #a5d6a7 | xanh nhạt | `var(--pos-soft)` |
| #ff4444, #ef5350, #ff5252, #f44336 | đỏ giảm | `var(--neg)` |
| #ff8a80, #ff7777, #ff8a8a, #ff8a65, #ff7043, #ffab91 | đỏ/cam nhạt | `var(--neg-soft)` |
| #ff9800, #ff5722 | cam warn | `var(--warn)` |
| #ffb74d, #ffc107, #ffa726, #ffd700, #ffd180, #fff176, #ffa000? | cam/vàng nhạt | `var(--warn-soft)` |
| #2196f3 | xanh dương info | `var(--info)` |
| #9c27b0, #ce93d8, #ab47bc, #f8bbd0 | tím/hồng | `var(--purple)` |
| #b0bec5, #cdd, #cddc?, #d0d6e2, #d0e0e8, #b8c0d0, #c0c0c0 | xám xanh nhạt (text phụ trên panel) | `var(--text-dim)` |

**rgba() động** (alpha trên màu thương hiệu): `rgba(0,210,255,α)`→`rgba(var(--accent-rgb),α)`; tương tự pos/neg/warn. `rgba(0,0,0,α)` bóng đổ→`var(--shadow)` nếu là box-shadow, else giữ. rgba trắng overlay giữ nguyên.

**Nếu một hex không khớp bảng** (màu ngữ nghĩa hiếm, vd legend dot cố định) → GIỮ nguyên hex, note lại trong task report. Không ép map sai.

**Sau convert mỗi range:** chạy `node -e "..."` guard (xem Task) đảm bảo không phá cú pháp + đếm hex còn lại.

---

### Task 1: Định nghĩa bảng token + toggle UI + theme JS

**Files:**
- Modify: `stock-pwa/style.css` (thêm block `:root` + `body[data-theme=light]` ngay sau reset `*{}`, tức sau dòng ~10)
- Modify: `stock-pwa/index.html` (thêm nút `#theme-btn` trong `.app-header-row`, cạnh `#bell-btn`)
- Modify: `stock-pwa/app.js` (thêm `initTheme`/`applyTheme`/`getChartTheme`; gọi init khi load)

**Interfaces:**
- Produces:
  - CSS token names (bảng trên) — mọi task sau dùng `var(--token)`.
  - `getChartTheme()` → `{ layout:{background:{color},textColor}, grid:{vertLines:{color},horzLines:{color}}, up, down, ma20, ma50, ma200 }` (đọc từ getComputedStyle body; có fallback dark literal).
  - `applyTheme()` → set body dataset, đổi icon nút, redraw 4 chart instance nếu sống.
  - Body attribute `data-theme` = nguồn sự thật.

- [ ] **Step 1: Thêm bảng token vào style.css**

Chèn NGAY SAU block `* { box-sizing... }` (dòng ~10), TRƯỚC `html, body`:
Copy nguyên block `:root {...}` + `body[data-theme="light"] {...}` từ Global Constraints.

- [ ] **Step 2: Sửa `body{}` dùng token**

Trong `body {}` (dòng ~17): `background: #0f0f1e;`→`background: var(--bg);`, `color: #e0e0e0;`→`color: var(--text);`. Thêm `transition: background .2s, color .2s;` để đổi theme mượt.

- [ ] **Step 3: Thêm nút toggle vào index.html**

Trong `.app-header-row`, ngay trước `<button class="bell-btn" id="bell-btn"...>`:
```html
<button class="theme-btn" id="theme-btn" title="Đổi giao diện">🌙</button>
```

- [ ] **Step 4: Style nút toggle (style.css, cuối file)**

```css
.theme-btn {
  background: none; border: none; font-size: 18px;
  padding: 4px 8px; line-height: 1; color: var(--text-mute);
}
.theme-btn:active { opacity: .6; }
```

- [ ] **Step 5: Thêm theme JS vào app.js**

Đặt gần đầu IIFE (sau các hằng key, trước phần chart). Dùng module-level vì các `*Instance` đã ở scope này:
```js
const THEME_KEY = "theme_pref";
function getThemePref() {
  try { return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark"; }
  catch (e) { return "dark"; }
}
function chartCssVar(name, fallback) {
  const v = getComputedStyle(document.body).getPropertyValue(name).trim();
  return v || fallback;
}
function getChartTheme() {
  return {
    layout: {
      background: { color: chartCssVar("--bg-deep", "#0a0a14") },
      textColor: chartCssVar("--text-mute", "#888888"),
    },
    grid: {
      vertLines: { color: chartCssVar("--border-dim", "#1f1f2e") },
      horzLines: { color: chartCssVar("--border-dim", "#1f1f2e") },
    },
    up: chartCssVar("--pos", "#4caf50"),
    down: chartCssVar("--neg", "#ff4444"),
    ma20: chartCssVar("--accent", "#00d2ff"),
    ma50: chartCssVar("--warn-soft", "#ffb74d"),
    ma200: chartCssVar("--neg", "#ef5350"),
    accentSoft: chartCssVar("--accent-soft", "#4dd0e1"),
    border: chartCssVar("--border", "#2a2a3e"),
  };
}
function applyChartTheme() {
  const t = getChartTheme();
  [chartInstance, technicalChartInstance, vnindexChartInstance, hdChartInstance]
    .forEach((c) => {
      if (!c) return;
      try { c.applyOptions({ layout: t.layout, grid: t.grid }); } catch (e) {}
    });
}
function applyTheme() {
  const pref = getThemePref();
  document.body.dataset.theme = pref;
  const btn = document.getElementById("theme-btn");
  if (btn) btn.textContent = pref === "light" ? "☀️" : "🌙";
  applyChartTheme();
}
function initTheme() {
  const btn = document.getElementById("theme-btn");
  if (btn) btn.addEventListener("click", () => {
    const next = getThemePref() === "light" ? "dark" : "light";
    try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
    applyTheme();
  });
  applyTheme();
}
```
Gọi `initTheme();` trong flow init sẵn có (chỗ app bootstrap DOM — tìm nơi các init handler khác được gọi, vd cùng chỗ `initTechnicalTabHandlers` hoặc trong listener load; nếu init chạy inline cuối IIFE thì thêm `initTheme()` cạnh đó).

- [ ] **Step 6: Syntax guard**

Run: `cd /Users/qngnhat/bong/ck_tracking/stock-pwa && node -c app.js && echo OK`
Expected: `OK`

- [ ] **Step 7: Commit**

```bash
cd /Users/qngnhat/bong/ck_tracking
git add stock-pwa/style.css stock-pwa/index.html stock-pwa/app.js
git commit -m "feat(pwa): add theme token layer + light/dark toggle scaffold"
```

---

### Task 2: Chart config đọc token (app.js)

**Files:**
- Modify: `stock-pwa/app.js` — 4 site `createChart` (dòng ~413, ~944, ~5251, ~6173) + series color.

**Interfaces:**
- Consumes: `getChartTheme()` từ Task 1.

- [ ] **Step 1: chartInstance (dòng ~413)**

Thay `layout: { background: { color: "#0f0f1e" }, textColor: "#a0a0b0" }` và grid literal bằng spread từ theme:
```js
const _ct = getChartTheme();
chartInstance = window.LightweightCharts.createChart(container, {
  ...,
  layout: _ct.layout,
  grid: _ct.grid,
  ...
});
```
Candle series `upColor/downColor/borderUpColor/wickUpColor` = `_ct.up`; down = `_ct.down`. MA20 line `color: _ct.ma20`, MA50 `_ct.ma50`.

- [ ] **Step 2: technicalChartInstance (dòng ~944)**

`layout: _ct.layout, grid: _ct.grid` (khai báo `const _ct = getChartTheme();` đầu hàm). Candle up/down = `_ct.up/_ct.down`. MA20=`_ct.ma20`, MA50=`_ct.ma50`, MA200=`_ct.ma200`.

- [ ] **Step 3: vnindexChartInstance (dòng ~5251)**

Giữ `background: transparent` (card có nền riêng) nhưng `textColor: _ct.layout.textColor`. Candle up/down = `_ct.up/_ct.down`.

- [ ] **Step 4: hdChartInstance (dòng ~6173)**

Đọc block layout tại đó, thay background/textColor/grid bằng `_ct`. Candle + MA line tương tự.

- [ ] **Step 5: Syntax guard**

Run: `cd /Users/qngnhat/bong/ck_tracking/stock-pwa && node -c app.js && echo OK`
Expected: `OK`

- [ ] **Step 6: Commit**

```bash
cd /Users/qngnhat/bong/ck_tracking
git add stock-pwa/app.js
git commit -m "feat(pwa): chart configs read theme tokens, redraw on toggle"
```

---

### Task 3: Convert CSS cụm 1 — core UI (dòng 1–1400)

**Files:**
- Modify: `stock-pwa/style.css` dòng ~36–1395 (Header, Tab nav, Regime, Search, Suggestions, Main, Empty, Command palette, VN-Index card, Watches, Pills, Personality, Settings modal, Offline, Analysis sub-tabs).

Áp dụng "Quy tắc map hex → token" (Global Constraints) cho toàn range. KHÔNG đụng block `:root`/`[data-theme=light]` đã thêm ở Task 1.

- [ ] **Step 1: Convert range 36–900**

Thay mọi hex literal trong dòng 36–900 sang `var(--token)` theo bảng. rgba động → `rgba(var(--*-rgb),α)`. box-shadow đen → `var(--shadow)`.

- [ ] **Step 2: Convert range 900–1400**

Tương tự cho 900–1400.

- [ ] **Step 3: Guard — đếm hex còn lại + phạm vi**

Run:
```bash
cd /Users/qngnhat/bong/ck_tracking/stock-pwa
awk 'NR>=36 && NR<=1400' style.css | grep -oiE '#[0-9a-f]{3,8}\b' | sort | uniq -c | sort -rn
```
Expected: chỉ còn hex CỐ Ý GIỮ (màu ngữ nghĩa hiếm). Ghi list vào report. Số lượng phải giảm ~90%+.

- [ ] **Step 4: CSS parse guard**

Run: `cd /Users/qngnhat/bong/ck_tracking/stock-pwa && node -e "const c=require('fs').readFileSync('style.css','utf8');let d=0;for(const ch of c){if(ch==='{')d++;if(ch==='}')d--;}if(d!==0)throw new Error('brace mismatch '+d);console.log('braces OK')"`
Expected: `braces OK`

- [ ] **Step 5: Commit**

```bash
cd /Users/qngnhat/bong/ck_tracking
git add stock-pwa/style.css
git commit -m "refactor(pwa): tokenize core UI colors (header→analysis subtabs)"
```

---

### Task 4: Convert CSS cụm 2 — analysis + ranking (dòng 1395–2830)

**Files:**
- Modify: `stock-pwa/style.css` dòng ~1395–2830 (Analysis Card, Recommendation, Perf pills, Text analysis, Chart, Disclaimer, Loading/Error, Tooltip sheet, Foreign flow, Valuation, DCA blocks, Pick card, Performance dashboard, Regime banner, Warning banner, Daily briefing, Order checklist, Term chip).

Áp dụng quy tắc map. Xử lý giống Task 3.

- [ ] **Step 1: Convert range 1395–2100**
- [ ] **Step 2: Convert range 2100–2830**
- [ ] **Step 3: Guard hex còn lại**

Run: `awk 'NR>=1395 && NR<=2830' style.css | grep -oiE '#[0-9a-f]{3,8}\b' | sort | uniq -c | sort -rn`

- [ ] **Step 4: Brace guard** (lệnh như Task 3 Step 4)
- [ ] **Step 5: Commit**

```bash
git add stock-pwa/style.css
git commit -m "refactor(pwa): tokenize analysis + ranking colors"
```

---

### Task 5: Convert CSS cụm 3 — cards + trackers (dòng 2830–4600)

**Files:**
- Modify: `stock-pwa/style.css` dòng ~2830–4600 (Climax card, Live tracker, Home briefing, các block lớn không tên).

- [ ] **Step 1: Convert range 2830–3750**
- [ ] **Step 2: Convert range 3750–4600**
- [ ] **Step 3: Guard hex còn lại** (`awk 'NR>=2830 && NR<=4600'`)
- [ ] **Step 4: Brace guard**
- [ ] **Step 5: Commit**

```bash
git add stock-pwa/style.css
git commit -m "refactor(pwa): tokenize card + tracker colors"
```

---

### Task 6: Convert CSS cụm 4 — snapshot + portfolio + holding modal (dòng 4600–6660)

**Files:**
- Modify: `stock-pwa/style.css` dòng ~4600–6660 (Aggregate badges, Rich pick row, 2-col grid, Portfolio coach, Drawdown, Sector warning, Watch tier, Holding detail modal).

- [ ] **Step 1: Convert range 4600–5450**
- [ ] **Step 2: Convert range 5450–6660**
- [ ] **Step 3: Guard hex còn lại** (`awk 'NR>=4600 && NR<=6660'`)
- [ ] **Step 4: Brace guard**
- [ ] **Step 5: Commit**

```bash
git add stock-pwa/style.css
git commit -m "refactor(pwa): tokenize snapshot + portfolio + holding modal colors"
```

---

### Task 7: Convert CSS cụm 5 — leaders + AI + verdict (dòng 6660–8082)

**Files:**
- Modify: `stock-pwa/style.css` dòng ~6660–8082 (Strong Leaders card, các block lớn, AI analysis section, Buy Verdict tab + state description).

- [ ] **Step 1: Convert range 6660–7550**
- [ ] **Step 2: Convert range 7550–8082**
- [ ] **Step 3: Guard hex còn lại** (`awk 'NR>=6660 && NR<=8082'`)
- [ ] **Step 4: Brace guard + full-file hex audit**

Run:
```bash
cd /Users/qngnhat/bong/ck_tracking/stock-pwa
echo "hex ngoài block token (dòng >120):"
awk 'NR>120' style.css | grep -oiE '#[0-9a-f]{3,8}\b' | sort | uniq -c | sort -rn | head -40
```
Expected: chỉ còn màu ngữ nghĩa cố ý giữ; tổng giảm mạnh so với 943 ban đầu.

- [ ] **Step 5: Commit**

```bash
git add stock-pwa/style.css
git commit -m "refactor(pwa): tokenize leaders + AI + verdict colors"
```

---

### Task 8: Final review + light palette tinh chỉnh + docs

**Files:**
- Modify: `stock-pwa/style.css` (chỉ block `[data-theme=light]` nếu cần chỉnh contrast).
- Modify: `stock-pwa/docs/superpowers/plans/2026-07-01-lightmode.md` (log tiến độ).

- [ ] **Step 1: Audit hex sót toàn cục**

Run: `cd /Users/qngnhat/bong/ck_tracking/stock-pwa && grep -oiE '#[0-9a-f]{3,8}\b' style.css | sort | uniq -c | sort -rn | wc -l` — so với 80 ban đầu. Các hex còn lại phải nằm trong block token hoặc là màu ngữ nghĩa cố ý (list ra).

- [ ] **Step 2: Kiểm token light không có cặp trắng-trên-trắng**

Rà `[data-theme=light]`: `--text*` phải đậm, `--surface*`/`--bg*` phải sáng, contrast text/nền đạt AA (text chính #1a1d26 trên #fff = ~15:1 OK; text-faint #9aa0ad trên #fff = ~2.6:1 — chỉ dùng cho decor, chấp nhận). Chỉnh token nếu có chỗ chối.

- [ ] **Step 3: Syntax + brace guard toàn bộ**

Run: `node -c app.js && node -e "const c=require('fs').readFileSync('style.css','utf8');let d=0;for(const ch of c){if(ch==='{')d++;if(ch==='}')d--;}console.log('braces',d)"`
Expected: `braces 0`.

- [ ] **Step 4: Cập nhật plan log**

Ghi cuối plan.md: ngày, các hex cố ý giữ, ghi chú "manual visual verify = việc của user (env không có Chrome)".

- [ ] **Step 5: Commit**

```bash
cd /Users/qngnhat/bong/ck_tracking
git add stock-pwa/style.css stock-pwa/docs/superpowers/plans/2026-07-01-lightmode.md
git commit -m "polish(pwa): tune light palette contrast + log lightmode plan"
```

---

## Self-Review notes

- Spec coverage: token layer (T1), chart helper+redraw (T1,T2), toggle UI (T1), convert 940 hex theo cụm (T3–T7), light palette tune (T8). ✓
- Inline badge màu-dữ-liệu: KHÔNG đụng (Global Constraint). ✓
- Type consistency: `getChartTheme`/`applyTheme`/`applyChartTheme`/`initTheme` tên nhất quán T1↔T2. ✓
- Rủi ro chính: convert sai ngữ cảnh 1 hex → sai màu 1 chỗ ở light (dark không đổi vì token=hex cũ). Guard: đếm hex + brace, và user visual verify.
