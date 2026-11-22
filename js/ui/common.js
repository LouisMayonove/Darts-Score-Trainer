// Small helpers shared by the tabs.

import { regionName, targetPoint } from "../core/board.js";
import { expectedAt } from "../core/expected.js";

export const $ = (id) => document.getElementById(id);

export const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "–");
export const signed = (v, d = 1) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(d);
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Friendly description of an aim point: "T19", "Bullseye (50)", ... */
export function describeAim([x, y]) {
  return regionName(x, y);
}

/** "(−31, −98) mm" */
export function formatXY([x, y]) {
  return `(${Math.round(x)}, ${Math.round(y)}) mm`;
}

export const STANDARD_TARGETS = [
  ["Treble 20", "T20"],
  ["Treble 19", "T19"],
  ["Treble 18", "T18"],
  ["Bull", "bull"],
];

/**
 * Fill a <tbody> with expected scores at a list of aim points.
 * rows: [{ label, aim: [x, y], best?: bool, removable?: bool }]
 * M: map, bias: [bx, by]. Darts aimed at `aim` centre on aim + bias.
 */
export function fillTargetTable(tbody, rows, M, bias, onRemove) {
  tbody.replaceChildren();
  const best = M.bestValue;
  for (const row of rows) {
    const v = expectedAt(M, row.aim[0] + bias[0], row.aim[1] + bias[1]);
    const diff = v - best;
    const tr = document.createElement("tr");
    if (row.best) tr.className = "is-best";
    const name = document.createElement("td");
    name.textContent = row.label;
    if (row.removable) {
      const b = document.createElement("button");
      b.className = "remove";
      b.title = "Remove this aim point";
      b.setAttribute("aria-label", "Remove pinned aim point");
      b.textContent = "×";
      b.addEventListener("click", onRemove);
      name.append(" ", b);
    }
    const val = document.createElement("td");
    val.textContent = v.toFixed(2);
    const d = document.createElement("td");
    d.textContent = Math.abs(diff) < 0.005 ? "best" : diff.toFixed(2);
    d.className = Math.abs(diff) < 0.005 ? "zero" : "neg";
    tr.append(name, val, d);
    tbody.append(tr);
  }
}

/** Rows for the standard targets plus the best aim point. */
export function standardRows(bestAim) {
  const rows = [{ label: `Best: ${describeAim(bestAim)}`, aim: bestAim, best: true }];
  for (const [label, name] of STANDARD_TARGETS) rows.push({ label, aim: targetPoint(name) });
  return rows;
}

/** Bind a range slider and a number box to the same value. */
export function bindSlider(rangeEl, numEl, { get, set, onInput, onCommit }) {
  const show = () => {
    const v = get();
    rangeEl.value = v;
    if (document.activeElement !== numEl) numEl.value = v;
  };
  rangeEl.addEventListener("input", () => { set(Number(rangeEl.value)); show(); onInput(); });
  rangeEl.addEventListener("change", () => onCommit());
  numEl.addEventListener("input", () => {
    const v = Number(numEl.value);
    if (numEl.value === "" || !Number.isFinite(v)) return;
    set(clamp(v, Number(numEl.min), Number(numEl.max)));
    rangeEl.value = get();
    onInput();
  });
  numEl.addEventListener("change", () => { show(); numEl.value = get(); onCommit(); });
  return show;
}

/** Save a text file through a temporary download link. */
export function downloadText(filename, text, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** localStorage that never throws (private windows, blocked storage...). */
export const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  },
};
