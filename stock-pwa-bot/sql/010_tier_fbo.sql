-- Add 'FBO' (Foreign-Backed Oversold) tier to climax_active_picks.
--
-- V1 backtest verified (run_foreign_flow_deep.py):
--   Train 2024-25: n=38, Win 63%, avg +1.61%, Sharpe +1.62, PF 1.81
--   Test 2026   : n=14, Win 71%, avg +1.28%, Sharpe +1.42, PF 1.61
--
-- Pattern: drop 3d <-5% + day green + RSI<50 + NN net buy 5d > 0.
-- Hold T+5, target +3%, SL -8% (same Climax config).
-- Smaller sample → flag experimental, monitor real perf.

ALTER TABLE climax_active_picks DROP CONSTRAINT IF EXISTS climax_active_picks_tier_check;
ALTER TABLE climax_active_picks
  ADD CONSTRAINT climax_active_picks_tier_check
  CHECK (tier IN ('A', 'B', 'Elite', 'Momentum', 'Premium', 'FBO'));

-- Add fbo_partial column to scan_state (chunked scan state)
ALTER TABLE scan_state
  ADD COLUMN IF NOT EXISTS fbo_partial JSONB DEFAULT '[]'::jsonb;
