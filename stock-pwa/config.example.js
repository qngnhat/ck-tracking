// Copy file này sang config.js (đã trong .gitignore) và paste credentials.
// Hoặc edit trực tiếp config.js nếu đã có.
//
// Lấy credentials ở: Supabase project → Settings → API
// → Project URL + anon/public key.
// (KHÔNG dùng service_role key — đó là key admin, không expose.)

window.__SSI_CONFIG__ = {
  SUPABASE_URL: "https://xxxxxxxx.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGc...",
  // Telegram bot username (không có @, phải kết thúc _bot hoặc Bot)
  // Setup bot: xem stock-pwa-bot/SETUP.md
  TELEGRAM_BOT_USERNAME: "stock_pwa_bot",
};
