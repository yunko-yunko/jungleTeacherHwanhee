'use strict';
const { EventEmitter } = require('node:events');
const { LcuClient } = require('./lcu-client');
const { LiveClient } = require('./live-client');
const { CAMPS, EDGES } = require('./camps');
const { JungleTracker } = require('./jungle-tracker');
const { planRoute } = require('./algorithms/route-planner');

const ACTIVE_PHASES = new Set(['GameStart', 'InProgress', 'Reconnect']);
const IDLE_PHASES = new Set(['None', 'Lobby', 'Matchmaking', 'ReadyCheck', 'ChampSelect', 'WaitingForStats', 'PreEndOfGame', 'EndOfGame']);
const DEFAULT_SETTINGS = Object.freeze({ startCamp: 'blue', routeLength: 3, includeUnknown: true, team: 'auto' });

function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('설정 형식이 올바르지 않습니다.');
  const clean = {};
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) throw new Error('지원하지 않는 설정입니다.');
    if (key === 'startCamp' && !CAMPS.some(camp => camp.id === value)) throw new Error('시작 캠프를 확인하세요.');
    if (key === 'routeLength' && (!Number.isInteger(value) || value < 1 || value > 6)) throw new Error('캠프 수는 1~6이어야 합니다.');
    if (key === 'includeUnknown' && typeof value !== 'boolean') throw new Error('미확인 캠프 설정을 확인하세요.');
    if (key === 'team' && !['auto', 'ORDER', 'CHAOS'].includes(value)) throw new Error('진영 설정을 확인하세요.');
    clean[key] = value;
  }
  return clean;
}

class AppService extends EventEmitter {
  constructor({ lcu = new LcuClient(), live = new LiveClient(), tracker = new JungleTracker(), planner = planRoute, now = Date.now, mode = 'live' } = {}) {
    super();
    this.lcu = lcu;
    this.live = live;
    this.tracker = tracker;
    this.planner = planner;
    this.now = now;
    this.mode = mode;
    this.settings = { ...DEFAULT_SETTINGS };
    this.lcuState = { connected: false, phase: 'None', summoner: null, gameId: null, error: null };
    this.liveStatus = { connected: false, error: null };
    this.liveData = null;
    this.lastTime = null;
    this.lastGameId = null;
    this.matchRevision = 0;
    this.revision = 0;
    this.completionRequest = null;
    this.running = false;
    this.lcu.on('state', state => {
      if (this.mode !== 'live' || !this.running) return;
      const previousPhase = this.lcuState.phase;
      this.lcuState = state;
      if (state.gameId != null) {
        if (this.lastGameId != null && String(this.lastGameId) !== String(state.gameId)) this.resetMatch();
        this.lastGameId = state.gameId;
      }
      if (state.connected && IDLE_PHASES.has(state.phase) && (ACTIVE_PHASES.has(previousPhase) || this.liveData)) this.resetMatch();
      this.publish();
    });
    this.live.on('data', data => {
      if (this.mode !== 'live' || !this.running) return;
      if (this.lastTime != null && data.time < this.lastTime - 5) this.resetMatch();
      if (this.settings.team === 'auto' && this.liveData?.team && data.team && this.liveData.team !== data.team) this.tracker.reset();
      this.lastTime = data.time;
      this.liveData = data;
      this.liveStatus = { connected: true, error: null };
      this.publish();
    });
    this.live.on('status', status => {
      if (this.mode !== 'live' || !this.running) return;
      this.liveStatus = status;
      if (!status.connected) this.liveData = null;
      this.publish();
    });
  }

  start() {
    if (this.running) return;
    this.running = true;
    if (this.mode === 'demo') this.seedDemo();
    else { this.lcu.start(); this.live.start(); }
    this.timer = setInterval(() => this.publish(), 1000);
    this.timer.unref?.();
    this.publish();
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    this.lcu.stop();
    this.live.stop();
    this.resetMatch();
    this.lastGameId = null;
    this.lcuState = { connected: false, phase: 'None', summoner: null, gameId: null, error: null };
    this.liveStatus = { connected: false, error: null };
  }

  resetMatch() {
    this.matchRevision++;
    this.tracker.reset();
    this.liveData = null;
    this.lastTime = null;
  }

  seedDemo() {
    this.demoStartedAt = this.now();
    this.tracker.reset();
    this.tracker.observe('blue', 'cleared', 430);
    this.tracker.observe('gromp', 'cleared', 460);
    this.tracker.observe('wolves', 'alive', 492);
    this.tracker.observe('red', 'alive', 492);
  }

  setMode(mode) {
    if (!['live', 'demo'].includes(mode)) throw new Error('지원하지 않는 실행 모드입니다.');
    if (mode === this.mode) return this.snapshot();
    this.lcu.stop();
    this.live.stop();
    this.mode = mode;
    this.resetMatch();
    this.lastGameId = null;
    this.lcuState = { connected: false, phase: 'None', summoner: null, gameId: null, error: null };
    this.liveStatus = { connected: false, error: null };
    if (mode === 'demo') this.seedDemo();
    else if (this.running) { this.lcu.start(); this.live.start(); }
    return this.publish();
  }

  updateSettings(input) {
    const clean = validateSettings(input);
    if (clean.team !== undefined && clean.team !== this.settings.team) this.tracker.reset();
    this.settings = { ...this.settings, ...clean };
    return this.publish();
  }

  observeCamp(campId, status) {
    const state = this.snapshot();
    if (!state.game || !state.supportedMap) throw new Error('소환사의 협곡 게임 중에 상태를 기록할 수 있습니다.');
    if (!state.game.team) throw new Error('아군 진영을 먼저 선택하세요.');
    if (!CAMPS.some(camp => camp.id === campId) || !['alive', 'cleared', 'unknown'].includes(status)) throw new Error('캠프 상태를 확인하세요.');
    this.tracker.observe(campId, status, state.game.time);
    return this.publish();
  }

  completeNext(target = {}) {
    const state = this.snapshot();
    if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error('처치 기록 요청을 확인하세요.');
    if (target.matchKey !== undefined && target.matchKey !== state.matchKey) throw new Error('경기가 변경되었습니다. 현재 추천 캠프를 다시 확인하세요.');
    if (!this.running || !['live', 'demo'].includes(state.mode) || (state.mode === 'live' && state.connection.live !== 'connected')) {
      throw new Error('게임 연결을 확인한 뒤 추천 캠프의 완료를 기록하세요.');
    }
    if (!state.game || !state.supportedMap) throw new Error('소환사의 협곡 게임 중에 완료를 기록할 수 있습니다.');
    if (!['ORDER', 'CHAOS'].includes(state.game.team)) throw new Error('아군 진영을 먼저 선택하세요.');
    const campId = state.plan?.stops?.[0]?.campId;
    if (!CAMPS.some(camp => camp.id === campId)) throw new Error('완료할 추천 캠프가 없습니다.');
    if (target.campId !== undefined && target.campId !== campId) throw new Error('추천 캠프가 변경되었습니다. 현재 캠프를 다시 확인하세요.');
    // This method runs only after the user confirms the recommended camp was
    // cleared. Game time and route estimates never complete a camp themselves.
    this.tracker.observe(campId, 'cleared', state.game.time);
    this.settings = { ...this.settings, startCamp: campId };
    return this.publish();
  }

  completeNextAndRefresh(target = {}) {
    const currentKey = this.snapshot().matchKey;
    if (this.completionRequest?.matchKey === currentKey) return this.completionRequest.promise;
    // Exclude the clicked target immediately. A failed refresh must never undo
    // this manual clear or reapply it to a newly recommended target.
    const cleared = this.completeNext(target);
    if (this.mode === 'demo') return Promise.resolve(cleared);
    const request = { matchKey: cleared.matchKey, promise: null };
    this.completionRequest = request;
    request.promise = Promise.resolve().then(async () => {
      try { await this.live.refresh(); } catch { /* Polling reports connection state; keep the manual timer. */ }
      return this.running ? this.publish() : this.snapshot();
    }).finally(() => {
      if (this.completionRequest === request) this.completionRequest = null;
    });
    return request.promise;
  }

  snapshot() {
    const isDemo = this.mode === 'demo';
    const idle = this.lcuState.connected && IDLE_PHASES.has(this.lcuState.phase);
    const realGame = this.liveStatus.connected && !idle ? this.liveData : null;
    const demoGame = { time: 494 + Math.max(0, (this.now() - (this.demoStartedAt ?? this.now())) / 1000), mapNumber: 11, mode: 'CLASSIC', team: 'ORDER', summonerName: 'Jungle Teacher', championName: 'Lee Sin', level: 6, health: 824, maxHealth: 1050, gold: 1240, kills: 2, deaths: 0, assists: 3, cs: 52, movementSpeed: 350 };
    const game = isDemo ? demoGame : realGame ? { ...realGame } : null;
    if (game && this.settings.team !== 'auto') game.team = this.settings.team;
    const supportedMap = Boolean(game && game.mapNumber === 11);
    const camps = this.tracker.snapshot(game?.time ?? this.lastTime ?? 0);
    const reason = !game ? '게임 연결을 기다리고 있습니다.' : !supportedMap ? '소환사의 협곡에서 동선을 추천합니다.' : !game.team ? '아군 진영을 확인할 수 없습니다. 진영을 직접 선택하세요.' : null;
    const plan = reason ? { stops: [], path: [], taskOrder: [], totalSeconds: 0, travelSeconds: 0, waitSeconds: 0, clearSeconds: 0, reason, algorithm: 'Dijkstra + greedy / Kahn' } : this.planner({ camps, ...this.settings, gameTime: game.time, movementSpeed: game.movementSpeed });
    return {
      mode: this.mode,
      revision: this.revision,
      matchKey: `${this.mode}:${this.matchRevision}:${this.lastGameId ?? 'unknown'}`,
      connection: {
        lcu: isDemo ? 'demo' : this.lcuState.connected ? 'connected' : 'waiting',
        live: isDemo ? 'demo' : game ? 'connected' : this.liveStatus.error ? 'stale' : 'waiting',
        message: isDemo ? '체험용 데이터 · 실제 경기와 무관합니다.' : this.lcuState.error || this.liveStatus.error || '클라이언트와 게임에 자동 연결합니다.'
      },
      phase: isDemo ? 'InProgress' : this.lcuState.connected ? this.lcuState.phase : game ? 'InProgress' : 'None',
      summoner: isDemo ? { displayName: 'Jungle Teacher', summonerLevel: 30 } : this.lcuState.summoner,
      game, supportedMap, camps, plan, settings: { ...this.settings },
      graph: { edges: EDGES },
      updatedAt: this.now()
    };
  }

  publish() {
    this.revision++;
    const state = this.snapshot();
    this.emit('state', state);
    return state;
  }
}

module.exports = { AppService, validateSettings, ACTIVE_PHASES };
