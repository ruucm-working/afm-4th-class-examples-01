#!/usr/bin/env bash
# Stop 훅 — runs/latest/decision.json 이 스키마를 통과할 때까지 턴을 끝내 주지 않는다 (최대 3회).
# "일이 끝난 것처럼 보이면 멈추는" 문제를 결정론적 검사로 막는다 (Claude Code 베스트프랙티스: 검증 가능한 종료 조건).
IN="$(cat)"
DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
RUN="$DIR/runs/latest"
[ -d "$RUN" ] || exit 0                      # 회차 밖에서 실행됐으면 검사하지 않는다
COUNT_FILE="$RUN/.stop-blocks"
N=0; [ -f "$COUNT_FILE" ] && N="$(cat "$COUNT_FILE")"
if [ "$N" -ge 3 ]; then exit 0; fi           # 세 번 막았으면 포기 — run.sh 가 무효 결정으로 기록한다
CYCLE="$(basename "$(readlink -f "$RUN")")"
OUT="$(node "$DIR/../common/validate.mjs" "$RUN/decision.json" --cycle "$CYCLE" --policy "$DIR/policy.json" 2>&1)"
RC=$?
if [ $RC -eq 0 ]; then exit 0; fi
echo $((N + 1)) > "$COUNT_FILE"
python3 - "$OUT" "$CYCLE" <<'PY'
import json, sys
out, cycle = sys.argv[1], sys.argv[2]
print(json.dumps({"decision": "block", "reason": f"runs/{cycle}/decision.json 이 아직 유효하지 않다 (../common/decision.schema.json). 검사 결과:\n{out[:1200]}\n파일을 고쳐 저장한 뒤 다시 끝내라. 관망이면 orders 와 targetWeights 를 비우고 stance 를 hold 로 둔다."}, ensure_ascii=False))
PY
exit 0
