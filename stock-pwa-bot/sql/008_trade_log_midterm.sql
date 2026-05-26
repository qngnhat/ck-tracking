-- Extend trade_log để support mid-term picks (Base Breakout, hold ~30 phiên).
-- Climax trades: target_price + sl_price fix, resolve T+5.
-- Mid-term trades: trailing stop, resolve T+30 trading (~42 calendar).
--
-- Approach: thêm nullable cols + dùng tier='MidTerm' để differentiate.

ALTER TABLE trade_log
  ADD COLUMN IF NOT EXISTS pattern_type  TEXT,
  ADD COLUMN IF NOT EXISTS max_hold_days INTEGER,
  ADD COLUMN IF NOT EXISTS trail_pct     NUMERIC,
  ADD COLUMN IF NOT EXISTS init_sl_pct   NUMERIC;

-- Existing Climax trades: tier in ('A','B','Elite','Premium','Momentum').
-- New Mid-term trades: tier='MidTerm', pattern_type='base_breakout', max_hold=30.
