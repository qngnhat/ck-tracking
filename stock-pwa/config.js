// Supabase credentials.
//
// Note: anon key là PUBLIC key (designed to be exposed in client apps).
// RLS policies trên DB đảm bảo data isolation per user → an toàn để commit.
// KHÔNG dùng service_role key (key admin, KHÔNG expose).

window.__SSI_CONFIG__ = {
  SUPABASE_URL: "https://vlmxjsofgixjjjqztfjd.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_S7MxpzfOtEArJeBxjrtjyQ_Dbc7R2yu",
  TELEGRAM_BOT_USERNAME: "stock_pwa_qngnhat_bot"
};
