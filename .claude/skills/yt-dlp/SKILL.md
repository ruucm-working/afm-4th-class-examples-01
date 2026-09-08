---
name: yt-dlp
description: 유튜브(및 대부분의 영상 사이트) 주소로 자막·음성·제목·조회수 같은 메타데이터를 내려받을 때 사용. "이 유튜브 자막 받아줘", "영상 내용 정리해줘", "유튜브 리서치", "음성만 mp3 로 뽑아줘", "조회수/업로드일 알려줘", "yt-dlp 써서" 같은 요청에 사용. 자막이 없으면 음성(mp3)만 받아 두고 whisper 스킬로 넘긴다.
---

# yt-dlp — 영상·자막·메타데이터 내려받기

유튜브 주소 하나로 **자막 → 없으면 음성 → 메타데이터** 를 내려받아 문서(md)로 정리하는 스킬. 영상을 "보는" 게 아니라 **텍스트 데이터 소스**로 다루는 것이 목적이다.

## 0. 설치 확인

```bash
yt-dlp --version || { brew install yt-dlp; }      # Mac
# Windows: winget install yt-dlp
```

- 없으면 설치를 제안하고 진행한다 (Mac `brew`, Windows `winget`)
- 자막 없는 영상의 음성 변환에는 `ffmpeg` 가 필요: `brew install ffmpeg`

## 1. 작업 절차

1. **메타데이터 먼저** — 제목·채널·조회수·업로드일·길이를 json 으로 받는다
2. **자막 시도** — 한국어(`ko`) → 영어(`en`) → 자동 자막(`auto-subs`) 순
3. **자막이 없으면 음성만** — mp3 로 받아 두고, 받아쓰기는 `whisper` 스킬로 넘긴다
4. **정리** — `.vtt` 의 시간표시·중복줄을 지우고 문장만 남겨 `transcript.md` 로 저장

`scripts/fetch.sh <URL> [출력폴더]` 가 1~4 를 한 번에 한다.

```bash
bash .claude/skills/yt-dlp/scripts/fetch.sh "https://youtu.be/XXXX" research/코인
```

산출물 (출력폴더 안):

| 파일 | 내용 |
|---|---|
| `meta.json` | 제목·채널·조회수·업로드일·길이 (yt-dlp `--dump-json` 축약) |
| `subs.<lang>.vtt` | 원본 자막 (있을 때) |
| `transcript.md` | 시간·중복 제거한 문장 텍스트 (있을 때) |
| `audio.mp3` | 자막이 없을 때만 — whisper 스킬 입력 |

## 2. 자주 쓰는 명령 (직접 쓸 때)

```bash
# 자막만 (한국어 → 없으면 자동 자막)
yt-dlp --write-subs --write-auto-subs --sub-langs "ko,en" --skip-download -o "%(id)s.%(ext)s" <URL>

# 음성만 (Whisper 에 넣을 용도)
yt-dlp -x --audio-format mp3 -o "audio.%(ext)s" <URL>

# 제목·조회수·업로드날짜만 (json)
yt-dlp --dump-json --skip-download <URL>

# 검색 결과 상위 5개 (URL 없이 키워드로)
yt-dlp "ytsearch5:비트코인 전망" --dump-json --skip-download | jq -r '.title + " | " + .webpage_url'
```

## 3. vtt → 문장 텍스트

자동 자막 `.vtt` 는 같은 줄이 두 번씩 굴러가며 반복된다. `scripts/vtt2md.py` 가 시간표시·태그·중복을 지운다.

```bash
python3 .claude/skills/yt-dlp/scripts/vtt2md.py subs.ko.vtt > transcript.md
```

## 4. 리서치 산출물 형식

여러 영상을 조사할 때는 영상마다 폴더 하나, 마지막에 종합 문서 하나:

```
research/코인/
  ├─ <video-id-1>/ (meta.json, transcript.md)
  ├─ <video-id-2>/ …
  └─ summary.md   ← 영상별 핵심 주장 3줄 + 출처 링크 + 조회수
```

`summary.md` 에는 **출처(URL)·업로드일·조회수를 반드시** 남긴다 — 시장 분위기 문서(market-mood.md)로 이어질 때 근거가 된다.

## 팁

- 자동 자막(auto-subs)은 오타가 많다. 중요한 영상은 `audio.mp3` 를 whisper 스킬로 다시 받아쓴다
- 긴 영상(1시간+)은 자막만 받아도 충분하다 — 음성까지 받으면 시간·용량 낭비
- 재생목록 URL 은 영상 전체를 받는다. 하나만 원하면 `--no-playlist`
- 403/`Sign in to confirm` 오류가 나면 `yt-dlp -U` 로 업데이트부터 (유튜브가 자주 바뀐다)
- 사이트 약관·저작권 범위 안에서 **개인 리서치 용도**로만 쓴다. 영상 재업로드 금지
