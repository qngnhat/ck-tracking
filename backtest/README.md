# Backtest Framework — Stock Analyzer

Validation pipeline cho hệ scoring của Stock Analyzer PWA. Phase 1 của roadmap ([`../stock-pwa/plan.md`](../stock-pwa/plan.md)).

## Setup

```bash
cd /Users/qngnhat/bong/ck_tracking/backtest
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Cấu trúc

```
backtest/
├── src/
│   ├── data_fetch.py    # VNDirect API wrappers
│   ├── indicators.py    # (Phase 1.2) port từ analysis.js
│   ├── signals.py       # (Phase 1.3) signal generators
│   ├── backtest.py      # (Phase 1.4) backtest engine
│   └── metrics.py       # (Phase 1.4) Sharpe, drawdown, win rate
├── notebooks/
│   ├── 01_data_fetch.ipynb
│   ├── 02_indicators.ipynb
│   ├── 03_single_signal_backtest.ipynb
│   └── 04_combined_scoring_backtest.ipynb
├── data/                # cached parquet, gitignored
├── universe.txt         # 55 mã VN liquid
├── fetch_all.py         # main fetch script
└── requirements.txt
```

## Chạy fetch lần đầu

```bash
# Fetch all (OHLCV + fundamentals + foreign flow) — mất ~5 phút
python fetch_all.py

# Hoặc fetch từng loại riêng
python fetch_all.py ohlcv
python fetch_all.py fundamentals
python fetch_all.py foreign
```

Data save ra `data/*.parquet` (gitignored). Re-run sẽ overwrite.

## Verify data

```python
import pandas as pd

ohlcv = pd.read_parquet("data/ohlcv.parquet")
print(ohlcv.groupby("symbol").size().describe())
print(ohlcv.head())
```

Kỳ vọng: ~1700 bars/symbol cho 7 năm.

## Progress

- [x] **Phase 1.1** — Data fetch pipeline
- [ ] **Phase 1.2** — Port indicators to Python
- [ ] **Phase 1.3** — Single signal backtest
- [ ] **Phase 1.4** — Combined scoring backtest
- [ ] **Phase 1.5** — Results report

## Data sources

- **OHLCV**: VNDirect dchart API (TradingView format) — miễn phí, ổn định
- **Fundamentals**: VNDirect finfo API — snapshot mới nhất, có thể lag 1-2 ngày
- **Foreign flow**: VNDirect finfo API — daily net buy/sell khối ngoại

Data quality ~95%, một số mã thỉnh thoảng thiếu ngày hoặc field → handle graceful trong phase 1.2.
