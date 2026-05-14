-- Add 'Elite' tier value to climax_active_picks (Vol Climax + VNI correction regime).
-- Backtest 8.5y: Win 56% → 61%, Avg +0.8% → +2.0%, Sharpe 0.7 → 1.7.

ALTER TABLE climax_active_picks DROP CONSTRAINT IF EXISTS climax_active_picks_tier_check;
ALTER TABLE climax_active_picks
  ADD CONSTRAINT climax_active_picks_tier_check
  CHECK (tier IN ('A', 'B', 'Elite'));
