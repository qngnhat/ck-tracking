-- Trade log + peak tracking foundation.
--
-- 1. trade_log: forward-test tracker. Worker cron resolves expired active picks
--    by fetching actual close prices, computes outcome (target/SL/force), stores
--    actual return. UI dashboard so sánh actual vs backtest expectation.
--
-- 2. Peak tracking on climax_active_picks: post-entry running peak để trailing
--    stop concept (backtest Sharpe 1.35 vs target +3% Sharpe 0.67). Portfolio
--    Coach hiển thị peak + drawdown from peak để user manually adjust GTD order.

CREATE TABLE IF NOT EXISTS trade_log (
  id            BIGSERIAL PRIMARY KEY,
  symbol        TEXT NOT NULL,
  signal_date   DATE NOT NULL,
  tier          TEXT NOT NULL,            -- A | B | Elite | Premium | Momentum
  entry_price   NUMERIC NOT NULL,
  target_price  NUMERIC NOT NULL,
  sl_price      NUMERIC NOT NULL,
  nn_net_5d_bn  NUMERIC,                  -- foreign flow at signal
  is_premium    BOOLEAN DEFAULT FALSE,
  -- Outcome (filled by resolveExpiredPicks worker cron after T+5)
  resolved_at   TIMESTAMPTZ,
  exit_price    NUMERIC,
  exit_day      INTEGER,                  -- 3, 4, or 5
  exit_reason   TEXT,                     -- 'target' | 'sl' | 'force' | 'unresolved'
  net_ret       NUMERIC,                  -- (exit - entry)/entry - cost (0.004)
  is_win        BOOLEAN,                  -- net_ret > 0
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(symbol, signal_date)
);

CREATE INDEX IF NOT EXISTS idx_trade_log_signal_date ON trade_log(signal_date DESC);
CREATE INDEX IF NOT EXISTS idx_trade_log_tier ON trade_log(tier);
CREATE INDEX IF NOT EXISTS idx_trade_log_unresolved
  ON trade_log(signal_date) WHERE resolved_at IS NULL;

-- Peak tracking on existing active picks
ALTER TABLE climax_active_picks
  ADD COLUMN IF NOT EXISTS peak_price NUMERIC,
  ADD COLUMN IF NOT EXISTS peak_date  DATE;
