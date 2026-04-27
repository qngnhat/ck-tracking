"""Hardcoded sector mapping cho universe (mapping VN stocks → ngành chính).

Last reviewed: 2026-04-27 (sau VN30 rebalance Q1)
Next review: ~2026-07-27 (khi VN30 rebalance Q2)

Universe được chia 2 tier:
- CORE_VN30: VN30 actual constituents
- EXTENDED: mid/large-cap diversifiers theo ngành

Update workflow khi rebalance:
  curl 'https://api-finfo.vndirect.com.vn/v4/stocks?q=indexCode:VN30&size=50' \\
    -H 'User-Agent: Mozilla/5.0' | jq '[.data[].code] | sort'
"""

# ── Tier 1: VN30 actual (Apr 2026) ──
CORE_VN30 = {
    # Banks
    "VCB": "bank", "BID": "bank", "CTG": "bank", "TCB": "bank",
    "VPB": "bank", "MBB": "bank", "ACB": "bank", "HDB": "bank",
    "STB": "bank", "SHB": "bank", "TPB": "bank", "LPB": "bank",
    "VIB": "bank", "SSB": "bank",
    # Real estate
    "VHM": "realestate", "VIC": "realestate", "VRE": "realestate",
    # Consumer / Tourism
    "MSN": "consumer", "VNM": "consumer", "SAB": "consumer",
    "VJC": "consumer", "VPL": "consumer",
    # Retail
    "MWG": "retail",
    # Industrial / Materials
    "HPG": "industrial", "GVR": "industrial", "DGC": "industrial",
    # Energy
    "GAS": "energy", "PLX": "energy",
    # Tech
    "FPT": "tech",
    # Broker
    "SSI": "broker",
}

# ── Tier 2: Extended diversifiers ──
EXTENDED = {
    "EIB": "bank",
    # Real estate mid-tier
    "NVL": "realestate", "BCM": "realestate",
    "KDH": "realestate", "DXG": "realestate",
    "KBC": "realestate", "DIG": "realestate",
    "NLG": "realestate", "PDR": "realestate",
    # Consumer / Retail mid
    "PNJ": "retail", "DGW": "retail", "FRT": "retail",
    # Industrial mid
    "HSG": "industrial", "NKG": "industrial",
    "DCM": "industrial", "DPM": "industrial",
    "PC1": "industrial",
    # Energy mid
    "BSR": "energy",
    # Utility
    "POW": "utility", "REE": "utility", "NT2": "utility",
    # Tech mid
    "CMG": "tech",
    # Broker mid
    "VCI": "broker", "VND": "broker", "HCM": "broker",
    # Pharma
    "DHG": "pharma", "IMP": "pharma", "DBD": "pharma",
}

SECTOR_MAP = {**CORE_VN30, **EXTENDED}


def get_sector(symbol: str) -> str:
    return SECTOR_MAP.get(symbol, "other")


def is_core(symbol: str) -> bool:
    return symbol in CORE_VN30
