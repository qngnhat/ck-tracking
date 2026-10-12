-- Dấu đã báo cho vị thế mua tay, để alert chạm stop không bắn lại mỗi 3 phút.
--
-- Pick của bot ghi dấu ở climax_active_picks / mid_term_active_picks; mã mua
-- tay không có row ở đó nên dấu phải nằm cùng chỗ với vị thế.
-- Dấu cũ hơn first_buy_date = của lần mua trước, không tính (giống cách pick
-- so dấu với signal_date).

ALTER TABLE holdings ADD COLUMN IF NOT EXISTS exit_alerted_at   TIMESTAMPTZ;
ALTER TABLE holdings ADD COLUMN IF NOT EXISTS exit_alert_reason TEXT;
ALTER TABLE holdings ADD COLUMN IF NOT EXISTS near_alerted_at   TIMESTAMPTZ;
