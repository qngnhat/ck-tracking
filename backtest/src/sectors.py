"""Hardcoded sector mapping cho universe (mapping VN stocks → ngành chính).

Dùng cho sector cap khi ranking để tránh concentrate quá 1 ngành.
"""

SECTOR_MAP = {
    # Banks
    "VCB": "bank", "BID": "bank", "CTG": "bank", "TCB": "bank", "VPB": "bank",
    "MBB": "bank", "ACB": "bank", "HDB": "bank", "STB": "bank", "SHB": "bank",
    "TPB": "bank", "EIB": "bank", "LPB": "bank", "VIB": "bank",
    # Real estate
    "VHM": "realestate", "VIC": "realestate", "VRE": "realestate", "NVL": "realestate",
    "PDR": "realestate", "KDH": "realestate", "DXG": "realestate", "KBC": "realestate",
    "DIG": "realestate", "NLG": "realestate",
    # Consumer / Retail
    "MWG": "retail", "PNJ": "retail", "MSN": "consumer", "VNM": "consumer",
    "SAB": "consumer", "DGW": "retail", "FRT": "retail",
    # Industrial / Materials
    "HPG": "industrial", "HSG": "industrial", "NKG": "industrial", "GVR": "industrial",
    "DGC": "industrial", "DCM": "industrial", "DPM": "industrial", "BCM": "industrial",
    "PC1": "industrial",
    # Energy
    "GAS": "energy", "BSR": "energy", "PLX": "energy",
    # Utilities
    "POW": "utility", "REE": "utility", "NT2": "utility",
    # Tech
    "FPT": "tech", "CMG": "tech",
    # Securities/Brokers
    "SSI": "broker", "VCI": "broker", "VND": "broker", "HCM": "broker",
    # Pharma
    "DHG": "pharma", "IMP": "pharma", "DBD": "pharma",
}


def get_sector(symbol: str) -> str:
    return SECTOR_MAP.get(symbol, "other")
