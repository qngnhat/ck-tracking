"""Load and prepare data for backtest."""

from __future__ import annotations

from pathlib import Path
from typing import Optional

import pandas as pd

from .indicators import compute_all

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def load_universe(start: Optional[str] = None, end: Optional[str] = None) -> pd.DataFrame:
    """Load all OHLCV + foreign flow merged + indicators computed per symbol.

    Returns DataFrame sorted by (symbol, date) with all columns ready for signals.
    """
    ohlcv = pd.read_parquet(DATA_DIR / "ohlcv.parquet")
    foreign = pd.read_parquet(DATA_DIR / "foreign_flow.parquet")

    if start:
        ohlcv = ohlcv[ohlcv["date"] >= pd.Timestamp(start)]
        foreign = foreign[foreign["date"] >= pd.Timestamp(start)]
    if end:
        ohlcv = ohlcv[ohlcv["date"] <= pd.Timestamp(end)]
        foreign = foreign[foreign["date"] <= pd.Timestamp(end)]

    parts: list[pd.DataFrame] = []
    for _, group in ohlcv.groupby("symbol", sort=False):
        g = group.sort_values("date").reset_index(drop=True)
        g = compute_all(g)
        parts.append(g)
    df = pd.concat(parts, ignore_index=True)

    # Merge foreign flow (left join — some early dates may be missing)
    foreign_keep = foreign[["symbol", "date", "net_val", "buy_val", "sell_val", "current_room"]]
    df = df.merge(foreign_keep, on=["symbol", "date"], how="left")

    return df.sort_values(["symbol", "date"]).reset_index(drop=True)


def load_vnindex() -> pd.DataFrame:
    """Load VN-Index OHLCV."""
    df = pd.read_parquet(DATA_DIR / "vnindex.parquet")
    return df.sort_values("date").reset_index(drop=True)
