#!/usr/bin/env bash
# 최근 판단 일지 2개를 이어서 출력한다 (스킬의 동적 주입용 · 없으면 "(아직 없음)")
# 스킬 주입 명령은 권한 규칙에 걸리면 스킬 전체가 무산되므로, 파이프 대신 이 스크립트 하나를 allowed-tools 로 허용한다.
DIR="${CLAUDE_PROJECT_DIR:-.}/memory/daily"
files=$(ls -t "$DIR"/*.md 2>/dev/null | head -n 2)
if [ -z "$files" ]; then echo "(아직 없음)"; exit 0; fi
for f in $files; do echo "### $(basename "$f")"; cat "$f"; echo; done
exit 0
