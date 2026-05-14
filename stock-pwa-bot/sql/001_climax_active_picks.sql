-- Active picks table: lưu các mã match Vol Climax Bounce trong window holding 5 phiên.
-- EOD cron INSERT khi detect match, intraday cron READ để spike-alert.

CREATE TABLE IF NOT EXISTS climax_active_picks (
  symbol            TEXT PRIMARY KEY,
  signal_date       DATE NOT NULL,
  entry_price       NUMERIC NOT NULL,        -- close giá signal day (ref cho threshold)
  target_price      NUMERIC NOT NULL,        -- entry × 1.03 (level alert)
  tier              TEXT NOT NULL CHECK (tier IN ('A', 'B')),
  expires_at        TIMESTAMPTZ NOT NULL,    -- now + ~5 trading days (7 calendar days OK)
  above_threshold   BOOLEAN NOT NULL DEFAULT FALSE,
  last_alert_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_climax_active_picks_expires
  ON climax_active_picks(expires_at);

-- Service role bypass RLS, không cần policy. Nếu sau này expose anon → thêm RLS deny.
