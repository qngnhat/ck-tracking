-- Add base_breakout_partial column to scan_state.
-- Worker chunked scan persist 3 pattern types partial trong scan flow:
-- climax_partial, momentum_partial, base_breakout_partial.
-- Trước đây thiếu column này → setScanState fail silently → offset không advance.

ALTER TABLE scan_state
  ADD COLUMN IF NOT EXISTS base_breakout_partial JSONB DEFAULT '[]'::jsonb;
