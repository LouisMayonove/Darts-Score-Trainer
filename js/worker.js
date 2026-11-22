// Web Worker: computes expected-score maps off the main thread.
//
// Request:  { id, sx, sy, rho, res, view, mcThrows }
// Response: { id, map: {axis0, res, n, E, best, bestValue, min, max, ...},
//             mc: {mean, se} | null, ms }
// or        { id, error }

import { ExpectedScoreMapper } from "./core/expected.js";
import { monteCarlo, Rng } from "./core/stats.js";

const mapper = new ExpectedScoreMapper();

self.onmessage = (e) => {
  const { id, sx, sy, rho, res, view, mcThrows = 0 } = e.data;
  try {
    const t0 = performance.now();
    const map = mapper.compute({ sx, sy, rho, res, view });
    const mc = mcThrows > 0 ? monteCarlo(map.best, sx, sy, rho, mcThrows, new Rng(id + 1)) : null;
    const ms = performance.now() - t0;
    self.postMessage({ id, map, mc, ms }, [map.E.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err.message || err) });
  }
};
