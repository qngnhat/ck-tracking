-- Add 'Momentum' tier (Strength Continuation pattern, bull/neutral regime).
-- Backtest 8.5y bull: Win 55%, Avg +3.5%, Sharpe 1.04, PF 2.44 (trailing 7% exit).
-- Hold ~20 phiên với trailing stop — khác Climax T+3-5 ngắn hạn.

ALTER TABLE climax_active_picks DROP CONSTRAINT IF EXISTS climax_active_picks_tier_check;
ALTER TABLE climax_active_picks
  ADD CONSTRAINT climax_active_picks_tier_check
  CHECK (tier IN ('A', 'B', 'Elite', 'Momentum'));
