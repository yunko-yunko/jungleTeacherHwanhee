'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
let failed = false;
function check(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'artifacts', '.git'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) check(file);
    else if (/\.(c?js)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
      if (result.status !== 0) { failed = true; console.error(result.stderr); }
    }
  }
}
check(root);
console.log(failed ? 'JavaScript 구문 검사 실패' : '모든 JavaScript 구문 검사 통과');
process.exitCode = failed ? 1 : 0;
