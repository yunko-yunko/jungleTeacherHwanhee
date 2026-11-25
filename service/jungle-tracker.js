'use strict';

const { CAMPS } = require('./camps');
const { scheduleTasks } = require('./algorithms/topological');

function validateTime(gameTime) {
  if (!Number.isFinite(gameTime) || gameTime < 0) throw new RangeError('Game time must be non-negative finite seconds.');
}

class JungleTracker {
  constructor({ camps = CAMPS, aliveTtlSeconds = 30 } = {}) {
    if (!Number.isFinite(aliveTtlSeconds) || aliveTtlSeconds <= 0) throw new RangeError('Alive observation TTL must be positive.');
    if (!Array.isArray(camps) || new Set(camps.map(camp => camp.id)).size !== camps.length) throw new TypeError('Camp IDs must be unique.');
    for (const camp of camps) {
      for (const field of ['initialSpawnSeconds', 'respawnSeconds', 'clearSeconds']) {
        if (!Number.isFinite(camp[field]) || camp[field] < 0) throw new RangeError(`Invalid camp ${field}.`);
      }
    }
    this.camps = camps.map(camp => ({ ...camp }));
    this.aliveTtlSeconds = aliveTtlSeconds;
    this.reset();
  }

  reset() { this.observations = new Map(); }

  observe(campId, status, gameTime) {
    validateTime(gameTime);
    if (!this.camps.some(camp => camp.id === campId)) throw new RangeError('Unknown camp.');
    if (!['alive', 'cleared', 'unknown'].includes(status)) throw new RangeError('Unsupported observation.');
    if (status === 'unknown') this.observations.delete(campId);
    else this.observations.set(campId, { status, observedAt: gameTime });
  }

  snapshot(gameTime) {
    validateTime(gameTime);
    return this.camps.map(camp => {
      const observation = this.observations.get(camp.id);
      const baseline = { ...camp, status: 'unknown', source: 'unknown', observedAt: null, availableAt: camp.initialSpawnSeconds };
      if (!observation) return baseline;
      if (observation.status === 'alive') {
        if (observation.observedAt > gameTime) return baseline;
        if (gameTime - observation.observedAt > this.aliveTtlSeconds) {
          return { ...baseline, observedAt: observation.observedAt, observationExpired: true };
        }
        return { ...baseline, status: 'alive', source: 'manual', observedAt: observation.observedAt, availableAt: observation.observedAt };
      }
      // This DAG is evaluated: its final finishAt is the estimated release time
      // consumed by the route planner. A timer never confirms camp presence.
      const lifecycleTasks = scheduleTasks([
        { id: `${camp.id}:observed`, label: `${camp.shortLabel} 처치 기록`, duration: 0, releaseAt: observation.observedAt },
        { id: `${camp.id}:respawn`, label: `${camp.shortLabel} 재생성 추정`, duration: camp.respawnSeconds, dependsOn: [`${camp.id}:observed`] },
      ]);
      const availableAt = lifecycleTasks.find(task => task.id === `${camp.id}:respawn`).finishAt;
      return {
        ...baseline,
        status: gameTime < availableAt ? 'respawning' : 'estimated',
        source: 'timer',
        observedAt: observation.observedAt,
        availableAt,
        lifecycleTasks,
      };
    });
  }
}

module.exports = { JungleTracker };
