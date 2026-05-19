-- Add Premium tier + foreign flow columns to climax_active_picks.
--
-- Backtest 7.4y (run_foreign_flow_combo.py): Tier A + NN net buy 5d > 0
-- gives Sharpe 1.90 vs base 0.36 (5× edge boost). Premium = climax match
-- + foreign net buy positive last 5 sessions.

ALTER TABLE climax_active_picks DROP CONSTRAINT IF EXISTS climax_active_picks_tier_check;
ALTER TABLE climax_active_picks
  ADD CONSTRAINT climax_active_picks_tier_check
  CHECK (tier IN ('A', 'B', 'Elite', 'Momentum', 'Premium'));

ALTER TABLE climax_active_picks
  ADD COLUMN IF NOT EXISTS nn_net_5d_bn NUMERIC,
  ADD COLUMN IF NOT EXISTS is_premium  BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_climax_active_picks_premium
  ON climax_active_picks(is_premium) WHERE is_premium = TRUE;
