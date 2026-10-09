-- Dấu "đã cảnh báo sắp chạm stop" trên 2 bảng pick.
--
-- Alert chạm luật bắn 1 lần/vị thế (exit_alerted_at), còn cảnh báo sớm bắn 1
-- lần/phiên: giá lảng vảng quanh stop cả phiên mà không dedupe theo ngày thì
-- cron 3 phút gửi vài chục tin.
--
-- Giống exit_alerted_at: upsert lúc re-signal KHÔNG đụng cột này.
--
-- Chưa chạy file này thì checkExitAlerts tự tắt phần cảnh báo sớm (đọc lại
-- không có cột) — alert chạm luật vẫn chạy nguyên.

ALTER TABLE climax_active_picks
  ADD COLUMN IF NOT EXISTS near_alerted_at TIMESTAMPTZ;

ALTER TABLE mid_term_active_picks
  ADD COLUMN IF NOT EXISTS near_alerted_at TIMESTAMPTZ;
