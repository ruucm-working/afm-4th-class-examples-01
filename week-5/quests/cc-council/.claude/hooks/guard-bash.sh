#!/usr/bin/env bash
# PreToolUse(Bash) 가드 — 에이전트가 장부·네트워크·실행 스크립트에 손대는 명령을 결정론적으로 막는다.
# permissions.deny 는 명령의 첫 단어로만 거르므로, 파이프·복합 명령 안에 숨은 것까지 여기서 본다.
IN="$(cat)"
CMD="$(printf '%s' "$IN" | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("tool_input",{}).get("command",""))
except Exception: print("")')"
if printf '%s' "$CMD" | grep -qiE 'curl|wget|/api/|execute\.mjs|snapshot\.mjs|https?://|fetch\(|urllib|requests\.|socket|http\.client|\bnc |ncat|\bgit\b|rm -rf|> *policy|> *strategy|> *memory/'; then
  python3 - "$CMD" <<'PY'
import json, sys
print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
  "permissionDecisionReason": "리그 규칙: 네트워크·장부·실행 스크립트·git·정책 파일 수정 명령은 에이전트가 쓸 수 없다. 주문은 운영 코드(execute.mjs)가 낸다. 막힌 명령: " + sys.argv[1][:160]}}, ensure_ascii=False))
PY
fi
exit 0
