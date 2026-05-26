-- Mid-term Active Picks (Base Breakout pattern)
-- Backtest verified Phase 1: Test 2025-26 Sharpe +1.13, PF 2.82, avg +6.95%/trade,
-- annualized +29.8%/năm with 10M VND/signal sizing.
--
-- Hold horizon: max 30 trading days (~42 calendar) với trailing stop 10%.
-- Khác climax_active_picks (hold T+5, target +3%) — bảng riêng để clean separation.

CREATE TABLE IF NOT EXISTS mid_term_active_picks (
  symbol               TEXT PRIMARY KEY,
  signal_date          DATE NOT NULL,
  entry_price          NUMERIC NOT NULL,         -- close giá signal day
  pattern_type         TEXT NOT NULL DEFAULT 'base_breakout',

  -- Plan exits
  init_sl_price        NUMERIC NOT NULL,         -- entry × 0.90 (init SL -10%)
  trail_pct            NUMERIC NOT NULL DEFAULT 10,    -- trailing stop % từ peak
  max_hold_days        INT     NOT NULL DEFAULT 30,    -- trading days

  -- Expiry: now + 42 calendar days (~30 trading days)
  expires_at           TIMESTAMPTZ NOT NULL,

  -- Peak tracking (cập nhật mỗi phiên qua updateMidTermPeaks)
  peak_price           NUMERIC,
  peak_date            DATE,

  -- Exit alert dedup
  exit_alerted_at      TIMESTAMPTZ,
  exit_alert_reason    TEXT,                     -- 'sl_hit' | 'trail_hit' | 'timeout'

  -- Spike alert state (informational, optional)
  above_threshold      BOOLEAN NOT NULL DEFAULT FALSE,
  last_alert_at        TIMESTAMPTZ,

  -- Context tại signal day (informational, không drive logic)
  ma200_at_signal      NUMERIC,
  vol_ratio_at_signal  NUMERIC,
  base_range_pct       NUMERIC,                  -- % range 30-day base (low <10%)

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mid_term_active_picks_expires
  ON mid_term_active_picks(expires_at);

CREATE INDEX IF NOT EXISTS idx_mid_term_active_picks_exit_unalerted
  ON mid_term_active_picks(exit_alerted_at)
  WHERE exit_alerted_at IS NULL;
