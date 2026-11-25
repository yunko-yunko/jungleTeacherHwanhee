'use strict';

const https = require('node:https');
const { EventEmitter } = require('node:events');

// The self-signed exception is limited to Riot's fixed local in-game endpoint.
// It never changes Node's TLS defaults or Electron's certificate handling.
function requestLiveData({ signal, timeoutMs = 2000, maxBytes = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => request.destroy(new Error('Live request aborted'));
    const request = https.get({
      hostname: '127.0.0.1', port: 2999, path: '/liveclientdata/allgamedata',
      rejectUnauthorized: false, agent: false,
      headers: { Accept: 'application/json' }
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        request.destroy();
        finish(new Error('Live API unavailable'));
        return;
      }
      let size = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) { request.destroy(new Error('Live response too large')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (settled) return;
        try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { finish(new Error('Invalid Live API JSON')); }
      });
      response.on('error', (error) => finish(error));
      response.on('aborted', () => finish(new Error('Live response aborted')));
    });
    request.on('error', (error) => finish(error));
    deadline = setTimeout(() => request.destroy(new Error('Live API timeout')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function normalizeLiveData(data) {
  if (!data || typeof data !== 'object' || !data.gameData || !data.activePlayer ||
      typeof data.activePlayer !== 'object' || Array.isArray(data.activePlayer) || !Array.isArray(data.allPlayers)) {
    throw new Error('Incomplete Live API data');
  }
  const time = data.gameData.gameTime;
  if (!Number.isFinite(time) || time < 0) throw new Error('Invalid game time');
  const active = data.activePlayer;
  const players = data.allPlayers.filter((player) => player && typeof player === 'object');
  const exact = (key) => {
    if (typeof active[key] !== 'string' || !active[key]) return null;
    const matches = players.filter((player) => player[key] === active[key]);
    return matches.length === 1 ? matches[0] : null;
  };
  // Prefer full Riot ID; never identify somebody solely by a shared game name.
  const compositeMatches = active.riotIdGameName && active.riotIdTagLine ? players.filter((candidate) =>
    candidate.riotIdGameName === active.riotIdGameName && candidate.riotIdTagLine === active.riotIdTagLine) : [];
  const player = exact('riotId') || exact('summonerName') || (compositeMatches.length === 1 ? compositeMatches[0] : null);
  const number = (value, fallback = 0) => Number.isFinite(value) && value >= 0 ? value : fallback;
  const text = (value) => typeof value === 'string' ? value.slice(0, 128) : '';
  const stats = active.championStats || {};
  const scores = player?.scores || {};
  return {
    time, mapNumber: number(data.gameData.mapNumber), mode: text(data.gameData.gameMode),
    team: player?.team === 'ORDER' || player?.team === 'CHAOS' ? player.team : null,
    summonerName: text(active.riotId || active.summonerName || player?.riotId || player?.summonerName),
    championName: text(player?.championName), level: number(active.level || player?.level),
    health: number(stats.currentHealth), maxHealth: number(stats.maxHealth),
    gold: number(active.currentGold), kills: number(scores.kills), deaths: number(scores.deaths),
    assists: number(scores.assists), cs: number(scores.creepScore),
    movementSpeed: Number.isFinite(stats.moveSpeed) && stats.moveSpeed > 0 ? stats.moveSpeed : 350
  };
}

class LiveClient extends EventEmitter {
  constructor({ request = requestLiveData, pollInterval = 1000, timeoutMs = 2000 } = {}) {
    super();
    this.request = request;
    this.pollInterval = pollInterval;
    this.timeoutMs = timeoutMs;
    this.running = false;
    this.generation = 0;
    this.timer = null;
    this.controller = null;
    this.inFlight = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    void this.poll(++this.generation).catch(() => {});
  }

  stop() {
    this.running = false;
    ++this.generation;
    clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.controller = null;
    this.inFlight = null;
  }

  // Manual refresh and the scheduled poll share one physical GET. An in-flight
  // response is fresh for both callers; an idle refresh replaces the next timer.
  refresh() {
    if (!this.running) return Promise.reject(new Error('게임 정보 연결이 중지되었습니다.'));
    return this.poll(this.generation);
  }

  poll(generation) {
    const active = () => this.running && this.generation === generation;
    if (!active()) return Promise.reject(new Error('게임 정보 연결이 중지되었습니다.'));
    if (this.inFlight?.generation === generation) return this.inFlight.promise;
    clearTimeout(this.timer);
    this.timer = null;
    const controller = new AbortController();
    this.controller = controller;
    const operation = { generation, controller, promise: null };
    this.inFlight = operation;
    let onAbort;
    const cancelled = new Promise((_resolve, reject) => {
      onAbort = () => reject(new Error('게임 정보 연결이 중지되었습니다.'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    let request;
    try {
      request = this.request({ signal: controller.signal, timeoutMs: this.timeoutMs });
    } catch (error) {
      request = Promise.reject(error);
    }
    operation.promise = Promise.race([request, cancelled]).then(payload => {
      if (!active() || controller.signal.aborted) throw new Error('Request stopped');
      const data = normalizeLiveData(payload);
      this.emit('data', data);
      if (!active() || controller.signal.aborted) throw new Error('Request stopped');
      this.emit('status', { connected: true, error: null });
      if (!active() || controller.signal.aborted) throw new Error('Request stopped');
      return data;
    }).catch(() => {
      if (active()) this.emit('status', { connected: false, error: '게임 중 API 연결을 기다리고 있습니다.' });
      throw new Error(active() ? '게임 중 API 정보를 갱신할 수 없습니다.' : '게임 정보 연결이 중지되었습니다.');
    }).finally(() => {
      controller.signal.removeEventListener('abort', onAbort);
      if (this.inFlight === operation) this.inFlight = null;
      if (this.controller === controller) this.controller = null;
      if (active()) this.timer = setTimeout(() => {
        this.timer = null;
        void this.poll(generation).catch(() => {});
      }, this.pollInterval);
    });
    return operation.promise;
  }
}

module.exports = { LiveClient, requestLiveData, normalizeLiveData };
