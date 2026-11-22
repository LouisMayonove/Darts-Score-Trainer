// Minimal radix-2 complex FFT, 1D and 2D, on split real/imaginary arrays.
//
// Sizes must be powers of two. Plans (twiddles and bit-reversal tables) are
// cached per size, so repeated transforms of the same size are cheap.
//
// The 2D transform does the column pass as whole-row vector operations
// (each butterfly combines two complete rows), which keeps memory access
// contiguous and is several times faster in JS than copying columns out.

const plans = new Map();

function plan(n) {
  let p = plans.get(n);
  if (p) return p;
  if (n < 1 || (n & (n - 1)) !== 0) throw new Error(`FFT size ${n} is not a power of two`);
  const rev = new Uint32Array(n);
  let bits = 0;
  while ((1 << bits) < n) bits++;
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  // Twiddles for every stage, laid out contiguously: the stage with half-size
  // h uses entries [h - 1, 2h - 1): w_k = exp(-2 pi i k / (2h)), k < h.
  const wr = new Float64Array(Math.max(n - 1, 1));
  const wi = new Float64Array(Math.max(n - 1, 1));
  for (let h = 1; h < n; h *= 2) {
    for (let k = 0; k < h; k++) {
      wr[h - 1 + k] = Math.cos((Math.PI * k) / h);
      wi[h - 1 + k] = -Math.sin((Math.PI * k) / h);
    }
  }
  p = { rev, wr, wi };
  plans.set(n, p);
  return p;
}

/** Smallest power of two >= n. */
export function nextPow2(n) {
  let m = 1;
  while (m < n) m *= 2;
  return m;
}

/**
 * In-place FFT of re/im (length n, starting at `offset`).
 * inverse=true computes the unnormalised inverse transform.
 */
export function fft1d(re, im, n, offset = 0, inverse = false) {
  const { rev, wr, wi } = plan(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      const a = offset + i, b = offset + j;
      let t = re[a]; re[a] = re[b]; re[b] = t;
      t = im[a]; im[a] = im[b]; im[b] = t;
    }
  }
  const sign = inverse ? -1 : 1;
  for (let h = 1; h < n; h *= 2) {
    const size = 2 * h;
    for (let k = 0; k < h; k++) {
      const cr = wr[h - 1 + k];
      const ci = sign * wi[h - 1 + k];
      for (let a = offset + k; a < offset + n; a += size) {
        const b = a + h;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

/**
 * FFT along columns of an n x n row-major complex array, in place.
 * Each butterfly combines two whole rows.
 */
export function fftColumns(re, im, n, inverse = false) {
  const { rev, wr, wi } = plan(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      const a = i * n, b = j * n;
      for (let c = 0; c < n; c++) {
        let t = re[a + c]; re[a + c] = re[b + c]; re[b + c] = t;
        t = im[a + c]; im[a + c] = im[b + c]; im[b + c] = t;
      }
    }
  }
  const sign = inverse ? -1 : 1;
  for (let h = 1; h < n; h *= 2) {
    const size = 2 * h;
    for (let k = 0; k < h; k++) {
      const cr = wr[h - 1 + k];
      const ci = sign * wi[h - 1 + k];
      for (let r = k; r < n; r += size) {
        const a0 = r * n, b0 = (r + h) * n;
        for (let c = 0; c < n; c++) {
          const a = a0 + c, b = b0 + c;
          const xr = re[b] * cr - im[b] * ci;
          const xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}

/**
 * In-place 2D FFT of an n x n complex array stored row-major in re/im.
 * inverse=true computes the inverse transform, normalised by 1/n^2.
 */
export function fft2d(re, im, n, inverse = false) {
  for (let r = 0; r < n; r++) fft1d(re, im, n, r * n, inverse);
  fftColumns(re, im, n, inverse);
  if (inverse) {
    const s = 1 / (n * n);
    for (let i = 0; i < n * n; i++) { re[i] *= s; im[i] *= s; }
  }
}
