"""오디세이(2026) 한국어 포스터를 GPT Image 2(fal.ai openai/gpt-image-2/edit)로 만든다.

참고 이미지는 odyssey-images/stills 의 '장면 스틸'만 쓴다.
기존 포스터(posters-*, key-art-wide)와 stills/01~08(키아트)은 넣지 않는다.

    python make_posters.py              # 전체 콘셉트
    python make_posters.py A C          # 일부만
    python make_posters.py A --quality medium --size 1024x1536
    python make_posters.py --textless   # 글자 없는 배경 → ../odyssey-poster-react/bg/
                                        # (글자는 React 레이어가 그린다)

키는 레포 루트 .env 의 FAL_KEY (환경변수가 있으면 그쪽이 우선).
"""
import argparse
import base64
import io
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests
from PIL import Image

for s in (sys.stdout, sys.stderr):
    s.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
STILLS = HERE.parent / "odyssey-images" / "stills"
OUT = HERE / "posters"
BG_OUT = HERE.parent / "odyssey-poster-react" / "bg"
MODEL = "openai/gpt-image-2/edit"


def load_key():
    if os.environ.get("FAL_KEY"):
        return os.environ["FAL_KEY"].strip()
    env = HERE.parents[1] / ".env"
    for line in env.read_text(encoding="utf-8").splitlines():
        if line.startswith("FAL_KEY="):
            return line.split("=", 1)[1].strip()
    sys.exit("FAL_KEY 가 없습니다 (.env 또는 환경변수)")


COMMON = """\
Create an original theatrical one-sheet movie poster (vertical 2:3) for Christopher Nolan's
epic film "The Odyssey" (2026), shot entirely on IMAX 70mm film, for the KOREAN release.

The attached images are frames from the film itself. Use them as the reference for the
actors' faces and likenesses, costumes, props, ships, locations, lighting, color grading and
film grain — keep everything consistent with them. Build a NEW poster composition; do not
simply crop or repeat one still. Photoreal, cinematic, rich 70mm film grain, no painterly or
CGI illustration look, no frames or borders.

Korean typography, all text sharp, correctly spelled and legible (Hangul exactly as given):
- Main title, large: "오디세이" — bold, classical, chiseled serif Hangul letterforms with a subtle
  bronze/stone texture. A small spaced Roman-capital line "THE ODYSSEY" sits just above it.
- Tagline, small, near the top: "신에 맞서다"
- Near the bottom: "크리스토퍼 놀란 감독 작품" and below it "8월 5일 대개봉"
- Very small at the very bottom: "IMAX 70MM 필름 촬영"
No other text at all: no credits block, no actor names, no studio or rating logos, no watermark.
"""

# --textless: 글자 없는 배경. 제목·태그라인·크레딧은 웹(React 레이어)에서 얹는다.
TEXTLESS = """\
Create the BACKGROUND ART for an original theatrical one-sheet movie poster (vertical 2:3) for
Christopher Nolan's epic film "The Odyssey" (2026), shot entirely on IMAX 70mm film.

The attached images are frames from the film itself. Use them as the reference for the
actors' faces and likenesses, costumes, props, ships, locations, lighting, color grading and
film grain — keep everything consistent with them. Build a NEW poster composition; do not
simply crop or repeat one still. Photoreal, cinematic, rich 70mm film grain, no painterly or
CGI illustration look, no frames or borders.

ABSOLUTELY NO TEXT: no letters, words, numbers, title, logos, symbols or watermark anywhere —
typography will be added later by a designer.
Layout for that typography: keep the top 14% of the frame calm and simple (sky, haze or shadow)
and the bottom 32% darker, calm and low in detail (sea, sand or shadow) with the scene fading
gently into it. The main subjects live between roughly 12% and 68% of the height, centred.
"""

CONCEPTS = {
    "A": {
        "name": "귀향",
        "slug": "homecoming",
        "refs": ["31-odysseus-red-light", "32-odysseus-closeup", "33-odysseus-shouting-ship",
                 "60-red-sail-ship", "61-whirlpool"],
        "scene": """\
Concept "The way home". The upper two-thirds: an immense close-up of Odysseus (the bearded,
weathered man from the first three stills — his face must clearly be the same actor: same
nose, eyes, brow and face shape; middle-aged, dark-brown hair with grey streaks, grey-flecked
beard, not an elderly man) in three-quarter profile,
gazing toward a distant horizon, lit by a low warm red-gold sunset from one side, the other side
falling into deep blue shadow. His shoulders and beard dissolve seamlessly into a dark,
wine-dark open sea. The lower third: seen from high above, a tiny ship with a red square sail
cutting toward a vast spiralling whirlpool in the deep blue sea; the spiral is huge compared to
the ship. Palette: deep ocean blues against ember red and gold.""",
        "type": 'The title "오디세이" sits over the calm sea between the face and the whirlpool.',
    },
    "B": {
        "name": "목마",
        "slug": "horse",
        "refs": ["19-horse-in-waves", "21-horse-silhouette-backlit", "14-beach-horse-army",
                 "15-beach-white-horse-rider", "18-horse-in-sea"],
        "scene": """\
Concept "The horse". A colossal dark bronze horse statue (exactly the ribbed, archaic horse from
the stills) rears up out of crashing white surf, its head reaching toward the top of the poster,
strongly backlit by a low sun burning through sea mist so its silhouette glows at the edges.
Far below at the bottom, on wet reflective sand, hundreds of tiny ancient soldiers strain on long
ropes to haul it ashore, and a lone rider on a white horse stands in front of them — the human
figures are minuscule, selling the monumental scale. Palette: hazy amber, gold and sepia with
dark bronze.""",
        "type": "Leave calm misty sky at the top for the tagline and the lower sand area for the\n"
                "title and credits.",
    },
    "C": {
        "name": "이타카",
        "slug": "ithaca",
        "refs": ["49-penelope-bow", "48-penelope-closeup", "45-telemachus-sea",
                 "55-cliff-fortress", "62-ship-storm"],
        "scene": """\
Concept "Ithaca waits". Center: Penelope (the dark-haired woman with the high braided updo, gold
collar and deep blue gown from the stills), waist-up, facing the viewer with a resolute stare,
holding the great curved horn bow horizontally across her body, lit by warm palace firelight.
Over her shoulder, slightly behind and smaller, the young man Telemachus (curly dark hair, dark
cloak) looks out toward the sea. Above them, fading into the sky: the stone fortress of Ithaca
on its high white limestone cliff under a heavy storm sky. At the bottom, a dark oared war ship
fights a stormy, deep-teal sea. Palette: firelit gold and amber against deep teal and slate
blue.""",
    },
    "D": {
        "name": "앙상블",
        "slug": "ensemble",
        "refs": ["27-odysseus-red-smoke", "48-penelope-closeup", "45-telemachus-sea",
                 "51-antinous-pattinson", "41-odysseus-woman-white-hood", "60-red-sail-ship",
                 "61-whirlpool"],
        "scene": """\
Concept "Epic ensemble". A classic stacked blockbuster character composition. Top and largest:
Odysseus facing the viewer in his bronze helmet with the red crest, beard, sword lowered, amid
red smoke and drifting embers. Below him, flanking: Penelope (braided updo, blue gown) on the
left; the curly-haired young Telemachus on the right; lower, half in shadow, the scheming suitor
Antinous (slicked-back hair, gold-trimmed armour) on the left and the young woman in the white
hood on the right. All faces must match the actors in the stills. The bottom of the poster: the
small red-sailed ship on a dark sea skirting an enormous whirlpool. Embers and sea spray tie the
layers together. Palette: ember red and gold over deep ocean blue.
Odysseus holds his sword in his own hand, clearly attached to his arm — no floating weapons.""",
        "type": "Leave clear dark sky above the helmet crest for the tagline so it overlaps nothing,\n"
                'and set "THE ODYSSEY" and the title over open sea, never across a face or armour.',
    },
}


def data_uri(name, long_edge=1536):
    im = Image.open(STILLS / f"{name}.jpg").convert("RGB")
    im.thumbnail((long_edge, long_edge))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=88)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def run(cid, key, quality, size, tag, textless):
    c = CONCEPTS[cid]
    w, h = (int(v) for v in size.split("x"))
    if textless:
        prompt, out, stem = TEXTLESS + "\n" + c["scene"], BG_OUT, f"{cid}-{c['slug']}{tag}"
    else:
        prompt = COMMON + "\n" + c["scene"] + "\n" + c.get("type", "")
        out, stem = OUT, f"{cid}-{c['name']}{tag}"
    body = {
        "prompt": prompt,
        "image_urls": [data_uri(r) for r in c["refs"]],
        "image_size": {"width": w, "height": h},
        "quality": quality,
        "num_images": 1,
        "output_format": "png",
    }
    hdr = {"Authorization": f"Key {key}", "Content-Type": "application/json"}
    for attempt in range(1, 4):
        try:
            r = requests.post(f"https://queue.fal.run/{MODEL}", headers=hdr, json=body, timeout=120)
            r.raise_for_status()
            job = r.json()
            t0 = time.time()
            while True:
                time.sleep(4)
                st = requests.get(job["status_url"], headers=hdr, timeout=60).json()
                if st.get("status") == "COMPLETED":
                    break
                if time.time() - t0 > 600:
                    raise TimeoutError("10분 초과")
            res = requests.get(job["response_url"], headers=hdr, timeout=60).json()
            if "images" not in res:
                raise RuntimeError(json.dumps(res, ensure_ascii=False)[:500])
            img = requests.get(res["images"][0]["url"], timeout=120).content
            (out / f"{stem}.png").write_bytes(img)
            (out / f"{stem}.json").write_text(json.dumps({
                "model": MODEL, "request_id": job.get("request_id"), "quality": quality,
                "size": size, "refs": [f"odyssey-images/stills/{r}.jpg" for r in c["refs"]],
                "prompt": body["prompt"], "seconds": round(time.time() - t0),
            }, ensure_ascii=False, indent=2), encoding="utf-8")
            return f"{stem}.png OK ({round(time.time() - t0)}s)"
        except Exception as e:  # noqa: BLE001
            print(f"[{cid}] 시도 {attempt} 실패: {e}", flush=True)
            time.sleep(5 * attempt)
    return f"{cid} 실패"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ids", nargs="*", default=list(CONCEPTS))
    ap.add_argument("--quality", default="high", choices=["low", "medium", "high", "auto"])
    ap.add_argument("--size", default="1024x1536")
    ap.add_argument("--tag", default="", help="파일명 뒤에 붙일 꼬리표 (예: --tag=-v2)")
    ap.add_argument("--textless", action="store_true", help="글자 없는 배경만 → odyssey-poster-react/bg/")
    a = ap.parse_args()
    (BG_OUT if a.textless else OUT).mkdir(parents=True, exist_ok=True)
    key = load_key()
    with ThreadPoolExecutor(max_workers=3) as ex:
        for msg in ex.map(lambda i: run(i, key, a.quality, a.size, a.tag, a.textless), a.ids):
            print(msg, flush=True)


if __name__ == "__main__":
    main()
