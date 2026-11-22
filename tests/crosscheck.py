# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "matplotlib"]
# ///
"""Helper for crosscheck.mjs: compute expected-score maps with the original
Python script (reference/dart_heatmap.py) and write them as raw float64.

Usage: uv run tests/crosscheck.py <out_dir> <cases.json>
cases.json: [{"sx":..,"sy":..,"rho":..,"res":..,"view":..}, ...]
Writes <out_dir>/case<i>.f64 (row-major E) and prints one JSON summary line
per case: {"n":.., "axis0":.., "best":[x, y], "best_value":..}.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "reference"))
import matplotlib

matplotlib.use("Agg")
import numpy as np  # noqa: E402

import dart_heatmap as dh  # noqa: E402

out_dir = Path(sys.argv[1])
cases = json.loads(Path(sys.argv[2]).read_text())
for i, c in enumerate(cases):
    axis, E = dh.expected_score_map(c["sx"], c["sy"], c["rho"], c["res"], c["view"])
    best, val = dh.best_aim(axis, E)
    np.ascontiguousarray(E, dtype="<f8").tofile(out_dir / f"case{i}.f64")
    print(json.dumps({"n": len(axis), "axis0": float(axis[0]),
                      "best": [float(best[0]), float(best[1])],
                      "best_value": float(val)}))
