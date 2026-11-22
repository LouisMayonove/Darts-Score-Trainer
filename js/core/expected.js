// Expected score of one dart for every aim point.
//
// The landing point is aim + N(0, Sigma). The expected-score map is the
// board's score function convolved with the Gaussian, done exactly on a grid
// with a 2D FFT (port of expected_score_map in reference/dart_heatmap.py).
//
// The Gaussian is symmetric about its centre, so convolution equals the
// correlation E(a) = sum_z S(a + z) p(z) that we want. The score is zero
// off the board, so a circular convolution is exact as long as the FFT size
// keeps the wrapped-around copies away from the part of the map we return.
//
// Two kernels are available:
//   "analytic" (default): the DFT of the sampled, untruncated Gaussian,
//       written in closed form (Poisson summation). It saves one 2D FFT per
//       map, which is what keeps the sliders live.
//   "discrete": the sampled Gaussian truncated at 4 sigma and renormalised,
//       transformed with an FFT. Identical to the Python script.
// The two differ by the Gaussian mass beyond 4 sigma: below 0.01 points.

import { score, R_DOUBLE_OUT } from "./board.js";
import { fft1d, fftColumns, nextPow2 } from "./fft.js";

/**
 * Discrete, normalised 2D Gaussian on a grid with spacing `res` (mm),
 * truncated at n_sigma * max(sx, sy), as in the Python script.
 * Returns { half, size, data } with data row-major (row = y, column = x).
 */
export function gaussianKernel(sx, sy, rho, res, nSigma = 4) {
  const half = Math.ceil((nSigma * Math.max(sx, sy)) / res);
  const size = 2 * half + 1;
  const det = sx * sx * sy * sy * (1 - rho * rho);
  const a = (sy * sy) / det;
  const b = (-rho * sx * sy) / det;
  const c = (sx * sx) / det;
  const data = new Float64Array(size * size);
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const y = (i - half) * res;
    for (let j = 0; j < size; j++) {
      const x = (j - half) * res;
      const v = Math.exp(-0.5 * (a * x * x + 2 * b * x * y + c * y * y));
      data[i * size + j] = v;
      sum += v;
    }
  }
  for (let i = 0; i < data.length; i++) data[i] /= sum;
  return { half, size, data };
}

/** Standard deviation along the narrowest axis of the spread. */
function minorSigma(sx, sy, rho) {
  const cxx = sx * sx, cyy = sy * sy, cxy = rho * sx * sy;
  const disc = Math.sqrt(((cxx - cyy) / 2) ** 2 + cxy * cxy);
  return Math.sqrt(Math.max((cxx + cyy) / 2 - disc, 0));
}

/**
 * Number of alias terms per axis the analytic spectrum needs, or -1 when the
 * spread is so narrow compared to the grid that the discrete kernel is the
 * better choice. Alias k sits at least (2k - 1) * pi / res away in frequency.
 */
function aliasTerms(sx, sy, rho, res) {
  const t = (minorSigma(sx, sy, rho) * Math.PI) / res;
  if (t > 6.8) return 0;           // exp(-t^2 / 2) < 1e-10
  if (3 * t > 6.8) return 1;
  return -1;
}

/**
 * Real spectrum (N x N, row = y frequency) of the sampled Gaussian, wrapped
 * on an N-periodic grid, normalised to sum 1: exactly what an FFT of the
 * untruncated sampled kernel would give.
 */
function analyticSpectrum(sx, sy, rho, res, N, A) {
  const out = new Float64Array(N * N);
  const a = 0.5 * sx * sx, b = rho * sx * sy, c = 0.5 * sy * sy;
  const step = (2 * Math.PI) / (N * res);
  const alias = (2 * Math.PI) / res;
  for (let p = 0; p < N; p++) {
    const fy = (p < N / 2 ? p : p - N) * step;
    const row = p * N;
    for (let q = 0; q < N; q++) {
      const fx = (q < N / 2 ? q : q - N) * step;
      let v;
      if (A === 0) {
        v = Math.exp(-(a * fx * fx + b * fx * fy + c * fy * fy));
      } else {
        v = 0;
        for (let u = -A; u <= A; u++) {
          const wy = fy + u * alias;
          for (let t = -A; t <= A; t++) {
            const wx = fx + t * alias;
            v += Math.exp(-(a * wx * wx + b * wx * wy + c * wy * wy));
          }
        }
      }
      out[row + q] = v;
    }
  }
  const dc = out[0];
  for (let k = 0; k < N * N; k++) out[k] /= dc;
  return out;
}

/** Wrap a signed index into [0, n). */
const wrap = (i, n) => ((i % n) + n) % n;

/**
 * Computes expected-score maps, caching the FFT of the board for each grid
 * resolution and FFT size (so live slider updates only transform the kernel).
 */
export class ExpectedScoreMapper {
  constructor() {
    this.boardCache = new Map();
  }

  /** FFT of the score grid S, centred on index 0 (wrapped). */
  boardSpectrum(res, N) {
    const key = `${res}|${N}`;
    let cached = this.boardCache.get(key);
    if (cached) return cached;
    const m = Math.ceil(R_DOUBLE_OUT / res);
    const re = new Float64Array(N * N);
    const im = new Float64Array(N * N);
    const rows = [];
    for (let i = -m; i <= m; i++) {
      const row = wrap(i, N);
      rows.push(row);
      for (let j = -m; j <= m; j++) re[row * N + wrap(j, N)] = score(j * res, i * res);
    }
    forward2d(re, im, N, rows);
    cached = { re, im };
    // Keep the cache small: a handful of (res, N) combinations at most.
    if (this.boardCache.size >= 6) this.boardCache.delete(this.boardCache.keys().next().value);
    this.boardCache.set(key, cached);
    return cached;
  }

  /**
   * Expected-score map for spread (sx, sy, rho), on the square [-view, view]^2.
   *
   * Returns { axis0, res, n, E, best: [x, y], bestValue, min, max, ... } where
   * E[i * n + j] is the expected score when the darts are centred on
   * (axis0 + j * res, axis0 + i * res).
   */
  compute({ sx, sy, rho = 0, res = 1, view = 200, kernel = "analytic" }) {
    if (!(sx > 0 && sy > 0)) throw new Error("sigma must be positive");
    if (!(rho > -1 && rho < 1)) throw new Error("rho must be strictly between -1 and 1");
    const v = Math.ceil(view / res - 1e-9);
    const n = 2 * v + 1;
    const m = Math.ceil(R_DOUBLE_OUT / res);
    const A = kernel === "analytic" ? aliasTerms(sx, sy, rho, res) : -1;
    const useAnalytic = A >= 0;

    // Kernel reach in grid steps. The analytic kernel is not truncated, so
    // leave room for 5 sigma of tail (mass beyond: < 4e-6) before wrapping.
    const h = Math.ceil(((useAnalytic ? 5 : 4) * Math.max(sx, sy)) / res);
    const N = nextPow2(Math.max(v + m + h + 1, 2 * h + 1, 2 * m + 1));
    const board = this.boardSpectrum(res, N);
    const br = board.re, bi = board.im;

    const pr = new Float64Array(N * N);
    const pi = new Float64Array(N * N);
    if (useAnalytic) {
      const K = analyticSpectrum(sx, sy, rho, res, N, A);
      for (let k = 0; k < N * N; k++) { pr[k] = br[k] * K[k]; pi[k] = bi[k] * K[k]; }
    } else {
      // Truncated kernel, centred on index 0 (wrapped); only 2h+1 rows non-zero.
      const g = gaussianKernel(sx, sy, rho, res);
      const rows = [];
      for (let i = -g.half; i <= g.half; i++) {
        const row = wrap(i, N);
        rows.push(row);
        for (let j = -g.half; j <= g.half; j++) {
          pr[row * N + wrap(j, N)] = g.data[(i + g.half) * g.size + (j + g.half)];
        }
      }
      forward2d(pr, pi, N, rows);
      for (let k = 0; k < N * N; k++) {
        const r = br[k] * pr[k] - bi[k] * pi[k];
        const q = br[k] * pi[k] + bi[k] * pr[k];
        pr[k] = r;
        pi[k] = q;
      }
    }

    // Inverse: all columns, then only the rows we return.
    const outRows = [];
    for (let i = -v; i <= v; i++) outRows.push(wrap(i, N));
    inverse2d(pr, pi, N, outRows);

    const E = new Float32Array(n * n);
    let best = 0, bestValue = -Infinity, min = Infinity, max = -Infinity;
    for (let i = 0; i < n; i++) {
      const row = wrap(i - v, N) * N;
      for (let j = 0; j < n; j++) {
        const val = pr[row + wrap(j - v, N)];
        const idx = i * n + j;
        E[idx] = val;
        if (val > bestValue) { bestValue = val; best = idx; }
        if (val < min) min = val;
        if (val > max) max = val;
      }
    }
    const axis0 = -v * res;
    const bestRow = Math.floor(best / n), bestCol = best % n;
    return {
      axis0, res, n, E,
      best: [axis0 + bestCol * res, axis0 + bestRow * res],
      bestValue, min, max,
      sx, sy, rho, fftSize: N, kernel: useAnalytic ? "analytic" : "discrete",
    };
  }
}

/** Row transforms (only the listed rows; the others are all zero), then columns. */
function forward2d(re, im, N, rows) {
  for (const r of rows) fft1d(re, im, N, r * N, false);
  fftColumns(re, im, N, false);
}

/** Column transforms, then row transforms of `rows` only; normalised by 1/N^2. */
function inverse2d(re, im, N, rows) {
  fftColumns(re, im, N, true);
  const s = 1 / (N * N);
  for (const r of rows) {
    fft1d(re, im, N, r * N, true);
    for (let k = r * N; k < (r + 1) * N; k++) re[k] *= s;
  }
}

/** Expected score from map M when the darts are centred at (x, y): nearest grid point. */
export function expectedAt(M, x, y) {
  const j = Math.min(M.n - 1, Math.max(0, Math.round((x - M.axis0) / M.res)));
  const i = Math.min(M.n - 1, Math.max(0, Math.round((y - M.axis0) / M.res)));
  return M.E[i * M.n + j];
}

/** Bilinear interpolation of map M at (x, y); 0 outside the map. */
export function sampleBilinear(M, x, y) {
  const fx = (x - M.axis0) / M.res;
  const fy = (y - M.axis0) / M.res;
  if (fx < 0 || fy < 0 || fx > M.n - 1 || fy > M.n - 1) return 0;
  const j = Math.min(M.n - 2, Math.floor(fx));
  const i = Math.min(M.n - 2, Math.floor(fy));
  const tx = fx - j, ty = fy - i;
  const e = M.E, n = M.n;
  const a = e[i * n + j], b = e[i * n + j + 1];
  const c = e[(i + 1) * n + j], d = e[(i + 1) * n + j + 1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}
