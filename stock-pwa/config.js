// Supabase credentials.
//
// Note: anon key là PUBLIC key (designed to be exposed in client apps).
// RLS policies trên DB đảm bảo data isolation per user → an toàn để commit.
// KHÔNG dùng service_role key (key admin, KHÔNG expose).

window.__SSI_CONFIG__ = {
  SUPABASE_URL: "https://vlmxjsofgixjjjqztfjd.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZsbXhqc29mZ2l4ampqcXp0ZmpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyNTEyODEsImV4cCI6MjA5MjgyNzI4MX0.U7kF-Q90ZQI57_MJWXmzuFNzoFzHntv3QYMCdWz7TCc"
};
