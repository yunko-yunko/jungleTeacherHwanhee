'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AppService } = require('../service/app-service');
const { OverlayPolicy } = require('../ui/overlay-policy');

class FakeTransport extends EventEmitter {
  starts = 0;
  stops = 0;
  start() { this.starts++; }
  stop() { this.stops++; }
}

function game(overrides = {}) {
  return {
    time: 500, mapNumber: 11, mode: 'CLASSIC', team: 'ORDER',
    summonerName: '테스터#KR1', championName: 'Vi', level: 6,
    health: 800, maxHealth: 1000, gold: 1000, kills: 1, deaths: 0, assists: 2, cs: 45, movementSpeed: 350,
    ...overrides
  };
}

function lcuState(overrides = {}) {
  return { connected: true, phase: 'InProgress', summoner: { displayName: '테스터' }, gameId: 123, error: null, ...overrides };
}

function setup(t, mode = 'live') {
  const lcu = new FakeTransport();
  const live = new FakeTransport();
  const clock = { now: 1000 };
  const service = new AppService({ lcu, live, mode, now: () => clock.now });
  t.after(() => service.stop());
  service.start();
  const camp = (id = 'blue') => service.snapshot().camps.find(value => value.id === id);
  return { lcu, live, service, clock, camp };
}

test('Live API can drive the game and planner while LCU is unavailable', (t) => {
  const { lcu, live, service } = setup(t);
  lcu.emit('state', lcuState({ connected: false, phase: 'None', gameId: null, error: '대기 중' }));
  live.emit('data', game());
  const state = service.snapshot();
  assert.equal(state.connection.lcu, 'waiting');
  assert.equal(state.connection.live, 'connected');
  assert.equal(state.phase, 'InProgress');
  assert.equal(state.game.championName, 'Vi');
  assert.equal(state.plan.stops.length, 3);
});

test('Live disconnect clears the current game and route instead of reusing cached live stats', (t) => {
  const { live, service } = setup(t);
  live.emit('data', game());
  service.observeCamp('blue', 'cleared');
  live.emit('status', { connected: false, error: '연결 중단' });
  const state = service.snapshot();
  assert.equal(state.game, null);
  assert.equal(state.connection.live, 'stale');
  assert.equal(state.plan.stops.length, 0);
  assert.throws(() => service.observeCamp('red', 'alive'));
});

test('game clock rollover resets manual observations for a new Live-only match', (t) => {
  const { live, service, camp } = setup(t);
  live.emit('data', game({ time: 500 }));
  service.observeCamp('blue', 'cleared');
  const oldMatchKey = service.snapshot().matchKey;
  assert.equal(camp().observedAt, 500);
  live.emit('data', game({ time: 2 }));
  assert.equal(service.snapshot().game.time, 2);
  assert.equal(camp().observedAt, null);
  assert.equal(camp().status, 'unknown');
  assert.notEqual(service.snapshot().matchKey, oldMatchKey);
});

test('gameflow end clears the current game and observations, including later stale data', (t) => {
  const { lcu, live, service, camp } = setup(t);
  lcu.emit('state', lcuState());
  live.emit('data', game());
  service.observeCamp('blue', 'cleared');
  lcu.emit('state', lcuState({ phase: 'EndOfGame' }));
  live.emit('data', game({ time: 501 }));
  assert.equal(service.snapshot().game, null);
  assert.equal(service.snapshot().plan.stops.length, 0);
  assert.equal(camp().observedAt, null);
});

test('LCU reconnecting directly to idle after a Live-only match clears observations', (t) => {
  const { lcu, live, service, camp } = setup(t);
  live.emit('data', game());
  service.observeCamp('blue', 'cleared');
  assert.equal(camp().observedAt, 500);
  lcu.emit('state', lcuState({ phase: 'Lobby', gameId: null }));
  assert.equal(service.snapshot().game, null);
  assert.equal(camp().observedAt, null);
  assert.equal(camp().status, 'unknown');
  assert.throws(() => service.observeCamp('blue', 'alive'));
  live.emit('data', game({ time: 501 }));
  assert.equal(service.snapshot().game, null);
  assert.equal(camp().observedAt, null);
});

test('new LCU game ID resets observations even if the live game clock increased', (t) => {
  const { lcu, live, service, camp } = setup(t);
  lcu.emit('state', lcuState());
  live.emit('data', game());
  service.observeCamp('blue', 'cleared');
  lcu.emit('state', lcuState({ gameId: 124 }));
  live.emit('data', game({ time: 600 }));
  assert.equal(camp().observedAt, null);
  assert.equal(service.snapshot().game.time, 600);
});

test('temporary disconnect can reconnect to the same match without losing manual evidence', (t) => {
  const { live, service, camp } = setup(t);
  live.emit('data', game());
  service.observeCamp('blue', 'cleared');
  live.emit('status', { connected: false, error: '연결 중단' });
  live.emit('data', game({ time: 503 }));
  assert.equal(camp().observedAt, 500);
  assert.equal(service.snapshot().game.time, 503);
});

test('demo data and real transport events remain isolated across mode transitions', (t) => {
  const { lcu, live, service, camp, clock } = setup(t);
  live.emit('data', game());
  service.observeCamp('krugs', 'cleared');
  service.setMode('demo');
  assert.equal(service.snapshot().mode, 'demo');
  assert.equal(camp('krugs').observedAt, null);
  assert.equal(camp('blue').observedAt, 430);
  live.emit('data', game({ time: 9999, team: 'CHAOS' }));
  lcu.emit('state', lcuState({ phase: 'Lobby' }));
  clock.now += 2000;
  assert.equal(service.snapshot().game.time, 496);
  assert.equal(service.snapshot().game.team, 'ORDER');
  service.setMode('live');
  assert.equal(service.snapshot().game, null);
  assert.equal(camp().observedAt, null);
  assert.equal(lcu.starts, 2);
  assert.equal(live.starts, 2);
  live.emit('data', game({ time: 100 }));
  assert.equal(service.snapshot().game.time, 100);
});

test('demo startup never starts the real transports', (t) => {
  const { lcu, live, service } = setup(t, 'demo');
  assert.equal(lcu.starts, 0);
  assert.equal(live.starts, 0);
  assert.equal(service.snapshot().connection.live, 'demo');
});

test('settings validate atomically and reject unsupported keys and types', (t) => {
  const { service } = setup(t);
  const original = service.snapshot().settings;
  for (const invalid of [
    null, [], { routeLength: 0 }, { routeLength: 7 }, { routeLength: 2.5 }, { routeLength: '3' },
    { includeUnknown: 1 }, { team: 'enemy' }, { startCamp: 'baron' }, { password: 'nope' },
    { startCamp: 'red', routeLength: 999 }
  ]) {
    assert.throws(() => service.updateSettings(invalid));
    assert.deepEqual(service.snapshot().settings, original);
  }
  const result = service.updateSettings({ startCamp: 'red', routeLength: 5, includeUnknown: false });
  assert.equal(result.settings.startCamp, 'red');
  assert.equal(result.settings.routeLength, 5);
  assert.equal(result.settings.includeUnknown, false);
});

test('unsupported map still displays game data but disables camp actions and routes', (t) => {
  const { live, service } = setup(t);
  live.emit('data', game({ mapNumber: 12, mode: 'ARAM' }));
  const state = service.snapshot();
  assert.equal(state.game.championName, 'Vi');
  assert.equal(state.supportedMap, false);
  assert.equal(state.plan.stops.length, 0);
  assert.throws(() => service.observeCamp('blue', 'cleared'));
});

test('unknown team blocks observations until a valid manual side is selected', (t) => {
  const { live, service, camp } = setup(t);
  live.emit('data', game({ team: null }));
  assert.equal(service.snapshot().plan.stops.length, 0);
  assert.throws(() => service.observeCamp('blue', 'alive'));
  service.updateSettings({ team: 'CHAOS' });
  assert.equal(service.snapshot().game.team, 'CHAOS');
  service.observeCamp('blue', 'alive');
  assert.equal(camp().status, 'alive');
});

test('stopped service ignores transport events and clears stale game state before restart', (t) => {
  const { lcu, live, service, camp } = setup(t);
  lcu.emit('state', lcuState());
  live.emit('data', game());
  service.observeCamp('blue', 'cleared');
  service.stop();
  live.emit('data', game({ time: 900 }));
  lcu.emit('state', lcuState({ gameId: 999 }));
  assert.equal(service.snapshot().game, null);
  service.start();
  assert.equal(service.snapshot().game, null);
  assert.equal(service.snapshot().connection.lcu, 'waiting');
  assert.equal(camp().observedAt, null);
});

test('switching effective ally side discards observations tied to the previous side', (t) => {
  const { live, service, camp } = setup(t);
  live.emit('data', game({ team: 'ORDER' }));
  service.observeCamp('blue', 'cleared');
  service.updateSettings({ team: 'CHAOS' });
  assert.equal(service.snapshot().game.team, 'CHAOS');
  assert.equal(camp().observedAt, null);
});

test('automatic live team changes clear old-side observations without changing settings', (t) => {
  const { live, service, camp } = setup(t);
  live.emit('data', game({ team: 'ORDER' }));
  service.observeCamp('blue', 'cleared');
  assert.equal(camp().observedAt, 500);
  live.emit('data', game({ time: 501, team: 'CHAOS' }));
  assert.equal(service.snapshot().settings.team, 'auto');
  assert.equal(service.snapshot().game.team, 'CHAOS');
  assert.equal(camp().observedAt, null);
});

test('overlay automatically follows active game phases and preserves a manual hide until game ends', () => {
  const policy = new OverlayPolicy();
  const state = { mode: 'live', phase: 'Lobby', game: null, connection: { live: 'waiting' } };
  policy.update(state);
  assert.equal(policy.visible, false);
  policy.update({ ...state, phase: 'InProgress' });
  assert.equal(policy.visible, true);
  policy.toggle();
  policy.update({ ...state, phase: 'InProgress' });
  assert.equal(policy.visible, false);
  policy.update(state);
  policy.update({ ...state, phase: 'GameStart' });
  assert.equal(policy.visible, true);
  policy.update(state);
  assert.equal(policy.visible, false);
});

test('overlay can activate from Live data without LCU and closes on demo transition', () => {
  const policy = new OverlayPolicy();
  const state = { mode: 'live', phase: 'None', game: game(), connection: { live: 'connected' } };
  policy.update(state);
  assert.equal(policy.visible, true);
  policy.update({ ...state, mode: 'demo' });
  assert.equal(policy.visible, false);
});

test('new match automatically reopens an overlay hidden during the previous Live-only match', (t) => {
  const { live, service } = setup(t);
  const policy = new OverlayPolicy();
  live.emit('data', game({ time: 500 }));
  policy.update(service.snapshot());
  policy.toggle();
  assert.equal(policy.visible, false);
  live.emit('data', game({ time: 1 }));
  policy.update(service.snapshot());
  assert.equal(policy.visible, true);
});
