// Explore tab: live heatmap of the expected score for a chosen spread
// (port of the Python script's interactive mode).

import { regionName } from "../core/board.js";
import { sampleBilinear } from "../core/expected.js";
import { Rng, standardNormals, transformNormals } from "../core/stats.js";
import {
  BoardView, drawColorbar, drawStar, drawLabel, drawDots, drawCrosses, drawRing,
} from "./boardview.js";
import { MapChannel } from "./mapclient.js";
import {
  $, fmt, clamp, formatXY, describeAim, fillTargetTable, standardRows, bindSlider,
} from "./common.js";

const DEFAULTS = { sx: 20, sy: 20, rho: 0, bx: 0, by: 0, link: true, throws: false, res: "auto" };

/**
 * Grid resolution for "auto": fine enough that the grid itself costs under
 * ~0.1 points per dart (see tests/expected.test.mjs), coarse enough to stay live.
 */
export function autoResolution(sx, sy, rho) {
  const cxx = sx * sx, cyy = sy * sy, cxy = rho * sx * sy;
  const minor = Math.sqrt(Math.max((cxx + cyy) / 2 - Math.sqrt(((cxx - cyy) / 2) ** 2 + cxy * cxy), 0));
  return minor < 4 ? 0.5 : 1;
}
const LIMITS = { sigma: [1, 100], rho: [-0.95, 0.95], bias: [-60, 60] };
const MC_THROWS = 200000;

export class ExploreTab {
  constructor({ onStateChange }) {
    this.state = { ...DEFAULTS };
    this.measured = null;       // [[x, y], ...] recorded darts, from the Measure tab
    this.pinned = null;         // [x, y] user aim point
    this.map = null;
    this.mapBias = [0, 0];
    this.mc = null;
    this.onStateChange = onStateChange;
    this.channel = new MapChannel();
    // Fixed standard-normal draws, so the simulated cloud morphs smoothly
    // instead of jumping when the sliders move.
    this.z = standardNormals(400, new Rng(0));

    this.view = new BoardView($("ex-board"));
    this.view.overlay = (ctx, P) => this.drawOverlay(ctx, P);
    this.colorbar = $("ex-colorbar");
    new ResizeObserver(() => this.map && this.drawColorbar()).observe(this.colorbar);

    this.bindControls();
    this.bindBoard();
  }

  // ---------------------------------------------------------------- controls

  bindControls() {
    const s = this.state;
    const sigmaSetter = (key, other) => (v) => {
      s[key] = v;
      if (s.link) s[other] = v;
    };
    this.shows = [
      bindSlider($("ex-sx"), $("ex-sx-num"), {
        get: () => s.sx, set: sigmaSetter("sx", "sy"),
        onInput: () => this.changed(false), onCommit: () => this.changed(true),
      }),
      bindSlider($("ex-sy"), $("ex-sy-num"), {
        get: () => s.sy, set: sigmaSetter("sy", "sx"),
        onInput: () => this.changed(false), onCommit: () => this.changed(true),
      }),
      bindSlider($("ex-rho"), $("ex-rho-num"), {
        get: () => s.rho, set: (v) => { s.rho = v; },
        onInput: () => this.changed(false), onCommit: () => this.changed(true),
      }),
      bindSlider($("ex-bx"), $("ex-bx-num"), {
        get: () => s.bx, set: (v) => { s.bx = v; },
        onInput: () => this.changed(false), onCommit: () => this.changed(true),
      }),
      bindSlider($("ex-by"), $("ex-by-num"), {
        get: () => s.by, set: (v) => { s.by = v; },
        onInput: () => this.changed(false), onCommit: () => this.changed(true),
      }),
    ];

    $("ex-link").addEventListener("change", (e) => {
      s.link = e.target.checked;
      if (s.link) s.sy = s.sx;
      this.changed(true);
    });
    $("ex-preset").addEventListener("change", (e) => {
      if (!e.target.value) return;
      const [sx, sy, rho] = e.target.value.split(",").map(Number);
      Object.assign(s, { sx, sy, rho, link: sx === sy });
      this.changed(true);
    });
    $("ex-throws").addEventListener("change", (e) => { s.throws = e.target.checked; this.syncInputs(); this.view.render(); this.onStateChange(); });
    $("ex-measured").addEventListener("change", () => this.view.render());
    $("ex-res").addEventListener("change", (e) => {
      s.res = e.target.value === "auto" ? "auto" : Number(e.target.value);
      this.changed(true);
    });
    $("ex-reset").addEventListener("click", () => {
      Object.assign(s, DEFAULTS);
      this.measured = null;
      this.pinned = null;
      this.changed(true);
    });
    $("ex-share").addEventListener("click", async () => {
      const btn = $("ex-share");
      try {
        await navigator.clipboard.writeText(location.href);
        btn.textContent = "Copied!";
      } catch {
        btn.textContent = "Copy failed";
      }
      setTimeout(() => { btn.textContent = "Copy link"; }, 1500);
    });
  }

  /** Reflect the state in every input. */
  syncInputs() {
    const s = this.state;
    for (const show of this.shows) show();
    $("ex-link").checked = s.link;
    $("ex-throws").checked = s.throws;
    $("ex-res").value = String(s.res);
    $("ex-measured-row").hidden = !this.measured;
    const preset = `${s.sx},${s.sy},${s.rho}`;
    const sel = $("ex-preset");
    sel.value = [...sel.options].some((o) => o.value === preset) ? preset : "";
  }

  /** Something changed: refresh inputs, URL and map. final = slider released. */
  changed(final) {
    this.syncInputs();
    this.onStateChange();
    this.requestMap(final);
  }

  // ---------------------------------------------------------------- state I/O

  /** URL query fragment for the current settings. */
  toQuery() {
    const s = this.state, q = new URLSearchParams();
    q.set("sx", s.sx);
    q.set("sy", s.sy);
    if (s.rho) q.set("rho", s.rho);
    if (s.bx) q.set("bx", s.bx);
    if (s.by) q.set("by", s.by);
    if (s.throws) q.set("throws", 1);
    if (s.res !== DEFAULTS.res) q.set("res", s.res);
    return q.toString();
  }

  fromQuery(query) {
    const q = new URLSearchParams(query);
    const num = (k, d, [lo, hi]) => {
      const v = Number(q.get(k));
      return q.has(k) && Number.isFinite(v) ? clamp(v, lo, hi) : d;
    };
    const s = this.state;
    s.sx = num("sx", DEFAULTS.sx, LIMITS.sigma);
    s.sy = num("sy", s.sx, LIMITS.sigma);
    s.rho = num("rho", 0, LIMITS.rho);
    s.bx = num("bx", 0, LIMITS.bias);
    s.by = num("by", 0, LIMITS.bias);
    s.link = s.sx === s.sy;
    s.throws = q.get("throws") === "1";
    s.res = [0.5, 1, 2].includes(Number(q.get("res"))) ? Number(q.get("res")) : DEFAULTS.res;
    this.syncInputs();
    this.requestMap(true);
  }

  /**
   * Load a fitted pattern from the Measure tab. Values beyond the slider
   * range are clipped; returns a list of what was clipped.
   */
  applyMeasured({ sx, sy, rho, bias, points }) {
    const clipped = [];
    const c = (v, [lo, hi], name) => {
      const r = clamp(v, lo, hi);
      if (Math.abs(r - v) > 1e-9) clipped.push(name);
      return Math.round(r * 100) / 100;
    };
    Object.assign(this.state, {
      sx: c(sx, LIMITS.sigma, "σx"),
      sy: c(sy, LIMITS.sigma, "σy"),
      rho: c(rho, LIMITS.rho, "ρ"),
      bx: c(bias[0], LIMITS.bias, "bias"),
      by: c(bias[1], LIMITS.bias, "bias"),
      link: false,
    });
    this.measured = points.map((p) => p.slice());
    this.pinned = null;
    $("ex-measured").checked = true;
    this.changed(true);
    return [...new Set(clipped)];
  }

  // ---------------------------------------------------------------- map

  async requestMap(withMonteCarlo) {
    const s = this.state;
    const bias = [s.bx, s.by];
    // Widen the computed area by the bias so the shifted map still covers
    // the whole visible board.
    const view = 200 + Math.ceil(Math.max(Math.abs(s.bx), Math.abs(s.by)));
    const res = s.res === "auto" ? autoResolution(s.sx, s.sy, s.rho) : s.res;
    const params = { sx: s.sx, sy: s.sy, rho: s.rho, res, view, mcThrows: withMonteCarlo ? MC_THROWS : 0 };
    $("ex-status").textContent = "Computing…";
    let result;
    try {
      result = await this.channel.request(params);
    } catch (err) {
      $("ex-status").textContent = `Error: ${err.message}`;
      return;
    }
    if (!result) return;                       // superseded by a newer request
    this.map = result.map;
    this.mapBias = bias;
    this.mc = result.mc;
    this.view.setMap(this.map, bias);
    this.drawColorbar();
    this.showResults();
    $("ex-status").textContent = `Grid ${this.map.res} mm · ${this.map.n}² points · FFT ${this.map.fftSize}² · ${Math.round(result.ms)} ms`;
  }

  drawColorbar() {
    drawColorbar(this.colorbar, this.map.min, this.map.max);
  }

  /** Where to aim (centre of the darts minus the bias). */
  bestAim() {
    const M = this.map;
    return [M.best[0] - this.mapBias[0], M.best[1] - this.mapBias[1]];
  }

  showResults() {
    const M = this.map;
    const aim = this.bestAim();
    $("ex-best-region").textContent = describeAim(aim);
    $("ex-best-value").textContent = M.bestValue.toFixed(2);
    $("ex-best-visit").textContent = `${(3 * M.bestValue).toFixed(1)} points`;
    $("ex-best-xy").textContent = formatXY(aim);
    $("ex-mc").textContent = this.mc ? `${this.mc.mean.toFixed(2)} ± ${this.mc.se.toFixed(2)}` : "…";
    const rows = standardRows(aim);
    if (this.pinned) rows.push({ label: `Pinned: ${regionName(...this.pinned)}`, aim: this.pinned, removable: true });
    fillTargetTable($("ex-targets"), rows, M, this.mapBias, () => { this.pinned = null; this.showResults(); this.view.render(); });
    $("ex-pin-hint").hidden = !!this.pinned;
  }

  // ---------------------------------------------------------------- board

  bindBoard() {
    const canvas = $("ex-board");
    let down = null;
    canvas.addEventListener("pointermove", (e) => this.hover(this.view.toBoard(e)));
    canvas.addEventListener("pointerleave", () => {
      $("ex-hover").textContent = "Hover over the board to read the expected score at any aim point. Click to pin it.";
    });
    canvas.addEventListener("pointerdown", (e) => { down = [e.clientX, e.clientY]; this.hover(this.view.toBoard(e)); });
    canvas.addEventListener("pointerup", (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) return;
      down = null;
      const p = this.view.toBoard(e);
      const rect = canvas.getBoundingClientRect();
      const mmPerPx = 400 / rect.width;
      if (this.pinned && Math.hypot(p[0] - this.pinned[0], p[1] - this.pinned[1]) < 10 * mmPerPx) this.pinned = null;
      else this.pinned = p.map((v) => Math.round(v));
      if (this.map) this.showResults();
      this.view.render();
    });
  }

  hover([x, y]) {
    if (!this.map) return;
    const v = sampleBilinear(this.map, x + this.mapBias[0], y + this.mapBias[1]);
    const out = $("ex-hover");
    out.replaceChildren();
    const strong = document.createElement("strong");
    strong.textContent = `${v.toFixed(2)} points per dart`;
    out.append(`Aim at ${regionName(x, y)} ${formatXY([x, y])} → `, strong,
      ` (${fmt(v - this.map.bestValue, 2)} vs best)`);
  }

  drawOverlay(ctx, P) {
    if (!this.map) return;
    const M = this.map;
    const centre = M.best;
    const aim = this.bestAim();
    const s = this.state;
    if (s.throws) {
      drawDots(ctx, P, transformNormals(this.z, centre, M.sx, M.sy, M.rho));
    }
    if (this.measured && $("ex-measured").checked) {
      drawCrosses(ctx, P, this.measured, { color: "#000", halo: "rgba(255,255,255,0.7)", r: 3.5, width: 1.3 });
    }
    if (this.mapBias[0] || this.mapBias[1]) {
      // Dashed line from the aim point to where the darts will centre.
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(0,0,0,0.7)";
      ctx.beginPath();
      ctx.moveTo(P.px(aim[0]), P.py(aim[1]));
      ctx.lineTo(P.px(centre[0]), P.py(centre[1]));
      ctx.stroke();
      ctx.restore();
      drawRing(ctx, P, centre[0], centre[1], "#FFD43B", 3);
    }
    if (this.pinned) {
      drawRing(ctx, P, this.pinned[0], this.pinned[1], "#fff", 6);
      const v = sampleBilinear(M, this.pinned[0] + this.mapBias[0], this.pinned[1] + this.mapBias[1]);
      drawLabel(ctx, P, this.pinned[0], this.pinned[1], v.toFixed(2), { size: 12 });
    }
    drawStar(ctx, P, aim[0], aim[1], 13);
    drawLabel(ctx, P, aim[0], aim[1], M.bestValue.toFixed(2));
  }
}
