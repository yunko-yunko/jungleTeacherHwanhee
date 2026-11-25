'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CAMPS } = require('../service/camps');
const { buildUndirectedGraph, dijkstra, shortestPath } = require('../service/algorithms/graph');
const { topologicalSort, scheduleTasks } = require('../service/algorithms/topological');
const { planRoute } = require('../service/algorithms/route-planner');

test('Dijkstra finds cheaper multi-edge paths in either direction', () => {
  const graph = buildUndirectedGraph(['a', 'b', 'c', 'd', 'isolated'], [
    { from: 'a', to: 'b', weight: 3 }, { from: 'b', to: 'c', weight: 4 },
    { from: 'a', to: 'c', weight: 20 }, { from: 'c', to: 'd', weight: 2 },
  ]);
  assert.deepEqual(shortestPath(graph, 'a', 'd'), { distance: 9, path: ['a', 'b', 'c', 'd'] });
  assert.deepEqual(shortestPath(graph, 'd', 'a'), { distance: 9, path: ['d', 'c', 'b', 'a'] });
  assert.deepEqual(shortestPath(graph, 'a', 'isolated'), { distance: Infinity, path: [] });
  assert.deepEqual(shortestPath(graph, 'a', 'a'), { distance: 0, path: ['a'] });
  assert.equal(dijkstra(graph, 'a').distances.get('c'), 7);
});

test('graph rejects negative weights and invalid endpoints; parallel edges retain cheapest weight', () => {
  assert.throws(() => buildUndirectedGraph(['a'], [{ from: 'a', to: 'a', weight: -1 }]), /non-negative/);
  assert.throws(() => buildUndirectedGraph(['a'], [{ from: 'a', to: 'missing', weight: 1 }]), /unknown/);
  assert.throws(() => buildUndirectedGraph(['a', 'a'], []), /unique/);
  const graph = buildUndirectedGraph(['a', 'b'], [{ from: 'a', to: 'b', weight: 7 }, { from: 'b', to: 'a', weight: 0 }]);
  assert.equal(shortestPath(graph, 'a', 'b').distance, 0);
  assert.throws(() => dijkstra(graph, 'missing'), /Unknown/);
});

test('Kahn resolves a DAG provided out of dependency order and scheduler respects both parents', () => {
  const tasks = [
    { id: 'clear', duration: 20, dependsOn: ['ready'] },
    { id: 'ready', dependsOn: ['arrival', 'spawn'] },
    { id: 'arrival', duration: 8, releaseAt: 180 },
    { id: 'spawn', releaseAt: 220 },
  ];
  assert.deepEqual(topologicalSort(tasks).map(task => task.id), ['arrival', 'spawn', 'ready', 'clear']);
  const scheduled = new Map(scheduleTasks(tasks).map(task => [task.id, task]));
  assert.equal(scheduled.get('ready').startAt, 220);
  assert.equal(scheduled.get('clear').finishAt, 240);
});

test('topological sorting rejects cycles, missing dependencies, duplicate IDs and invalid durations', () => {
  assert.throws(() => topologicalSort([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }]), /cycle/);
  assert.throws(() => topologicalSort([{ id: 'a', dependsOn: ['a'] }]), /cycle/);
  assert.throws(() => topologicalSort([{ id: 'a', dependsOn: ['missing'] }]), /Unknown/);
  assert.throws(() => topologicalSort([{ id: 'a' }, { id: 'a' }]), /unique/);
  assert.throws(() => scheduleTasks([{ id: 'a', duration: -1 }]), /non-negative/);
});

test('route integrates shortest walking paths, clear estimates and dependency scheduling', () => {
  const camps = CAMPS.map(camp => ({ ...camp, status: 'alive', availableAt: 180 }));
  const route = planRoute({ camps, startCamp: 'blue', gameTime: 180 });
  assert.deepEqual(route.stops.map(stop => stop.campId), ['blue', 'gromp', 'wolves']);
  assert.deepEqual(route.path, ['blue', 'gromp', 'wolves']);
  assert.equal(route.travelSeconds, 16);
  assert.equal(route.clearSeconds, 54);
  assert.equal(route.waitSeconds, 0);
  assert.equal(route.totalSeconds, 70);
  assert.equal(route.stops[2].finishAt, 250);
  assert.ok(route.stops.every(stop => !stop.uncertain));
  const byId = new Map(route.taskOrder.map(task => [task.id, task]));
  for (const task of route.taskOrder) {
    for (const parent of task.dependsOn || []) assert.ok(byId.get(parent).finishAt <= task.startAt);
  }
});

test('respawning camps are excluded until a later snapshot confirms the timer elapsed', () => {
  const camps = [{ ...CAMPS[0], status: 'respawning', availableAt: 300 }];
  const route = planRoute({ camps, startCamp: 'blue', gameTime: 200, routeLength: 1 });
  assert.equal(route.stops.length, 0);
  assert.equal(route.waitSeconds, 0);
  assert.equal(route.totalSeconds, 0);
  assert.equal(route.nextAvailableAt, 300);
  assert.deepEqual(route.excludedCampIds, ['blue']);
  assert.match(route.reason, /재생성/);
});

test('planner can leave a respawning current camp for a faster available target', () => {
  const camps = CAMPS.slice(0, 2).map(camp => ({ ...camp, status: camp.id === 'blue' ? 'respawning' : 'alive', availableAt: camp.id === 'blue' ? 500 : 180 }));
  const route = planRoute({ camps, gameTime: 180, routeLength: 1 });
  assert.equal(route.stops[0].campId, 'gromp');
  assert.equal(route.travelSeconds, 6);
});

test('unknown filter never treats unobserved camps as confirmed alive', () => {
  const camps = CAMPS.map(camp => ({ ...camp, status: 'unknown' }));
  assert.equal(planRoute({ camps, includeUnknown: false }).stops.length, 0);
  const route = planRoute({ camps, gameTime: 180 });
  assert.ok(route.stops.length > 0);
  assert.ok(route.stops.every(stop => stop.uncertain));
});

test('movement speed scales walking, disconnected camps are skipped and input is validated', () => {
  const camps = CAMPS.slice(0, 2).map(camp => ({ ...camp, status: 'alive', availableAt: 180 }));
  const fast = planRoute({ camps, gameTime: 180, movementSpeed: 700, routeLength: 2 });
  assert.equal(fast.travelSeconds, 3);
  const disconnected = buildUndirectedGraph(CAMPS, []);
  const route = planRoute({ camps, gameTime: 180, graph: disconnected, routeLength: 2 });
  assert.deepEqual(route.stops.map(stop => stop.campId), ['blue']);
  assert.match(route.reason, /도달/);
  assert.throws(() => planRoute({ routeLength: 0 }), /between/);
  assert.throws(() => planRoute({ movementSpeed: 0 }), /movement/);
  assert.throws(() => planRoute({ gameTime: NaN }), /game time/);
  assert.throws(() => planRoute({ startCamp: 'missing' }), /start camp/);
});
