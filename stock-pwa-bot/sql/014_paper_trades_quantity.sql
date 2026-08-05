-- Vá cho ai đã lỡ chạy bản 013 đầu tiên (bản đó có sl_price, chưa có quantity).
--
-- "SL" trong lệnh /b là SỐ LƯỢNG cổ phiếu, không phải stop-loss — hiểu nhầm ở
-- bản trước. Bot không dùng stop-loss của user: mức thoát đã có sẵn trong
-- exit alert tính từ close ngày signal.
--
-- Idempotent: chạy được cả khi 013 bản mới đã tạo sẵn cột quantity.

ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS quantity INTEGER;
ALTER TABLE paper_trades DROP COLUMN IF EXISTS sl_price;
