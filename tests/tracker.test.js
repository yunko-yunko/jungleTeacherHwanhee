'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JungleTracker } = require('../service/jungle-tracker');

function camp(tracker, id, time) { return tracker.snapshot(time).find(item => item.id === id); }

test('unobserved camps remain unknown before and after estimated initial spawn', () => {
  const tracker = new JungleTracker();
  assert.ok(tracker.snapshot(0).every(item => item.status === 'unknown'));
  assert.ok(tracker.snapshot(900).every(item => item.status === 'unknown' && item.source === 'unknown'));
});

test('manual alive evidence expires rather than pretending presence stays live', () => {
  const tracker = new JungleTracker();
  tracker.observe('blue', 'alive', 100);
  assert.equal(camp(tracker, 'blue', 100).status, 'alive');
  assert.equal(camp(tracker, 'blue', 130).status, 'alive');
  assert.equal(camp(tracker, 'blue', 131).status, 'unknown');
  assert.equal(camp(tracker, 'blue', 131).observationExpired, true);
  assert.equal(camp(tracker, 'blue', 90).status, 'unknown');
});

test('manual clear uses lifecycle DAG to estimate a respawn without confirming presence', () => {
  const tracker = new JungleTracker();
  tracker.observe('blue', 'cleared', 100);
  const before = camp(tracker, 'blue', 399);
  assert.equal(before.status, 'respawning');
  assert.equal(before.availableAt, 400);
  assert.equal(before.source, 'timer');
  assert.deepEqual(before.lifecycleTasks.map(task => [task.id, task.finishAt]), [['blue:observed', 100], ['blue:respawn', 400]]);
  assert.equal(camp(tracker, 'blue', 400).status, 'estimated');
  assert.equal(camp(tracker, 'blue', 900).status, 'estimated');
});

test('unknown observation and reset remove previous evidence', () => {
  const tracker = new JungleTracker();
  tracker.observe('gromp', 'cleared', 100);
  assert.equal(camp(tracker, 'gromp', 100).availableAt, 235);
  tracker.observe('gromp', 'unknown', 110);
  assert.equal(camp(tracker, 'gromp', 110).observedAt, null);
  tracker.observe('red', 'alive', 100);
  tracker.reset();
  assert.ok(tracker.snapshot(100).every(item => item.status === 'unknown'));
});

test('tracker rejects unsupported observations and invalid time without mutation', () => {
  const tracker = new JungleTracker();
  assert.throws(() => tracker.observe('enemy-blue', 'alive', 100), /Unknown camp/);
  assert.throws(() => tracker.observe('blue', 'auto-detected', 100), /Unsupported/);
  assert.throws(() => tracker.observe('blue', 'alive', -1), /non-negative/);
  assert.throws(() => tracker.snapshot(Infinity), /non-negative/);
  assert.ok(tracker.snapshot(100).every(item => item.status === 'unknown'));
});
