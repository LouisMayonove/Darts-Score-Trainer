// App shell: tabs, URL routing and theme.
//
// URL format: #explore?sx=20&sy=20&rho=0.2  ·  #measure  ·  #compare  ·  #about
// The Explore settings live in the URL so a link reproduces the view.

import { ExploreTab } from "./ui/explore.js";
import { MeasureTab } from "./ui/measure.js";
import { $, store } from "./ui/common.js";

const PAGES = ["explore", "measure", "compare", "about"];
const tabs = {};
let current = null;

const explore = new ExploreTab({ onStateChange: () => writeUrl() });
const lazy = {};               // tabs built the first time they are shown
const factories = {
  measure: () => new MeasureTab({
    openInExplore: (fit) => {
      const clipped = explore.applyMeasured(fit);
      show("explore");
      return clipped;
    },
  }),
};

function writeUrl() {
  const hash = current === "explore" ? `#explore?${explore.toQuery()}` : `#${current}`;
  if (location.hash !== hash) history.replaceState(null, "", hash);
}

function show(page, { fromUrl = false } = {}) {
  if (!PAGES.includes(page)) page = "explore";
  current = page;
  for (const p of PAGES) {
    $(`page-${p}`).hidden = p !== page;
    $(`tab-${p}`).setAttribute("aria-selected", String(p === page));
    $(`tab-${p}`).tabIndex = p === page ? 0 : -1;
  }
  if (!lazy[page] && factories[page]) lazy[page] = factories[page]();
  lazy[page]?.shown?.();
  if (page === "explore") explore.view.resize();
  if (!fromUrl) writeUrl();
}

function readUrl() {
  const [page, query = ""] = location.hash.replace(/^#/, "").split("?");
  const isExplore = (page || "explore") === "explore";
  // Explore always needs a first map, even when the page opens elsewhere.
  if (isExplore || !explore.map) explore.fromQuery(isExplore ? query : "");
  show(page || "explore", { fromUrl: true });
}

// Tabs: click and arrow keys.
for (const p of PAGES) {
  tabs[p] = $(`tab-${p}`);
  tabs[p].addEventListener("click", () => show(p));
  tabs[p].addEventListener("keydown", (e) => {
    const i = PAGES.indexOf(p);
    let j = null;
    if (e.key === "ArrowRight") j = (i + 1) % PAGES.length;
    if (e.key === "ArrowLeft") j = (i - 1 + PAGES.length) % PAGES.length;
    if (j === null) return;
    e.preventDefault();
    show(PAGES[j]);
    tabs[PAGES[j]].focus();
  });
}

window.addEventListener("hashchange", readUrl);

// Theme: system -> light -> dark -> system.
const THEMES = [null, "light", "dark"];
const THEME_LABEL = { null: "follow system", light: "light", dark: "dark" };
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const btn = $("theme-toggle");
  btn.title = `Theme: ${THEME_LABEL[t]}`;
  btn.textContent = t === "light" ? "☀" : t === "dark" ? "☾" : "◐";
  // Canvas text colours follow the theme: redraw what depends on them.
  if (explore.map) explore.drawColorbar();
}
let theme = store.get("darts.theme", null);
applyTheme(theme);
$("theme-toggle").addEventListener("click", () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  store.set("darts.theme", theme);
  applyTheme(theme);
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme(theme));

readUrl();
