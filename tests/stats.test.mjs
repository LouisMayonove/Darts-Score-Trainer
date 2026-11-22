// Unit tests for random draws, fitting and the throws CSV format.

import test from "node:test";
import assert from "node:assert/strict";
import { Rng, standardNormals, transformNormals, fitGaussian, covarianceEllipse, monteCarlo } from "../js/core/stats.js";
import { formatThrowsCsv, parseThrowsCsv } from "../js/core/throws.js";

test("Rng is deterministic and roughly standard normal", () => {
  const a = new Rng(42), b = new Rng(42);
  for (let i = 0; i < 10; i++) assert.equal(a.next(), b.next());
  const z = standardNormals(50000, new Rng(3));
  let m = 0, v = 0;
  for (const x of z) m += x;
  m /= z.length;
  for (const x of z) v += (x - m) ** 2;
  v /= z.length - 1;
  assert.ok(Math.abs(m) < 0.02 && Math.abs(v - 1) < 0.03, `mean ${m}, var ${v}`);
});

test("fit recovers the spread of simulated throws", () => {
  const z = standardNormals(40000, new Rng(5));
  const pts = transformNormals(z, [10, 95], 18, 30, -0.5);
  const points = [];
  for (let i = 0; i < pts.length; i += 2) points.push([pts[i], pts[i + 1]]);
  const fit = fitGaussian(points, [0, 103]);
  assert.ok(Math.abs(fit.bias[0] - 10) < 0.5 && Math.abs(fit.bias[1] + 8) < 0.5);
  assert.ok(Math.abs(fit.sx - 18) < 0.4 && Math.abs(fit.sy - 30) < 0.6);
  assert.ok(Math.abs(fit.rho + 0.5) < 0.02);
});

test("fit matches numpy.cov on a small sample", () => {
  // numpy: np.cov([[0,0],[2,1],[4,5],[1,-1]], rowvar=False)
  //   -> [[2.9167, 4.0833], [4.0833, 6.9167]]
  const fit = fitGaussian([[0, 0], [2, 1], [4, 5], [1, -1]], [0, 0]);
  assert.ok(Math.abs(fit.sx - Math.sqrt(35 / 12)) < 1e-12);
  assert.ok(Math.abs(fit.sy - Math.sqrt(83 / 12)) < 1e-12);
  assert.ok(Math.abs(fit.rho - (49 / 12) / Math.sqrt((35 / 12) * (83 / 12))) < 1e-12);
  assert.deepEqual(fit.bias, [1.75, 1.25]);
  assert.throws(() => fitGaussian([[0, 0], [1, 1]], [0, 0]), /at least 3/);
});

test("covariance ellipse", () => {
  const e = covarianceEllipse(10, 10, 0, 2);
  assert.ok(Math.abs(e.a - 20) < 1e-12 && Math.abs(e.b - 20) < 1e-12);
  const t = covarianceEllipse(10, 10, 0.5);
  assert.ok(Math.abs(t.angle - Math.PI / 4) < 1e-12);
  assert.ok(Math.abs(t.a - Math.sqrt(150)) < 1e-9 && Math.abs(t.b - Math.sqrt(50)) < 1e-9);
  const w = covarianceEllipse(30, 5, 0);
  assert.ok(Math.abs(w.angle) < 1e-12 && Math.abs(w.a - 30) < 1e-12);
});

test("Monte Carlo at the bull with a tiny spread scores 50", () => {
  const mc = monteCarlo([0, 0], 0.5, 0.5, 0, 2000, new Rng(1));
  assert.equal(mc.mean, 50);
  assert.equal(mc.se, 0);
});

test("throws CSV round trip, Python format", () => {
  const pts = [[1.234, -5.678], [0, 100]];
  const text = formatThrowsCsv(pts, "T20");
  assert.equal(text, "# aim=T20\n# x_mm,y_mm\n1.23,-5.68\n0.00,100.00\n");
  const back = parseThrowsCsv(text);
  assert.equal(back.aim, "T20");
  assert.deepEqual(back.points, [[1.23, -5.68], [0, 100]]);
});

test("throws CSV parser is forgiving", () => {
  const r = parseThrowsCsv("x_mm,y_mm\r\n1,2\r\n\r\nbad line\n3;4\n5\t6,extra\n,7\n");
  assert.equal(r.aim, null);
  assert.deepEqual(r.points, [[1, 2], [3, 4], [5, 6]]);
});
