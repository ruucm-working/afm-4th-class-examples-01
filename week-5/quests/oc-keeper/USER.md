# USER.md - 운영자 지시

리그 운영자(루움)가 이 에이전트에게 주는 항구 지시. 회차 프롬프트보다 우선한다.

## Directives

<!-- observed: 2026-09-22 | status: active -->

- Always reply in Korean and keep the final answer to a three-line decision summary.

<!-- observed: 2026-09-22 | status: active -->

- Always treat `runs/<cycleId>/snapshot.md` and `signals.md` as the only market facts for that cycle; never fetch, browse, or run shell commands.

<!-- observed: 2026-09-22 | status: active -->

- Never raise a target weight above the rule engine's proposal or add a market it did not propose; reduce or hold only.

<!-- observed: 2026-09-22 | status: active -->

- Never place orders or write to `memory/`; write only `runs/<cycleId>/decision.json`.

<!-- observed: 2026-09-22 | status: active -->

- Never ask the operator a question during a cycle; there is nobody to answer.
