#!/usr/bin/env bash
# oc-keeper 한 회차 — ① 스냅샷 ② 규칙 엔진 ③ OpenClaw 에이전트(검산 → decision.json) ④ 검증 ⑤ 실행·기록
# 사용:  bash run.sh [cycleId]
# 환경:  VENUE_URL · DRY_RUN=1 · LEAGUE_MODEL(기본 anthropic/claude-opus-5) · LEAGUE_THINKING(high) · LEAGUE_TIMEOUT(900초)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; cd "$HERE"
export PATH="/home/openclaw/.openclaw/tools/node-v24.19.0/bin:/home/openclaw/.local/bin:$PATH"
MODEL="${LEAGUE_MODEL:-anthropic/claude-opus-5}"
THINKING="${LEAGUE_THINKING:-high}"
TIMEOUT="${LEAGUE_TIMEOUT:-900}"

CYCLE="${1:-}"
if [ -z "$CYCLE" ]; then
  CYCLE="$(node ../common/snapshot.mjs --agent . --quiet)" || { echo "✗ 스냅샷 실패 (장부 또는 시세 조회 실패) — 입력이 없으면 회차를 돌리지 않는다"; exit 2; }
fi
RUN="runs/$CYCLE"
[ -f "$RUN/snapshot.md" ] || { echo "✗ 스냅샷 없음: $RUN"; exit 2; }
ln -sfn "$CYCLE" runs/latest
rm -f "$RUN/decision.json"
echo "▶ oc-keeper $CYCLE · 모델 $MODEL · thinking $THINKING · DRY_RUN=${DRY_RUN:-0}"

node ../common/signals.mjs --agent . --cycle "$CYCLE" >/dev/null || { echo "✗ 규칙 엔진 실패"; exit 2; }

cat > "$RUN/prompt.md" <<EOF
리그 회차 $CYCLE 를 처리하라.
절차: skills/league-cycle/SKILL.md 를 그대로 따른다.
입력: runs/$CYCLE/signals.md · runs/$CYCLE/snapshot.md · policy.md · memory/lessons.md · memory/daily/ 최근 2일
출력: runs/$CYCLE/decision.json (스키마 common/decision.schema.json · cycleId 는 "$CYCLE")
도구는 파일 읽기·쓰기만 쓴다. 질문하지 말고 끝까지 진행한 뒤 세 줄 요약으로 답하라.
EOF

T0=$(date +%s)
openclaw agent exec --cwd "$HERE" --message-file "$RUN/prompt.md" \
  --model "$MODEL" --thinking "$THINKING" --timeout "$TIMEOUT" --json \
  > "$RUN/openclaw.json" 2> "$RUN/openclaw.err" < /dev/null
RC=$?
python3 - "$RUN/openclaw.json" "$RUN/openclaw-meta.json" "$RC" "$T0" <<'PY'
import json, sys, time
src, dst, rc, t0 = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
try: d = json.load(open(src))
except Exception as e: d = {"error": {"message": f"openclaw 출력 파싱 실패: {e}"}}
meta = {"runtime": "openclaw-agent-exec", "exitCode": rc, "wallSeconds": int(time.time()) - t0, "status": d.get("status"),
        "sessionId": d.get("sessionId"), "costUsd": d.get("costUsd"), "usage": d.get("usage"), "assistantTurns": d.get("assistantTurns"),
        "provider": d.get("provider"), "model": d.get("model"), "tools": d.get("toolSummary"), "result": (d.get("final") or "")[:600], "error": d.get("error")}
json.dump(meta, open(dst, "w"), ensure_ascii=False, indent=2)
print(f"  openclaw rc={rc} · {meta['status']} · 턴 {meta['assistantTurns']} · 비용 ${meta['costUsd']} · {meta['wallSeconds']}초 · {meta['provider']}/{meta['model']} · 도구 {(meta['tools'] or {}).get('tools')}")
if meta["error"]: print(f"  오류: {meta['error']}")
PY

if node ../common/validate.mjs "$RUN/decision.json" --cycle "$CYCLE" --policy policy.json; then :; else
  echo "  ✗ 결정 무효 — decision.json 을 decision.rejected.json 으로 옮기고 '결정 없음'으로 기록한다"
  [ -f "$RUN/decision.json" ] && mv "$RUN/decision.json" "$RUN/decision.rejected.json"
fi

node ../common/execute.mjs --agent . --cycle "$CYCLE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"  실행: {d.get('status')} · 자산 {d.get('equityBefore')} → {d.get('equityAfter')} · 결과 {[(r['market'],r['side'],r['status']) for r in d.get('results',[])]}\")"
