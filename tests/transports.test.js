'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { LcuClient, requestLcuJson } = require('../service/lcu-client');
const { LiveClient, normalizeLiveData } = require('../service/live-client');

function payload(overrides = {}) {
  return {
    gameData: { gameTime: 320, gameMode: 'CLASSIC', mapNumber: 11 },
    activePlayer: {
      riotId: '정글러#KR1', summonerName: '정글러', level: 5, currentGold: 450,
      championStats: { currentHealth: 810, maxHealth: 1000, moveSpeed: 355 }
    },
    allPlayers: [
      { riotId: '정글러#KR2', summonerName: '정글러', team: 'CHAOS', championName: 'Lee Sin', scores: { kills: 9 } },
      { riotId: '정글러#KR1', summonerName: '정글러', team: 'ORDER', championName: 'Vi', scores: { kills: 2, deaths: 1, assists: 3, creepScore: 40 } }
    ],
    ...overrides
  };
}

test('Live API chooses full Riot ID before a shared name and normalizes usable stats', () => {
  const data = normalizeLiveData(payload());
  assert.equal(data.team, 'ORDER');
  assert.equal(data.championName, 'Vi');
  assert.equal(data.kills, 2);
  assert.equal(data.cs, 40);
  assert.equal(data.time, 320);
  assert.equal(data.health, 810);
  assert.equal(data.movementSpeed, 355);
});

test('unidentified or ambiguous active player never guesses the ally team', () => {
  const data = normalizeLiveData(payload({ activePlayer: { summonerName: '정글러' } }));
  assert.equal(data.team, null);
  assert.equal(data.championName, '');
  assert.equal(data.movementSpeed, 350);
  assert.equal(normalizeLiveData(payload({ activePlayer: { riotId: '없는아이디#KR1' } })).team, null);
});

test('malformed live data is rejected; missing numeric values do not propagate NaN', () => {
  for (const invalid of [null, {}, payload({ gameData: { gameTime: NaN } }), payload({ gameData: { gameTime: -1 } })]) {
    assert.throws(() => normalizeLiveData(invalid));
  }
  const data = normalizeLiveData(payload({ activePlayer: { riotId: '정글러#KR1', championStats: { moveSpeed: 0, currentHealth: NaN } } }));
  assert.equal(data.health, 0);
  assert.equal(data.movementSpeed, 350);
});

test('LCU reads only allowlisted GET data and does not emit auth secrets', async () => {
  const credentials = { port: 12345, password: 'do-not-emit', certificate: 'private-cert', pid: 1 };
  const paths = [];
  const client = new LcuClient({
    authenticate: async () => credentials,
    request: async (path, receivedCredentials, options) => {
      paths.push(path);
      assert.equal(receivedCredentials, credentials);
      assert.equal(options.signal.aborted, false);
      if (path.endsWith('gameflow-phase')) return 'InProgress';
      if (path.endsWith('current-summoner')) return { displayName: '테스터', summonerLevel: 30, password: 'leak' };
      return { gameData: { gameId: 123 } };
    }
  });
  const result = once(client, 'state');
  client.start();
  const [state] = await result;
  client.stop();
  assert.equal(state.connected, true);
  assert.equal(state.phase, 'InProgress');
  assert.equal(state.gameId, 123);
  assert.equal(state.summoner.displayName, '테스터');
  assert.equal(paths.length, 3);
  assert.equal(JSON.stringify(state).includes('do-not-emit'), false);
  assert.equal(JSON.stringify(state).includes('leak'), false);
  await assert.rejects(requestLcuJson('https://example.com/', credentials), /Unsupported/);
});

test('missing optional summoner/session endpoints do not drop an available LCU', async () => {
  const client = new LcuClient({
    authenticate: async () => ({}),
    request: async (path) => {
      if (path.endsWith('gameflow-phase')) return 'Lobby';
      throw new Error('404');
    }
  });
  const event = once(client, 'state');
  client.start();
  const [state] = await event;
  client.stop();
  assert.equal(state.connected, true);
  assert.equal(state.summoner, null);
  assert.equal(state.gameId, null);
});

test('LCU retries discovery after restart and emits sanitized failures', async () => {
  let authenticationCount = 0;
  let phaseCount = 0;
  const client = new LcuClient({
    pollInterval: 1,
    authenticate: async () => ({ generation: ++authenticationCount }),
    request: async (path, credentials) => {
      if (!path.endsWith('gameflow-phase')) return null;
      if (++phaseCount === 1) throw new Error('sensitive-auth-token');
      assert.equal(credentials.generation, 2);
      return 'InProgress';
    }
  });
  const states = [];
  const done = new Promise((resolve) => client.on('state', (state) => {
    states.push(state);
    if (states.length === 2) { client.stop(); resolve(); }
  }));
  client.start();
  await done;
  assert.equal(states[0].connected, false);
  assert.equal(states[0].error.includes('sensitive'), false);
  assert.equal(states[1].connected, true);
  assert.equal(authenticationCount, 2);
});

test('stop aborts a live request and suppresses late data and status', async () => {
  let release;
  let signal;
  const client = new LiveClient({ request: (options) => {
    signal = options.signal;
    return new Promise((resolve) => { release = resolve; });
  } });
  const emitted = [];
  client.on('data', (value) => emitted.push(value));
  client.on('status', (value) => emitted.push(value));
  client.start();
  client.stop();
  assert.equal(signal.aborted, true);
  release(payload());
  await delay(5);
  assert.deepEqual(emitted, []);
});

test('stop during discovery suppresses late LCU state and requests', async () => {
  let release;
  let requests = 0;
  const client = new LcuClient({
    authenticate: () => new Promise((resolve) => { release = resolve; }),
    request: async () => { requests++; return 'InProgress'; }
  });
  const states = [];
  client.on('state', (state) => states.push(state));
  client.start();
  await Promise.resolve();
  client.stop();
  release({});
  await delay(5);
  assert.equal(requests, 0);
  assert.deepEqual(states, []);
});

test('live polling does not overlap slow requests or duplicate start calls', async () => {
  let inflight = 0;
  let maxInflight = 0;
  let count = 0;
  const client = new LiveClient({ pollInterval: 1, request: async () => {
    inflight++;
    maxInflight = Math.max(inflight, maxInflight);
    await delay(8);
    inflight--;
    count++;
    return payload();
  } });
  const done = new Promise((resolve) => client.on('status', () => {
    if (count === 3) { client.stop(); resolve(); }
  }));
  client.start();
  client.start();
  await done;
  assert.equal(count, 3);
  assert.equal(maxInflight, 1);
});

test('malformed Live API reply emits disconnected status without stale data', async () => {
  const client = new LiveClient({ request: async () => ({}) });
  const data = [];
  client.on('data', (value) => data.push(value));
  const event = once(client, 'status');
  client.start();
  const [status] = await event;
  client.stop();
  assert.equal(status.connected, false);
  assert.deepEqual(data, []);
});

test('slow authentication is bounded without spawning overlapping process discovery', async () => {
  let discoveries = 0;
  let release;
  let emitted = 0;
  const client = new LcuClient({
    timeoutMs: 5, pollInterval: 1,
    authenticate: () => { discoveries++; return new Promise((resolve) => { release = resolve; }); },
    request: async () => 'None'
  });
  const done = new Promise((resolve) => client.on('state', (state) => {
    assert.equal(state.connected, false);
    if (++emitted === 2) { client.stop(); resolve(); }
  }));
  client.start();
  await done;
  assert.equal(discoveries, 1);
  release({});
  await delay(2);
  assert.equal(emitted, 2);
});

test('restarting live client ignores a previous generation that resolves later', async () => {
  let requestCount = 0;
  let oldRelease;
  const client = new LiveClient({ request: async () => {
    if (++requestCount === 1) return new Promise((resolve) => { oldRelease = resolve; });
    return payload({ gameData: { gameTime: 42, gameMode: 'CLASSIC', mapNumber: 11 } });
  } });
  const times = [];
  client.on('data', (data) => times.push(data.time));
  client.start();
  client.stop();
  const done = once(client, 'status');
  client.start();
  await done;
  client.stop();
  oldRelease(payload());
  await delay(2);
  assert.deepEqual(times, [42]);
});

test('manual refresh fetches immediately between regular polling ticks and returns new normalized data', async (t) => {
  let requests = 0;
  const client = new LiveClient({ pollInterval: 60_000, request: async () =>
    payload({ gameData: { gameTime: 320 + requests++, gameMode: 'CLASSIC', mapNumber: 11 } })
  });
  t.after(() => client.stop());
  const times = [];
  client.on('data', data => times.push(data.time));
  client.start();
  const initial = await client.refresh();
  assert.equal(initial.time, 320);
  assert.equal(requests, 1);
  const fresh = await client.refresh();
  assert.equal(fresh.time, 321);
  assert.equal(fresh.championName, 'Vi');
  assert.equal(requests, 2);
  assert.deepEqual(times, [320, 321]);
});

test('simultaneous manual refreshes coalesce with an active periodic GET', async (t) => {
  let requests = 0;
  let release;
  const client = new LiveClient({ pollInterval: 60_000, request: () => {
    requests++;
    return new Promise(resolve => { release = resolve; });
  } });
  t.after(() => client.stop());
  let events = 0;
  client.on('data', () => events++);
  client.start();
  const first = client.refresh();
  const second = client.refresh();
  assert.equal(first, second);
  assert.equal(requests, 1);
  release(payload());
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one, two);
  assert.equal(events, 1);
});

test('repeated immediate refreshes replace the periodic timer without creating extra polling chains', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requests = 0;
  const client = new LiveClient({ pollInterval: 100, request: async () => {
    requests++;
    return payload();
  } });
  t.after(() => client.stop());
  client.start();
  await client.refresh();
  for (let index = 0; index < 3; index++) await client.refresh();
  assert.equal(requests, 4);
  t.mock.timers.tick(99);
  assert.equal(requests, 4);
  t.mock.timers.tick(1);
  assert.equal(requests, 5);
  await client.refresh();
  t.mock.timers.tick(100);
  assert.equal(requests, 6);
  await client.refresh();
  client.stop();
  t.mock.timers.tick(1000);
  assert.equal(requests, 6);
});

test('stop promptly rejects manual refresh even when a request ignores abort and resolves later', async () => {
  let release;
  let signal;
  const client = new LiveClient({ request: options => {
    signal = options.signal;
    return new Promise(resolve => { release = resolve; });
  } });
  const emitted = [];
  client.on('data', data => emitted.push(data));
  client.on('status', status => emitted.push(status));
  client.start();
  const pending = client.refresh();
  const rejected = assert.rejects(pending, /중지/);
  client.stop();
  assert.equal(signal.aborted, true);
  await rejected;
  await assert.rejects(client.refresh(), /중지/);
  release(payload());
  await Promise.resolve();
  assert.deepEqual(emitted, []);
});

test('manual refresh after restart never receives data from a previous request generation', async (t) => {
  let requests = 0;
  let releaseOld;
  const client = new LiveClient({ pollInterval: 60_000, request: () => {
    if (++requests === 1) return new Promise(resolve => { releaseOld = resolve; });
    return Promise.resolve(payload({ gameData: { gameTime: 42, gameMode: 'CLASSIC', mapNumber: 11 } }));
  } });
  t.after(() => client.stop());
  const times = [];
  client.on('data', data => times.push(data.time));
  client.start();
  const oldRefresh = client.refresh();
  const rejected = assert.rejects(oldRefresh, /중지/);
  client.stop();
  client.start();
  const current = await client.refresh();
  assert.equal(current.time, 42);
  await rejected;
  releaseOld(payload());
  await Promise.resolve();
  assert.deepEqual(times, [42]);
  assert.equal(requests, 2);
});

test('failed manual refresh rejects a sanitized error, emits disconnected status, and can retry', async (t) => {
  let requests = 0;
  const client = new LiveClient({ pollInterval: 60_000, timeoutMs: 17, request: async options => {
    assert.equal(options.timeoutMs, 17);
    assert.equal(options.signal.aborted, false);
    if (++requests === 1) throw new Error('sensitive-local-response');
    return payload();
  } });
  t.after(() => client.stop());
  const statuses = [];
  const data = [];
  client.on('status', status => statuses.push(status));
  client.on('data', value => data.push(value));
  client.start();
  await assert.rejects(client.refresh(), error => {
    assert.equal(error.message.includes('sensitive'), false);
    assert.match(error.message, /갱신/);
    return true;
  });
  assert.equal(statuses[0].connected, false);
  assert.equal(statuses[0].error.includes('sensitive'), false);
  assert.deepEqual(data, []);
  const refreshed = await client.refresh();
  assert.equal(refreshed.time, 320);
  assert.equal(statuses[1].connected, true);
  assert.equal(data.length, 1);
});

test('manual refresh rejects malformed API JSON data rather than returning stale normalized data', async (t) => {
  const client = new LiveClient({ pollInterval: 60_000, request: async () => ({}) });
  t.after(() => client.stop());
  client.start();
  await assert.rejects(client.refresh(), /갱신/);
});
