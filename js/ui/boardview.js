// A dartboard drawn on a canvas: either an expected-score heatmap or the
// board in its real colours, with wires, sector numbers and overlays.
//
// Everything is drawn through a "projector" that maps board millimetres to
// CSS pixels, so the same scene can be drawn again zoomed in (the loupe shown
// while placing a dart with a finger).

import {
  SECTORS, R_BULLSEYE, R_BULL, R_TRIPLE_IN, R_TRIPLE_OUT, R_DOUBLE_IN, R_DOUBLE_OUT,
  sectorCentreAngle, sectorEdgeAngle,
} from "../core/board.js";
import { BLUES_LUT } from "../core/colormap.js";

export const BOARD_COLORS = {
  black: "#1f1f1f",
  cream: "#efe2bf",
  red: "#d32a2a",
  green: "#1b8a43",
  surround: "#141414",
};

const RINGS = [R_BULLSEYE, R_BULL, R_TRIPLE_IN, R_TRIPLE_OUT, R_DOUBLE_IN, R_DOUBLE_OUT];

export class BoardView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{mode?: "heatmap" | "board", extent?: number}} opts
   *   extent: half-width of the visible square in mm (default 200).
   */
  constructor(canvas, { mode = "heatmap", extent = 200 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.mode = mode;
    this.extent = extent;
    this.image = null;           // heatmap canvas
    this.imageRect = null;       // [x0, y0, x1, y1] in mm
    this.overlay = null;         // (ctx, P) => void, drawn on top
    this.loupe = null;           // [x, y] mm to magnify, or null
    this.size = 0;
    this.queued = false;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const size = Math.max(1, Math.round(Math.min(rect.width, rect.height || rect.width)));
    const dpr = window.devicePixelRatio || 1;
    if (size === this.size && this.dpr === dpr) return;
    this.size = size;
    this.dpr = dpr;
    this.canvas.width = Math.round(size * dpr);
    this.canvas.height = Math.round(size * dpr);
    this.renderNow();
  }

  /** Projector for the main view. */
  projector() {
    const s = this.size / (2 * this.extent);
    const c = this.size / 2;
    return { s, px: (x) => c + x * s, py: (y) => c - y * s };
  }

  /** Board coordinates (mm) of a pointer event. */
  toBoard(evt) {
    const rect = this.canvas.getBoundingClientRect();
    const s = rect.width / (2 * this.extent);
    return [
      (evt.clientX - rect.left - rect.width / 2) / s,
      -(evt.clientY - rect.top - rect.height / 2) / s,
    ];
  }

  /**
   * Show an expected-score map. bias shifts the picture so that each pixel
   * means "expected score when aiming here" for darts landing at aim + bias.
   * vmin/vmax fix the colour scale (default: the map's own range).
   */
  setMap(M, bias = [0, 0], vmin = M.min, vmax = M.max) {
    const n = M.n;
    if (!this.image || this.image.width !== n) {
      this.image = document.createElement("canvas");
      this.image.width = n;
      this.image.height = n;
    }
    const ictx = this.image.getContext("2d");
    const img = ictx.createImageData(n, n);
    const d = img.data;
    const span = vmax - vmin || 1;
    for (let i = 0; i < n; i++) {
      const src = i * n;
      const dst = (n - 1 - i) * n * 4;       // row 0 of E is the bottom
      for (let j = 0; j < n; j++) {
        let t = (M.E[src + j] - vmin) / span;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const l = Math.round(t * 255) * 3;
        const o = dst + j * 4;
        d[o] = BLUES_LUT[l];
        d[o + 1] = BLUES_LUT[l + 1];
        d[o + 2] = BLUES_LUT[l + 2];
        d[o + 3] = 255;
      }
    }
    ictx.putImageData(img, 0, 0);
    const h = M.res / 2;
    const x0 = M.axis0 - h - bias[0];
    const y0 = M.axis0 - h - bias[1];
    this.imageRect = [x0, y0, x0 + n * M.res, y0 + n * M.res];
    this.render();
  }

  /** Schedule a redraw on the next animation frame. */
  render() {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.renderNow();
    });
  }

  renderNow() {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.size, this.size);
    this.drawScene(ctx, this.projector());
    if (this.loupe) this.drawLoupe(ctx);
  }

  drawScene(ctx, P) {
    if (this.mode === "board") drawRealBoard(ctx, P);
    else if (this.image) {
      const [x0, y0, x1, y1] = this.imageRect;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(this.image, P.px(x0), P.py(y1), (x1 - x0) * P.s, (y1 - y0) * P.s);
    }
    drawWires(ctx, P);
    drawNumbers(ctx, P, this.mode === "board" ? "#f2f2f2" : "#222");
    if (this.overlay) this.overlay(ctx, P);
  }

  drawLoupe(ctx) {
    const [lx, ly] = this.loupe;
    const main = this.projector();
    const r = Math.min(80, this.size * 0.2);
    // Put the loupe in the corner away from the finger.
    const fx = main.px(lx), fy = main.py(ly);
    const cx = fx < this.size / 2 ? this.size - r - 8 : r + 8;
    const cy = fy < this.size / 2 ? this.size - r - 8 : r + 8;
    const z = 4;
    const s = main.s * z;
    const P = { s, px: (x) => cx + (x - lx) * s, py: (y) => cy - (y - ly) * s };
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.fillStyle = "#777";
    ctx.fill();
    ctx.clip();
    this.drawScene(ctx, P);
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - r, cy); ctx.lineTo(cx - 6, cy);
    ctx.moveTo(cx + 6, cy); ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy - 6);
    ctx.moveTo(cx, cy + 6); ctx.lineTo(cx, cy + r);
    ctx.stroke();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// Scene pieces
// ---------------------------------------------------------------------------

function wedge(ctx, P, r0, r1, a0, a1) {
  // Canvas angles run clockwise (y down), board angles counter-clockwise.
  // Sector k runs from edge angle a0 down to a1 = a0 - 18 deg, i.e. from -a0
  // up to -a1 on the canvas.
  const cx = P.px(0), cy = P.py(0);
  ctx.beginPath();
  ctx.arc(cx, cy, r1 * P.s, -a0, -a1, false);
  ctx.arc(cx, cy, r0 * P.s, -a1, -a0, true);
  ctx.closePath();
}

export function drawRealBoard(ctx, P) {
  const cx = P.px(0), cy = P.py(0);
  ctx.fillStyle = BOARD_COLORS.surround;
  ctx.beginPath();
  ctx.arc(cx, cy, 200 * P.s, 0, 2 * Math.PI);
  ctx.fill();
  for (let k = 0; k < 20; k++) {
    const a0 = sectorEdgeAngle(k), a1 = sectorEdgeAngle(k + 1);
    const even = k % 2 === 0;
    const single = even ? BOARD_COLORS.black : BOARD_COLORS.cream;
    const ring = even ? BOARD_COLORS.red : BOARD_COLORS.green;
    const bands = [
      [R_BULL, R_TRIPLE_IN, single], [R_TRIPLE_IN, R_TRIPLE_OUT, ring],
      [R_TRIPLE_OUT, R_DOUBLE_IN, single], [R_DOUBLE_IN, R_DOUBLE_OUT, ring],
    ];
    for (const [r0, r1, color] of bands) {
      wedge(ctx, P, r0, r1, a0, a1);
      ctx.fillStyle = color;
      ctx.fill();
    }
  }
  ctx.fillStyle = BOARD_COLORS.green;
  ctx.beginPath();
  ctx.arc(cx, cy, R_BULL * P.s, 0, 2 * Math.PI);
  ctx.fill();
  ctx.fillStyle = BOARD_COLORS.red;
  ctx.beginPath();
  ctx.arc(cx, cy, R_BULLSEYE * P.s, 0, 2 * Math.PI);
  ctx.fill();
}

export function drawWires(ctx, P) {
  const cx = P.px(0), cy = P.py(0);
  const path = new Path2D();
  for (const r of RINGS) {
    path.moveTo(cx + r * P.s, cy);
    path.arc(cx, cy, r * P.s, 0, 2 * Math.PI);
  }
  for (let k = 0; k < 20; k++) {
    const a = sectorEdgeAngle(k);
    const ux = Math.cos(a), uy = Math.sin(a);
    path.moveTo(P.px(R_BULL * ux), P.py(R_BULL * uy));
    path.lineTo(P.px(R_DOUBLE_OUT * ux), P.py(R_DOUBLE_OUT * uy));
  }
  const w = Math.max(0.6, Math.min(1.4, P.s * 1.2));
  ctx.lineWidth = w * 2.2;
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.stroke(path);
  ctx.lineWidth = w;
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.stroke(path);
}

export function drawNumbers(ctx, P, color) {
  const size = Math.max(9, Math.min(22, 10 * P.s));
  ctx.font = `700 ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  SECTORS.forEach((n, k) => {
    const a = sectorCentreAngle(k);
    ctx.fillText(String(n), P.px(186 * Math.cos(a)), P.py(186 * Math.sin(a)));
  });
}

// ---------------------------------------------------------------------------
// Overlay helpers (sizes in CSS pixels, positions in mm)
// ---------------------------------------------------------------------------

/** Five-pointed star marker. */
export function drawStar(ctx, P, x, y, r = 12, fill = "#FFD43B") {
  const cx = P.px(x), cy = P.py(y);
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const px = cx + rad * Math.cos(a), py = cy + rad * Math.sin(a);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = "#000";
  ctx.stroke();
}

/** Text in a rounded white box, offset up and right from (x, y). */
export function drawLabel(ctx, P, x, y, text, { dx = 12, dy = -14, size = 13 } = {}) {
  ctx.font = `700 ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const w = ctx.measureText(text).width + 10;
  const h = size + 8;
  let bx = P.px(x) + dx, by = P.py(y) + dy - h / 2;
  const max = ctx.canvas.width / (window.devicePixelRatio || 1);
  if (bx + w > max - 2) bx = P.px(x) - dx - w;      // keep inside the canvas
  if (by < 2) by = P.py(y) + 10;
  ctx.fillStyle = "rgba(255,255,255,0.88)";
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(bx, by, w, h, 4); else ctx.rect(bx, by, w, h);
  ctx.fill();
  ctx.fillStyle = "#000";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, bx + 5, by + h / 2 + 0.5);
}

/** Small filled dots for a Float64Array [x0, y0, x1, y1, ...]. */
export function drawDots(ctx, P, pts, color = "rgba(217,72,15,0.6)", r = 2.2) {
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < pts.length; i += 2) {
    const x = P.px(pts[i]), y = P.py(pts[i + 1]);
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, 2 * Math.PI);
  }
  ctx.fill();
}

/** X markers for an array of [x, y]. */
export function drawCrosses(ctx, P, points, { color = "#000", halo = null, r = 4, width = 1.4 } = {}) {
  const path = new Path2D();
  for (const [x, y] of points) {
    const cx = P.px(x), cy = P.py(y);
    path.moveTo(cx - r, cy - r); path.lineTo(cx + r, cy + r);
    path.moveTo(cx - r, cy + r); path.lineTo(cx + r, cy - r);
  }
  ctx.lineCap = "round";
  if (halo) {
    ctx.lineWidth = width + 2.2;
    ctx.strokeStyle = halo;
    ctx.stroke(path);
  }
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.stroke(path);
  ctx.lineCap = "butt";
}

/** Target marker: a plus inside a ring. */
export function drawTarget(ctx, P, x, y, color = "#00B4D8") {
  const cx = P.px(x), cy = P.py(y);
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  const draw = () => {
    ctx.beginPath();
    ctx.moveTo(cx - 14, cy); ctx.lineTo(cx + 14, cy);
    ctx.moveTo(cx, cy - 14); ctx.lineTo(cx, cy + 14);
    ctx.moveTo(cx + 7, cy);
    ctx.arc(cx, cy, 7, 0, 2 * Math.PI);
    ctx.stroke();
  };
  draw();
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  draw();
}

/** Ellipse centred at (x, y) with semi-axes a, b (mm) and angle (radians). */
export function drawEllipse(ctx, P, x, y, { a, b, angle }, color = "#00B4D8", dash = []) {
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(P.px(x), P.py(y), Math.max(a * P.s, 0.5), Math.max(b * P.s, 0.5), -angle, 0, 2 * Math.PI);
  ctx.setLineDash(dash);
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = "rgba(0,0,0,0.45)";
  ctx.stroke();
  ctx.lineWidth = 1.8;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.restore();
}

/** Small ring marker (e.g. a pinned aim point). */
export function drawRing(ctx, P, x, y, color = "#fff", r = 6) {
  ctx.beginPath();
  ctx.arc(P.px(x), P.py(y), r, 0, 2 * Math.PI);
  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(0,0,0,0.6)";
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.stroke();
}

/**
 * Vertical colour bar on its own canvas, with tick labels.
 */
export function drawColorbar(canvas, vmin, vmax) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(rect.width)), h = Math.max(1, Math.round(rect.height));
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const barW = 14, top = 8, bottom = h - 8, barH = bottom - top;
  const grad = ctx.createLinearGradient(0, bottom, 0, top);
  for (let i = 0; i <= 16; i++) {
    const l = Math.round((i / 16) * 255) * 3;
    grad.addColorStop(i / 16, `rgb(${BLUES_LUT[l]},${BLUES_LUT[l + 1]},${BLUES_LUT[l + 2]})`);
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, top, barW, barH);
  const style = getComputedStyle(canvas);
  ctx.fillStyle = style.color;
  ctx.strokeStyle = style.color;
  ctx.font = `12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const span = vmax - vmin;
  if (!(span > 0)) return;
  const step = niceStep(span / 5);
  for (let v = Math.ceil(vmin / step) * step; v <= vmax + 1e-9; v += step) {
    const y = bottom - ((v - vmin) / span) * barH;
    ctx.fillRect(barW, Math.round(y) - 0.5, 4, 1);
    ctx.fillText(formatTick(v, step), barW + 7, y);
  }
}

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
}

function formatTick(v, step) {
  const digits = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  return v.toFixed(digits);
}
