'use strict';

function indexTasks(tasks) {
  if (!Array.isArray(tasks)) throw new TypeError('Tasks must be an array.');
  const byId = new Map();
  const indegrees = new Map();
  const children = new Map();
  for (const task of tasks) {
    if (typeof task.id !== 'string' || !task.id || byId.has(task.id)) throw new TypeError('Task IDs must be unique strings.');
    if (task.dependsOn !== undefined && !Array.isArray(task.dependsOn)) throw new TypeError('Dependencies must be an array.');
    byId.set(task.id, task);
    indegrees.set(task.id, 0);
    children.set(task.id, []);
  }
  for (const task of tasks) {
    const dependencies = new Set(task.dependsOn || []);
    for (const dependency of dependencies) {
      if (!byId.has(dependency)) throw new RangeError(`Unknown dependency: ${dependency}`);
      indegrees.set(task.id, indegrees.get(task.id) + 1);
      children.get(dependency).push(task.id);
    }
  }
  return { byId, indegrees, children };
}

// Kahn's algorithm. The separate task DAG represents prerequisites, not roads.
function topologicalSort(tasks) {
  const { byId, indegrees, children } = indexTasks(tasks);
  const queue = [...byId.keys()].filter(id => indegrees.get(id) === 0);
  const ordered = [];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const id = queue[cursor];
    ordered.push(byId.get(id));
    for (const child of children.get(id)) {
      indegrees.set(child, indegrees.get(child) - 1);
      if (indegrees.get(child) === 0) queue.push(child);
    }
  }
  if (ordered.length !== tasks.length) throw new RangeError('Task graph contains a cycle.');
  return ordered;
}

function scheduleTasks(tasks) {
  const ordered = topologicalSort(tasks);
  const finished = new Map();
  return ordered.map(task => {
    const duration = task.duration ?? 0;
    const releaseAt = task.releaseAt ?? 0;
    if (!Number.isFinite(duration) || duration < 0 || !Number.isFinite(releaseAt) || releaseAt < 0) {
      throw new RangeError('Task duration and release time must be non-negative finite seconds.');
    }
    const startAt = Math.max(releaseAt, ...(task.dependsOn || []).map(id => finished.get(id)));
    const finishAt = startAt + duration;
    finished.set(task.id, finishAt);
    return { ...task, startAt, finishAt };
  });
}

module.exports = { topologicalSort, scheduleTasks };
