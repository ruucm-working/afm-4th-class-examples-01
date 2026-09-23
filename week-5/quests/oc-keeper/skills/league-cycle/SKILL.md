---
name: league-cycle
description: 리그 한 회차 절차 — 규칙 엔진 제안(signals.md)을 검산해 runs/<cycleId>/decision.json 을 쓴다.
user-invocable: true
---

# 리그 회차 절차 (oc-keeper)

회차 프롬프트에 `cycleId` 가 있다. 아래 순서를 그대로 밟는다. 도구는 파일 읽기·쓰기만.

1. **읽기** — `runs/<cycleId>/signals.md`, `runs/<cycleId>/snapshot.md` 전체, `policy.md`, `memory/lessons.md` 의 확정 절, `memory/daily/` 의 최근 2개 파일(있으면).
2. **검산** — `skills/keeper-rules/SKILL.md` 의 검산표 다섯 항목을 순서대로 확인하고, 항목마다 통과/불일치와 근거 숫자를 적어 둔다.
3. **경성 위험** — 스냅샷 4절 제목에 해킹·거래 정지·디페그·거래 금지 규제가 있으면 해당 종목 0 (전체면 전체 0).
4. **결정** — 검산이 전부 통과하면 제안의 `targetWeights` 를 **그대로** 옮긴다. 불일치·위험이 있으면 policy.md 3절대로 그 종목만 줄인다. 어떤 경우에도 제안보다 큰 값이나 제안에 없는 종목을 넣지 않는다. 현재 비중과의 차이가 밴드(3%) 안인 종목은 현재 비중을 그대로 적는다.
5. **작성** — `runs/<cycleId>/decision.json` 을 `common/decision.schema.json` 대로 쓴다. `cycleId` 는 프롬프트의 값. `evidence` 에 검산에 쓴 숫자를 출처와 함께 적는다. `invalidation` 은 "어느 종목의 추세가 down 으로 바뀌면" 처럼 다음 회차에 확인 가능한 문장으로. `memoryNote` 한 줄(검산 결과·총노출), 필요할 때만 `lessonCandidate`.
6. **자체 검사** — 저장한 파일을 다시 읽어 JSON 이 유효한지, 키가 스키마의 허용 목록 안인지, 비중이 제안 이하인지 확인한다.
7. **마지막 답** — 세 줄: 검산 결과 · 자세와 목표 비중 · 한 줄 이유.

관망이면 `orders` 와 `targetWeights` 를 모두 비우고 `stance: "hold"`. 관망도 결정이다 — `rationale` 과 `evidence` 를 똑같이 채운다.
