-- Ứng viên "sắp thành Climax" — phục vụ cảnh báo sớm trong phiên.
--
-- Lý do: detector Climax cần close + volume CẢ PHIÊN nên chỉ chạy được lúc EOD,
-- signal về thì phiên đã đóng. Bảng này giữ snapshot số liệu lịch sử (tính ở EOD
-- ngày D, khi chunk scan đã có sẵn 220 phiên daily) để phiên D+1 chỉ cần thêm
-- giá + volume intraday là tái tính được detector mà không phải fetch lại history.
--
-- Vòng đời 1 phiên: EOD ngày D ghi (watch_date = phiên kế tiếp), phiên đó dùng,
-- EOD sau xoá. KHÔNG phải lệnh mua — chỉ là cảnh báo chuẩn bị.

CREATE TABLE IF NOT EXISTS presignal_watch (
  symbol           TEXT NOT NULL,
  watch_date       DATE NOT NULL,           -- phiên sẽ theo dõi (= phiên kế tiếp sau ngày scan)
  snapshot_date    DATE NOT NULL,           -- ngày data dùng để tính snapshot
  -- Snapshot đủ để chạy lại detectVolClimaxBounce giữa phiên
  prev3_close      NUMERIC NOT NULL,        -- close[D-2]: mẫu số ret3d của phiên D+1
  prev_close       NUMERIC NOT NULL,        -- close[D]: để tính true range của phiên D+1
  vol_avg20        NUMERIC NOT NULL,        -- TB volume 20 phiên gần nhất (kể cả D)
  -- ATR14 của phiên D+1 = (tr_sum13 + TR hôm đó) / 14. Tách ra vì TR hôm đó chỉ
  -- có khi đang chạy phiên (high/low từ bar 5 phút), không snapshot trước được.
  tr_sum13         NUMERIC,
  median_turnover  NUMERIC NOT NULL,        -- gate ≥ 3 tỷ
  closes60         JSONB NOT NULL,          -- 60 close gần nhất, để RSI Wilder hội tụ
  ret3d_at_scan    NUMERIC,                 -- ret3d lúc scan, dùng để xếp hạng ứng viên
  rsi_at_scan      NUMERIC,
  alerted_at       TIMESTAMPTZ,             -- đã bắn cảnh báo → không bắn lại
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (symbol, watch_date)
);

CREATE INDEX IF NOT EXISTS idx_presignal_watch_date
  ON presignal_watch(watch_date);
