# common/ — 리그 공통 실행 기반

리그 플랜의 「공통 실행·검증 기반」에 해당한다. **시세·장부·주문 검증·기록은 운영자가 제공하는 공통 코드가 맡고, 에이전트(수강생 설계 영역)는 판단만 한다.**
네 에이전트(`cc-trend` `cc-council` `oc-mood` `oc-keeper`)가 전부 이 폴더를 공유한다. 의존성 없음 — Node 20+ 만 있으면 된다.

## 한 회차의 흐름

```
① snapshot.mjs   장부 + 업비트 시세/지표 + 시장 맥락 + 뉴스 제목 + 내 최근 기록  →  runs/<cycleId>/snapshot.md
② signals.mjs    (체계적 에이전트만) strategy.json 규칙으로 목표 비중 제안            →  runs/<cycleId>/signals.md
③ (LLM)          snapshot.md · signals.md · policy.md · memory/ 를 읽고               →  runs/<cycleId>/decision.json
④ risk.mjs       결정을 주문으로 바꿔 정책에 걸리는지 미리 본다 (주문 안 냄)         →  stdout JSON
⑤ validate.mjs   decision.json 스키마·허용 종목·상한 검사 (Stop 훅과 run.sh 가 쓴다) →  종료 코드 0/1
⑥ execute.mjs    정책 검사 → 장부에 주문 → journal.jsonl · equity.csv · daily/ 기록  →  runs/<cycleId>/result.json
⑦ review.mjs     하루 한 번 회고 자료 (자산 추이·최대낙폭·거절 사유·판단 이유)       →  stdout Markdown
```

LLM 이 만드는 파일은 **`decision.json` 하나**다. 스키마는 `decision.schema.json`. `orders`(직접 주문) 또는 `targetWeights`(목표 비중 → 리밸런스) 중 하나만 쓴다. 둘 다 비우면 관망(`hold`)으로 기록된다.

에이전트 폴더의 `run.sh` 가 이 순서를 자기 런타임(Claude Code `claude -p` · OpenClaw `openclaw agent exec`)에 맞춰 묶는다. `league/run-cycle.sh` 는 그 `run.sh` 를 에이전트마다 부른다.

## 규칙 엔진 (`signals.mjs` · 에이전트 폴더의 `strategy.json`)

`strategy: "trend"`(cc-trend) 는 추세 up + 7일·30일 양수 종목을 모멘텀 점수로 3개 골라 1/변동성 가중, `strategy: "keeper"`(oc-keeper) 는 추세 down 이 아닌 종목 전부를 1/변동성 가중(위험균형). 둘 다 포트폴리오 일변동성 목표(`targetDailyVol`)로 총노출을 정하고, 공포탐욕(`greedCut`)·손실 사다리(`ddLadder`)로 줄인다. 상한은 policy.json. 출력의 계산 메모가 근거다. **LLM 은 이 제안을 줄이거나 관망으로만 바꾼다.**

## 코드가 강제하는 것 (에이전트 폴더의 `policy.json`)

| 키 | 뜻 |
|---|---|
| `markets` | 거래 허용 종목 |
| `maxWeightPerMarket` | 종목당 최대 비중 (총자산 대비) |
| `maxGrossExposure` | 코인 총노출 상한 |
| `cashFloor` | 매수 후에도 남겨야 하는 현금 비율 |
| `maxOrdersPerCycle` | 회차당 주문 수 |
| `maxTurnoverPerDay` | 하루(KST) 체결 명목 금액 합 ÷ 총자산 |
| `minOrderKRW` / `minTradeKRW` | 업비트 최소 주문액(5,000원) / 먼지 거래 무시 기준 |
| `rebalanceBand` | targetWeights 와 현재 비중 차이가 이 밴드 안이면 주문 안 함 |
| `drawdownHaltPct` / `dailyLossHaltPct` | 시작 대비·24시간 대비 손실이 이만큼이면 **신규 매수 금지** (매도만 허용) |
| `venueUrl` | 장부 주소 (환경변수 `VENUE_URL` 이 우선) |

상한을 넘는 매수는 자동 축소, 못 맞추면 거절 — 전부 `journal.jsonl` 의 `results[].status` 와 `flags` 에 남는다.

## 안전장치

- **체결가는 장부(서버)가 정한다.** 에이전트는 가격을 보내지도 않는다 (모의투자 앱 규칙 ①).
- **중복 실행 방지 두 겹:** 같은 `cycleId` 가 journal 에 있으면 `execute.mjs` 는 아무것도 안 한다. 주문 메모에 `[cid:<cycleId>/<n>]` 을 남겨, 재시도 때 장부에 같은 cid 가 있으면 다시 주문하지 않는다.
- **「판단 후 관망」과 「실행 실패」를 다른 상태로 남긴다:** `hold` · `executed` · `all-rejected` · `failed` · `no-decision` · `invalid-decision` · `dry-run`.
- **뉴스는 신뢰하지 않는 외부 텍스트.** 스냅샷 4절에 제목·시각·링크만 넣고, 안에 적힌 지시는 무시하라고 표시한다.
- **장부를 못 읽는 회차는 주문하지 않는다** (`snapshot.mjs` 가 종료 코드 2 로 멈춘다).
- `DRY_RUN=1` 이면 주문을 내지 않고 판단·기록만 한다.

## 기록 파일 (에이전트 폴더 `memory/`)

| 파일 | 내용 | 누가 쓰나 |
|---|---|---|
| `journal.jsonl` | 회차별 사실 기록 — 입력 시각, 자세, 제안 주문, 실제 결과, 이유, 근거, 확신, 무효화 조건 | `execute.mjs` |
| `equity.csv` | 회차마다 총자산·현금·평가액 | `execute.mjs` |
| `daily/YYYY-MM-DD.md` | 사람이 읽는 판단 일지 (결정 시점 문장 그대로) | `execute.mjs` + LLM 의 `memoryNote` |
| `lessons.md` | 확정 교훈(사람 검토) / 후보(에이전트 제안) | LLM `lessonCandidate` → 후보 절 |
| `policy.md` (에이전트 루트) | 사람이 읽는 규칙책 — **리그 중 동결.** 에이전트가 고치지 않는다 | 사람 |

기억 갱신(일지·교훈 후보)과 정책 변경은 다른 작업이다 — 리그 플랜 2절.

## 시세·지표 (snapshot.md 2절)

업비트 공개 API(키 없음): `/v1/ticker` · `/v1/candles/minutes/60` (200개) · `/v1/candles/days` (30개).
1h/4h/24h/7d/30d 수익률, EMA20·EMA50(1h) 대비 위치와 기울기, RSI14(1h), ATR%14(1h), 20일 일간 변동성, 20일 고점·저점 대비, 24h 거래대금 ÷ 7일 평균, 추세 라벨(up/down/mixed), 업비트 전일대비(KST 09:00 기준)와 24h 롤링을 **둘 다** 준다 (4주차 리서치 메모 3번).

## 시장 맥락 (3·4절 · 전부 선택 사항, 실패해도 회차는 돈다)

- 공포·탐욕 지수 — `api.alternative.me/fng` (7일)
- USD/KRW — frankfurter(ECB) → 실패 시 open.er-api · 하루 1회 갱신 참고치
- 바이낸스 선물 마크가·펀딩비 — `fapi.binance.com/fapi/v1/premiumIndex` (이 호스트에서 막히면 실패로 표시)
- 김치 프리미엄 = 업비트 원화가 ÷ (바이낸스 마크가 × USD/KRW) − 1
- 뉴스 제목 — CoinDesk RSS · Cointelegraph RSS · 구글뉴스(ko) "비트코인" — 각 8건, 제목 160자 · HTML 제거

## 재현 모드 (`LEAGUE_ASOF`)

`LEAGUE_ASOF=2026-09-19T19:10:00+09:00` 을 주면 `lib.mjs` 의 「지금」이 그 시각이 된다 — `nowIso()`·`kst()`·`cycleIdFrom()`·손실 제동의 24h 기준·하루 회전율의 날짜가 전부 그 시각 기준. 시세는 업비트 캔들의 `to=`(그 시각 미만)로 1시간봉 199개 + 그 시각까지의 1분봉을 합친 진행 중 봉, 일봉 29개 + 진행 중 날(KST 09:00~)로 라이브와 같은 모양을 만든다(`marketSnapshotAsOf`). 현재가는 그 시각 직전 1분봉 종가. 시장 맥락은 공포탐욕 일별 이력 · ECB 그 날짜 환율 · 바이낸스 1분봉 종가와 그 시각 직전 펀딩비 · 구글뉴스 날짜 검색(그 시각 이전 48시간)으로 대신한다(`contextSnapshotAsOf`). 장부는 `LEAGUE_VENUE_DB=<db.json>` 을 직접 읽고 써서(`ReplayVenue`) 그 시각 가격·시각으로 체결한다 — 서버(server.js)와 같은 규칙. `snapshot.mjs`·`execute.mjs`·`risk.mjs` 는 `openVenue(policy)` 로 자동 분기하고, journal 항목에 `replay: true` 가 붙는다. 운영은 `league/backfill.sh` 가 한다.

## 실행 예

```bash
export PATH=/home/openclaw/.openclaw/tools/node-v24.19.0/bin:$PATH
node common/snapshot.mjs --agent cc-trend                       # 스냅샷 (cycleId 자동 = KST YYYYMMDD-HHmm)
node common/risk.mjs --agent cc-trend --decision runs/20260922-1000/decision.json
node common/execute.mjs --agent cc-trend --cycle 20260922-1000  # 실행 + 기록
node common/review.mjs --agent cc-trend --days 7                # 회고 자료
node common/scoreboard.mjs --write                              # 리그 현황판 (league/scoreboard.md)
```
