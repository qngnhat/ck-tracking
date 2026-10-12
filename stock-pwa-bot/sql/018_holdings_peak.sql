-- Đỉnh kể từ ngày mua cho vị thế mua tay, để trailing stop bò lên theo giá.
--
-- Pick của bot đã có peak_price/peak_date trong climax_active_picks /
-- mid_term_active_picks; mã mua tay không nằm bảng nào nên phải có chỗ riêng.
-- Cùng cron EOD updatePeakPrices ghi cả hai nơi.

ALTER TABLE holdings ADD COLUMN IF NOT EXISTS peak_price NUMERIC;
ALTER TABLE holdings ADD COLUMN IF NOT EXISTS peak_date  DATE;
