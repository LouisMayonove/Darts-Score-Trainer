// Reading and writing recorded throws as CSV.
//
// Same format as the Python script (--measure saves it, --throws loads it):
//
//   # aim=bull
//   # x_mm,y_mm
//   12.30,-4.10
//   ...
//
// x, y in mm, origin at the bull centre, y up. The aim comment is optional.

/** CSV text for points ([x, y] array) thrown at `aimName`. */
export function formatThrowsCsv(points, aimName) {
  const lines = [`# aim=${aimName}`, "# x_mm,y_mm"];
  for (const [x, y] of points) lines.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  return lines.join("\n") + "\n";
}

/**
 * Parse throws CSV text. Returns { points, aim } where aim is the name from
 * an "aim=..." comment line, or null. Header and malformed lines are skipped.
 */
export function parseThrowsCsv(text) {
  let aim = null;
  const points = [];
  for (let line of String(text).split(/\r?\n/)) {
    line = line.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const body = line.replace(/^#+/, "").trim();
      if (body.toLowerCase().startsWith("aim=")) aim = body.slice(4).trim() || null;
      continue;
    }
    const parts = line.split(/[,;\t]/);
    if (parts.length < 2) continue;
    const x = Number(parts[0]), y = Number(parts[1]);
    if (parts[0].trim() === "" || parts[1].trim() === "") continue;
    if (Number.isFinite(x) && Number.isFinite(y)) points.push([x, y]);
  }
  return { points, aim };
}
