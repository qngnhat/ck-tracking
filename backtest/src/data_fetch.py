"""VNDirect API wrappers for fetching VN stock data.

Endpoints used:
- dchart (OHLCV):         https://dchart-api.vndirect.com.vn/dchart/history
- ratios (fundamentals):  https://api-finfo.vndirect.com.vn/v4/ratios/latest
- foreign trade summary:  https://api-finfo.vndirect.com.vn/v4/foreign_trade_summary
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta
from typing import Optional

import pandas as pd
import requests

DCHART_URL = "https://dchart-api.vndirect.com.vn/dchart/history"
FINFO_BASE = "https://api-finfo.vndirect.com.vn/v4"

# Map VNDirect's ratioCode (string) → readable field name
# Discovered from /v4/ratios endpoint on 2026-04
RATIO_CODE_MAP = {
    "PRICE_TO_EARNINGS": "pe",
    "PRICE_TO_BOOK": "pb",
    "PRICE_TO_SALES": "ps",
    "BVPS_CR": "bvps",
    "MARKETCAP": "market_cap",
    "DIVIDEND_YIELD": "dividend_yield",
    "BETA": "beta",
    "PRICE_HIGHEST_CR_52W": "high_52w",
    "PRICE_LOWEST_CR_52W": "low_52w",
    "FOREIGN_BUY_VOLUME_CR_WTD": "nn_buy_vol_wtd",
    "FOREIGN_SELL_VOLUME_CR_WTD": "nn_sell_vol_wtd",
}

DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9,vi;q=0.8",
    "Origin": "https://dchart.vndirect.com.vn",
    "Referer": "https://dchart.vndirect.com.vn/",
}


# ── OHLCV ────────────────────────────────────────────────

def fetch_ohlcv(
    symbol: str,
    start: str = "2018-01-01",
    end: Optional[str] = None,
    resolution: str = "D",
) -> pd.DataFrame:
    """Fetch OHLCV via VNDirect dchart API.

    Returns DataFrame with columns: date, open, high, low, close, volume, symbol.
    """
    if end is None:
        end = datetime.now().strftime("%Y-%m-%d")

    from_ts = int(pd.Timestamp(start).timestamp())
    to_ts = int(pd.Timestamp(end).timestamp())

    params = {
        "resolution": resolution,
        "symbol": symbol,
        "from": from_ts,
        "to": to_ts,
    }
    r = requests.get(DCHART_URL, params=params, headers=DEFAULT_HEADERS, timeout=30)
    r.raise_for_status()
    data = r.json()

    if data.get("s") != "ok" or not data.get("c"):
        raise ValueError(f"No OHLCV for {symbol}: {data.get('s')}")

    df = pd.DataFrame({
        "date": pd.to_datetime(data["t"], unit="s").normalize(),
        "open": data["o"],
        "high": data["h"],
        "low": data["l"],
        "close": data["c"],
        "volume": data["v"],
    })
    df["symbol"] = symbol
    return df[["symbol", "date", "open", "high", "low", "close", "volume"]]


# ── Fundamentals ─────────────────────────────────────────

def fetch_fundamentals(symbol: str) -> dict:
    """Fetch latest fundamental ratios snapshot.

    NOTE: This is a CURRENT snapshot only. Cannot be used for historical
    backtest of signals like "P/E < 10 → buy". Suitable only for current
    app display (most recent valuation).

    Returns: {symbol, pe, pb, ps, bvps, market_cap, dividend_yield, beta, ...}
    """
    url = f"{FINFO_BASE}/ratios"
    params = {"q": f"code:{symbol}", "size": 200, "sort": "reportDate:desc"}

    r = requests.get(url, params=params, headers=DEFAULT_HEADERS, timeout=30)
    r.raise_for_status()
    data = r.json().get("data", [])

    result: dict = {"symbol": symbol}
    seen_keys: set[str] = set()
    # Iterate most recent first; keep only the first value per ratioCode
    for item in data:
        key = RATIO_CODE_MAP.get(item.get("ratioCode"))
        if key and key not in seen_keys and item.get("value") is not None:
            result[key] = item["value"]
            seen_keys.add(key)
            if "report_date" not in result:
                result["report_date"] = item.get("reportDate")
    return result


# ── Foreign flow (NN mua/bán ròng) ───────────────────────

def fetch_foreign_flow(
    symbol: str,
    start: str = "2018-01-01",
    end: Optional[str] = None,
) -> pd.DataFrame:
    """Fetch daily foreign trading summary from /v4/foreigns.

    Returns DataFrame with:
      symbol, date, buy_val, sell_val, net_val,
      buy_vol, sell_vol, net_vol, total_room, current_room
    """
    if end is None:
        end = datetime.now().strftime("%Y-%m-%d")

    url = f"{FINFO_BASE}/foreigns"
    all_rows: list[dict] = []
    page = 1

    while True:
        params = {
            "q": f"code:{symbol}~tradingDate:gte:{start}~tradingDate:lte:{end}",
            "size": 1000,
            "page": page,
            "sort": "tradingDate:asc",
        }
        r = requests.get(url, params=params, headers=DEFAULT_HEADERS, timeout=30)
        r.raise_for_status()
        j = r.json()
        rows = j.get("data", [])
        if not rows:
            break
        all_rows.extend(rows)
        if len(rows) < 1000:
            break
        page += 1
        time.sleep(0.2)

    if not all_rows:
        return pd.DataFrame()

    df = pd.DataFrame(all_rows)
    df["date"] = pd.to_datetime(df["tradingDate"]).dt.normalize()
    df["symbol"] = symbol

    rename = {
        "buyVal": "buy_val",
        "sellVal": "sell_val",
        "netVal": "net_val",
        "buyVol": "buy_vol",
        "sellVol": "sell_vol",
        "netVol": "net_vol",
        "totalRoom": "total_room",
        "currentRoom": "current_room",
    }
    df = df.rename(columns=rename)

    keep = ["symbol", "date"] + [v for v in rename.values() if v in df.columns]
    return df[keep].sort_values("date").reset_index(drop=True)
