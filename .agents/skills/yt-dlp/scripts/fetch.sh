#!/usr/bin/env bash
# 유튜브 URL → meta.json + 자막(transcript.md) / 없으면 audio.mp3
# 사용: fetch.sh <URL> [출력폴더]
set -euo pipefail

URL="${1:?사용법: fetch.sh <URL> [출력폴더]}"
OUT="${2:-.}"
HERE="$(cd "$(dirname "$0")" && pwd)"

command -v yt-dlp >/dev/null || { echo "yt-dlp 가 없습니다: brew install yt-dlp" >&2; exit 1; }

# 1. 메타데이터
ID="$(yt-dlp --get-id --no-playlist "$URL")"
DIR="$OUT/$ID"
mkdir -p "$DIR"
yt-dlp --dump-json --skip-download --no-playlist "$URL" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps({k:d.get(k) for k in ("id","title","channel","upload_date","view_count","like_count","duration","webpage_url")}, ensure_ascii=False, indent=2))' \
  > "$DIR/meta.json"
echo "meta.json  → $(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["title"])' "$DIR/meta.json" 2>/dev/null || echo "$DIR/meta.json")"

# 2. 자막 (ko → en → auto)
yt-dlp --write-subs --write-auto-subs --sub-langs "ko,en" --skip-download --no-playlist \
  -o "$DIR/subs.%(ext)s" "$URL" >/dev/null 2>&1 || true
VTT="$(ls "$DIR"/subs.*.vtt 2>/dev/null | head -n1 || true)"

if [ -n "$VTT" ]; then
  python3 "$HERE/vtt2md.py" "$VTT" > "$DIR/transcript.md"
  echo "transcript.md ← $(basename "$VTT")"
else
  # 3. 자막 없음 → 음성만
  echo "자막 없음 → 음성(mp3) 다운로드 (whisper 스킬로 받아쓰기)"
  yt-dlp -x --audio-format mp3 --no-playlist -o "$DIR/audio.%(ext)s" "$URL" >/dev/null
  echo "audio.mp3 → $DIR/audio.mp3"
fi

echo "done: $DIR"
