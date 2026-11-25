'use strict';

const https = require('node:https');
const { EventEmitter } = require('node:events');

const ENDPOINTS = new Set([
  '/lol-gameflow/v1/gameflow-phase',
  '/lol-summoner/v1/current-summoner',
  '/lol-gameflow/v1/session'
]);

// league-connect discovers the process and supplies Riot's certificate. Its
// HTTP helper has no cancellation API, so this small adapter adds deadlines.
function requestLcuJson(path, credentials, { signal, timeoutMs = 3000, maxBytes = 2 * 1024 * 1024 } = {}) {
  if (!ENDPOINTS.has(path)) return Promise.reject(new Error('Unsupported LCU endpoint'));
  if (!credentials || !Number.isInteger(credentials.port) || credentials.port < 1 || credentials.port > 65535 ||
      typeof credentials.password !== 'string' || !credentials.password || !credentials.certificate) {
    return Promise.reject(new Error('Invalid LCU credentials'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => request.destroy(new Error('Request aborted'));
    const request = https.request({
      hostname: '127.0.0.1', port: credentials.port, path, method: 'GET',
      ca: credentials.certificate, rejectUnauthorized: true,
      agent: false,
      headers: { Accept: 'application/json', Authorization: `Basic ${Buffer.from(`riot:${credentials.password}`).toString('base64')}` }
    }, (incoming) => {
      if (incoming.statusCode !== 200) {
        incoming.resume();
        const error = new Error('LCU request failed');
        error.status = incoming.statusCode;
        request.destroy();
        finish(error);
        return;
      }
      let size = 0;
      const chunks = [];
      incoming.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          request.destroy(new Error('LCU response too large'));
          return;
        }
        chunks.push(chunk);
      });
      incoming.on('end', () => {
        if (settled) return;
        try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { finish(new Error('Invalid LCU JSON')); }
      });
      incoming.on('error', (error) => finish(error));
      incoming.on('aborted', () => finish(new Error('LCU response aborted')));
    });
    request.on('error', (error) => finish(error));
    deadline = setTimeout(() => request.destroy(new Error('LCU timeout')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else request.end();
  });
}

function withDeadline(promise, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Authentication timeout')), timeoutMs);
    const abort = () => finish(new Error('Authentication cancelled'));
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    Promise.resolve(promise).then((value) => finish(null, value), (error) => finish(error));
  });
}

function normalizeSummoner(value) {
  if (!value || typeof value !== 'object') return null;
  const text = (name) => typeof value[name] === 'string' ? value[name].slice(0, 128) : '';
  return {
    displayName: text('displayName'), gameName: text('gameName'), tagLine: text('tagLine'),
    summonerLevel: Number.isFinite(value.summonerLevel) ? Math.max(0, value.summonerLevel) : 0
  };
}

class LcuClient extends EventEmitter {
  constructor({ authenticate, request = requestLcuJson, pollInterval = 2000, timeoutMs = 4000 } = {}) {
    super();
    this.authenticate = authenticate || (async () => {
      const leagueConnect = await import('league-connect');
      return leagueConnect.authenticate({ awaitConnection: false });
    });
    this.request = request;
    this.pollInterval = pollInterval;
    this.timeoutMs = timeoutMs;
    this.running = false;
    this.generation = 0;
    this.credentials = null;
    this.authenticationPromise = null;
    this.timer = null;
    this.controller = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const generation = ++this.generation;
    void this.poll(generation);
  }

  stop() {
    this.running = false;
    ++this.generation;
    clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.controller = null;
    this.credentials = null;
  }

  async poll(generation) {
    const active = () => this.running && this.generation === generation;
    if (!active()) return;
    const controller = new AbortController();
    this.controller = controller;
    try {
      if (!this.credentials) {
        // Reuse an unfinished discovery instead of spawning overlapping process
        // scans if the system's process query takes longer than the deadline.
        if (!this.authenticationPromise) {
          this.authenticationPromise = Promise.resolve().then(() => this.authenticate());
          const authentication = this.authenticationPromise;
          authentication.then(() => {
            if (this.authenticationPromise === authentication) this.authenticationPromise = null;
          }, () => {
            if (this.authenticationPromise === authentication) this.authenticationPromise = null;
          });
        }
        const credentials = await withDeadline(this.authenticationPromise, this.timeoutMs, controller.signal);
        if (!active()) return;
        this.credentials = credentials;
      }
      const credentials = this.credentials;
      const options = { signal: controller.signal, timeoutMs: this.timeoutMs };
      const [phaseResult, summonerResult, sessionResult] = await Promise.allSettled([
        this.request('/lol-gameflow/v1/gameflow-phase', credentials, options),
        this.request('/lol-summoner/v1/current-summoner', credentials, options),
        this.request('/lol-gameflow/v1/session', credentials, options)
      ]);
      if (!active()) return;
      if (phaseResult.status !== 'fulfilled' || typeof phaseResult.value !== 'string' || !phaseResult.value) {
        throw new Error('LCU unavailable');
      }
      const rawGameId = sessionResult.status === 'fulfilled' ? sessionResult.value?.gameData?.gameId : null;
      const gameId = typeof rawGameId === 'string' && rawGameId.trim()
        ? rawGameId.slice(0, 128) : Number.isFinite(rawGameId) && rawGameId > 0 ? rawGameId : null;
      this.emit('state', {
        connected: true, phase: phaseResult.value.slice(0, 128),
        summoner: summonerResult.status === 'fulfilled' ? normalizeSummoner(summonerResult.value) : null,
        gameId, error: null
      });
    } catch (error) {
      this.credentials = null;
      if (active()) this.emit('state', {
        connected: false, phase: 'None', summoner: null, gameId: null,
        error: error?.name === 'ClientElevatedPermsError'
          ? '롤 클라이언트와 앱의 실행 권한을 맞춰 주세요.'
          : '롤 클라이언트 연결을 기다리고 있습니다.'
      });
    } finally {
      if (this.controller === controller) this.controller = null;
      if (active()) this.timer = setTimeout(() => void this.poll(generation), this.pollInterval);
    }
  }
}

module.exports = { LcuClient, requestLcuJson, normalizeSummoner };
