# Strong Leaders T+ Backtest — Results (May 2026)

## Verdict: ⚠️ Weak edge — không pass criteria

Strong Leaders formula (mới ship May 2026) **CÓ edge** trên random baseline
nhưng **Sharpe 0.165 quá thấp** so với threshold 0.3 → variance cao, không
safe để trade blindly.

## Setup

- **Universe**: 58 mã curated HOSE+HNX (chưa có data full universe để test)
- **Test window**: 2024-01-01 onwards (out-of-sample, regime narrow leadership)
- **Strategy**: Mỗi ngày sau đóng cửa, pick top-N mã score ≥ min_score. Mua
  T+1 open, hold N phiên, bán close T+1+N.
- **Cost**: 0.4% round-trip
- **Score factors**: RS vs VNI 5d+20d, breakout w20/w52/ceiling, vol
  accumulation up/down, MA alignment 5>10>20>50, ADX+DI, RSI<30 residual,
  foreign flow

## V1 Results (no SL/TP, hold fixed)

| min_score | top_n | hold | Trades | Win% | Avg ret | Sharpe | PF |
|-----------|-------|------|--------|------|---------|--------|----|
| 4.0 | 3 | 15d | 1652 | **52.1%** | **+1.88%** | **0.165** | 1.62 |
| 4.0 | 3 | 10d | 1668 | 51.0% | +1.06% | 0.117 | 1.41 |
| 4.0 | 5 | 15d | 2637 | 51.5% | +1.61% | 0.144 | 1.52 |
| 5.0 | 3 | 15d | 1597 | 51.5% | +1.84% | 0.161 | 1.59 |
| 7.0 | 3 | 15d | 1413 | 51.8% | +1.81% | 0.159 | 1.58 |

**Random baseline** (same eligible filter, random pick):
- top5 hold10: win 49.5%, avg +0.59%, sharpe 0.078

**Edge vs random**: +2.6% win rate, +1.29% avg ret, Sharpe 2.1× higher.
Edge tồn tại nhưng nhỏ — variance cao.

## V2 Results (with TP1=+5%, TP2=+12%, SL=-8% intraday)

| min_score | top_n | hold≤ | n | Win% | Avg | Sharpe | TP1% | SL% |
|-----------|-------|-------|---|------|-----|--------|------|-----|
| 4.0 | 3 | 20d | 1698 | **62.3%** | +0.24% | 0.042 | 58% | 24% |
| 4.0 | 3 | 15d | 1698 | 59.6% | +0.12% | 0.021 | 54% | 22% |

V2 **worse than V1**:
- Win rate cao hơn nhưng avg ret giảm mạnh (+1.88% → +0.24%)
- TP2 (+12%) **0% hit rate** — quá xa, không bao giờ chạm
- TP1 (+5%) cap winners quá tight
- SL -8% chỉ 24% hit — không tệ
- Math: 0.58 × +5% + 0.24 × -8% + 0.18 × ~breakeven - cost ≈ +0.5% → match

→ TP/SL cap thực ra **hại** strategy. Phải để winners chạy.

## Pass criteria check

| Metric | Threshold | V1 Best | V2 Best | Pass? |
|--------|-----------|---------|---------|-------|
| Sharpe | > 0.3 | 0.165 | 0.042 | ❌ |
| Win rate | > 55% | 52.1% | 62.3% | ✓ V2 |
| Avg ret | > 1% | +1.88% | +0.24% | ✓ V1 |
| Profit factor | > 1.5 | 1.62 | 1.09 | ✓ V1 |

**Overall: KHÔNG PASS** chủ yếu do Sharpe quá thấp ở cả 2 variants.

## Phân tích

### Điểm tốt
1. ✓ Edge tồn tại — beat random ~2.6%/+1.29%
2. ✓ Avg ret +1.88% per trade (V1 best) khá tốt
3. ✓ Profit factor 1.62 (V1) reasonable

### Điểm yếu
1. ✗ Sharpe 0.165 quá thấp — variance cao, drawdown periods sẽ dài
2. ✗ Win rate chỉ 52% — gần coinflip, không cảm giác "edge mạnh"
3. ✗ Universe chỉ 58 mã curated — Strong Leaders design để bắt narrow leaders trong ~700 mã, nhưng data hiện tại chưa có full universe
4. ✗ Hold 15d optimal — nhưng vẫn dài cho T+ (≤14 phiên T+1 settlement)

### Hypothesis
- Formula đúng concept (momentum/RS/breakout) nhưng signal-to-noise thấp trên 58 mã (đa số đã filtered ra strong leaders qua thanh khoản)
- Universe rộng hơn có thể tăng edge — vì narrow leaders thường là mid-cap, small-cap không trong DCA-58
- Một số signals có thể đang noise hơn signal (cần ablation test)

## Recommendation

### Option A — Ship với warning (recommend)
- Formula có edge thật (~2.6% above random), không nguy hiểm
- Ship UI làm "Strong Leaders watchlist" thay vì "auto-pick mua"
- User vẫn nên human review trước khi vào lệnh
- Suitable cho post-screening, không phải full automation

### Option B — Iterate formula
- Fetch full universe data (HOSE 400+ mã có liquidity > 5tỷ)
- Re-backtest trên rộng → edge có thể stronger
- Ablation: remove signals 1 lúc, check Sharpe delta → ID best/worst signals
- Try LightGBM / logistic regression thay weighted sum
- ~6-8h work

### Option C — Combine với mean-reversion
- Old mean-reversion formula passed backtest (win 61%, avg +3.3%, Phase 4b)
- Combine 2 signals: Strong Leaders + Mean-reversion → ensemble
- User pick từ either signal set

### Option D — Accept current state, focus other features
- Backtest cho thấy edge yếu nhưng tồn tại
- User trade tay với app làm tool support, không rely solely
- Move on to other improvements (trade journal, EOD digest, etc.)

## Next steps

Recommend **Option D** — accept current state + log warning trong UI:
- Add disclaimer trong tab Lướt sóng T+: "Backtest 2024+: edge +1.29% avg trade vs random, Sharpe 0.17. Treat as 1-of-many inputs, không full automation."
- Move on to higher-value features (trade journal, in-app EOD)
- Revisit formula khi có full HOSE data + time để ablation deeper

User có thể chọn Option B nếu muốn invest deeper time.

## Files

- `run_strong_leaders.py` — V1 no SL/TP backtest
- `run_strong_leaders_v2.py` — V2 with SL/TP cap (worse)
- `src/strong_leaders_score.py` — score module (Python port của JS)
- `results/strong_leaders_metrics.csv` — V1 metrics all variants
- `results/strong_leaders_v2_metrics.csv` — V2 metrics
