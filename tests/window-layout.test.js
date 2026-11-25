'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOverlayBounds, clampBoundsToDisplays } = require('../ui/window-layout');

const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 };
const LEFT = { x: -1440, y: -120, width: 1440, height: 900 };
const ABOVE = { x: 100, y: -1080, width: 1920, height: 1080 };

function assertContained(bounds, area) {
  for (const value of Object.values(bounds)) assert.equal(Number.isInteger(value), true);
  assert.ok(bounds.width > 0 && bounds.height > 0);
  assert.ok(bounds.x >= area.x && bounds.y >= area.y);
  assert.ok(bounds.x + bounds.width <= area.x + area.width);
  assert.ok(bounds.y + bounds.height <= area.y + area.height);
}

test('initial compact overlay uses a 24px top and right margin', () => {
  assert.deepEqual(createOverlayBounds(PRIMARY), { x: 1536, y: 24, width: 360, height: 440 });
});

test('initial placement respects negative monitor coordinates and desktop work area', () => {
  assert.deepEqual(createOverlayBounds(LEFT), { x: -384, y: -96, width: 360, height: 440 });
  assertContained(createOverlayBounds(ABOVE), ABOVE);
});

test('saved position is restored but compact dimensions ignore corrupted or old sizes', () => {
  assert.deepEqual(createOverlayBounds(PRIMARY, { x: 80, y: 110, width: 999999, height: 'old' }),
    { x: 80, y: 110, width: 360, height: 440 });
});

test('saved position is restored only as a valid integer coordinate pair', () => {
  const fallback = createOverlayBounds(PRIMARY);
  for (const saved of [null, {}, { x: 20 }, { x: 20, y: NaN }, { x: Infinity, y: 10 },
    { x: '20', y: 10 }, { x: 20.5, y: 10 }, { x: Number.MAX_VALUE, y: 0 }]) {
    assert.deepEqual(createOverlayBounds(PRIMARY, saved), fallback);
  }
});

test('offscreen saved position clamps fully into the requested work area', () => {
  assert.deepEqual(createOverlayBounds(PRIMARY, { x: 5000, y: -5000 }),
    { x: 1560, y: 0, width: 360, height: 440 });
});

test('small displays shrink the overlay to actual available dimensions', () => {
  const area = { x: -300, y: 20, width: 260, height: 300 };
  const bounds = createOverlayBounds(area);
  assert.deepEqual(bounds, { x: -300, y: 20, width: 260, height: 300 });
  assert.deepEqual(clampBoundsToDisplays(bounds, [area]), bounds);
});

test('visible negative-coordinate monitor is preserved across multi-monitor restore', () => {
  const saved = { x: -900, y: 80, width: 360, height: 440 };
  assert.deepEqual(clampBoundsToDisplays(saved, [PRIMARY, LEFT]), saved);
});

test('window straddling monitors chooses the display containing the largest visible area', () => {
  const saved = { x: -280, y: 100, width: 360, height: 440 };
  assert.deepEqual(clampBoundsToDisplays(saved, [PRIMARY, LEFT]),
    { x: -360, y: 100, width: 360, height: 440 });
});

test('position from a removed monitor moves onto the nearest remaining display', () => {
  const saved = { x: -3000, y: 100, width: 360, height: 440 };
  const result = clampBoundsToDisplays(saved, [PRIMARY, LEFT]);
  assert.deepEqual(result, { x: -1440, y: 100, width: 360, height: 440 });
  assertContained(result, LEFT);
});

test('vertical monitor placement survives restore and clamps to its work area', () => {
  const result = clampBoundsToDisplays({ x: 1700, y: -1000, width: 360, height: 440 }, [PRIMARY, ABOVE]);
  assert.deepEqual(result, { x: 1660, y: -1000, width: 360, height: 440 });
  assertContained(result, ABOVE);
});

test('bad persisted geometry and invalid work areas fall back to safe compact geometry', () => {
  const result = clampBoundsToDisplays({ x: 'bad', y: 0, width: NaN, height: Infinity },
    [null, { x: 0, y: 0, width: -1, height: 500 }, PRIMARY]);
  assert.deepEqual(result, { x: 1536, y: 24, width: 360, height: 440 });
  assert.deepEqual(clampBoundsToDisplays(null, []), { x: 896, y: 24, width: 360, height: 440 });
  assertContained(createOverlayBounds(null), { x: 0, y: 0, width: 1280, height: 800 });
});

test('extreme persisted dimensions remain bounded and wholly visible', () => {
  const result = clampBoundsToDisplays({ x: 10, y: 10, width: 9000, height: 9000 }, [PRIMARY]);
  assert.ok(result.width <= 480 && result.height <= 640);
  assertContained(result, PRIMARY);
});

test('layout helpers do not mutate saved geometry or monitor arrays', () => {
  const saved = Object.freeze({ x: -3000, y: 100, width: 360, height: 440 });
  const areas = Object.freeze([Object.freeze({ ...PRIMARY }), Object.freeze({ ...LEFT })]);
  assert.doesNotThrow(() => clampBoundsToDisplays(saved, areas));
  assert.equal(saved.x, -3000);
});
