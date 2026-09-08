---
name: whisper
description: 음성·영상 파일(mp3/m4a/mp4/wav)을 OpenAI Whisper API 로 받아써서 텍스트(transcript.md)로 만들 때 사용. "이 음성 받아써줘", "영상 내용 글로 정리해줘", "자막 없는 유튜브 텍스트로", "회의 녹음 정리", "whisper 로 변환" 같은 요청에 사용. yt-dlp 스킬이 남긴 audio.mp3 의 후속 단계. 키는 .env 의 OPENAI_API_KEY 를 쓴다.
---

# Whisper (OpenAI) — 자막 없는 영상 받아쓰기

음성 파일을 넣으면 글이 나오는 OpenAI 받아쓰기 API. My ChatGPT 에 쓴 **같은 API 키**(`OPENAI_API_KEY`)로 쓴다.

## 0. 준비

- `.env` 에 `OPENAI_API_KEY=sk-...` — **스크립트나 대화에 키를 직접 적지 않는다**
- `ffmpeg` (25MB 넘는 파일을 자를 때): `brew install ffmpeg`
- 입력이 영상(mp4)이면 그대로 넣어도 되지만, 용량이 크면 먼저 음성만 뽑는다:
  `ffmpeg -i video.mp4 -vn -ac 1 -ar 16000 -b:a 48k audio.mp3`

## 1. 작업 절차

1. 파일 크기 확인 — **25MB 이하**면 바로, 넘으면 10분 단위로 잘라서 순서대로 보내고 합친다
2. `whisper-1` 모델, `language=ko` (영어면 `en`) 로 요청
3. 결과를 `transcript.md` 로 저장 — 맨 위에 원본 파일명·길이·날짜를 적는다
4. 요청이 "정리" 라면 transcript 를 바탕으로 요약/핵심 주장 문서를 별도로 만든다 (원문은 그대로 보존)

`scripts/transcribe.sh <파일> [출력.md]` 가 1~3 을 한 번에 한다 (자동 분할 포함).

```bash
bash .claude/skills/whisper/scripts/transcribe.sh research/코인/abc123/audio.mp3
# → research/코인/abc123/transcript.md
```

## 2. 직접 호출할 때

```bash
curl https://api.openai.com/v1/audio/transcriptions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -F file=@audio.mp3 -F model=whisper-1 -F language=ko \
  -F response_format=text
```

- `response_format=text` → 문장만 / `verbose_json` → 구간별 타임스탬프 포함 / `srt` → 자막 파일
- 고유명사(코인 이름·회사명)가 자꾸 틀리면 `-F prompt="비트코인, 이더리움, 업비트"` 처럼 힌트를 준다

## 3. 두 가지 방법 비교

| | OpenAI API (추천) | 내 컴퓨터에서 (`openai-whisper` 패키지) |
|---|---|---|
| 설치 | 없음 — 키만 있으면 | 무거움 (모델 다운로드, Python) |
| 속도 | 빠름 | 컴퓨터 성능에 따라 |
| 비용 | 분당 약 $0.006 (10분 ≈ 80원) | 무료 |
| 한계 | 파일 25MB 이하 (긴 영상은 나눠서) | 없음 |

수업에서는 API 방식만 쓴다. 로컬 방식은 사용자가 명시적으로 원할 때만.

## 팁

- **자막이 있는 영상은 Whisper 쓸 필요 없다** — yt-dlp 자막이 공짜고 빠르다. 자막이 없거나 자동 자막 품질이 나쁠 때만
- 1시간 영상 ≈ 60 × $0.006 ≈ $0.36. 비용을 먼저 알려주고 진행한다
- 결과에 문단 구분이 없다. "문단 나누고 오탈자 고쳐줘" 는 별도 단계로
- 키가 없거나 401 이 나면 `.env` 위치와 `OPENAI_API_KEY` 이름부터 확인
