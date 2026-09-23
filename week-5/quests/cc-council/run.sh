#!/usr/bin/env bash
# cc-council 한 회차 — ① 스냅샷 ② Claude Code(토론 → decision.json) ③ 검증 ④ 실행·기록
# 사용:  bash run.sh [cycleId]
# 환경:  VENUE_URL · DRY_RUN=1 · LEAGUE_MODEL(기본 opus) · LEAGUE_EFFORT(high) · LEAGUE_MAX_TURNS(50) · LEAGUE_BUDGET_USD(6)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; cd "$HERE"
export PATH="/home/openclaw/.openclaw/tools/node-v24.19.0/bin:/home/openclaw/.local/bin:$PATH"
export CLAUDE_CODE_DISABLE_AUTO_MEMORY=1
MODEL="${LEAGUE_MODEL:-opus}"
EFFORT="${LEAGUE_EFFORT:-high}"
MAX_TURNS="${LEAGUE_MAX_TURNS:-50}"
BUDGET="${LEAGUE_BUDGET_USD:-6}"

CYCLE="${1:-}"
if [ -z "$CYCLE" ]; then
  CYCLE="$(node ../common/snapshot.mjs --agent . --quiet)" || { echo "✗ 스냅샷 실패 (장부 또는 시세 조회 실패) — 입력이 없으면 회차를 돌리지 않는다"; exit 2; }
fi
RUN="runs/$CYCLE"
[ -f "$RUN/snapshot.md" ] || { echo "✗ 스냅샷 없음: $RUN"; exit 2; }
ln -sfn "$CYCLE" runs/latest
rm -f "$RUN/decision.json" "$RUN/.stop-blocks"
echo "▶ cc-council $CYCLE · 모델 $MODEL · effort $EFFORT · DRY_RUN=${DRY_RUN:-0}"

T0=$(date +%s)
claude --agent council-chair -p "/league-cycle $CYCLE" \
  --model "$MODEL" --effort "$EFFORT" \
  --permission-mode acceptEdits --permission-prompts none \
  --setting-sources project --strict-mcp-config \
  --max-turns "$MAX_TURNS" --max-budget-usd "$BUDGET" \
  --output-format json > "$RUN/claude.json" 2> "$RUN/claude.err" < /dev/null
RC=$?
python3 - "$RUN/claude.json" "$RUN/claude-meta.json" "$RC" "$T0" <<'PY'
import json, sys, time
src, dst, rc, t0 = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
try: d = json.load(open(src))
except Exception as e: d = {"error": f"claude 출력 파싱 실패: {e}"}
meta = {"runtime": "claude-code", "exitCode": rc, "wallSeconds": int(time.time()) - t0,
        "sessionId": d.get("session_id"), "costUsd": d.get("total_cost_usd"), "turns": d.get("num_turns"),
        "models": list((d.get("modelUsage") or {}).keys()), "denials": [x.get("tool_name") for x in d.get("permission_denials", [])],
        "subagents": (d.get("subagent_stats") or {}).get("by_type"), "result": (d.get("result") or "")[:600], "error": d.get("error")}
json.dump(meta, open(dst, "w"), ensure_ascii=False, indent=2)
print(f"  claude rc={rc} · 턴 {meta['turns']} · 비용 ${meta['costUsd']} · {meta['wallSeconds']}초 · 세션 {meta['sessionId']} · 서브에이전트 {meta['subagents']}")
if meta["denials"]: print(f"  거부된 도구 호출: {meta['denials']}")
PY

if node ../common/validate.mjs "$RUN/decision.json" --cycle "$CYCLE" --policy policy.json; then :; else
  echo "  ✗ 결정 무효 — decision.json 을 decision.rejected.json 으로 옮기고 '결정 없음'으로 기록한다"
  [ -f "$RUN/decision.json" ] && mv "$RUN/decision.json" "$RUN/decision.rejected.json"
fi

node ../common/execute.mjs --agent . --cycle "$CYCLE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"  실행: {d.get('status')} · 자산 {d.get('equityBefore')} → {d.get('equityAfter')} · 결과 {[(r['market'],r['side'],r['status']) for r in d.get('results',[])]}\")"
