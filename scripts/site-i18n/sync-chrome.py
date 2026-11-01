#!/usr/bin/env python3
"""Sync the language chrome of every translated marketing page.

website/ has no build step: each page is a full static copy per language.
Translating the copy is per-page work, but the chrome that ties the copies
together must be identical everywhere and is mechanical, so it lives here:

  - <html lang>, canonical, og:url, og:locale
  - the hreflang set (7 languages + x-default)
  - the nav language menu (all 7, pointing at this page's counterparts)
  - the static nav links (mirrors site-nav.js)
  - internal links to localized pages point at the page's own locale
  - Korean pages load Pretendard (the only CJK webfont the site ships)

Idempotent. Run from the repo root:  python3 scripts/site-i18n/sync-chrome.py
The guard that enforces the result is .github/scripts/check-website-lockstep.sh.
"""

import re
import sys
from pathlib import Path

ROOT = Path("website")
ORIGIN = "https://klorn.ai"
LANGS = ["en", "ko", "ja", "zh", "es", "fr", "de"]
NATIVE = {
    "en": "English", "ko": "한국어", "ja": "日本語", "zh": "中文",
    "es": "Español", "fr": "Français", "de": "Deutsch",
}
OG_LOCALE = {
    "en": "en_US", "ko": "ko_KR", "ja": "ja_JP", "zh": "zh_CN",
    "es": "es_ES", "fr": "fr_FR", "de": "de_DE",
}
NAV_LABELS = {
    "en": ["Accounts", "Lanes", "Pricing", "Security", "Blog"],
    "ko": ["계정", "레인", "요금", "보안", "블로그"],
    "ja": ["アカウント", "レーン", "料金", "セキュリティ", "ブログ"],
    "zh": ["账户", "分类", "定价", "安全", "博客"],
    "es": ["Cuentas", "Carriles", "Precios", "Seguridad", "Blog"],
    "fr": ["Comptes", "Files", "Tarifs", "Sécurité", "Blog"],
    "de": ["Konten", "Spuren", "Preise", "Sicherheit", "Blog"],
}
# Keep in lockstep with LOCALIZED_SUBPAGES in check-website-lockstep.sh.
SUBPAGES = [
    "pricing", "security", "download", "methodology", "open-source",
    "self-host", "status", "gdpr", "dpa", "blog",
    "vs/fyxer", "vs/superhuman", "vs/sanebox", "vs/inbox-zero",
]
PRETENDARD = '<link rel="stylesheet" href="/fonts/pretendard/pretendard.css">'

SUB_RE = "|".join(re.escape(p) for p in sorted(SUBPAGES, key=len, reverse=True))
LINK_RE = re.compile(r'href="/(?:(?:en|ko|ja|zh|es|fr|de)/)?(' + SUB_RE + r')/(#[^"]*)?"')
HOME_RE = re.compile(r'href="/(?:(?:ko|ja|zh|es|fr|de)/)?(#[^"]*)?"')


def prefix(lang):
    return "/" if lang == "en" else f"/{lang}/"


def url(lang, page):
    return f"{prefix(lang)}{page + '/' if page else ''}"


def page_file(lang, page):
    rel = url(lang, page).strip("/")
    return ROOT / rel / "index.html" if rel else ROOT / "index.html"


def localize_links(html, lang):
    """Point <a href> at this locale's copies. <a lang="xx"> for another
    language and the landing's data-lang-pick switcher are exempt: they are
    deliberate links to another language (language menu, legal notice)."""
    pre = prefix(lang)

    def tag(m):
        a = m.group(0)
        if "data-lang-pick" in a or ('lang="' in a and 'lang="' + lang + '"' not in a):
            return a
        a = LINK_RE.sub(lambda l: f'href="{pre}{l.group(1)}/{l.group(2) or ""}"', a)
        a = HOME_RE.sub(lambda l: f'href="{pre}{l.group(1) or ""}"', a)
        return a

    return re.sub(r"<a\b[^>]*>", tag, html)


def hreflang_block(page):
    lines = [f'<link rel="alternate" hreflang="{l}" href="{ORIGIN}{url(l, page)}">' for l in LANGS]
    lines.append(f'<link rel="alternate" hreflang="x-default" href="{ORIGIN}{url("en", page)}">')
    return "\n".join(lines)


def lang_menu(lang, page):
    items = []
    for l in LANGS:
        cur = ' aria-current="true"' if l == lang else ""
        items.append(f'      <a href="{url(l, page)}" role="menuitem" lang="{l}"{cur}>{NATIVE[l]}</a>')
    return (
        '  <span class="nav-lang">\n'
        '    <button type="button" class="nav-lang-btn" data-menu-toggle\n'
        '            aria-haspopup="true" aria-expanded="false" aria-controls="lang-menu">'
        f'{NATIVE[lang]} <i aria-hidden="true">▾</i></button>\n'
        '    <span class="nav-lang-menu" id="lang-menu" role="menu">\n'
        + "\n".join(items) + "\n"
        "    </span>\n"
        "  </span>\n"
    )


def nav_links(lang, page):
    """Static copy of what site-nav.js renders, so the header works without JS."""
    home = prefix(lang)
    here = url(lang, page)
    hrefs = [home + "#accounts", home + "#lanes", home + "pricing/", home + "security/", home + "blog/"]
    out = []
    for href, label in zip(hrefs, NAV_LABELS[lang]):
        cur = ' aria-current="page"' if href == here else ""
        out.append(f'<a href="{href}"{cur}>{label}</a>')
    return "".join(out)


def sync_subpage(lang, page):
    path = page_file(lang, page)
    html = path.read_text(encoding="utf-8")
    full = ORIGIN + url(lang, page)

    html = re.sub(r'<html lang="[^"]*">', f'<html lang="{lang}">', html, count=1)
    html = re.sub(r'<link rel="canonical" href="[^"]*">', f'<link rel="canonical" href="{full}">', html, count=1)
    html = re.sub(r'<meta property="og:url" content="[^"]*">', f'<meta property="og:url" content="{full}">', html, count=1)
    html = re.sub(r'<meta property="og:locale" content="[^"]*">',
                  f'<meta property="og:locale" content="{OG_LOCALE[lang]}">', html, count=1)

    html = re.sub(r'<link rel="alternate" hreflang="[^"]*" href="[^"]*">\n', "", html)
    html = re.sub(r'(<link rel="canonical" href="[^"]*">\n)', lambda m: m.group(1) + hreflang_block(page) + "\n",
                  html, count=1)

    html = re.sub(r'  <span class="nav-lang">\n.*?\n    </span>\n  </span>\n', "", html, flags=re.S)
    html = re.sub(r'(<span class="nav-links"[^>]*data-site-nav>).*?(</span>\n)',
                  lambda m: m.group(1) + nav_links(lang, page) + m.group(2) + lang_menu(lang, page),
                  html, count=1, flags=re.S)

    html = localize_links(html, lang)

    if lang == "ko" and PRETENDARD not in html:
        html = html.replace('<link rel="icon"', PRETENDARD + '\n<link rel="icon"', 1)
    path.write_text(html, encoding="utf-8")


def sync_landing(lang):
    if lang == "en":
        return
    path = page_file(lang, "")
    html = path.read_text(encoding="utf-8")
    path.write_text(localize_links(html, lang), encoding="utf-8")


def main():
    missing = [str(page_file(l, p)) for p in SUBPAGES for l in LANGS if not page_file(l, p).exists()]
    if missing:
        print("missing translations:\n  " + "\n  ".join(missing), file=sys.stderr)
        if "--partial" not in sys.argv:
            sys.exit(1)
    for p in SUBPAGES:
        for l in LANGS:
            if page_file(l, p).exists():
                sync_subpage(l, p)
    for l in LANGS:
        sync_landing(l)
    print(f"synced {len(SUBPAGES)} subpages x {len(LANGS)} languages + landings")


if __name__ == "__main__":
    main()
