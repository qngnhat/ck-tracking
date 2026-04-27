# Supabase Setup — Stock PWA

Hướng dẫn 1 lần, mất ~15 phút. Sau khi xong, app sẽ có login + sync data đa thiết bị.

---

## Bước 1: Tạo Supabase project (5 phút)

1. Vào https://supabase.com → **Sign up** (dùng Google account để nhanh)
2. Click **New project**
3. Điền:
   - **Name**: `stock-pwa` (hoặc tên gì tuỳ)
   - **Database password**: tạo + lưu lại (không cần dùng cho app)
   - **Region**: `Southeast Asia (Singapore)` — gần VN nhất
   - **Pricing**: **Free**
4. Click **Create new project** → đợi ~2 phút project khởi tạo

---

## Bước 2: Run SQL schema (3 phút)

1. Trong project, vào **SQL Editor** (icon database/code bên trái)
2. Click **New query**
3. Paste toàn bộ SQL dưới đây vào, rồi click **Run** (hoặc Cmd+Enter):

```sql
-- ════════════════════════════════════════════════════
-- Stock PWA — Schema (run 1 lần)
-- ════════════════════════════════════════════════════

-- 1. Watchlist (mã user theo dõi)
create table if not exists watchlist (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade not null,
  symbol text not null,
  added_at timestamptz default now(),
  unique(user_id, symbol)
);
alter table watchlist enable row level security;
create policy "watchlist_select_own" on watchlist
  for select using (auth.uid() = user_id);
create policy "watchlist_insert_own" on watchlist
  for insert with check (auth.uid() = user_id);
create policy "watchlist_delete_own" on watchlist
  for delete using (auth.uid() = user_id);

-- 2. Tracker snapshots (DCA + T+ history)
create table if not exists tracker_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade not null,
  mode text not null check (mode in ('dca', 'tplus')),
  snapshot_date timestamptz default now(),
  regime text,
  picks jsonb not null
);
alter table tracker_snapshots enable row level security;
create policy "tracker_select_own" on tracker_snapshots
  for select using (auth.uid() = user_id);
create policy "tracker_insert_own" on tracker_snapshots
  for insert with check (auth.uid() = user_id);
create policy "tracker_delete_own" on tracker_snapshots
  for delete using (auth.uid() = user_id);
create index if not exists idx_tracker_user_mode_date
  on tracker_snapshots(user_id, mode, snapshot_date desc);

-- 3. Alerts log (cảnh báo đã xảy ra)
create table if not exists alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade not null,
  symbol text not null,
  type text not null,
  title text not null,
  message text,
  color text,
  seen boolean default false,
  created_at timestamptz default now()
);
alter table alerts enable row level security;
create policy "alerts_select_own" on alerts
  for select using (auth.uid() = user_id);
create policy "alerts_insert_own" on alerts
  for insert with check (auth.uid() = user_id);
create policy "alerts_update_own" on alerts
  for update using (auth.uid() = user_id);
create policy "alerts_delete_own" on alerts
  for delete using (auth.uid() = user_id);
create index if not exists idx_alerts_user_unseen
  on alerts(user_id, seen, created_at desc);

-- 4. Alert state (last seen score per symbol — để detect change)
create table if not exists alert_state (
  user_id uuid references auth.users on delete cascade not null,
  symbol text not null,
  score numeric,
  rsi numeric,
  day_change numeric,
  last_seen_at timestamptz default now(),
  primary key (user_id, symbol)
);
alter table alert_state enable row level security;
create policy "alert_state_all_own" on alert_state
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

Phải thấy thông báo `Success. No rows returned` → OK.

---

## Bước 3: Enable Google OAuth (5 phút)

1. Trong project, vào **Authentication** (icon người bên trái) → **Providers**
2. Tìm **Google** → click **Enable**
3. Cần Google OAuth credentials. 2 cách:

### Cách A: Dùng Google credentials mặc định của Supabase (nhanh nhất)
- Mặc định Supabase đã có Google OAuth shared. **Bật toggle Enable** → OK.
- Test login → sẽ work, redirect URL hiện `*.supabase.co`.

### Cách B: Tạo Google OAuth riêng (chuyên nghiệp, không bắt buộc)
- Bỏ qua nếu mới setup. Có thể làm sau.

4. Trong **URL Configuration** (cùng tab Authentication):
   - **Site URL**: `https://gentle-pothos-70fc88.netlify.app` (URL Netlify của mày)
   - **Redirect URLs**: thêm cả `https://gentle-pothos-70fc88.netlify.app/**` và `http://localhost:8000/**` (cho dev)

---

## Bước 4: Copy URL + anon key (1 phút)

1. Vào **Project Settings** (icon bánh răng) → **API**
2. Copy 2 giá trị:
   - **Project URL**: dạng `https://xxxxxxxx.supabase.co`
   - **anon / public key**: dạng `eyJhbGc...` (rất dài)

3. Mở file [`config.js`](config.js) trong project, paste vào:

```js
window.__SSI_CONFIG__ = {
  SUPABASE_URL: "https://xxxxxxxx.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGc..."
};
```

`anon key` là PUBLIC key — an toàn để hardcode vào client. RLS policies (đã set ở Bước 2) đảm bảo data isolation per user.

⚠️ KHÔNG paste service_role key (key kia, dạng `eyJh...` khác) — nó có quyền admin, không được expose.

---

## Bước 5: Test

1. Reload PWA
2. Bấm nút **Đăng nhập** ở header
3. Login với Google
4. Sau khi quay lại app → header hiện avatar
5. Thử thêm 1 mã vào watchlist → mở app trên thiết bị khác → login → thấy đồng bộ

---

## Troubleshooting

**Login redirect về URL lạ:**
- Check `Site URL` trong Authentication > URL Configuration phải khớp domain Netlify

**"Invalid API key":**
- Copy đúng `anon` key, không phải `service_role`

**Data không sync:**
- Check console log: `Supabase auth error` hoặc `RLS policy violation`
- Verify SQL schema đã chạy thành công (tables có RLS enabled)
