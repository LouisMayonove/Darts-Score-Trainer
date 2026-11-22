// Compare tab: several spreads side by side (port of the Python script's
// default view, which plots a grid of patterns).

import { regionName } from "../core/board.js";
import { Rng, standardNormals, transformNormals } from "../core/stats.js";
import { BoardView, drawStar, drawLabel, drawDots } from "./boardview.js";
import { MapQueue } from "./mapclient.js";
import { $, clamp, formatXY, store } from "./common.js";
import { autoResolution } from "./explore.js";

const DEFAULT_PATTERNS = [
  { sx: 5, sy: 5, rho: 0 }, { sx: 15, sy: 15, rho: 0 }, { sx: 30, sy: 30, rho: 0 },
  { sx: 50, sy: 50, rho: 0 }, { sx: 15, sy: 45, rho: 0 }, { sx: 45, sy: 15, rho: 0 },
];
const STORAGE_KEY = "darts.compare.v1";
const MAX_PATTERNS = 9;
const MC_THROWS = 100000;

export class CompareTab {
  constructor() {
    const saved = store.get(STORAGE_KEY);
    this.patterns = Array.isArray(saved?.patterns) && saved.patterns.length
      ? saved.patterns.slice(0, MAX_PATTERNS).map(sanitize)
      : DEFAULT_PATTERNS.map((p) => ({ ...p }));
    this.shared = !!saved?.shared;
    this.throws = !!saved?.throws;
    this.queue = new MapQueue();
    this.cards = [];
    this.generation = 0;
    this.z = standardNormals(400, new Rng(0));

    $("cmp-shared").checked = this.shared;
    $("cmp-throws").checked = this.throws;
    $("cmp-add").addEventListener("click", () => {
      if (this.patterns.length >= MAX_PATTERNS) return;
      const last = this.patterns[this.patterns.length - 1] || { sx: 20, sy: 20, rho: 0 };
      this.patterns.push({ ...last });
      this.rebuild();
    });
    $("cmp-defaults").addEventListener("click", () => {
      this.patterns = DEFAULT_PATTERNS.map((p) => ({ ...p }));
      this.rebuild();
    });
    $("cmp-shared").addEventListener("change", (e) => { this.shared = e.target.checked; this.save(); this.paint(); });
    $("cmp-throws").addEventListener("change", (e) => {
      this.throws = e.target.checked;
      this.save();
      for (const c of this.cards) c.view.render();
    });
    this.rebuild();
  }

  shown() {
    for (const c of this.cards) c.view.resize();
  }

  save() {
    store.set(STORAGE_KEY, { patterns: this.patterns, shared: this.shared, throws: this.throws });
  }

  /** Rebuild the pattern editors and the cards, then compute every map. */
  rebuild() {
    this.save();
    this.buildEditors();
    this.buildCards();
    this.computeAll();
  }

  buildEditors() {
    const list = $("cmp-patterns");
    list.replaceChildren();
    this.patterns.forEach((p, i) => {
      const box = document.createElement("div");
      box.className = "pattern";
      const field = (key, label, min, max, step) => {
        const id = `cmp-${i}-${key}`;
        const l = document.createElement("label");
        l.htmlFor = id;
        l.textContent = label;
        const input = document.createElement("input");
        Object.assign(input, { type: "number", id, min, max, step, value: p[key] });
        input.addEventListener("change", () => {
          const v = Number(input.value);
          if (!Number.isFinite(v)) { input.value = p[key]; return; }
          p[key] = clamp(v, min, max);
          input.value = p[key];
          this.save();
          this.computeOne(i, this.generation);
        });
        box.append(l, input);
      };
      field("sx", "σx", 1, 100, 0.5);
      field("sy", "σy", 1, 100, 0.5);
      field("rho", "ρ", -0.95, 0.95, 0.05);
      const rm = document.createElement("button");
      rm.className = "remove";
      rm.title = "Remove this pattern";
      rm.setAttribute("aria-label", `Remove pattern ${i + 1}`);
      rm.textContent = "×";
      rm.disabled = this.patterns.length <= 1;
      rm.addEventListener("click", () => { this.patterns.splice(i, 1); this.rebuild(); });
      box.append(rm);
      list.append(box);
    });
    $("cmp-add").disabled = this.patterns.length >= MAX_PATTERNS;
  }

  buildCards() {
    const grid = $("cmp-grid");
    grid.replaceChildren();
    this.cards = this.patterns.map(() => {
      const card = document.createElement("article");
      card.className = "compare-card";
      const title = document.createElement("h3");
      const wrap = document.createElement("div");
      wrap.className = "board-wrap";
      const canvas = document.createElement("canvas");
      canvas.className = "board";
      wrap.append(canvas);
      const line = document.createElement("p");
      const scale = document.createElement("p");
      card.append(title, wrap, line, scale);
      grid.append(card);
      const view = new BoardView(canvas);
      const c = { card, title, line, scale, view, result: null };
      view.overlay = (ctx, P) => this.drawOverlay(c, ctx, P);
      return c;
    });
  }

  computeAll() {
    const gen = ++this.generation;
    this.patterns.forEach((_, i) => this.computeOne(i, gen));
  }

  async computeOne(i, gen) {
    const p = this.patterns[i];
    const c = this.cards[i];
    c.title.textContent = describePattern(p);
    c.line.textContent = "Computing…";
    let result;
    try {
      result = await this.queue.request({
        sx: p.sx, sy: p.sy, rho: p.rho, res: autoResolution(p.sx, p.sy, p.rho), view: 200, mcThrows: MC_THROWS,
      });
    } catch (err) {
      c.line.textContent = `Error: ${err.message}`;
      return;
    }
    if (gen !== this.generation || this.cards[i] !== c) return;
    c.result = result;
    this.paint();
  }

  /** Draw every finished map, on a shared colour scale if asked. */
  paint() {
    const done = this.cards.filter((c) => c.result);
    let lo = Infinity, hi = -Infinity;
    for (const c of done) { lo = Math.min(lo, c.result.map.min); hi = Math.max(hi, c.result.map.max); }
    for (const c of done) {
      const M = c.result.map;
      const [vmin, vmax] = this.shared ? [lo, hi] : [M.min, M.max];
      c.view.setMap(M, [0, 0], vmin, vmax);
      c.line.replaceChildren();
      const strong = document.createElement("strong");
      strong.textContent = `${regionName(...M.best)} ${formatXY(M.best)} → ${M.bestValue.toFixed(2)} pts/dart`;
      c.line.append("Best: ", strong);
      const mc = c.result.mc;
      c.scale.textContent = `Simulation ${mc.mean.toFixed(2)} ± ${mc.se.toFixed(2)} · colours ${vmin.toFixed(1)}–${vmax.toFixed(1)} pts`;
    }
  }

  drawOverlay(c, ctx, P) {
    if (!c.result) return;
    const M = c.result.map;
    if (this.throws) drawDots(ctx, P, transformNormals(this.z, M.best, M.sx, M.sy, M.rho), "rgba(217,72,15,0.6)", 1.8);
    drawStar(ctx, P, M.best[0], M.best[1], 11);
    drawLabel(ctx, P, M.best[0], M.best[1], M.bestValue.toFixed(2), { size: 12 });
  }
}

function sanitize(p) {
  const num = (v, d, lo, hi) => (Number.isFinite(Number(v)) ? clamp(Number(v), lo, hi) : d);
  return { sx: num(p?.sx, 20, 1, 100), sy: num(p?.sy, 20, 1, 100), rho: num(p?.rho, 0, -0.95, 0.95) };
}

function describePattern({ sx, sy, rho }) {
  return `σx = ${sx} mm, σy = ${sy} mm${rho ? `, ρ = ${rho}` : ""}`;
}
