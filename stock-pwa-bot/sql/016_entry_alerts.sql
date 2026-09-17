-- Dấu "đã nhắc vào lệnh" trên 2 bảng pick.
--
-- Bot nhắc mua lúc 8:30 phiên kế tiếp phiên signal (đúng phiên resolver lấy giá
-- mở cửa làm giá vào). Dấu khoá theo symbol giống exit_alerted_at: upsert lúc
-- re-signal KHÔNG đụng cột này, nên so với signal_date mới biết dấu là của vị
-- thế hiện tại hay của vị thế cũ cùng mã.
--
-- Chưa chạy file này thì select cột này trả 400 → không có dấu, không dedupe:
-- cron 8:30 bắn 2 lần (hoặc gõ /mn sau đó) là gửi trùng tin nhắc trong cùng phiên.

ALTER TABLE climax_active_picks
  ADD COLUMN IF NOT EXISTS entry_alerted_at TIMESTAMPTZ;

ALTER TABLE mid_term_active_picks
  ADD COLUMN IF NOT EXISTS entry_alerted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_climax_active_picks_entry_unalerted
  ON climax_active_picks (entry_alerted_at)
  WHERE entry_alerted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_mid_term_active_picks_entry_unalerted
  ON mid_term_active_picks (entry_alerted_at)
  WHERE entry_alerted_at IS NULL;
