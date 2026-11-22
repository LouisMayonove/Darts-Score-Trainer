// Board geometry and scoring (regulation steel-tip board, millimetres).
//
// Coordinates: origin at the centre of the bull, x to the right, y up.
// Port of the geometry in reference/dart_heatmap.py.

export const R_BULLSEYE = 6.35;   // inner bull (50)
export const R_BULL = 15.9;       // outer bull (25)
export const R_TRIPLE_IN = 99.0;
export const R_TRIPLE_OUT = 107.0;
export const R_DOUBLE_IN = 162.0;
export const R_DOUBLE_OUT = 170.0;

/** Sector numbers clockwise starting from the top. */
export const SECTORS = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17,
                        3, 19, 7, 16, 8, 11, 14, 9, 12, 5];

const DEG = 180 / Math.PI;

/** Index into SECTORS for the point (x, y); 20 is centred straight up. */
export function sectorIndex(x, y) {
  const theta = Math.atan2(y, x) * DEG;          // 0 deg = +x, counter-clockwise
  let cw = (90 - theta + 9) % 360;               // clockwise from the top
  if (cw < 0) cw += 360;
  return Math.floor(cw / 18) % 20;
}

/** Score of a dart landing at (x, y). */
export function score(x, y) {
  const r = Math.hypot(x, y);
  if (r < R_BULLSEYE) return 50;
  if (r < R_BULL) return 25;
  if (r >= R_DOUBLE_OUT) return 0;
  const s = SECTORS[sectorIndex(x, y)];
  if (r >= R_TRIPLE_IN && r < R_TRIPLE_OUT) return 3 * s;
  if (r >= R_DOUBLE_IN) return 2 * s;
  return s;
}

/** Short name of the region at (x, y): "T19", "D16", "S5", "25", "50" or "Miss". */
export function regionShort(x, y) {
  const r = Math.hypot(x, y);
  if (r < R_BULLSEYE) return "50";
  if (r < R_BULL) return "25";
  if (r >= R_DOUBLE_OUT) return "Miss";
  const n = SECTORS[sectorIndex(x, y)];
  if (r >= R_TRIPLE_IN && r < R_TRIPLE_OUT) return `T${n}`;
  if (r >= R_DOUBLE_IN) return `D${n}`;
  return `S${n}`;
}

/** Human-readable name of the region at (x, y), as in the Python script. */
export function regionName(x, y) {
  const r = Math.hypot(x, y);
  if (r < R_BULLSEYE) return "Bullseye (50)";
  if (r < R_BULL) return "Outer bull (25)";
  if (r >= R_DOUBLE_OUT) return "Off board";
  return regionShort(x, y);
}

const TARGET_RADII = {
  T: (R_TRIPLE_IN + R_TRIPLE_OUT) / 2,
  D: (R_DOUBLE_IN + R_DOUBLE_OUT) / 2,
  S: (R_TRIPLE_OUT + R_DOUBLE_IN) / 2,   // centre of the big outer single
};

/**
 * Board coordinates [x, y] (mm) of a named target: "bull", "T20", "D16",
 * "S5" (centre of the big outer single) or explicit "x,y".
 * Throws an Error for anything else.
 */
export function targetPoint(name) {
  const s = String(name).trim().toUpperCase();
  if (["BULL", "BULLSEYE", "DB", "50", "25", "SB"].includes(s)) return [0, 0];
  if (s.includes(",")) {
    const parts = s.split(",").map((v) => Number(v.trim()));
    if (parts.length === 2 && parts.every(Number.isFinite)) return parts;
  } else if (s[0] in TARGET_RADII && /^\d+$/.test(s.slice(1))) {
    const k = SECTORS.indexOf(Number(s.slice(1)));
    if (k >= 0) {
      const ang = (90 - 18 * k) / DEG;
      const r = TARGET_RADII[s[0]];
      return [r * Math.cos(ang), r * Math.sin(ang)];
    }
  }
  throw new Error(`unknown target "${name}" (use bull, T20, D16, S5 or x,y)`);
}

/** Angle (radians, standard orientation) of the centre of sector k. */
export function sectorCentreAngle(k) {
  return (90 - 18 * k) / DEG;
}

/** Angle (radians) of the boundary between sector k-1 and sector k. */
export function sectorEdgeAngle(k) {
  return (90 + 9 - 18 * k) / DEG;
}
