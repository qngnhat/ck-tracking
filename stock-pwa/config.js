// Supabase credentials.
//
// Note: anon key là PUBLIC key (designed to be exposed in client apps).
// RLS policies trên DB đảm bảo data isolation per user → an toàn để commit.
// KHÔNG dùng service_role key (key admin, KHÔNG expose).
//
// Setup:
// 1. Vào Supabase project → Settings → API
// 2. Copy Project URL + anon/public key
// 3. Paste vào dưới đây + commit + push (Netlify auto-deploy)

window.__SSI_CONFIG__ = {
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: ""
};
