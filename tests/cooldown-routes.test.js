'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CAMPS } = require('../service/camps');
const { JungleTracker } = require('../service/jungle-tracker');
const { planRoute } = require('../service/algorithms/route-planner');

test('six cleared camps produce no farming route and expose the next known release', () => {
  const camps = CAMPS.map((camp, index) => ({ ...camp, status: 'cleared', availableAt: 600 + index * 10 }));
  const route = planRoute({ camps, startCamp: 'blue', routeLength: 6, gameTime: 500 });
  assert.deepEqual(route.stops, []);
  assert.deepEqual(route.excludedCampIds, CAMPS.map(camp => camp.id));
  assert.equal(route.nextAvailableAt, 600);
  assert.equal(route.totalSeconds, 0);
  assert.equal(route.waitSeconds, 0);
  assert.match(route.reason, /재생성을 기다리는 중/);
});

test('future respawn is excluded even when a later stop could arrive after its timer', () => {
  const camps = CAMPS.map(camp => ({ ...camp, status: 'alive', availableAt: 400 }));
  const gromp = camps.find(camp => camp.id === 'gromp');
  gromp.status = 'respawning';
  gromp.availableAt = 505;
  const route = planRoute({ camps, routeLength: 6, gameTime: 500 });
  assert.equal(route.stops[0].finishAt, 520);
  assert.ok(route.stops.every(stop => stop.campId !== 'gromp'));
  assert.equal(route.stops.length, 5);
  assert.deepEqual(route.excludedCampIds, ['gromp']);
  assert.equal(route.nextAvailableAt, 505);
  assert.equal(route.waitSeconds, 0);
});

test('includeUnknown never re-enables a cooldown and only controls available unknown camps', () => {
  const camps = [
    { ...CAMPS[0], status: 'respawning', availableAt: 700 },
    { ...CAMPS[1], status: 'unknown', availableAt: 90 },
    { ...CAMPS[2], status: 'unknown', availableAt: 600 },
    { ...CAMPS[3], status: 'estimated', availableAt: 400 },
  ];
  const withUnknown = planRoute({ camps, routeLength: 6, gameTime: 500, includeUnknown: true });
  assert.deepEqual(new Set(withUnknown.stops.map(stop => stop.campId)), new Set(['gromp', 'raptors']));
  assert.deepEqual(withUnknown.excludedCampIds, ['blue', 'wolves']);
  const withoutUnknown = planRoute({ camps, routeLength: 6, gameTime: 500, includeUnknown: false });
  assert.deepEqual(withoutUnknown.stops.map(stop => stop.campId), ['raptors']);
  assert.deepEqual(withoutUnknown.excludedCampIds, ['blue', 'gromp', 'wolves']);
  assert.equal(withUnknown.nextAvailableAt, 600);
  assert.equal(withoutUnknown.nextAvailableAt, 600);
});

test('tracker estimated status is eligible exactly at the respawn boundary and remains uncertain', () => {
  const tracker = new JungleTracker();
  tracker.observe('blue', 'cleared', 100);
  const before = planRoute({ camps: tracker.snapshot(399), gameTime: 399, includeUnknown: false });
  assert.equal(before.stops.length, 0);
  assert.equal(before.nextAvailableAt, 400);
  const boundary = planRoute({ camps: tracker.snapshot(400), gameTime: 400, includeUnknown: false });
  assert.deepEqual(boundary.stops.map(stop => stop.campId), ['blue']);
  assert.equal(boundary.stops[0].uncertain, true);
  assert.equal(boundary.stops[0].waitSeconds, 0);
  assert.equal(boundary.nextAvailableAt, null);
});

test('both first-spawn and explicit availability are respected when their fields disagree', () => {
  const camps = [
    { ...CAMPS[0], status: 'unknown', initialSpawnSeconds: 600, availableAt: 400 },
    { ...CAMPS[1], status: 'estimated', initialSpawnSeconds: 610, availableAt: 300 },
    { ...CAMPS[2], status: 'alive', initialSpawnSeconds: 90, availableAt: 620 },
    { ...CAMPS[3], status: 'unknown', initialSpawnSeconds: 90, availableAt: 630 },
    { ...CAMPS[4], status: 'estimated', initialSpawnSeconds: 90, availableAt: 640 },
    { ...CAMPS[5], status: 'estimated', initialSpawnSeconds: 90, availableAt: 500 },
  ];
  const route = planRoute({ camps, gameTime: 500, routeLength: 6 });
  assert.deepEqual(route.stops.map(stop => stop.campId), ['krugs']);
  assert.deepEqual(route.excludedCampIds, ['blue', 'gromp', 'wolves', 'raptors', 'red']);
  assert.equal(route.nextAvailableAt, 600);
  assert.equal(route.waitSeconds, 0);
});

test('cleared and respawning status remain blocked without a usable future timestamp', () => {
  const camps = [
    { ...CAMPS[0], status: 'cleared', availableAt: null },
    { ...CAMPS[1], status: 'respawning' },
    { ...CAMPS[2], status: 'cleared', availableAt: 400 },
    { ...CAMPS[3], status: 'respawning', availableAt: 500 },
  ];
  const route = planRoute({ camps, gameTime: 500 });
  assert.deepEqual(route.stops, []);
  assert.equal(route.nextAvailableAt, null);
  assert.deepEqual(route.excludedCampIds, camps.map(camp => camp.id));
});

test('dead camps stay usable as graph transit and current origin without becoming farming stops', () => {
  const camps = CAMPS.map(camp => ({ ...camp, status: 'cleared', availableAt: 900 }));
  camps.find(camp => camp.id === 'raptors').status = 'alive';
  camps.find(camp => camp.id === 'raptors').availableAt = 400;
  const route = planRoute({ camps, gameTime: 500, startCamp: 'blue', routeLength: 6 });
  assert.deepEqual(route.stops.map(stop => stop.campId), ['raptors']);
  assert.deepEqual(route.path, ['blue', 'wolves', 'raptors']);
  assert.equal(route.travelSeconds, 22);
  assert.equal(route.waitSeconds, 0);
});

test('all unobserved camps stay excluded before first spawn for both unknown settings', () => {
  const camps = CAMPS.map(camp => ({ ...camp, status: 'unknown' }));
  const firstSpawnAt = Math.min(...CAMPS.map(camp => camp.initialSpawnSeconds));
  for (const includeUnknown of [true, false]) {
    const before = planRoute({ camps, gameTime: firstSpawnAt - 0.1, includeUnknown });
    assert.deepEqual(before.stops, []);
    assert.equal(before.nextAvailableAt, firstSpawnAt);
    assert.equal(before.excludedCampIds.length, 6);
  }
  const boundary = planRoute({ camps, gameTime: firstSpawnAt, includeUnknown: true });
  assert.equal(boundary.stops.length, 3);
  assert.ok(boundary.stops.every(stop => stop.uncertain));
});

test('late first-spawn camps are not targeted until their own spawn boundary', () => {
  const camps = CAMPS.map(camp => ({ ...camp, status: 'unknown' }));
  const early = planRoute({ camps, gameTime: 55, routeLength: 6 });
  assert.deepEqual(new Set(early.stops.map(stop => stop.campId)), new Set(['blue', 'wolves', 'raptors', 'red']));
  const full = planRoute({ camps, gameTime: 67, routeLength: 6 });
  assert.equal(full.stops.length, 6);
});
