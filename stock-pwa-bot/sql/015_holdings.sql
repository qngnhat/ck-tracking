-- Danh mục thật của user, do app menubar (vnstock-menubar) đẩy lên.
--
-- Tách khỏi `transactions` chứ không ghi đè: PWA sync hai chiều với
-- localStorage (syncTransactionsFromDB kéo DB→local), nên nếu menubar xoá row
-- ở đó thì hai app sẽ cãi nhau, mỗi lần mở một kết quả. Bảng này có đúng MỘT
-- writer là menubar, qua endpoint POST /portfolio/sync của worker.
--
-- Đây là SNAPSHOT vị thế, không phải lịch sử giao dịch: 1 mã = 1 row, sửa giá
-- vốn thì ghi đè. Muốn lịch sử mua/bán thì vẫn là `transactions`.

CREATE TABLE IF NOT EXISTS holdings (
  symbol         TEXT PRIMARY KEY,
  -- Đơn vị nghìn đồng (17.88 = 17.880đ), giống mọi bảng giá khác trong hệ.
  avg_cost       NUMERIC NOT NULL CHECK (avg_cost > 0),
  qty            NUMERIC NOT NULL CHECK (qty > 0),
  -- Menubar chỉ note giá vốn, không có lịch sử → ngày này là ngày user đóng
  -- dấu lần đầu, dùng để hiện T+. Sai thì sửa tay được.
  first_buy_date DATE,
  source         TEXT NOT NULL DEFAULT 'menubar',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
