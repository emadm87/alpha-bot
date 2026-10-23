"""Reference values for technical.test.ts, computed with TA-Lib (C library).

Regenerate (not needed to run the tests):
    python -m venv venv && venv/bin/pip install TA-Lib==0.8.2 numpy pandas
    venv/bin/python generate_talib_reference.py

Input: btc-1d-candles.json (closed bars, oldest -> newest).
Output: talib-reference.json, NaN written as null.
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd
import talib

here = Path(__file__).parent
candles = json.loads((here / "btc-1d-candles.json").read_text())["candles"]
high = np.array([c["high"] for c in candles])
low = np.array([c["low"] for c in candles])
close = np.array([c["close"] for c in candles])
volume = np.array([c["volume"] for c in candles])

# MACD with every EMA seeded on its own first values (the module's
# convention), composed from TA-Lib's EMA: line from index 25, signal = EMA9
# of the line seeded on the line's first 9 values.
line = talib.EMA(close, 12) - talib.EMA(close, 26)
signal = np.full_like(close, np.nan)
signal[25:] = talib.EMA(line[25:], 9)

macd, macd_signal, macd_hist = talib.MACD(close, 12, 26, 9)
volume_s = pd.Series(volume)
relative_volume = volume_s / volume_s.rolling(20).mean().shift(1)


def out(a):
    return [None if np.isnan(v) else float(v) for v in a]


reference = {
    "generator": f"TA-Lib {talib.__version__}, numpy {np.__version__}, pandas {pd.__version__}",
    "ema20": out(talib.EMA(close, 20)),
    "ema50": out(talib.EMA(close, 50)),
    "rsi14": out(talib.RSI(close, 14)),
    "atr14": out(talib.ATR(high, low, close, 14)),
    "talibMacd": {"macd": out(macd), "signal": out(macd_signal), "histogram": out(macd_hist)},
    "composedMacd": {"macd": out(line), "signal": out(signal), "histogram": out(line - signal)},
    "relativeVolume20": out(relative_volume.to_numpy()),
}
(here / "talib-reference.json").write_text(json.dumps(reference, indent=1))
print("written", len(close), "bars with", reference["generator"])
