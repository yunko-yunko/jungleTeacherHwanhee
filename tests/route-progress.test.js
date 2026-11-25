'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AppService } = require('../service/app-service');

class FakeTransport extends EventEmitter {
  start() {}
  stop() {}
}

function game(overrides = {}) {
  return {
    time: 500, mapNumber: 11, mode: 'CLASSIC', team: 'ORDER', movementSpeed: 350,
    championName: 'Vi', summonerName: 'Tester#KR1', ...overrides,
  };
}

function setup(t, mode = 'live') {
  const lcu = new FakeTransport();
  const live = new FakeTransport();
  const clock = { now: 1000 };
  const service = new AppService({ lcu, live, mode, now: () => clock.now });
  service.start();
  t.after(() => service.stop());
  return { service, lcu, live, clock };
}

test('manual demo completion advances the physical origin and starts an estimated respawn timer', t => {
  const { service } = setup(t, 'demo');
  const before = service.snapshot();
  const completedId = before.plan.stops[0].campId;
  let published = null;
  service.once('state', state => { published = state; });
  const after = service.completeNext();
  const completed = after.camps.find(camp => camp.id === completedId);
  assert.notEqual(before.settings.startCamp, completedId);
  assert.equal(after.settings.startCamp, completedId);
  assert.equal(completed.observedAt, before.game.time);
  assert.equal(completed.status, 'respawning');
  assert.equal(completed.source, 'timer');
  assert.equal(completed.availableAt, before.game.time + completed.respawnSeconds);
  assert.notEqual(after.plan.stops[0].campId, completedId);
  assert.equal(after.plan.path[0], completedId);
  assert.equal(after.plan.stops[0].path[0], completedId);
  assert.strictEqual(published, after);
});

test('connected Live data can confirm a camp while LCU is unavailable', t => {
  const { service, live } = setup(t);
  live.emit('data', game());
  const before = service.snapshot();
  const campId = before.plan.stops[0].campId;
  assert.equal(before.connection.lcu, 'waiting');
  const after = service.completeNext();
  assert.equal(after.settings.startCamp, campId);
  assert.equal(after.camps.find(camp => camp.id === campId).observedAt, 500);
  assert.notEqual(after.plan.stops[0].campId, campId);
});

test('offline or disconnected sessions reject completion without changing observations or origin', t => {
  const { service, live } = setup(t);
  const original = service.snapshot();
  assert.throws(() => service.completeNext(), /게임 연결/);
  assert.deepEqual(service.snapshot().settings, original.settings);
  assert.ok(service.snapshot().camps.every(camp => camp.observedAt === null));
  live.emit('data', game());
  live.emit('status', { connected: false, error: '연결 중단' });
  assert.throws(() => service.completeNext(), /게임 연결/);
  assert.deepEqual(service.snapshot().settings, original.settings);
  assert.ok(service.snapshot().camps.every(camp => camp.observedAt === null));
});

test('unsupported maps and unknown teams reject completion before mutation', t => {
  const { service, live } = setup(t);
  live.emit('data', game({ mapNumber: 12, mode: 'ARAM' }));
  assert.throws(() => service.completeNext(), /소환사의 협곡/);
  live.emit('data', game({ team: null }));
  assert.throws(() => service.completeNext(), /아군 진영/);
  assert.ok(service.snapshot().camps.every(camp => camp.observedAt === null));
  assert.equal(service.snapshot().settings.startCamp, 'blue');
});

test('empty unknown-filtered routes reject completion instead of inventing a target', t => {
  const { service, live } = setup(t);
  live.emit('data', game());
  service.updateSettings({ includeUnknown: false });
  assert.equal(service.snapshot().plan.stops.length, 0);
  assert.throws(() => service.completeNext(), /완료할 추천 캠프/);
  assert.ok(service.snapshot().camps.every(camp => camp.status === 'unknown' && camp.observedAt === null));
  assert.equal(service.snapshot().settings.startCamp, 'blue');
});

test('time updates and route recomputation never automatically record camp completion', t => {
  const { service, live } = setup(t);
  live.emit('data', game());
  const nextId = service.snapshot().plan.stops[0].campId;
  service.publish();
  live.emit('data', game({ time: 600 }));
  assert.equal(service.snapshot().camps.find(camp => camp.id === nextId).observedAt, null);
  const recorded = service.completeNext();
  const recordedId = recorded.settings.startCamp;
  assert.equal(recorded.camps.find(camp => camp.id === recordedId).observedAt, 600);
  live.emit('data', game({ time: 601 }));
  assert.equal(service.snapshot().camps.find(camp => camp.id === recordedId).observedAt, 600);
  assert.ok(service.snapshot().camps.filter(camp => camp.id !== recordedId).every(camp => camp.observedAt === null));
});

test('stopped demo sessions reject completion even though preview snapshots contain demo data', t => {
  const { service } = setup(t, 'demo');
  service.stop();
  assert.throws(() => service.completeNext(), /게임 연결/);
  assert.ok(service.snapshot().camps.every(camp => camp.observedAt === null));
});
