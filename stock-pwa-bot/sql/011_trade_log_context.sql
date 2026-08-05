-- Lưu context thị trường + đặc trưng signal tại thời điểm vào lệnh.
--
-- Lý do: trade_log hiện chỉ có giá vào/ra, nên không trả lời được các câu hỏi
-- hiệu suất kiểu "Elite lúc VNI correction ăn hơn lúc bull bao nhiêu?" hay
-- "vào phiên VNI đỏ có tệ hơn phiên xanh không?" — phải replay detector trên
-- OHLCV lịch sử mới ra số, mà replay thì lệch giá điều chỉnh và không tách
-- được Premium (thiếu data NN lịch sử).
--
-- Các cột dưới đây đủ để group-by trực tiếp trên DB sau này.

ALTER TABLE trade_log
  -- Market context tại phiên signal
  ADD COLUMN IF NOT EXISTS vni_regime      TEXT,     -- 'correction' | 'neutral' | 'bull'
  ADD COLUMN IF NOT EXISTS vni_ret20       NUMERIC,  -- % 20 phiên, ngưỡng Elite là < -5
  ADD COLUMN IF NOT EXISTS vni_change_pct  NUMERIC,  -- % VNI phiên signal (xanh/đỏ)
  ADD COLUMN IF NOT EXISTS market_health   TEXT,     -- 'ok' | 'caution' | 'weak'
  ADD COLUMN IF NOT EXISTS breadth_up      INTEGER,
  ADD COLUMN IF NOT EXISTS breadth_down    INTEGER,
  -- Đặc trưng signal (để soi ngưỡng detector nào thực sự có edge)
  ADD COLUMN IF NOT EXISTS ret3d           NUMERIC,
  ADD COLUMN IF NOT EXISTS vol_ratio       NUMERIC,
  ADD COLUMN IF NOT EXISTS rsi             NUMERIC;

-- resolved_at IS NOT NULL + exit_reason='unresolved' = đã bỏ cuộc, không tính
-- vào win rate. Index phục vụ /stats lọc nhanh.
CREATE INDEX IF NOT EXISTS idx_trade_log_resolved
  ON trade_log(signal_date DESC) WHERE resolved_at IS NOT NULL;
