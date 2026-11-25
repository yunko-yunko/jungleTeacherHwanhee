'use strict';
const { app, BrowserWindow, ipcMain, globalShortcut, protocol, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { AppService } = require('../service/app-service');
const { OverlayPolicy } = require('./overlay-policy');
const { createOverlayBounds, clampBoundsToDisplays } = require('./window-layout');
protocol.registerSchemesAsPrivileged([{ scheme: 'jungle', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const smoke = process.argv.includes('--smoke');
const demo = smoke || process.argv.includes('--demo');
if (smoke) {
  const smokeProfile = path.join(app.getPath('temp'), 'jungle-teacher-smoke-profile');
  require('node:fs').mkdirSync(smokeProfile, { recursive: true });
  app.setPath('userData', smokeProfile);
}
let dashboard;
let overlay;
let service;
let quitting = false;
let lastState;
let overlayInteractionLocked;
let positionSaveTimer;
let positionWrite = Promise.resolve();
let exitReady = false;
const policy = new OverlayPolicy();
const shortcuts = { toggle: false, lock: false };
const smokeErrors = [];
const uiPath = __dirname;
const contentSecurityPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

async function overlayBounds() {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  let saved = null;
  if (!smoke) {
    try { saved = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'overlay-position.json'), 'utf8')); } catch { /* First launch or corrupt position: use the default. */ }
  }
  const areas = screen.getAllDisplays().map(display => display.workArea);
  const bounds = saved && Number.isSafeInteger(saved.x) && Number.isSafeInteger(saved.y)
    ? { x: saved.x, y: saved.y, width: 360, height: 440 }
    : createOverlayBounds(workArea);
  return clampBoundsToDisplays(bounds, areas);
}

function saveOverlayPosition() {
  if (smoke || !overlay || overlay.isDestroyed()) return positionWrite;
  const bounds = overlay.getBounds();
  const file = path.join(app.getPath('userData'), 'overlay-position.json');
  positionWrite = positionWrite.catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.tmp`, JSON.stringify(bounds));
    await fs.rename(`${file}.tmp`, file);
  }).catch(() => {});
  return positionWrite;
}

function keepOverlayOnScreen() {
  if (!overlay || overlay.isDestroyed()) return;
  overlay.setBounds(clampBoundsToDisplays(overlay.getBounds(), screen.getAllDisplays().map(display => display.workArea)));
}

function secureWindow(options) {
  const win = new BrowserWindow({
    show: false,
    backgroundColor: '#091522',
    ...options,
    webPreferences: { preload: path.join(uiPath, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  if (smoke) win.webContents.on('console-message', details => { if (details.level === 'error') smokeErrors.push(details.message); });
  return win;
}

function decoratedState() {
  return { ...lastState, overlay: { visible: policy.visible, locked: policy.locked, shortcutsAvailable: shortcuts.toggle && shortcuts.lock, shortcuts: { ...shortcuts } } };
}

function broadcast() {
  if (!lastState) return;
  const state = decoratedState();
  for (const win of [dashboard, overlay]) if (win && !win.isDestroyed()) win.webContents.send('jungle:state', state);
}

function syncOverlay() {
  if (!overlay || overlay.isDestroyed()) return;
  if (overlayInteractionLocked !== policy.locked) {
    overlay.setIgnoreMouseEvents(policy.locked, { forward: true });
    overlay.setFocusable(!policy.locked);
    overlayInteractionLocked = policy.locked;
  }
  if (policy.visible) {
    if (!overlay.isVisible()) overlay.showInactive();
    overlay.setAlwaysOnTop(true, 'screen-saver');
  } else overlay.hide();
  broadcast();
}

function trustedSender(event) {
  const sender = [dashboard, overlay].find(win => win && !win.isDestroyed() && win.webContents === event.sender);
  if (!sender || event.senderFrame !== event.sender.mainFrame) throw new Error('허용되지 않은 요청입니다.');
  const url = new URL(event.senderFrame.url);
  if (url.protocol !== 'jungle:' || url.hostname !== 'app' || url.pathname !== '/index.html') throw new Error('허용되지 않은 화면입니다.');
  return sender;
}

async function initialize() {
  protocol.handle('jungle', async request => {
    const url = new URL(request.url);
    const allowed = { '/index.html': 'text/html; charset=utf-8', '/styles.css': 'text/css; charset=utf-8', '/renderer.js': 'text/javascript; charset=utf-8' };
    if (url.hostname !== 'app' || !Object.hasOwn(allowed, url.pathname)) return new Response('Not found', { status: 404 });
    const body = await fs.readFile(path.join(uiPath, url.pathname.slice(1)));
    return new Response(body, { headers: { 'Content-Type': allowed[url.pathname], 'Content-Security-Policy': contentSecurityPolicy, 'X-Content-Type-Options': 'nosniff' } });
  });
  const { workArea } = screen.getPrimaryDisplay();
  dashboard = secureWindow({ width: Math.min(420, workArea.width), height: Math.min(500, workArea.height), minWidth: 340, minHeight: 440, title: 'Jungle Teacher', frame: false });
  overlay = secureWindow({ ...await overlayBounds(), frame: false, transparent: true, backgroundColor: '#00000000', resizable: false, movable: true, maximizable: false, minimizable: false, fullscreenable: false, skipTaskbar: true, focusable: true, hasShadow: false, title: 'Jungle Teacher Overlay', alwaysOnTop: true });
  if (process.platform === 'darwin') overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.on('move', () => { clearTimeout(positionSaveTimer); positionSaveTimer = setTimeout(saveOverlayPosition, 180); });
  screen.on('display-removed', keepOverlayOnScreen);
  screen.on('display-metrics-changed', keepOverlayOnScreen);
  overlay.on('close', event => { if (!quitting) { event.preventDefault(); policy.visible = false; syncOverlay(); } });
  dashboard.on('closed', () => { dashboard = null; app.quit(); });
  service = new AppService({ mode: demo ? 'demo' : 'live' });
  lastState = service.snapshot();
  service.on('state', state => { lastState = state; policy.update(state); syncOverlay(); });

  ipcMain.handle('jungle:command', async (event, action, payload) => {
    const sender = trustedSender(event);
    switch (action) {
      case 'get-state': return decoratedState();
      case 'observe': service.observeCamp(payload?.campId, payload?.status); break;
      case 'complete-next': await service.completeNextAndRefresh(payload); break;
      case 'settings': service.updateSettings(payload); break;
      case 'mode': service.setMode(payload); break;
      case 'toggle-overlay': policy.toggle(); syncOverlay(); break;
      case 'toggle-lock': policy.locked = !policy.locked; syncOverlay(); break;
      case 'close': if (sender === overlay) { policy.visible = false; syncOverlay(); } else app.quit(); return;
      case 'minimize': sender.minimize(); return;
      default: throw new Error('지원하지 않는 동작입니다.');
    }
    return decoratedState();
  });

  if (!smoke) {
    shortcuts.toggle = globalShortcut.register('CommandOrControl+Shift+O', () => { policy.toggle(); syncOverlay(); });
    shortcuts.lock = globalShortcut.register('CommandOrControl+Shift+L', () => { policy.locked = !policy.locked; syncOverlay(); });
  }
  await Promise.all([dashboard.loadURL('jungle://app/index.html?view=dashboard'), overlay.loadURL('jungle://app/index.html?view=overlay')]);
  service.start();
  if (smoke) await runSmoke();
  else dashboard.show();
}

async function runSmoke() {
  const output = process.env.JUNGLE_ARTIFACT_DIR || (app.isPackaged ? path.join(app.getPath('temp'), 'jungle-teacher-smoke') : path.join(app.getAppPath(), 'artifacts'));
  await fs.mkdir(output, { recursive: true });
  await dashboard.webContents.executeJavaScript('document.fonts.ready');
  const initial = await dashboard.webContents.executeJavaScript('window.jungle.getState()');
  const leagueConnect = await import('league-connect');
  if (typeof leagueConnect.authenticate !== 'function') throw new Error('league-connect 로딩 검증 실패');
  if (initial.mode !== 'demo' || initial.camps.length !== 6 || !initial.plan.stops.length) throw new Error('초기 체험 상태 검증 실패');
  await dashboard.webContents.executeJavaScript("window.jungle.updateSettings({startCamp:'wolves',routeLength:3})");
  await dashboard.webContents.executeJavaScript("document.getElementById('next-complete').click()");
  await new Promise(resolve => setTimeout(resolve, 120));
  const progressed = await dashboard.webContents.executeJavaScript('window.jungle.getState()');
  if (progressed.camps.find(camp => camp.id === 'wolves').status !== 'respawning' || progressed.plan.stops.some(stop => stop.campId === 'wolves')) throw new Error('처치 완료와 다음 동선 검증 실패');
  await dashboard.webContents.executeJavaScript("window.jungle.observeCamp('wolves','alive')");
  const settingsHidden = await dashboard.webContents.executeJavaScript("getComputedStyle(document.getElementById('settings-panel')).display === 'none'");
  if (!settingsHidden) throw new Error('기본 화면 설정 숨김 검증 실패');
  await dashboard.webContents.executeJavaScript("document.getElementById('settings-toggle').click()");
  const settingsOpened = await dashboard.webContents.executeJavaScript("getComputedStyle(document.getElementById('settings-panel')).display !== 'none'");
  if (!settingsOpened) throw new Error('설정 열기 검증 실패');
  await dashboard.webContents.executeJavaScript("document.getElementById('settings-toggle').click()");
  await dashboard.webContents.executeJavaScript('window.jungle.toggleOverlay()');
  if (!overlay.isVisible()) throw new Error('오버레이 표시 검증 실패');
  const movable = await dashboard.webContents.executeJavaScript('window.jungle.getState()');
  if (movable.overlay.locked || !overlay.isMovable()) throw new Error('기본 드래그 상태 검증 실패');
  const locked = await dashboard.webContents.executeJavaScript('window.jungle.toggleLock()');
  if (!locked.overlay.locked) throw new Error('오버레이 잠금 IPC 검증 실패');
  await dashboard.webContents.executeJavaScript('window.jungle.toggleLock()');
  const original = overlay.getBounds();
  const moved = clampBoundsToDisplays({ ...original, x: original.x - 48, y: original.y + 32 }, screen.getAllDisplays().map(display => display.workArea));
  overlay.setBounds(moved);
  const actual = overlay.getBounds();
  if (actual.x !== moved.x || actual.y !== moved.y) throw new Error('네이티브 창 이동 검증 실패');
  overlay.setBounds(original);
  await new Promise(resolve => setTimeout(resolve, 350));
  for (const [name, win] of [['dashboard', dashboard], ['overlay', overlay]]) {
    const image = await win.webContents.capturePage();
    await fs.writeFile(path.join(output, `${name}.png`), image.toPNG());
  }
  const security = await dashboard.webContents.executeJavaScript("({ node: typeof require, bridge: typeof jungle, title: document.title, text: document.body.innerText.length, horizontalOverflow: document.documentElement.scrollWidth > innerWidth })");
  if (security.node !== 'undefined' || security.bridge !== 'object' || security.text < 40 || security.horizontalOverflow) throw new Error(`렌더러 검증 실패: ${JSON.stringify(security)}`);
  const overlayUi = await overlay.webContents.executeJavaScript("({ background: getComputedStyle(document.querySelector('.app-shell')).backgroundColor, drag: getComputedStyle(document.querySelector('.titlebar')).getPropertyValue('-webkit-app-region'), buttonDrag: getComputedStyle(document.getElementById('close-button')).getPropertyValue('-webkit-app-region'), horizontalOverflow: document.documentElement.scrollWidth > innerWidth, nextCamp: document.getElementById('next-camp').textContent, legacyMap: !!document.getElementById('jungle-map') })");
  if (!overlayUi.background.startsWith('rgba') || overlayUi.drag !== 'drag' || overlayUi.buttonDrag !== 'no-drag' || overlayUi.horizontalOverflow || overlayUi.legacyMap || !overlayUi.nextCamp.trim()) throw new Error(`오버레이 UI 검증 실패: ${JSON.stringify(overlayUi)}`);
  const latest = decoratedState();
  overlay.webContents.send('jungle:state', { ...latest, revision: latest.revision - 1, plan: { ...latest.plan, stops: [{ ...latest.plan.stops[0], label: '오래된 응답' }] } });
  await new Promise(resolve => setTimeout(resolve, 50));
  const staleIgnored = await overlay.webContents.executeJavaScript("document.getElementById('next-camp').textContent !== '오래된 응답'");
  if (!staleIgnored) throw new Error('오래된 응답 무시 검증 실패');
  for (const camp of service.snapshot().camps) service.observeCamp(camp.id, 'cleared');
  await new Promise(resolve => setTimeout(resolve, 50));
  const cooldown = service.snapshot();
  const cooldownUi = await overlay.webContents.executeJavaScript("({ title: document.getElementById('next-camp').textContent, disabled: document.getElementById('next-complete').disabled, targets: document.getElementById('route-steps').children.length })");
  if (cooldown.plan.stops.length || cooldownUi.targets || !cooldownUi.disabled || cooldownUi.title !== '정글 재생성 대기') throw new Error('재생성 전 전체 제외 검증 실패');
  await fs.writeFile(path.join(output, 'cooldown.png'), (await overlay.webContents.capturePage()).toPNG());
  // Advance only the demo clock, then let the real 1s app timer recalculate.
  service.demoStartedAt -= (cooldown.plan.nextAvailableAt - cooldown.game.time + 0.2) * 1000;
  await new Promise(resolve => setTimeout(resolve, 1150));
  const returned = service.snapshot();
  if (!returned.plan.stops.length || returned.plan.stops.some(stop => ['blue', 'red'].includes(stop.campId))) throw new Error('주기적 재계산과 캠프별 재생성 검증 실패');
  let rejected = false;
  try { await dashboard.webContents.executeJavaScript("window.jungle.updateSettings({routeLength:999})"); } catch { rejected = true; }
  if (!rejected) throw new Error('IPC 입력 검증 실패');
  if (smokeErrors.length) throw new Error(`렌더러 오류: ${smokeErrors.join(', ')}`);
  await fs.writeFile(path.join(output, 'smoke-result.json'), JSON.stringify({ passed: true, checks: ['demo', 'route', 'complete-next button', 'all cooldown targets excluded', 'periodic respawn recheck', 'stale response ignored', 'collapsed settings', 'overlay visibility', 'default draggable', 'native movement', 'click-through toggle', 'translucent background', 'drag region', 'input validation', 'renderer isolation', 'minimal layout'], security, overlayUi, cooldownUi }, null, 2));
  console.log(`Electron smoke 통과: ${output}`);
  app.quit();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (dashboard) { dashboard.restore(); dashboard.show(); dashboard.focus(); } });
  app.on('before-quit', event => {
    quitting = true;
    service?.stop();
    globalShortcut.unregisterAll();
    clearTimeout(positionSaveTimer);
    if (!smoke && !exitReady) {
      event.preventDefault();
      saveOverlayPosition().finally(() => { exitReady = true; app.quit(); });
    }
  });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(initialize).catch(error => { console.error(error); app.exit(1); });
}
