// Random numbers, simulated throws, Monte Carlo check and Gaussian fitting.

import { score } from "./board.js";

/** Small seeded PRNG (mulberry32) with uniform and standard-normal draws. */
export class Rng {
  constructor(seed = 0) {
    this.state = (seed >>> 0) || 0x9e3779b9;
    this.spare = null;
  }

  /** Uniform in [0, 1). */
  next() {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Standard normal (Box-Muller, the second draw is kept for the next call). */
  normal() {
    if (this.spare !== null) {
      const s = this.spare;
      this.spare = null;
      return s;
    }
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }
}

/** n pairs of standard-normal draws, as a Float64Array [z1x, z1y, z2x, ...]. */
export function standardNormals(n, rng) {
  const z = new Float64Array(2 * n);
  for (let i = 0; i < 2 * n; i++) z[i] = rng.normal();
  return z;
}

/**
 * Map standard-normal pairs z to landing points centred at `centre` with
 * spread (sx, sy, rho), through the Cholesky factor of the covariance.
 * Reusing the same z makes a throw cloud morph smoothly as the spread changes.
 */
export function transformNormals(z, centre, sx, sy, rho) {
  const out = new Float64Array(z.length);
  const c = Math.sqrt(1 - rho * rho);
  for (let i = 0; i < z.length; i += 2) {
    out[i] = centre[0] + sx * z[i];
    out[i + 1] = centre[1] + sy * (rho * z[i] + c * z[i + 1]);
  }
  return out;
}

/** Simulate n throws at `centre`; return { mean, se } of the score. */
export function monteCarlo(centre, sx, sy, rho, n = 200000, rng = new Rng(0)) {
  const c = Math.sqrt(1 - rho * rho);
  let sum = 0, sumSq = 0;
  for (let i = 0; i < n; i++) {
    const z1 = rng.normal(), z2 = rng.normal();
    const s = score(centre[0] + sx * z1, centre[1] + sy * (rho * z1 + c * z2));
    sum += s;
    sumSq += s * s;
  }
  const mean = sum / n;
  const variance = n > 1 ? (sumSq - n * mean * mean) / (n - 1) : 0;
  return { mean, se: Math.sqrt(Math.max(variance, 0) / n) };
}

/**
 * Fit a 2D Gaussian to landing points thrown at `aim`.
 * points: array of [x, y]. Returns { bias: [bx, by], sx, sy, rho, mean }.
 * Uses the unbiased (n - 1) covariance, like numpy.cov.
 */
export function fitGaussian(points, aim) {
  const n = points.length;
  if (n < 3) throw new Error("need at least 3 throws to fit a distribution");
  let mx = 0, my = 0;
  for (const [x, y] of points) { mx += x; my += y; }
  mx /= n; my /= n;
  let cxx = 0, cyy = 0, cxy = 0;
  for (const [x, y] of points) {
    const dx = x - mx, dy = y - my;
    cxx += dx * dx; cyy += dy * dy; cxy += dx * dy;
  }
  cxx /= n - 1; cyy /= n - 1; cxy /= n - 1;
  const sx = Math.sqrt(cxx), sy = Math.sqrt(cyy);
  const rho = sx > 0 && sy > 0 ? cxy / (sx * sy) : 0;
  return { bias: [mx - aim[0], my - aim[1]], sx, sy, rho, mean: [mx, my] };
}

/**
 * Axes of the k-sigma ellipse of the spread (sx, sy, rho):
 * { a, b, angle } with semi-axes a >= b (mm) and angle of a (radians).
 */
export function covarianceEllipse(sx, sy, rho, k = 1) {
  const cxx = sx * sx, cyy = sy * sy, cxy = rho * sx * sy;
  const tr = cxx + cyy;
  const disc = Math.sqrt(Math.max(((cxx - cyy) / 2) ** 2 + cxy * cxy, 0));
  const l1 = tr / 2 + disc, l2 = Math.max(tr / 2 - disc, 0);
  const angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  return { a: k * Math.sqrt(l1), b: k * Math.sqrt(l2), angle };
}
