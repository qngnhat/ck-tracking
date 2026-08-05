-- Nhật ký lệnh tay của user (paper trade) — tách hẳn khỏi trade_log.
--
-- trade_log là forward-test TỰ ĐỘNG của bot: entry luôn = open D+1, exit theo
-- rule cứng, chạy bất kể user có mua hay không. Bảng này ngược lại ghi quyết
-- định THẬT của user: mua giá nào, bán lúc nào.
--
-- Có cả hai mới trả lời được câu "bot có đáng follow không": so kết quả user
-- với kết quả bot trên cùng mã, và tách lệnh theo signal vs lệnh tự chế.
--
-- 1 lot = 1 row. Mua 2 lần cùng mã = 2 row, /s đóng lot cũ nhất (FIFO).
-- Bán một phần thì lot gốc teo quantity lại, phần đã bán tách thành row closed.

CREATE TABLE IF NOT EXISTS paper_trades (
  id              BIGSERIAL PRIMARY KEY,
  chat_id         BIGINT NOT NULL,
  symbol          TEXT NOT NULL,
  entry_price     NUMERIC NOT NULL,
  entry_date      DATE NOT NULL,
  quantity        INTEGER,                 -- số lượng CP; NULL = chỉ theo dõi %
  exit_price      NUMERIC,
  exit_date       DATE,
  -- Tên có hậu tố _pct vì trade_log.net_ret là TỶ LỆ (0.05 = +5%) — hai bảng
  -- hay bị đem so với nhau, lệch đơn vị là sai âm thầm.
  net_ret_pct     NUMERIC,                 -- % đã trừ phí khứ hồi, điền khi đóng
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  -- Bot có gợi ý mã này quanh lúc mua không → tách "theo bot" vs "tự chế"
  bot_tier        TEXT,
  bot_signal_date DATE,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_paper_trades_open
  ON paper_trades(chat_id, symbol) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_paper_trades_chat
  ON paper_trades(chat_id, status);
