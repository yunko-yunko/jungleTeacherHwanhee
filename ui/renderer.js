'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const overlay = new URLSearchParams(location.search).get('view') === 'overlay';
  document.body.classList.toggle('overlay', overlay);
  const dom = Object.fromEntries(['game-time','connection-dot','lock-button','settings-toggle','settings-panel','next-caption','next-camp','next-uncertain','waiting-message','next-timing','next-arrival','next-wait','next-finish','next-complete','route-section','route-total','route-steps','start-camp','route-length','team','include-unknown','live-mode','demo-mode','overlay-toggle','shortcut-hint','toast'].map(id => [id, $(id)]));
  let state;
  let toastTimer;
  let routeKey = '';
  let completing = false;
  let unsubscribe;
  const finite = (value, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const clock = value => { const t = Math.max(0, Math.floor(finite(value))); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
  const seconds = value => Math.max(0, Math.round(finite(value)));
  const element = (tag, className, text) => { const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const setText = (id, value) => { if (dom[id].textContent !== value) dom[id].textContent = value; };

  function toast(message) {
    setText('toast', message);
    dom.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { dom.toast.hidden = true; }, 3300);
  }

  async function invoke(method, ...args) {
    if (!window.jungle || typeof window.jungle[method] !== 'function') { toast('Electron 앱에서 실행해 주세요.'); return; }
    try {
      const result = await window.jungle[method](...args);
      if (result?.ok === false) toast(result.error || '변경 내용을 적용하지 못했습니다.');
      else if (result?.settings) render(result);
      return result;
    } catch { toast('요청을 적용하지 못했습니다. 연결 상태를 확인해 주세요.'); }
  }

  function renderRoute(stops) {
    const key = JSON.stringify(stops.map(stop => [stop.campId,stop.label,stop.uncertain]));
    if (key !== routeKey) {
      const previousScroll = dom['route-steps'].scrollTop;
      routeKey = key;
      const rows = stops.map((stop, index) => {
        const row = element('li', 'route-step');
        const name = element('span', 'step-name', stop.label || stop.campId);
        row.append(element('span', 'step-index', String(index + 1)), name);
        if (stop.uncertain) row.append(element('span', 'step-uncertain', '추정'));
        row.append(element('time', 'step-time', clock(stop.arrivalAt)));
        row.title = `이동 ${seconds(stop.travelSeconds)}초 · 대기 ${seconds(stop.waitSeconds)}초 · 사냥 ${seconds(stop.clearSeconds)}초`;
        return row;
      });
      dom['route-steps'].replaceChildren(...rows);
      dom['route-steps'].scrollTop = previousScroll;
    }
    Array.from(dom['route-steps'].children).forEach((row,index) => {
      const stop = stops[index];
      row.querySelector('.step-time').textContent = clock(stop.arrivalAt);
      row.title = `이동 ${seconds(stop.travelSeconds)}초 · 대기 ${seconds(stop.waitSeconds)}초 · 사냥 ${seconds(stop.clearSeconds)}초`;
    });
  }

  function render(nextState) {
    if (!nextState?.settings) return;
    // IPC replies can arrive after a newer periodic update or match change.
    if (finite(nextState.revision, -1) < finite(state?.revision, -1)) return;
    state = nextState;
    const game = state.game;
    const demo = state.mode === 'demo';
    const connected = demo || state.connection?.live === 'connected';
    const supported = state.supportedMap !== false;
    const stops = game && supported ? state.plan?.stops || [] : [];
    const next = stops[0];
    const ready = Boolean(next && game && connected);
    const locked = Boolean(state.overlay?.locked);
    const dot = dom['connection-dot'];
    dot.className = `connection-dot ${connected ? 'connected' : state.connection?.live === 'stale' ? 'stale' : ''}`;
    const connectionTitle = demo ? '체험 모드 · 예제 데이터' : connected ? '게임 데이터 연결됨' : state.connection?.message || '게임 연결 대기';
    dot.title = connectionTitle;
    dot.setAttribute('aria-label', connectionTitle);
    setText('game-time', game ? clock(game.time) : '--:--');
    dom['lock-button'].setAttribute('aria-pressed', String(locked));
    dom['lock-button'].setAttribute('aria-label', locked ? '클릭 통과 끄기' : '클릭 통과 켜기');
    dom['lock-button'].title = locked ? '클릭 통과 켜짐 · Ctrl/Cmd + Shift + L로 해제' : '클릭 통과 끔 · 드래그로 이동 · Ctrl/Cmd + Shift + L';
    document.querySelector('.companion').classList.toggle('waiting', !next);
    dom['waiting-message'].hidden = Boolean(next);
    dom['next-timing'].hidden = !next;
    dom['next-uncertain'].hidden = !next?.uncertain;
    dom['next-complete'].disabled = !ready || completing;
    dom['next-complete'].title = ready ? '직접 확인한 처치를 기록하고 다음 동선으로 이동합니다.' : '게임 데이터가 연결되고 추천 캠프가 있으면 기록할 수 있습니다.';
    if (next) {
      setText('next-caption', '다음 캠프');
      setText('next-camp', next.label || next.campId);
      setText('next-arrival', clock(next.arrivalAt));
      setText('next-wait', `${seconds(next.waitSeconds)}초`);
      setText('next-finish', clock(next.finishAt));
    } else {
      setText('next-caption', demo ? '체험 모드' : '정글 동선');
      if (!game) {setText('next-camp', '연결을 기다리는 중');setText('waiting-message', '게임이 시작되면 다음 동선을 표시합니다.');}
      else if (!supported) {setText('next-camp', '소환사의 협곡에서 만나요');setText('waiting-message', '이 지도에서는 정글 동선을 표시하지 않습니다.');}
      else if (typeof state.plan?.nextAvailableAt === 'number' && Number.isFinite(state.plan.nextAvailableAt) && state.plan.nextAvailableAt > finite(game.time)) {
        const remaining = Math.max(0, state.plan.nextAvailableAt - finite(game.time));
        setText('next-camp', '정글 재생성 대기');
        setText('waiting-message', `${clock(Math.ceil(remaining))} 후 다시 추천합니다.`);
      } else {setText('next-camp', '추천 가능한 캠프가 없어요');setText('waiting-message', '미확인 캠프 포함 설정을 확인해 주세요.');}
    }
    dom['route-section'].hidden = !stops.length;
    setText('route-total', `약 ${seconds(state.plan?.totalSeconds)}초`);
    renderRoute(stops);
    if (document.activeElement !== dom['start-camp']) dom['start-camp'].value = state.settings.startCamp;
    if (document.activeElement !== dom['route-length']) dom['route-length'].value = String(state.settings.routeLength);
    if (document.activeElement !== dom.team) dom.team.value = state.settings.team;
    dom['include-unknown'].checked = Boolean(state.settings.includeUnknown);
    dom['live-mode'].setAttribute('aria-pressed', String(!demo));
    dom['demo-mode'].setAttribute('aria-pressed', String(demo));
    dom['overlay-toggle'].firstChild.textContent = state.overlay?.visible ? '오버레이 숨기기' : '오버레이 보기';
    setText('shortcut-hint', state.overlay?.shortcutsAvailable === false ? '단축키를 등록하지 못했습니다. 버튼으로 제어하세요.' : 'Ctrl/Cmd + Shift + O 보기 · L 클릭 통과');
  }

  dom['settings-toggle'].addEventListener('click', () => {
    const open = dom['settings-panel'].hidden;
    dom['settings-panel'].hidden = !open;
    dom['settings-toggle'].setAttribute('aria-expanded', String(open));
    dom['settings-toggle'].setAttribute('aria-label', open ? '설정 닫기' : '설정 열기');
    if (open) dom['settings-panel'].scrollIntoView({ block: 'nearest' });
  });
  dom['lock-button'].addEventListener('click', () => invoke('toggleLock'));
  $('close-button').addEventListener('click', () => invoke('closeWindow'));
  dom['next-complete'].addEventListener('click', async event => {
    if (event.detail > 1 || completing || dom['next-complete'].disabled) return;
    const campId = state?.plan?.stops?.[0]?.campId;
    if (!campId) return;
    const target = { campId, matchKey: state.matchKey };
    completing = true;
    dom['next-complete'].disabled = true;
    await invoke('completeNext', target);
    completing = false;
    if (state) render(state);
  });
  dom['live-mode'].addEventListener('click', () => invoke('setMode', 'live'));
  dom['demo-mode'].addEventListener('click', () => invoke('setMode', 'demo'));
  dom['start-camp'].addEventListener('change', event => invoke('updateSettings', {startCamp:event.target.value}));
  dom['route-length'].addEventListener('change', event => invoke('updateSettings', {routeLength:Number(event.target.value)}));
  dom.team.addEventListener('change', event => invoke('updateSettings', {team:event.target.value}));
  dom['include-unknown'].addEventListener('change', event => invoke('updateSettings', {includeUnknown:event.target.checked}));
  dom['overlay-toggle'].addEventListener('click', () => invoke('toggleOverlay'));
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (!dom.toast.hidden) dom.toast.hidden = true;
    else if (!dom['settings-panel'].hidden) {
      dom['settings-panel'].hidden = true;
      dom['settings-toggle'].setAttribute('aria-expanded', 'false');
      dom['settings-toggle'].setAttribute('aria-label', '설정 열기');
      dom['settings-toggle'].focus();
    }
  });
  window.addEventListener('beforeunload', () => {clearTimeout(toastTimer);unsubscribe?.();});
  if (window.jungle) {
    unsubscribe = window.jungle.onState(render);
    window.jungle.getState().then(render).catch(() => toast('초기 정보를 불러오지 못했습니다.'));
  } else toast('Electron 앱에서 실행해 주세요.');
})();
