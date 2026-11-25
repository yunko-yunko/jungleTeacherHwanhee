'use strict';

// Normal Summoner's Rift first spawns follow Riot patch 26.1 (55s / 67s).
// https://www.leagueoflegends.com/en-us/news/game-updates/patch-26-1-notes/
// Respawn defaults are 300s for buffs, 135s for the other camps. Swiftplay's
// separate reduced timers must not be applied to the normal-map profile.
// Walking/clear times and coordinates remain illustrative approximations.
const BASE_MOVEMENT_SPEED = 350;
const CAMPS = Object.freeze([
  { id: 'blue', label: '푸른 파수꾼', shortLabel: '블루', x: 22, y: 44, initialSpawnSeconds: 55, respawnSeconds: 300, clearSeconds: 20 },
  { id: 'gromp', label: '두꺼비', shortLabel: '두꺼비', x: 15, y: 38, initialSpawnSeconds: 67, respawnSeconds: 135, clearSeconds: 18 },
  { id: 'wolves', label: '어스름 늑대', shortLabel: '늑대', x: 31, y: 56, initialSpawnSeconds: 55, respawnSeconds: 135, clearSeconds: 16 },
  { id: 'raptors', label: '칼날부리', shortLabel: '칼날부리', x: 48, y: 66, initialSpawnSeconds: 55, respawnSeconds: 135, clearSeconds: 16 },
  { id: 'red', label: '붉은 덩굴정령', shortLabel: '레드', x: 39, y: 78, initialSpawnSeconds: 55, respawnSeconds: 300, clearSeconds: 20 },
  { id: 'krugs', label: '고대 돌거북', shortLabel: '돌거북', x: 45, y: 89, initialSpawnSeconds: 67, respawnSeconds: 135, clearSeconds: 22 },
].map(Object.freeze));

// Each edge is an estimated, bidirectional walking time at movement speed 350.
const EDGES = Object.freeze([
  { from: 'blue', to: 'gromp', weight: 6 },
  { from: 'blue', to: 'wolves', weight: 8 },
  { from: 'gromp', to: 'wolves', weight: 10 },
  { from: 'wolves', to: 'raptors', weight: 14 },
  { from: 'wolves', to: 'red', weight: 16 },
  { from: 'raptors', to: 'red', weight: 7 },
  { from: 'red', to: 'krugs', weight: 8 },
  { from: 'raptors', to: 'krugs', weight: 13 },
].map(Object.freeze));

module.exports = { CAMPS, EDGES, BASE_MOVEMENT_SPEED };
