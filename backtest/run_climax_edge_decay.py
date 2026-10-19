"""n=85 quá nhỏ để kết luận gì. Mở rộng universe xem pattern có thật hay không."""
import math
import pandas as pd
import run_market_health_gate as g
from run_climax_regime_filter import enrich, simulate, filter_largemid
from src.load_data import load_universe

p2 = lambda t: math.erfc(abs(t) / math.sqrt(2))
uni = load_universe()

SETS = {
    "35 mã bot scan": uni[uni.symbol.isin(g.VOL_CLIMAX_UNIVERSE)],
    "thanh khoản >=3tỷ/phiên": filter_largemid(uni),
    "toàn bộ 655 mã": uni,
}

for name, sub in SETS.items():
    df = pd.concat([enrich(x) for _, x in sub.groupby("symbol", sort=False)], ignore_index=True)
    df["date"] = pd.to_datetime(df["date"])
    df["base_B"] = (df.ret_3d < -0.05) & (df.vol_ratio > 2.0) & df.day_green & (df.rsi < 50)
    print(f"\n████ {name} ({sub.symbol.nunique()} mã) ████")
    print(f"  {'kỳ':<14} {'n':>5} {'Win%':>6} {'Avg':>7} {'t':>6} {'p':>6}  CI95")
    for lab, s, e in [("2018-2023", "2018-01-01", "2023-12-31"),
                      ("2024-nay", "2024-01-01", "2026-10-16"),
                      ("toàn kỳ", "2018-01-01", "2026-10-16")]:
        r = simulate(df[(df.date >= s) & (df.date <= e)], "base_B").net_ret
        se = r.std() / math.sqrt(len(r)); t = r.mean() / se
        print(f"  {lab:<14} {len(r):5d} {(r>0).mean()*100:5.1f}% {r.mean()*100:+6.2f}% "
              f"{t:+6.2f} {p2(t):6.3f}  [{(r.mean()-1.96*se)*100:+5.2f}%, {(r.mean()+1.96*se)*100:+5.2f}%]")
