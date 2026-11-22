// Cross-check the JS engine against the original Python script.
//
// Computes expected-score maps for a range of spreads, correlations and grid
// resolutions in both engines and compares them point by point, with the
// board point-sampled as in Python (boardSamples: 1):
//   - the "discrete" JS kernel must match Python to float precision;
//   - the default "analytic" kernel must stay within 0.01 points;
//   - both must pick the same best aim point (or one of equal value).
//
// Usage:  node tests/crosscheck.mjs
// Needs uv (https://docs.astral.sh/uv/), which fetches numpy and matplotlib.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ExpectedScoreMapper } from "../js/core/expected.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cases = [
  { sx: 5, sy: 5, rho: 0, res: 1, view: 200 },
  { sx: 15, sy: 15, rho: 0, res: 1, view: 200 },
  { sx: 30, sy: 30, rho: 0, res: 0.5, view: 180 },
  { sx: 50, sy: 50, rho: 0, res: 1, view: 200 },
  { sx: 15, sy: 45, rho: 0, res: 1, view: 200 },
  { sx: 45, sy: 15, rho: 0, res: 1, view: 200 },
  { sx: 25, sy: 35, rho: 0.4, res: 1, view: 210 },
  { sx: 12, sy: 8, rho: -0.7, res: 0.5, view: 200 },
  { sx: 2, sy: 3, rho: 0.2, res: 1, view: 200 },
  { sx: 80, sy: 60, rho: 0.85, res: 2, view: 230 },
];

const dir = mkdtempSync(path.join(tmpdir(), "darts-crosscheck-"));
let failures = 0;
try {
  const casesFile = path.join(dir, "cases.json");
  writeFileSync(casesFile, JSON.stringify(cases));
  const py = spawnSync("uv", ["run", "--quiet", path.join(here, "crosscheck.py"), dir, casesFile],
    { encoding: "utf8" });
  if (py.status !== 0) {
    console.error(py.stderr || py.error);
    process.exit(2);
  }
  const summaries = py.stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l));
  const mapper = new ExpectedScoreMapper();

  cases.forEach((c, i) => {
    const ref = summaries[i];
    const buf = readFileSync(path.join(dir, `case${i}.f64`));
    const E = new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8);
    const label = `sx=${c.sx} sy=${c.sy} rho=${c.rho} res=${c.res}`;

    for (const kernel of ["discrete", "analytic"]) {
      const M = mapper.compute({ ...c, kernel, boardSamples: 1 });
      if (M.n !== ref.n || Math.abs(M.axis0 - ref.axis0) > 1e-9) {
        console.log(`FAIL ${label} [${kernel}]: grid ${M.n}@${M.axis0} vs ${ref.n}@${ref.axis0}`);
        failures++;
        continue;
      }
      let worst = 0;
      for (let k = 0; k < E.length; k++) worst = Math.max(worst, Math.abs(M.E[k] - E[k]));
      const tol = M.kernel === "discrete" ? 1e-4 : 0.01;   // E is stored as float32 in JS
      const sameBest = Math.hypot(M.best[0] - ref.best[0], M.best[1] - ref.best[1]) < 1e-9 ||
        Math.abs(M.bestValue - ref.best_value) < tol;
      const ok = worst < tol && sameBest;
      if (!ok) failures++;
      console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(36)} [${M.kernel.padEnd(8)}] ` +
        `max |dE| ${worst.toExponential(2)}  best JS (${M.best.join(", ")}) ${M.bestValue.toFixed(3)}` +
        `  Py (${ref.best.join(", ")}) ${ref.best_value.toFixed(3)}`);
    }
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failure(s)` : "\nall cases match");
process.exit(failures ? 1 : 0);
