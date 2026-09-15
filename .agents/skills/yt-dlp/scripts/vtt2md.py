#!/usr/bin/env python3
"""WebVTT 자막 → 시간표시·태그·중복 제거한 문장 텍스트.
사용: vtt2md.py subs.ko.vtt > transcript.md
"""
import re, sys

src = open(sys.argv[1], encoding="utf-8").read().splitlines()
lines, prev = [], None
for raw in src:
    s = re.sub(r"<[^>]+>", "", raw).strip()          # <c>, <00:00:01.000> 태그 제거
    if not s or s.startswith(("WEBVTT", "Kind:", "Language:", "NOTE")):
        continue
    if "-->" in s or re.fullmatch(r"\d+", s):        # 시간줄 / 번호줄
        continue
    s = s.replace("&nbsp;", " ").replace("&amp;", "&")
    if s == prev:                                     # 자동자막의 굴러가는 중복줄
        continue
    lines.append(s)
    prev = s

print("\n".join(lines))
