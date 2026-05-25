-- Auto-exit alert tracking on climax_active_picks.
-- Mỗi pick chỉ alert exit 1 lần (dedupe) — sau đó user tự quyết định hold/sell.
-- Reasons: 'sl_hit' (-8% from entry), 'trail_hit' (-6% from peak), 'timeout' (T+10).

ALTER TABLE climax_active_picks
  ADD COLUMN IF NOT EXISTS exit_alerted_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS exit_alert_reason TEXT;

-- Index để cron filter picks chưa alerted nhanh hơn.
CREATE INDEX IF NOT EXISTS idx_climax_active_picks_exit_unalerted
  ON climax_active_picks (exit_alerted_at)
  WHERE exit_alerted_at IS NULL;
