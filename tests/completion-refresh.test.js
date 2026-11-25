'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AppService } = require('../service/app-service');

const game = time => ({ time, mapNumber: 11, mode: 'CLASSIC', team: 'ORDER', movementSpeed: 350 });
class FakeTransport extends EventEmitter { start() {} stop() {} }
function setup(t) {
  const lcu = new FakeTransport();
  const live = new FakeTransport();
  const service = new AppService({ lcu, live });
  service.start();
  live.emit('data', game(500));
  t.after(() => service.stop());
  const state = service.snapshot();
  return { service, live, target: { campId: state.plan.stops[0].campId, matchKey: state.matchKey } };
}

test('completion excludes the clicked camp before one fresh GET and remains excluded in every route slot', async t => {
  const { service, live, target } = setup(t);
  service.updateSettings({ routeLength: 6 });
  let release;
  let refreshes = 0;
  live.refresh = () => { refreshes++; return new Promise(resolve => { release = () => { live.emit('data', game(501)); resolve(game(501)); }; }); };
  const pending = service.completeNextAndRefresh(target);
  assert.equal(service.snapshot().camps.find(camp => camp.id === target.campId).status, 'respawning');
  assert.ok(service.snapshot().plan.stops.every(stop => stop.campId !== target.campId));
  await Promise.resolve();
  assert.equal(refreshes, 1);
  release();
  const after = await pending;
  assert.equal(after.game.time, 501);
  assert.ok(after.plan.stops.every(stop => stop.campId !== target.campId));
  assert.equal(after.camps.find(camp => camp.id === target.campId).observedAt, 500);
});

test('concurrent completion from two windows shares the refresh and records only one camp', async t => {
  const { service, live, target } = setup(t);
  let release;
  live.refresh = () => new Promise(resolve => { release = resolve; });
  const first = service.completeNextAndRefresh(target);
  const second = service.completeNextAndRefresh(target);
  assert.strictEqual(second, first);
  assert.equal(service.snapshot().camps.filter(camp => camp.observedAt !== null).length, 1);
  await Promise.resolve();
  release();
  await first;
});

test('failed refresh preserves the clear, never revives it when the same game reconnects', async t => {
  const { service, live, target } = setup(t);
  live.refresh = async () => { live.emit('status', { connected: false, error: '연결 끊김' }); throw new Error('offline'); };
  const failed = await service.completeNextAndRefresh(target);
  assert.equal(failed.game, null);
  live.emit('data', game(503));
  const after = service.snapshot();
  assert.equal(after.camps.find(camp => camp.id === target.campId).status, 'respawning');
  assert.ok(after.plan.stops.every(stop => stop.campId !== target.campId));
});

test('stale clicked camp and previous-match completions are rejected without clearing another camp', t => {
  const { service, target } = setup(t);
  assert.throws(() => service.completeNext({ ...target, campId: 'gromp' }), /추천 캠프가 변경/);
  assert.throws(() => service.completeNext({ ...target, matchKey: 'old-match' }), /경기가 변경/);
  assert.ok(service.snapshot().camps.every(camp => camp.observedAt === null));
});

test('a slightly older in-flight game clock cannot erase a recorded death', async t => {
  const { service, live, target } = setup(t);
  live.refresh = async () => { live.emit('data', game(499.8)); };
  const after = await service.completeNextAndRefresh(target);
  assert.equal(after.camps.find(camp => camp.id === target.campId).status, 'respawning');
  assert.ok(after.plan.stops.every(stop => stop.campId !== target.campId));
});

test('responses crossing mode changes return current state and never apply a second clear', async t => {
  const { service, live, target } = setup(t);
  let release;
  live.refresh = () => new Promise(resolve => { release = resolve; });
  const pending = service.completeNextAndRefresh(target);
  await Promise.resolve();
  service.setMode('demo');
  const before = service.snapshot();
  release();
  const after = await pending;
  assert.equal(after.mode, 'demo');
  assert.deepEqual(after.camps.map(camp => [camp.id, camp.observedAt]), before.camps.map(camp => [camp.id, camp.observedAt]));
  assert.ok(after.revision > before.revision);
});

test('all known killed camps leave no farming route until the first respawn time', t => {
  const { service, live } = setup(t);
  service.updateSettings({ routeLength: 6 });
  const killed = service.snapshot().camps;
  for (const camp of killed) service.observeCamp(camp.id, 'cleared');
  let state = service.snapshot();
  assert.equal(state.plan.stops.length, 0);
  assert.equal(state.plan.nextAvailableAt, 635);
  live.emit('data', game(634.9));
  assert.equal(service.snapshot().plan.stops.length, 0);
  live.emit('data', game(635));
  state = service.snapshot();
  assert.ok(state.plan.stops.length > 0);
  assert.ok(state.plan.stops.every(stop => !['blue', 'red'].includes(stop.campId)));
});
