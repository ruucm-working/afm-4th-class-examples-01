#!/usr/bin/env bash
# 음성/영상 파일 → OpenAI Whisper API → transcript.md  (25MB 초과 시 10분 단위 자동 분할)
# 사용: transcribe.sh <파일> [출력.md]   (키는 .env 의 OPENAI_API_KEY)
set -euo pipefail

IN="${1:?사용법: transcribe.sh <파일> [출력.md]}"
OUT="${2:-$(dirname "$IN")/transcript.md}"
LANG_CODE="${WHISPER_LANG:-ko}"
MODEL="${WHISPER_MODEL:-whisper-1}"
LIMIT=$((24 * 1024 * 1024))   # API 한도 25MB 보다 살짝 아래

# .env 에서 키 읽기 (현재 폴더 → 상위 폴더 순)
if [ -z "${OPENAI_API_KEY:-}" ]; then
  d="$PWD"
  while [ "$d" != "/" ]; do
    if [ -f "$d/.env" ]; then set -a; . "$d/.env"; set +a; break; fi
    d="$(dirname "$d")"
  done
fi
[ -n "${OPENAI_API_KEY:-}" ] || { echo "OPENAI_API_KEY 가 없습니다 (.env 확인)" >&2; exit 1; }

transcribe_one() {   # $1 파일 → stdout 텍스트
  curl -sS https://api.openai.com/v1/audio/transcriptions \
    -H "Authorization: Bearer $OPENAI_API_KEY" \
    -F "file=@$1" -F "model=$MODEL" -F "language=$LANG_CODE" -F response_format=text
}

SIZE=$(stat -f%z "$IN" 2>/dev/null || stat -c%s "$IN")
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

{
  echo "# transcript"
  echo
  echo "- 원본: $(basename "$IN")"
  echo "- 모델: $MODEL ($LANG_CODE)"
  echo "- 생성: $(date '+%Y-%m-%d %H:%M')"
  echo
} > "$OUT"

if [ "$SIZE" -le "$LIMIT" ]; then
  transcribe_one "$IN" >> "$OUT"
else
  command -v ffmpeg >/dev/null || { echo "25MB 초과 — 분할하려면 ffmpeg 필요: brew install ffmpeg" >&2; exit 1; }
  echo "$(( SIZE / 1024 / 1024 ))MB → 10분 단위로 분할해서 보냅니다"
  ffmpeg -loglevel error -i "$IN" -vn -ac 1 -ar 16000 -b:a 48k -f segment -segment_time 600 "$TMP/part_%03d.mp3"
  for p in "$TMP"/part_*.mp3; do
    echo "  $(basename "$p")"
    transcribe_one "$p" >> "$OUT"
    echo >> "$OUT"
  done
fi

echo "done: $OUT"
