# Stock PWA Telegram Bot — Setup Guide

Setup mất ~30 phút, làm 1 lần.

## Phần 1: Tạo Telegram bot (5 phút)

1. Mở Telegram, search `@BotFather` → bấm Start
2. Gõ `/newbot` → BotFather hỏi:
   - **Tên bot** (display name): vd `Stock PWA Notifier`
   - **Username** (phải kết thúc `_bot` hoặc `Bot`): vd `stock_pwa_qngnhat_bot`
3. BotFather trả token (vd `7891234567:AAHabcXYZ...`) — **lưu lại**, không share

Optional commands setup (làm cho bot pro hơn):
- `/setdescription` → "Bot báo trigger T+ entry từ Stock PWA"
- `/setcommands`:
  ```
  start - Kết nối với Stock PWA
  status - Xem trạng thái kết nối + watches active
  ```

## Phần 2: Run Supabase schema (3 phút)

1. Vào Supabase project → **SQL Editor** → New query
2. Paste nội dung `/Users/qngnhat/OF1/plans/db_changes/telegram-bot-schema.sql`
3. Click **Run**
4. Verify: 2 tables tạo `user_telegram` + `tplus_watches`

## Phần 3: Lấy Supabase service_role key (2 phút)

1. Trong Supabase project → **Settings** → **API**
2. Section "Project API keys" → tìm `service_role` (secret) → click reveal → copy
3. ⚠️ **Quan trọng**: service_role key bypass RLS, KHÔNG commit vào git, KHÔNG paste public

## Phần 4: Deploy Cloudflare Worker (10 phút)

### 4.1 Cài wrangler CLI (nếu chưa có)

```bash
npm install -g wrangler
wrangler login   # mở browser, login Cloudflare
```

### 4.2 Set worker secrets

```bash
cd /Users/qngnhat/bong/ck_tracking/stock-pwa-bot

# Bot token từ @BotFather
wrangler secret put BOT_TOKEN
# Paste khi hỏi: 7891234567:AAHabcXYZ...

# Supabase URL (có sẵn trong config.js của PWA)
wrangler secret put SUPABASE_URL
# Paste: https://vlmxjsofgixjjjqztfjd.supabase.co

# Supabase service_role key (từ Phần 3)
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
# Paste: eyJhbGc...

# Webhook secret (random string, optional, dùng cho /cron-test endpoint)
wrangler secret put WEBHOOK_SECRET
# Paste: <bất kỳ string ngẫu nhiên, vd UUID>
```

### 4.3 Deploy worker

```bash
wrangler deploy
```

Output sẽ in worker URL, vd: `https://stock-pwa-bot.qngnhat.workers.dev`

### 4.4 Setup Telegram webhook (1 lần)

Replace `<TOKEN>` và `<WORKER_URL>`:

```bash
curl -F "url=https://stock-pwa-bot.qngnhat.workers.dev/webhook" \
     https://api.telegram.org/bot<TOKEN>/setWebhook
```

Verify webhook:

```bash
curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo
```

## Phần 5: Update PWA config (1 phút)

Edit `/Users/qngnhat/bong/ck_tracking/stock-pwa/config.js`:

```js
window.SSI_CONFIG = {
  // ... existing
  TELEGRAM_BOT_USERNAME: "stock_pwa_qngnhat_bot",  // không có @
};
```

Commit + redeploy PWA.

## Phần 6: Test end-to-end (5 phút)

1. **Test webhook**: vào Telegram, bấm bot link, /start (không có token) → bot trả greeting
2. **Test connect**: 
   - Mở PWA, đăng nhập
   - Click avatar → Auth dropdown → "Kết nối Telegram"
   - Browser mở Telegram bot → bấm Start
   - Bot trả "✅ Đã kết nối"
   - Reload PWA → status đổi "Telegram: ✅ @username"
3. **Test trigger**:
   - Vào Top picks T+ → 1 pick → analyze → bấm "🔔 BÁO KHI TRIGGER MET"
   - Watch sync to Supabase (verify trong table editor)
4. **Test cron** (manual):
   ```bash
   curl -X POST "https://stock-pwa-bot.qngnhat.workers.dev/cron-test?secret=<WEBHOOK_SECRET>"
   ```
   Worker log sẽ hiện checking watches.

## Troubleshooting

### Bot không trả lời `/start`
- Check webhook đã set đúng: `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo`
- Check worker log: `wrangler tail`

### Cron không chạy
- Worker free tier giới hạn 1000 cron invocations/day
- Check schedule: `wrangler triggers list`
- Manual trigger via `/cron-test` endpoint (cần secret)

### Trigger met nhưng không nhận message
- Check user đã connect Telegram (table `user_telegram` có row)
- Check watch có sync (table `tplus_watches` có row, `notified=false`)
- Check worker log có lỗi VNDirect API call không

### VNDirect API rate limit
- Cron 24 invocations/ngày × ~58 mã DCA = 1392 calls/day, well below limits
- Nếu hit limit, batching trong worker (đã có sẵn)

## Architecture summary

```
[User PWA] ──watch sync──→ [Supabase tplus_watches]
                                    ↑
                                    │ query
                                    │
[Cloudflare Cron] ──poll VND──→ [Worker check logic]
                                    │
                                    │ trigger met
                                    ↓
                            [Telegram Bot API]
                                    │
                                    ↓
                            [User phone notification]
```

## Cost

- Cloudflare Workers free tier: 100K req/day → đủ thừa
- Cron triggers: free
- Supabase free tier: 500MB DB, 2GB egress → đủ
- Telegram Bot API: free unlimited

Total: $0/month for personal use.

## Security notes

- `SUPABASE_SERVICE_ROLE_KEY` bypass RLS — chỉ dùng trong worker (server-side), KHÔNG expose cho client
- `BOT_TOKEN` lộ = ai cũng send message qua bot → KHÔNG commit, dùng wrangler secret
- `WEBHOOK_SECRET` protect `/cron-test` endpoint khỏi DDoS
- Telegram webhook nên HTTPS only (Cloudflare Workers tự HTTPS)
- `link_token` UUID 1-time, expire 10 phút → safer than passing user_id raw
