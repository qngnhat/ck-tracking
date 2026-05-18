-- Cron heartbeat: ghi log mỗi lần cron fire, để verify cron có thực sự chạy không.

CREATE TABLE IF NOT EXISTS cron_heartbeat (
  id              BIGSERIAL PRIMARY KEY,
  cron_name       TEXT NOT NULL,          -- 'eod' | 'intraday' | 'manual-digest' | 'manual-spike'
  fired_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  detail          JSONB                    -- {matches, vniRegime, vniRet20, users_sent, ...}
);

CREATE INDEX IF NOT EXISTS idx_cron_heartbeat_fired ON cron_heartbeat(fired_at DESC);

-- Cleanup retention 30 ngày — chạy thủ công nếu cần.
-- DELETE FROM cron_heartbeat WHERE fired_at < NOW() - INTERVAL '30 days';
