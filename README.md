# Jungle Teacher · jgTeacherParkHwanHee

JavaScript + Electron으로 만든 Windows/macOS용 LoL 정글 동선 앱입니다. 남색·금색의 간결한 UI와 반투명 오버레이에서 **다음 캠프, 추천 동선, 시간**을 확인합니다.

## 실행

Node.js 22.12 이상과 npm이 필요합니다. 로컬 API 사용에는 Riot 개발자 API 키가 필요하지 않습니다.

```powershell
cd C:\jgpark\jgTeacherParkHwanHee
npm ci
npm start
```

macOS에서도 프로젝트 디렉터리에서 동일한 npm 명령을 실행합니다.

게임 없이 확인하려면:

```sh
npm run demo
```

일반 실행 시 롤 클라이언트 연결을 기다립니다. 게임을 시작하면 오버레이가 표시됩니다. **톱니바퀴 → 체험 모드**로 샘플 데이터를 확인할 수 있습니다. 체험 데이터와 실제 경기 상태는 분리되며 모드를 바꾸면 관측 기록을 초기화합니다. 메인 창을 닫으면 앱이 종료되고 오버레이의 닫기 버튼은 오버레이만 숨깁니다.

오버레이 표시/숨김은 **Ctrl/Cmd + Shift + O**, 클릭 통과 잠금은 **Ctrl/Cmd + Shift + L**입니다. 기본값은 잠금 해제입니다. **상단을 드래그**하면 창이 이동하고 다음 실행에서도 위치가 복원됩니다. 자물쇠를 잠그면 마우스 입력이 게임으로 통과합니다. 잠긴 상태에서 창을 옮기거나 버튼을 누르려면 단축키 또는 메인 창의 자물쇠로 해제하세요.

## 사용 방법

1. 소환사의 협곡 게임에 진입합니다. API에서 아군 진영을 판별하며, 식별되지 않으면 톱니바퀴 설정에서 진영을 선택합니다.
2. 설정에서 현재 위치의 기준이 될 **출발 캠프**와 추천 캠프 수를 선택합니다. 플레이어 좌표를 자동 추적하지 않으므로 이 위치가 이동 시간의 기준입니다.
3. 기본 화면에서 **다음 캠프**, 도착·대기 추정 시간, **추천 동선과 총 소요 시간**, 게임 시간을 확인합니다. 불확실한 대상에는 `추정`을 표시합니다.
4. 추천 캠프를 실제로 모두 처치한 뒤 **처치 완료**를 누릅니다. 해당 캠프를 즉시 추천 전체에서 제외하고 재생성 타이머와 위치 기준점을 기록한 다음, 게임 정보를 한 번 더 조회해 동선을 갱신합니다. 캠프에 여러 몬스터가 있으면 마지막 몬스터까지 처치한 시점을 기록합니다.
5. 상단을 끌어 원하는 위치로 옮기고, 플레이 중 클릭을 통과시키려면 자물쇠를 잠급니다.

지도, KDA·CS, 소환사 상세 정보, 알고리즘 배지와 개별 캠프 상태 목록은 화면에서 제거했습니다. 출발 위치·진영·방문 수·미확인 포함·체험 모드·오버레이 표시 설정은 기본적으로 접혀 있습니다. 일반 캠프를 자동 감지하거나 시간이 지났다는 이유로 자동 처치 처리하지 않습니다.

**v1.2의 재생성 제외 규칙:** 현재 게임 시각에 재생성 대기 중인 캠프와 최초 생성 전인 캠프는 추천의 어느 방문 순서에도 넣지 않습니다. 나중에 도착하면 생성될 예정이어도 지금의 추천 대상에서 제외하며, `미확인 캠프 포함`을 켜도 이 규칙을 우회하지 않습니다. 모든 후보가 대기 중이면 경로 대신 남은 시간을 표시합니다. 게임 API는 약 1초 주기로 조회하고 수신한 게임 시각과 타이머를 주기적으로 다시 계산합니다. 타이머 만료 후에는 `재생성 추정` 상태로 다시 후보에 들어갈 수 있습니다. 이동 경로의 경유 지점과 출발 위치는 사냥 대상이 아니므로 이미 처치한 캠프의 위치를 지나갈 수 있습니다.

버튼을 누를 때 화면에 보인 캠프와 경기 키를 함께 확인해 다른 캠프를 잘못 처치 기록하지 않습니다. 갱신 요청이 실패하거나 약간 이전 시각의 응답이 와도 처치 기록을 취소하지 않습니다. 오래된 응답이 최신 추천 화면을 덮어쓰는 것도 차단합니다.

| 기능 | Windows | macOS |
|---|---|---|
| 오버레이 표시/숨김 | Ctrl + Shift + O | Cmd + Shift + O |
| 클릭 통과 잠금/해제 | Ctrl + Shift + L | Cmd + Shift + L |

단축키가 다른 앱에 등록되어 있으면 메인 창의 버튼을 사용합니다. Electron의 반투명 최상위 창을 게임 위에 겹쳐 표시하므로 LoL의 **테두리 없는 창 모드**를 권장합니다. 독점 전체 화면 내부에 창을 삽입하는 방식은 아니며, 독점 전체 화면에서는 표시가 보장되지 않습니다. macOS의 전체 화면 Spaces·창 순서는 OS 동작에 영향을 받습니다.

## 데이터 범위와 정확도

| 기능 | 구현 방식 |
|---|---|
| 클라이언트 연결·소환사 정보·게임 단계 | league-connect 인증 + LCU 읽기 전용 HTTPS |
| 게임 시간·챔피언·레벨·체력·골드·KDA·CS·이동 속도·진영 | Live Client Data API |
| 일반 아군 정글 캠프 상태 | 미확인 기본값, 추천 캠프 처치 완료 수동 기록 |
| 재생성 시각 | 처치 기록 + 설정된 재생성 시간으로 추정 |
| 이동 경로 | 무방향 가중치 그래프 + 다익스트라 |
| 캠프 방문 순서 | 이동·대기·사냥 시간을 고려한 탐욕적 선택 |
| 상태/일정의 선후관계 | 별도 DAG + Kahn 위상 정렬 |

일반 캠프의 현재 몬스터 존재 여부·정확한 처치 시각·플레이어 좌표는 이 앱이 사용하는 API 응답에 없습니다. 따라서 초기 상태는 **미확인**입니다. 생존 기록은 30초 후 미확인으로 만료되고, 재생성 시간이 지나도 **생존 확정**으로 바뀌지 않고 **재생성 추정**으로 표시됩니다. 전장의 안개에 가려진 정보를 수집하지 않습니다.

일반 협곡의 첫 출현 기본값은 블루·레드·늑대·칼날부리 55초, 두꺼비·돌거북 67초로 [공식 26.1 패치](https://www.leagueoflegends.com/en-us/news/game-updates/patch-26-1-notes/)를 반영합니다. 재생성 기본값은 버프 300초, 다른 캠프 135초이며, 별도의 Swiftplay 단축 규칙은 일반 협곡에 적용하지 않습니다. 이동·사냥 시간과 좌표는 근사치이며 실제 패치·모드·지형·챔피언·전투 상황을 완전히 반영하지 않습니다. `service/camps.js`에서 조정할 수 있습니다. 추천은 현재 이용 가능한 후보 사이에서 재계산하며 전체 최적 방문 순서를 보장하지 않습니다. 시작 캠프가 후보이면 먼저 사냥하고, 대기 중이면 사냥 대상에서 빼고 다른 이용 가능한 캠프를 고릅니다.

소환사의 협곡(mapNumber 11) 외에서는 동선 추천과 처치 완료 기록을 중단합니다. 게임 종료·경기 ID 변경·게임 시간 초기화·체험/실시간 전환 시 관측을 초기화합니다. API 연결이 끊기면 이전 경기 정보를 실시간 정보로 계속 표시하지 않습니다. 경기 관측과 동선 설정은 메모리에만 유지하고, **오버레이 창 위치만** Electron 사용자 데이터 디렉터리의 `overlay-position.json`에 저장합니다. 모니터 구성이 바뀌면 보이는 화면 안으로 위치를 보정합니다.

진영 설정을 변경하면 다른 진영의 캠프에 기록이 연결되지 않도록 캠프 관측을 초기화합니다. 직접 확인한 생존 기록도 30초가 지나면 미확인으로 전환됩니다.

## 폴더 구조

```text
jgTeacherParkHwanHee/
├─ service/
│  ├─ lcu-client.js           # league-connect 인증, LCU 연결/재시도
│  ├─ live-client.js          # 게임 중 API, 플레이어 식별
│  ├─ app-service.js          # 모드/경기/설정 통합
│  ├─ camps.js                # 캠프와 양방향 이동 간선
│  ├─ jungle-tracker.js       # 수동 관측, 재생성 추정 DAG
│  └─ algorithms/
│     ├─ graph.js             # 무방향 그래프, 다익스트라
│     ├─ topological.js       # Kahn 위상 정렬, DAG 일정 계산
│     └─ route-planner.js     # 방문 순서와 이동/대기/사냥 일정
├─ ui/
│  ├─ main.js                 # Electron 창, 프로토콜, IPC, 단축키
│  ├─ preload.js              # 제한된 contextBridge
│  ├─ overlay-policy.js       # 자동 표시/수동 숨김 정책
│  ├─ window-layout.js        # 작은 창 크기, 다중 모니터 위치 보정
│  ├─ index.html
│  ├─ renderer.js
│  └─ styles.css
├─ scripts/
├─ tests/
├─ ALGORITHMS.md              # 알고리즘 사용 위치, 예제, 한계
└─ package.json
```

## 검증과 패키징

```sh
npm run check
npm test
npm run smoke
npm run pack
```

`smoke`는 실제 Electron 창에서 처치 후 전체 경로 제외, 모든 캠프 재생성 대기 화면, 주기적 재추천, 오래된 응답 무시, 처치 완료 버튼, 설정, 반투명 배경, 창 이동·잠금, IPC와 렌더러 격리를 점검합니다. `artifacts/`에 기본 화면·`cooldown.png`와 결과 JSON을 저장한 뒤 종료합니다. 검증용 프로필을 분리해 기존 앱의 위치를 변경하지 않습니다. 실제 롤 클라이언트 연결 테스트는 로컬 게임 환경에서 별도로 확인해야 합니다.

각 운영체제에서 설치 파일 생성:

```sh
# Windows
npm run dist:win
# macOS (Mac에서 실행)
npm run dist:mac
```

출력은 `dist/`입니다. macOS는 Intel/Apple Silicon을 대상으로 설정했습니다. 공개 배포를 위한 Windows 코드 서명과 macOS Developer ID 서명/공증은 배포자 계정과 인증서 설정이 필요합니다. 이 프로젝트 폴더를 저장소 루트로 사용하면 `.github/workflows/build.yml` 구성이 Windows/macOS에서 검사·테스트·패키지 디렉터리 생성을 수행합니다.

## 통신과 보안

- LCU: `authenticate({ awaitConnection: false })`로 발견한 로컬 포트에만 접근합니다. 라이브러리가 제공한 Riot 인증서로 검증합니다. 요청 취소·시간 제한을 위해 작은 HTTPS 어댑터를 사용합니다.
- LCU 조회: `/lol-gameflow/v1/gameflow-phase`, `/lol-summoner/v1/current-summoner`, `/lol-gameflow/v1/session`.
- 게임 중: `https://127.0.0.1:2999/liveclientdata/allgamedata`. 여러 응답 하위 정보를 함께 사용하므로 통합 엔드포인트를 조회합니다. 자체 서명 예외는 이 고정 로컬 요청에만 적용합니다.
- 인증 토큰과 포트는 렌더러에 전달하거나 파일에 저장하지 않습니다. 외부 서버로 게임 정보를 전송하지 않습니다.
- renderer는 Node 접근 없이 sandbox + contextIsolation을 사용합니다. 로컬 커스텀 프로토콜/CSP, IPC 발신 프레임 확인, 입력 검증을 적용합니다.

LCU는 Riot이 안정성을 보장하는 공식 지원 인터페이스가 아니므로 패치에 따라 변경될 수 있습니다. 다른 사용자에게 배포하기 전에는 Riot Developer Portal에 앱과 사용 엔드포인트를 등록하고 현재 게임 정책에 맞는지 검토해야 합니다. 이 프로젝트는 Riot Games가 제작하거나 보증하는 앱이 아닙니다.

## 참고 문서

- [Riot: League Client API](https://developer.riotgames.com/docs/lol#league-client-api)
- [Riot: Live Client Data API](https://developer.riotgames.com/docs/lol#live-client-data-api)
- [Riot: 게임 정책](https://developer.riotgames.com/docs/lol#game-integrity)
- [league-connect 소스와 사용법](https://github.com/junlarsen/league-connect)
- [Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)
- [Electron 보안 지침](https://www.electronjs.org/docs/latest/tutorial/security)
