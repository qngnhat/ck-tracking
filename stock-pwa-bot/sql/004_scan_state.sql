-- Multi-stage EOD scan state cho bot worker (Cloudflare free tier 50 subreq/invocation).
-- 1411 mã / 35 per chunk = ~40 chunks × 1 min cron = ~40 min total scan window.
-- Process: init @ 14:50, chunks @ * 8 * * 1-5 (UTC 8:00-8:59 = VN 15:00-15:59),
-- finalize on last chunk.

CREATE TABLE IF NOT EXISTS scan_state (
  id                 TEXT PRIMARY KEY DEFAULT 'main',
  status             TEXT NOT NULL DEFAULT 'idle',  -- idle | in_progress | completed
  scan_date          DATE,
  current_offset     INT NOT NULL DEFAULT 0,
  total_universe     INT NOT NULL DEFAULT 0,
  climax_partial     JSONB DEFAULT '[]'::jsonb,
  momentum_partial   JSONB DEFAULT '[]'::jsonb,
  market_stats       JSONB DEFAULT '{}'::jsonb,
  vni_regime         TEXT,
  vni_ret20          NUMERIC,
  started_at         TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  last_chunk_at      TIMESTAMPTZ,
  error_count        INT NOT NULL DEFAULT 0,
  CONSTRAINT scan_status_chk CHECK (status IN ('idle', 'in_progress', 'completed', 'failed'))
);

-- Idempotent insert seed row
INSERT INTO scan_state (id, status) VALUES ('main', 'idle')
ON CONFLICT (id) DO NOTHING;
