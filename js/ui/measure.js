// Measure tab: record where your darts landed, fit your throwing pattern and
// get your personal best aim (port of the Python script's --measure mode).

import { targetPoint, regionName } from "../core/board.js";
import { fitGaussian, covarianceEllipse } from "../core/stats.js";
import { formatThrowsCsv, parseThrowsCsv } from "../core/throws.js";
import { BoardView, drawCrosses, drawTarget, drawEllipse, drawRing, drawStar } from "./boardview.js";
import { MapChannel } from "./mapclient.js";
import { $, fmt, signed, formatXY, fillTargetTable, standardRows, downloadText, store } from "./common.js";

const STORAGE_KEY = "darts.measure.v1";
const MIN_DARTS = 3;
const GOOD_DARTS = 20;

export class MeasureTab {
  /** @param {{ openInExplore: (fit) => string[] }} opts */
  constructor({ openInExplore }) {
    this.openInExplore = openInExplore;
    this.points = [];
    this.aimName = "bull";
    this.aim = [0, 0];
    this.fit = null;
    this.map = null;
    this.picking = false;
    this.dragging = null;        // pointerId while placing a dart
    this.channel = new MapChannel();

    this.view = new BoardView($("ms-board"), { mode: "board" });
    this.view.overlay = (ctx, P) => this.drawOverlay(ctx, P);

    this.restore();
    this.bindControls();
    this.bindBoard();
    this.update();
  }

  shown() {
    this.view.resize();
  }

  // ---------------------------------------------------------------- storage

  restore() {
    const saved = store.get(STORAGE_KEY);
    if (!saved) return;
    try {
      this.setAim(saved.aimName || "bull");
      if (Array.isArray(saved.points)) {
        this.points = saved.points.filter((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite));
      }
    } catch { /* ignore a corrupt save */ }
  }

  save() {
    store.set(STORAGE_KEY, { aimName: this.aimName, points: this.points });
  }

  // ---------------------------------------------------------------- target

  /** Set the target by name; throws on an unknown name. */
  setAim(name) {
    this.aim = targetPoint(name);
    this.aimName = name;
    const sel = $("ms-target");
    const known = [...sel.options].some((o) => o.value.toUpperCase() === name.toUpperCase() && o.value !== "custom");
    sel.value = known ? [...sel.options].find((o) => o.value.toUpperCase() === name.toUpperCase()).value : "custom";
    const custom = sel.value === "custom";
    $("ms-custom").hidden = !custom;
    $("ms-custom-label").hidden = !custom;
    if (custom && document.activeElement !== $("ms-custom")) $("ms-custom").value = name;
    $("ms-target-error").hidden = true;
  }

  bindControls() {
    $("ms-target").addEventListener("change", (e) => {
      if (e.target.value === "custom") {
        $("ms-custom").hidden = false;
        $("ms-custom-label").hidden = false;
        $("ms-custom").focus();
        return;
      }
      this.setAim(e.target.value);
      this.changed();
    });
    $("ms-custom").addEventListener("change", (e) => {
      try {
        this.setAim(e.target.value.trim());
        this.changed();
      } catch (err) {
        $("ms-target-error").textContent = err.message;
        $("ms-target-error").hidden = false;
      }
    });
    $("ms-pick").addEventListener("click", () => {
      this.picking = !this.picking;
      this.showPicking();
    });
    $("ms-undo").addEventListener("click", () => this.undo());
    $("ms-clear").addEventListener("click", () => this.clear());
    $("ms-save").addEventListener("click", () => {
      const d = new Date();
      const pad = (v) => String(v).padStart(2, "0");
      const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      downloadText(`throws_${stamp}.csv`, formatThrowsCsv(this.points, this.aimName));
    });
    $("ms-load").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      const { points, aim } = parseThrowsCsv(await file.text());
      if (!points.length) {
        this.flash(`No throws found in ${file.name}.`);
        return;
      }
      if (aim) {
        try { this.setAim(aim); } catch { this.flash(`Unknown target "${aim}" in the file; keeping ${this.aimName}.`); }
      }
      this.points = points;
      this.changed();
      this.flash(`Loaded ${points.length} darts from ${file.name}.`);
    });
    $("ms-explore").addEventListener("click", () => {
      if (!this.fit) return;
      const clipped = this.openInExplore({ ...this.fit, points: this.points });
      if (clipped.length) {
        this.flash(`Explore's sliders can't show your exact ${clipped.join(", ")}; the values were clipped.`);
      }
    });
    document.addEventListener("keydown", (e) => {
      if ($("page-measure").hidden) return;
      if (e.target.closest("input, select, textarea")) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        this.undo();
      } else if (e.key === "Escape" && this.picking) {
        this.picking = false;
        this.showPicking();
      }
    });
  }

  showPicking() {
    $("ms-pick").classList.toggle("active", this.picking);
    $("ms-pick").textContent = this.picking ? "Click the board to set the target (Esc cancels)" : "Pick target on the board";
  }

  flash(msg) {
    $("ms-hint").textContent = msg;
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.showHint(), 4000);
  }

  undo() {
    if (!this.points.length) return;
    this.points.pop();
    this.changed();
  }

  clear() {
    // Two-step clear instead of a confirm() dialog.
    const btn = $("ms-clear");
    if (!this.points.length) return;
    if (!btn.classList.contains("danger")) {
      btn.classList.add("danger");
      btn.textContent = "Clear all?";
      clearTimeout(this.clearTimer);
      this.clearTimer = setTimeout(() => { btn.classList.remove("danger"); btn.textContent = "Clear"; }, 3000);
      return;
    }
    clearTimeout(this.clearTimer);
    btn.classList.remove("danger");
    btn.textContent = "Clear";
    this.points = [];
    this.changed();
  }

  // ---------------------------------------------------------------- board

  bindBoard() {
    const canvas = $("ms-board");
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button === 2) { this.undo(); return; }
      if (e.button !== 0 || this.dragging !== null) return;
      const p = this.view.toBoard(e);
      if (this.picking) {
        this.picking = false;
        this.showPicking();
        this.setAim(`${p[0].toFixed(1)},${p[1].toFixed(1)}`);
        this.changed();
        return;
      }
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      this.dragging = e.pointerId;
      this.points.push(p);
      // Fingers hide what they touch: magnify the spot while placing.
      if (e.pointerType !== "mouse") this.view.loupe = p;
      this.changed(false);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (e.pointerId !== this.dragging) return;
      const p = this.view.toBoard(e);
      this.points[this.points.length - 1] = p;
      if (this.view.loupe) this.view.loupe = p;
      this.changed(false);
    });
    const end = (e) => {
      if (e.pointerId !== this.dragging) return;
      this.dragging = null;
      this.view.loupe = null;
      this.changed();
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
  }

  // ---------------------------------------------------------------- update

  /** Points or target changed. final=false while a dart is being dragged. */
  changed(final = true) {
    this.update(final);
    if (final) this.save();
  }

  update(final = true) {
    const n = this.points.length;
    $("ms-count").textContent = n;
    $("ms-undo").disabled = n === 0;
    $("ms-clear").disabled = n === 0;
    $("ms-save").disabled = n === 0;
    this.fit = null;
    if (n >= MIN_DARTS) {
      try {
        const f = fitGaussian(this.points, this.aim);
        // Identical points give zero spread; keep a sliver so maps still work.
        f.sx = Math.max(f.sx, 0.5);
        f.sy = Math.max(f.sy, 0.5);
        f.rho = Math.max(-0.95, Math.min(0.95, f.rho));
        this.fit = f;
      } catch { /* not enough distinct points */ }
    }
    this.showFit();
    this.showHint();
    this.view.render();
    if (final) this.requestMap();
  }

  showHint() {
    const n = this.points.length;
    let msg;
    if (this.picking) msg = "Click where you want to aim.";
    else if (n === 0) msg = `Throw at ${this.targetLabel()}, then click where your first dart landed.`;
    else if (n < MIN_DARTS) msg = `${MIN_DARTS - n} more dart${MIN_DARTS - n > 1 ? "s" : ""} before the first estimate.`;
    else if (n < GOOD_DARTS) msg = `Estimate ready. Keep going: ${GOOD_DARTS - n} more darts make it much more reliable.`;
    else msg = `${n} darts: a solid estimate. More darts keep refining it.`;
    $("ms-hint").textContent = msg;
  }

  targetLabel() {
    const name = this.aimName;
    return /,/.test(name) ? `the target at ${formatXY(this.aim)}` : regionName(...this.aim).replace("Bullseye (50)", "the bull");
  }

  showFit() {
    const f = this.fit;
    $("ms-bias").textContent = f ? `${signed(f.bias[0])} right, ${signed(f.bias[1])} up mm` : "–";
    $("ms-sigma").textContent = f ? `${fmt(f.sx)} / ${fmt(f.sy)} mm` : "–";
    $("ms-rho").textContent = f ? signed(f.rho, 2) : "–";
    const note = $("ms-note");
    const n = this.points.length;
    if (f && n < GOOD_DARTS) {
      note.textContent = `Only ${n} darts: the estimates are rough. 30 or more is better.`;
      note.hidden = false;
    } else note.hidden = true;
    if (!f) {
      $("ms-report").hidden = true;
      this.map = null;
    }
  }

  async requestMap() {
    const f = this.fit;
    if (!f) return;
    const view = 200 + Math.ceil(Math.max(Math.abs(f.bias[0]), Math.abs(f.bias[1])));
    const res = Math.min(f.sx, f.sy) < 4 ? 0.5 : 1;
    let result;
    try {
      result = await this.channel.request({ sx: f.sx, sy: f.sy, rho: f.rho, res, view, mcThrows: 0 });
    } catch (err) {
      this.flash(`Error: ${err.message}`);
      return;
    }
    if (!result || this.fit !== f) return;
    this.map = result.map;
    this.showReport();
    this.view.render();
  }

  bestAim() {
    const M = this.map, b = this.fit.bias;
    return [M.best[0] - b[0], M.best[1] - b[1]];
  }

  showReport() {
    const M = this.map;
    const aim = this.bestAim();
    $("ms-report").hidden = false;
    $("ms-best-region").textContent = `${regionName(...aim)}`;
    $("ms-best-value").textContent = M.bestValue.toFixed(2);
    const rows = standardRows(aim);
    rows[0].label = `Best: ${formatXY(aim)}`;
    fillTargetTable($("ms-targets"), rows, M, this.fit.bias);
  }

  drawOverlay(ctx, P) {
    const f = this.fit;
    if (f) {
      drawEllipse(ctx, P, f.mean[0], f.mean[1], covarianceEllipse(f.sx, f.sy, f.rho, 1), "#00B4D8");
      drawEllipse(ctx, P, f.mean[0], f.mean[1], covarianceEllipse(f.sx, f.sy, f.rho, 2), "#00B4D8", [6, 4]);
      drawRing(ctx, P, f.mean[0], f.mean[1], "#00B4D8", 3);
    }
    drawTarget(ctx, P, this.aim[0], this.aim[1]);
    drawCrosses(ctx, P, this.points, { color: "#FFD43B", halo: "#000", r: 5, width: 2 });
    if (f && this.map) {
      const aim = this.bestAim();
      drawStar(ctx, P, aim[0], aim[1], 11);
    }
  }
}
