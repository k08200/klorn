#!/usr/bin/env python3
"""Generate bilingual caption strips + title/end cards for the demo/promo build.

Outputs PNGs into ./assets/. Korean text renders via Apple SD Gothic Neo
(present on macOS); Latin via Helvetica. Run once before build-finals.py.
"""

import os

from PIL import Image, ImageDraw, ImageFont

W, H = 1600, 1000
BG = (15, 17, 21, 255)
AMBER = (252, 211, 77, 255)
WHITE = (245, 245, 244, 255)
GREY = (168, 162, 158, 255)

OUT = os.path.join(os.path.dirname(__file__), "assets")
os.makedirs(OUT, exist_ok=True)


def font(sz, bold=False, ko=False):
    path = (
        "/System/Library/Fonts/AppleSDGothicNeo.ttc"
        if ko
        else "/System/Library/Fonts/Helvetica.ttc"
    )
    try:
        return ImageFont.truetype(path, sz, index=1 if bold else 0)
    except OSError:
        return ImageFont.truetype(path, sz)


def strip(name, txt, ko=False, big=False):
    f = font(40 if big else 30, bold=True, ko=ko)
    tmp = ImageDraw.Draw(Image.new("RGBA", (10, 10)))
    w = tmp.textlength(txt, font=f)
    a, d = f.getmetrics()
    wb, hb = int(w) + 70, a + d + 38
    img = Image.new("RGBA", (wb, hb), (0, 0, 0, 0))
    dr = ImageDraw.Draw(img)
    dr.rounded_rectangle([0, 0, wb - 1, hb - 1], radius=14, fill=(10, 10, 10, 190))
    dr.text((35, 19), txt, font=f, fill=WHITE)
    img.save(os.path.join(OUT, f"s_{name}.png"))


def card(name, lines, ko=False):
    img = Image.new("RGBA", (W, H), BG)
    d = ImageDraw.Draw(img)
    metrics = [font(sz, bo, ko).getmetrics() for _, sz, _, bo in lines]
    total = sum(a + de + 28 for a, de in metrics) - 28
    y = (H - total) // 2
    for (txt, sz, col, bo), (a, de) in zip(lines, metrics):
        f = font(sz, bo, ko)
        w = d.textlength(txt, font=f)
        d.text(((W - w) / 2, y), txt, font=f, fill=col)
        y += a + de + 28
    img.convert("RGB").save(os.path.join(OUT, f"c_{name}.png"))


DEMO = {
    "en": [
        ("login", "Sign in — Klorn connects your Gmail and Calendar"),
        ("firewall", "The firewall sorts every email: PUSH / QUEUE / SILENT / AUTO"),
        ("mail_list", "One list across your inboxes — with AI summaries"),
        ("judgment", "Every message gets a judgment: summary, key points, action items"),
        ("draft", "Klorn drafts the reply — you edit and approve"),
        ("send", "Sent from your own account, only after approval"),
        ("calendar", "Calendar with meeting prep, next to your mail"),
        ("new_event", "Create events in one click — synced to Google Calendar"),
        ("settings", "You stay in control — disconnect anytime"),
    ],
    "ko": [
        ("login", "로그인 — Klorn이 Gmail과 캘린더를 연결합니다"),
        ("firewall", "방화벽이 모든 메일을 분류합니다: PUSH / QUEUE / SILENT / AUTO"),
        ("mail_list", "여러 인박스를 하나의 리스트로 — AI 요약과 함께"),
        ("judgment", "모든 메일에 판정: 요약 · 핵심 포인트 · 액션 아이템"),
        ("draft", "답장은 Klorn이 초안 — 수정과 승인은 당신이"),
        ("send", "승인 후에만, 당신의 계정에서 발송됩니다"),
        ("calendar", "메일 옆에서 미팅 준비까지 — 캘린더"),
        ("new_event", "클릭 한 번으로 일정 생성 — Google 캘린더에 동기화"),
        ("settings", "통제권은 언제나 당신에게 — 언제든 연결 해제"),
    ],
}

PROMO = {
    "en": [
        ("p1", "Every email sorted — PUSH / QUEUE / SILENT / AUTO"),
        ("p2", "AI judgment on every message"),
        ("p3", "Drafts replies. You approve."),
        ("p4", "Meetings + calendar, from your mail"),
    ],
    "ko": [
        ("p1", "모든 메일을 4단계로 분류 — PUSH / QUEUE / SILENT / AUTO"),
        ("p2", "모든 메일에 AI 판정"),
        ("p3", "답장은 AI가 초안, 승인은 당신이"),
        ("p4", "메일에서 미팅·캘린더까지"),
    ],
}

for lang, items in DEMO.items():
    for n, t in items:
        strip(f"{lang}_{n}", t, ko=(lang == "ko"))
for lang, items in PROMO.items():
    for n, t in items:
        strip(f"p{lang}_{n}", t, ko=(lang == "ko"), big=True)

card(
    "title_en",
    [
        ("Klorn", 150, WHITE, True),
        ("The AI email firewall", 56, AMBER, False),
        ("Only what matters interrupts you.", 36, GREY, False),
    ],
)
card(
    "end_en",
    [
        ("Only what matters", 84, WHITE, True),
        ("interrupts you.", 84, WHITE, True),
        ("app.klorn.ai", 54, AMBER, False),
    ],
)
card(
    "title_ko",
    [
        ("Klorn", 150, WHITE, True),
        ("AI 이메일 방화벽", 56, AMBER, True),
        ("중요한 것만 당신을 부릅니다.", 36, GREY, False),
    ],
    ko=True,
)
card(
    "end_ko",
    [
        ("중요한 것만", 84, WHITE, True),
        ("당신을 부릅니다.", 84, WHITE, True),
        ("app.klorn.ai", 54, AMBER, False),
    ],
    ko=True,
)
print(f"assets written to {OUT}")
