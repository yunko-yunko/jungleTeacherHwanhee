'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// Software readback keeps transparent-window screenshots deterministic on GPU
// drivers that intermittently reject capturePage(). Normal launches are unchanged.
const child = spawn(require('electron'), [path.join(__dirname, '..'), '--smoke', '--disable-gpu'], { env, stdio: 'inherit', windowsHide: true });
const timer = setTimeout(() => { console.error('Electron smoke 시간 초과'); child.kill(); process.exitCode = 1; }, 45000);
child.on('error', error => { clearTimeout(timer); console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
