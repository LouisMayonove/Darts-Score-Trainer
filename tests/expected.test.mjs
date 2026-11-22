// Unit tests for the FFT and the expected-score map.

import test from "node:test";
import assert from "node:assert/strict";
import { fft1d, fft2d, nextPow2 } from "../js/core/fft.js";
import { gaussianKernel, ExpectedScoreMapper, expectedAt, sampleBilinear } from "../js/core/expected.js";
import { score } from "../js/core/board.js";
import { Rng, monteCarlo } from "../js/core/stats.js";

test("nextPow2", () => {
  assert.equal(nextPow2(1), 1);
  assert.equal(nextPow2(5), 8);
  assert.equal(nextPow2(1024), 1024);
  assert.equal(nextPow2(1025), 2048);
});

test("1D FFT matches a direct DFT and inverts", () => {
  const n = 16, rng = new Rng(1);
  const re = Float64Array.from({ length: n }, () => rng.normal());
  const im = Float64Array.from({ length: n }, () => rng.normal());
  const r0 = re.slice(), i0 = im.slice();
  fft1d(re, im, n);
  for (let k = 0; k < n; k++) {
    let sr = 0, si = 0;
    for (let t = 0; t < n; t++) {
      const a = (-2 * Math.PI * k * t) / n;
      sr += r0[t] * Math.cos(a) - i0[t] * Math.sin(a);
      si += r0[t] * Math.sin(a) + i0[t] * Math.cos(a);
    }
    assert.ok(Math.abs(sr - re[k]) < 1e-9 && Math.abs(si - im[k]) < 1e-9);
  }
  fft1d(re, im, n, 0, true);
  for (let t = 0; t < n; t++) assert.ok(Math.abs(re[t] / n - r0[t]) < 1e-12);
});

test("2D FFT round trip", () => {
  const n = 8, rng = new Rng(2);
  const re = Float64Array.from({ length: n * n }, () => rng.normal());
  const im = new Float64Array(n * n);
  const r0 = re.slice();
  fft2d(re, im, n);
  fft2d(re, im, n, true);
  for (let i = 0; i < n * n; i++) assert.ok(Math.abs(re[i] - r0[i]) < 1e-12);
});

test("FFT rejects sizes that are not powers of two", () => {
  assert.throws(() => fft1d(new Float64Array(6), new Float64Array(6), 6), /power of two/);
});

test("Gaussian kernel is normalised, centred and tilted by rho", () => {
  const k = gaussianKernel(3, 5, 0.6, 1);
  assert.equal(k.half, 20);
  const sum = k.data.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12);
  const at = (x, y) => k.data[(y + k.half) * k.size + (x + k.half)];
  assert.ok(at(0, 0) > at(1, 0) && at(0, 0) > at(0, 1));
  assert.ok(Math.abs(at(3, 2) - at(-3, -2)) < 1e-15, "centrally symmetric");
  assert.ok(at(3, 3) > at(3, -3), "positive rho tilts along y = x");
});

// Direct (slow) evaluation of E at one aim point, for checking the FFT path.
function directExpected(ax, ay, sx, sy, rho, res) {
  const k = gaussianKernel(sx, sy, rho, res);
  let e = 0;
  for (let i = 0; i < k.size; i++) {
    for (let j = 0; j < k.size; j++) {
      e += k.data[i * k.size + j] * score(ax + (j - k.half) * res, ay + (i - k.half) * res);
    }
  }
  return e;
}

test("FFT map equals the direct sum at sample points", () => {
  const mapper = new ExpectedScoreMapper();
  for (const [sx, sy, rho] of [[4, 4, 0], [12, 25, 0.4], [30, 18, -0.7]]) {
    const M = mapper.compute({ sx, sy, rho, res: 2, view: 200, kernel: "discrete" });
    assert.equal(M.kernel, "discrete");
    for (const [x, y] of [[0, 0], [0, 102], [-40, 96], [150, -60], [190, 190], [-200, 0]]) {
      const want = directExpected(x, y, sx, sy, rho, 2);
      const got = expectedAt(M, x, y);
      assert.ok(Math.abs(got - want) < 1e-4, `(${sx},${sy},${rho}) at (${x},${y}): ${got} vs ${want}`);
    }
  }
});

test("analytic kernel agrees with the truncated discrete kernel", () => {
  const mapper = new ExpectedScoreMapper();
  for (const [sx, sy, rho, res] of [[3, 3, 0, 1], [20, 20, 0, 1], [15, 40, 0.6, 1], [60, 25, -0.4, 2], [1.5, 1.5, 0, 1]]) {
    const a = mapper.compute({ sx, sy, rho, res, kernel: "analytic" });
    const d = mapper.compute({ sx, sy, rho, res, kernel: "discrete" });
    assert.equal(a.n, d.n);
    let worst = 0;
    for (let k = 0; k < a.E.length; k++) worst = Math.max(worst, Math.abs(a.E[k] - d.E[k]));
    assert.ok(worst < 0.01, `(${sx},${sy},${rho},${res}): max diff ${worst}`);
    assert.ok(Math.abs(a.bestValue - d.bestValue) < 0.01);
  }
});

test("very narrow spreads fall back to the discrete kernel", () => {
  const M = new ExpectedScoreMapper().compute({ sx: 0.5, sy: 0.5, res: 1 });
  assert.equal(M.kernel, "discrete");
  assert.ok(Math.abs(M.bestValue - 60) < 1e-9, String(M.bestValue));
});

test("a tight thrower should aim at T20, a wild one lower left", () => {
  const mapper = new ExpectedScoreMapper();
  const tight = mapper.compute({ sx: 5, sy: 5, res: 1 });
  assert.equal(tight.best[0], 0);
  assert.ok(tight.best[1] >= 99 && tight.best[1] < 107, `T20 ring, got ${tight.best}`);
  assert.ok(tight.bestValue > 30);

  const wild = mapper.compute({ sx: 50, sy: 50, res: 1 });
  assert.ok(wild.best[0] < 0 && wild.best[1] < 0, `lower left, got ${wild.best}`);
  assert.ok(Math.hypot(...wild.best) < 100);
});

test("map agrees with a Monte Carlo simulation at the best aim", () => {
  const mapper = new ExpectedScoreMapper();
  const M = mapper.compute({ sx: 20, sy: 30, rho: 0.3, res: 0.5 });
  const mc = monteCarlo(M.best, 20, 30, 0.3, 200000, new Rng(7));
  assert.ok(Math.abs(mc.mean - M.bestValue) < 4 * mc.se + 0.05,
    `map ${M.bestValue}, MC ${mc.mean} +/- ${mc.se}`);
});

test("map metadata and interpolation", () => {
  const M = new ExpectedScoreMapper().compute({ sx: 10, sy: 10, res: 1, view: 180 });
  assert.equal(M.n, 361);
  assert.equal(M.axis0, -180);
  assert.ok(M.min >= -1e-9 && M.max === M.bestValue);
  assert.ok(Math.abs(sampleBilinear(M, 10, 20) - expectedAt(M, 10, 20)) < 1e-6);
  assert.equal(sampleBilinear(M, 500, 0), 0);
  assert.throws(() => new ExpectedScoreMapper().compute({ sx: 0, sy: 1 }), /sigma/);
  assert.throws(() => new ExpectedScoreMapper().compute({ sx: 1, sy: 1, rho: 1 }), /rho/);
});
