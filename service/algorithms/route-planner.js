'use strict';

const { CAMPS, EDGES, BASE_MOVEMENT_SPEED } = require('../camps');
const { buildUndirectedGraph, dijkstra, reconstructPath } = require('./graph');
const { scheduleTasks } = require('./topological');

const DEFAULT_GRAPH = buildUndirectedGraph(CAMPS, EDGES);
const VALID_STATUSES = new Set(['unknown', 'alive', 'respawning', 'estimated', 'cleared']);

function availableTime(camp) {
  // Missing a clear timestamp is not evidence that a dead camp has returned.
  if (['respawning', 'cleared'].includes(camp.status) && !Number.isFinite(camp.availableAt)) return Infinity;
  return Math.max(camp.initialSpawnSeconds ?? 0, Number.isFinite(camp.availableAt) ? camp.availableAt : 0);
}

function planRoute({ camps = CAMPS.map(camp => ({ ...camp, status: 'unknown' })), startCamp = 'blue', routeLength = 3, includeUnknown = true, gameTime = 0, movementSpeed = BASE_MOVEMENT_SPEED, graph = DEFAULT_GRAPH } = {}) {
  if (!Number.isInteger(routeLength) || routeLength < 1 || routeLength > 6) throw new RangeError('Route length must be between 1 and 6.');
  if (!Number.isFinite(gameTime) || gameTime < 0) throw new RangeError('Invalid game time.');
  if (!Number.isFinite(movementSpeed) || movementSpeed <= 0) throw new RangeError('Invalid movement speed.');
  if (typeof includeUnknown !== 'boolean') throw new TypeError('includeUnknown must be boolean.');
  if (!(graph instanceof Map) || !graph.has(startCamp)) throw new RangeError('Unknown start camp.');
  if (!Array.isArray(camps) || new Set(camps.map(camp => camp.id)).size !== camps.length) throw new TypeError('Camp IDs must be unique.');
  for (const camp of camps) {
    if (!graph.has(camp.id) || !VALID_STATUSES.has(camp.status)) throw new RangeError('Invalid camp state.');
    if (!Number.isFinite(camp.clearSeconds) || camp.clearSeconds < 0) throw new RangeError('Invalid clear time.');
    if (camp.availableAt != null && (!Number.isFinite(camp.availableAt) || camp.availableAt < 0)) throw new RangeError('Invalid availability time.');
    if (camp.initialSpawnSeconds != null && (!Number.isFinite(camp.initialSpawnSeconds) || camp.initialSpawnSeconds < 0)) throw new RangeError('Invalid initial spawn time.');
  }
  const excludedCampIds = [];
  let nextAvailableAt = null;
  let waitingForRespawn = false;
  const eligible = camps.filter(camp => {
    const releaseAt = availableTime(camp);
    const coolingDown = ['respawning', 'cleared'].includes(camp.status) || releaseAt > gameTime;
    const excluded = coolingDown || (camp.status === 'unknown' && !includeUnknown);
    if (excluded) {
      excludedCampIds.push(camp.id);
      waitingForRespawn ||= coolingDown;
      if (Number.isFinite(releaseAt) && releaseAt > gameTime) nextAvailableAt = Math.min(nextAvailableAt ?? Infinity, releaseAt);
    }
    return !excluded;
  });
  // Freeze this set at the observed game clock. A camp returning by a predicted
  // later arrival must wait for the next real snapshot before it is a target.
  // Every graph node remains available for transit, including a cleared origin.
  const remaining = new Map(eligible.map(camp => [camp.id, camp]));
  const selected = [];
  let current = startCamp;
  let elapsed = gameTime;
  const speedFactor = BASE_MOVEMENT_SPEED / movementSpeed;
  while (remaining.size && selected.length < routeLength) {
    const distances = dijkstra(graph, current);
    const options = [...remaining.values()].map(camp => {
      const travelSeconds = distances.distances.get(camp.id) * speedFactor;
      const arrivalAt = elapsed + travelSeconds;
      const waitSeconds = Math.max(0, availableTime(camp) - arrivalAt);
      return { camp, travelSeconds, waitSeconds, finishAt: arrivalAt + waitSeconds + camp.clearSeconds };
    }).filter(option => Number.isFinite(option.finishAt));
    if (!options.length) break;
    options.sort((left, right) => left.finishAt - right.finishAt || left.camp.id.localeCompare(right.camp.id));
    // Only currently available camps reached this stage. Honor the manually
    // selected origin first if it is also an eligible farming target.
    const choice = selected.length === 0 ? options.find(option => option.camp.id === startCamp && option.waitSeconds === 0) || options[0] : options[0];
    selected.push({ ...choice, path: reconstructPath(distances, current, choice.camp.id) });
    elapsed = choice.finishAt;
    current = choice.camp.id;
    remaining.delete(current);
  }
  const tasks = [];
  selected.forEach((choice, index) => {
    const prefix = `stop-${index + 1}`;
    const label = choice.camp.shortLabel || choice.camp.label || choice.camp.id;
    tasks.push({ id: `${prefix}:available`, label: `${label} 출현 조건 (${choice.camp.status === 'alive' ? '수동 관측' : '추정'})`, duration: 0, releaseAt: availableTime(choice.camp) });
    tasks.push({ id: `${prefix}:travel`, label: `${label} 이동`, duration: choice.travelSeconds, releaseAt: gameTime, dependsOn: index ? [`stop-${index}:clear`] : [] });
    tasks.push({ id: `${prefix}:wait`, label: `${label} 대기 조건`, duration: 0, dependsOn: [`${prefix}:travel`, `${prefix}:available`] });
    tasks.push({ id: `${prefix}:clear`, label: `${label} 사냥`, duration: choice.camp.clearSeconds, dependsOn: [`${prefix}:wait`] });
  });
  const taskOrder = scheduleTasks(tasks);
  const taskById = new Map(taskOrder.map(task => [task.id, task]));
  const stops = selected.map((choice, index) => {
    const prefix = `stop-${index + 1}`;
    const arrivalAt = taskById.get(`${prefix}:travel`).finishAt;
    const beginClearAt = taskById.get(`${prefix}:wait`).finishAt;
    return {
      campId: choice.camp.id,
      label: choice.camp.shortLabel || choice.camp.label || choice.camp.id,
      travelSeconds: choice.travelSeconds,
      waitSeconds: beginClearAt - arrivalAt,
      clearSeconds: choice.camp.clearSeconds,
      arrivalAt,
      finishAt: taskById.get(`${prefix}:clear`).finishAt,
      path: choice.path,
      uncertain: choice.camp.status !== 'alive',
    };
  });
  const path = [startCamp];
  for (const stop of stops) path.push(...stop.path.slice(1));
  const sum = field => stops.reduce((total, stop) => total + stop[field], 0);
  return {
    stops,
    totalSeconds: stops.length ? stops[stops.length - 1].finishAt - gameTime : 0,
    travelSeconds: sum('travelSeconds'),
    waitSeconds: sum('waitSeconds'),
    clearSeconds: sum('clearSeconds'),
    path,
    taskOrder,
    nextAvailableAt,
    excludedCampIds,
    algorithm: 'Dijkstra + greedy + Kahn DAG',
    reason: !stops.length ? (waitingForRespawn ? '재생성을 기다리는 중입니다.' : '현재 조건에 맞는 도달 가능한 캠프가 없습니다.') : remaining.size && stops.length < routeLength ? '일부 캠프는 그래프에서 도달할 수 없습니다.' : null,
  };
}

module.exports = { planRoute };
