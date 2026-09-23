---
name: league-cycle
description: 리그 한 회차를 처리한다 — bull·bear 토론과 risk-officer 상한을 거쳐 runs/<cycleId>/decision.json 을 쓴다. 운영자만 호출한다.
disable-model-invocation: true
arguments: [cycle]
argument-hint: "<cycleId 예: 20260922-0900>"
allowed-tools: Bash(node ../common/risk.mjs *) Bash(node ../common/validate.mjs *) Bash(${CLAUDE_SKILL_DIR}/recent-daily.sh) Read Write Agent
---

# 회차 $cycle

## 자동 주입된 입력

### 스냅샷 (지갑 · 시세 · 맥락 · 뉴스 · 내 기록)
!`cat runs/latest/snapshot.md`

### 교훈 (확정만 근거로 쓴다)
!`cat memory/lessons.md 2>/dev/null || echo "(아직 없음)"`

### 최근 판단 일지 (최대 2일)
!`${CLAUDE_SKILL_DIR}/recent-daily.sh`

## 절차

1. **토론** — `bull` 과 `bear` 서브에이전트를 **동시에** 부른다. 각자 종목별 논지 표를 돌려준다.
2. **상한** — `risk-officer` 서브에이전트를 부르면서 두 논지 표를 그대로 넘긴다. 자세별 종목 상한표와 거부권을 돌려준다.
3. **결정** — policy.md 3·4절대로 자세를 고르고, 그 자세의 상한표 **안에서** `targetWeights` 를 정한다. 반박되지 않은 논지만 채택, 확신 4 이상만 상단, 새 편입은 2종목까지, 거부권은 그대로 따른다.
4. **작성** — `runs/$cycle/decision.json` 을 `../common/decision.schema.json` 대로 쓴다. `cycleId` 는 `$cycle`. `evidence` 에는 채택한 논지의 인용을 그대로 옮긴다. `invalidation` 필수. `memoryNote` 한 줄, 필요할 때만 `lessonCandidate`.
5. **사전 검사** — `node ../common/risk.mjs --agent . --decision runs/$cycle/decision.json` 을 돌려 축소·거절 사유를 `rationale` 에 반영한다 (밴드 안 유지는 정상).
6. **검증** — `node ../common/validate.mjs runs/$cycle/decision.json --cycle $cycle` 이 통과하면 끝. 마지막 답은 결정 요약 세 줄(자세 · 목표 비중 · 채택한 논지)이면 된다.

관망이면 `orders` 와 `targetWeights` 를 모두 비우고 `stance: "hold"`. 관망도 결정이다 — `rationale` 과 `evidence` 를 똑같이 채운다.
