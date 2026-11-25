'use strict';
const { ACTIVE_PHASES } = require('../service/app-service');
class OverlayPolicy {
  constructor() { this.active = false; this.visible = false; this.locked = false; this.mode = null; this.matchKey = null; }
  update(state) {
    const active = state.mode === 'live' && (ACTIVE_PHASES.has(state.phase) || Boolean(state.game && state.connection.live === 'connected'));
    const newMatch = active && state.matchKey != null && this.matchKey !== state.matchKey;
    if (active !== this.active || newMatch || (this.mode !== null && this.mode !== state.mode)) this.visible = active;
    this.active = active;
    this.mode = state.mode;
    this.matchKey = state.matchKey ?? null;
    return this;
  }
  toggle() { this.visible = !this.visible; }
}
module.exports = { OverlayPolicy };
