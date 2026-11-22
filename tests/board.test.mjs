// Unit tests for board geometry and scoring. Run with: node --test "tests/*.test.mjs"

import test from "node:test";
import assert from "node:assert/strict";
import {
  SECTORS, score, sectorIndex, regionName, regionShort, targetPoint,
  R_BULLSEYE, R_BULL, R_TRIPLE_IN, R_TRIPLE_OUT, R_DOUBLE_IN, R_DOUBLE_OUT,
} from "../js/core/board.js";

const polar = (r, degFromTopClockwise) => {
  const a = ((90 - degFromTopClockwise) * Math.PI) / 180;
  return [r * Math.cos(a), r * Math.sin(a)];
};

test("20 is straight up, 6 to the right, 3 at the bottom, 11 to the left", () => {
  assert.equal(SECTORS[sectorIndex(0, 50)], 20);
  assert.equal(SECTORS[sectorIndex(50, 0)], 6);
  assert.equal(SECTORS[sectorIndex(0, -50)], 3);
  assert.equal(SECTORS[sectorIndex(-50, 0)], 11);
});

test("every sector scores its number at its centre", () => {
  SECTORS.forEach((n, k) => {
    assert.equal(score(...polar(60, 18 * k)), n, `single ${n}`);
    assert.equal(score(...polar(103, 18 * k)), 3 * n, `treble ${n}`);
    assert.equal(score(...polar(166, 18 * k)), 2 * n, `double ${n}`);
  });
});

test("ring boundaries follow the Python script (inner edge inclusive)", () => {
  assert.equal(score(0, 0), 50);
  assert.equal(score(0, R_BULLSEYE - 1e-9), 50);
  assert.equal(score(0, R_BULLSEYE), 25);
  assert.equal(score(0, R_BULL - 1e-9), 25);
  assert.equal(score(0, R_BULL), 20);
  assert.equal(score(0, R_TRIPLE_IN), 60);
  assert.equal(score(0, R_TRIPLE_OUT), 20);
  assert.equal(score(0, R_DOUBLE_IN), 40);
  assert.equal(score(0, R_DOUBLE_OUT - 1e-9), 40);
  assert.equal(score(0, R_DOUBLE_OUT), 0);
  assert.equal(score(500, 500), 0);
});

test("sector boundaries sit 9 degrees either side of the centre", () => {
  assert.equal(score(...polar(60, 8.9)), 20);
  assert.equal(score(...polar(60, 9.1)), 1);
  assert.equal(score(...polar(60, -8.9)), 20);
  assert.equal(score(...polar(60, -9.1)), 5);
});

test("region names", () => {
  assert.equal(regionName(0, 0), "Bullseye (50)");
  assert.equal(regionName(0, 10), "Outer bull (25)");
  assert.equal(regionName(0, 103), "T20");
  assert.equal(regionName(0, -166), "D3");
  assert.equal(regionName(0, 130), "S20");
  assert.equal(regionName(0, 180), "Off board");
  assert.equal(regionShort(0, 180), "Miss");
  assert.equal(regionShort(0, 3), "50");
});

test("target points", () => {
  assert.deepEqual(targetPoint("bull"), [0, 0]);
  assert.deepEqual(targetPoint(" Bullseye "), [0, 0]);
  assert.deepEqual(targetPoint("12.5, -3"), [12.5, -3]);
  const t20 = targetPoint("T20");
  assert.ok(Math.abs(t20[0]) < 1e-9 && Math.abs(t20[1] - 103) < 1e-9);
  assert.equal(score(...targetPoint("t19")), 57);
  assert.equal(score(...targetPoint("D16")), 32);
  assert.equal(score(...targetPoint("S5")), 5);
  for (const bad of ["T21", "X20", "", "T", "1,2,3", "a,b"]) {
    assert.throws(() => targetPoint(bad), /unknown target/, bad);
  }
});
