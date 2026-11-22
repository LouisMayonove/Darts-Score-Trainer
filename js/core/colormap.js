// Matplotlib's "Blues" colormap (ColorBrewer, 9 classes), linearly
// interpolated into a 256-entry RGB lookup table.

const BLUES = ["#f7fbff", "#deebf7", "#c6dbef", "#9ecae1", "#6baed6",
               "#4292c6", "#2171b5", "#08519c", "#08306b"];

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** Uint8Array(256 * 3) lookup table for a list of evenly spaced hex stops. */
export function buildLut(stops = BLUES) {
  const rgb = stops.map(hexToRgb);
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (rgb.length - 1);
    const k = Math.min(rgb.length - 2, Math.floor(t));
    const f = t - k;
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = Math.round(rgb[k][c] * (1 - f) + rgb[k + 1][c] * f);
  }
  return lut;
}

export const BLUES_LUT = buildLut();

/** CSS color string for t in [0, 1]. */
export function lutColor(t, lut = BLUES_LUT) {
  const i = Math.max(0, Math.min(255, Math.round(t * 255))) * 3;
  return `rgb(${lut[i]}, ${lut[i + 1]}, ${lut[i + 2]})`;
}
