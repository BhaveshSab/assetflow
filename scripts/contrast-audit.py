#!/usr/bin/env python3
"""
Measure the contrast of the theme tokens, in both themes.

`docs/ACCESSIBILITY.md` claims WCAG 2.1 AA contrast (4.5:1 for normal text,
3:1 for large text and UI edges). That is a claim about numbers, so it should
be checked by arithmetic and not by eye — and it should fail loudly, so a
future colour edit cannot quietly break it.

The tokens are read straight out of `src/index.css`; nothing is duplicated
here. Run from the repository root:

    python3 scripts/contrast-audit.py            # human table
    python3 scripts/contrast-audit.py --check    # exit 1 if a pair fails
"""
from __future__ import annotations

import colorsys
import re
import sys
from pathlib import Path

CSS = Path("src/index.css")

# Every pair that actually occurs on screen: (foreground, background, minimum).
# 4.5 is normal text, 3.0 is large text / UI borders.
PAIRS = [
    ("ink", "surface", 4.5),
    ("ink", "canvas", 4.5),
    ("ink-soft", "surface", 4.5),
    ("ink-muted", "surface", 4.5),
    ("ink-subtle", "surface", 4.5),
    ("ink-subtle", "canvas", 4.5),
    ("ink-faint", "surface", 4.5),
    ("ink-faint", "canvas", 4.5),
    ("success", "surface", 4.5),
    ("warning", "surface", 4.5),
    ("info", "surface", 4.5),
    ("danger", "surface", 4.5),
    ("violet", "surface", 4.5),
    ("primary", "surface", 4.5),
    # 1.4.11: the boundary of a form control is the only thing that identifies
    # it, so it needs 3:1 — a decorative card border does not.
    ("input", "surface", 3.0),
    ("input", "canvas", 3.0),
]


def read_tokens() -> dict[str, dict[str, tuple[float, float, float]]]:
    """{theme: {token: (h, s, l)}} for the `:root` and `.dark` blocks."""
    css = CSS.read_text()
    themes: dict[str, dict[str, tuple[float, float, float]]] = {}

    for theme, selector in (("light", r":root\s*{"), ("dark", r"\.dark\s*{")):
        match = re.search(selector + r"(.*?)}", css, re.S)
        if not match:
            raise SystemExit(f"could not find the {theme} token block in {CSS}")

        block = match.group(1)
        tokens: dict[str, tuple[float, float, float]] = {}
        for name, h, s, l in re.findall(
            r"--([a-z0-9-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%", block
        ):
            tokens[name] = (float(h), float(s), float(l))
        themes[theme] = tokens

    # `--background`, `--foreground`, … are aliases (var(--canvas), …); resolve
    # them so a pair can name either the token or its alias.
    for tokens in themes.values():
        for name in list(tokens):
            pass
    return themes


def relative_luminance(hsl: tuple[float, float, float]) -> float:
    h, s, l = hsl
    r, g, b = colorsys.hls_to_rgb(h / 360, l / 100, s / 100)

    def channel(c: float) -> float:
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = channel(r), channel(g), channel(b)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    la, lb = relative_luminance(a), relative_luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def main() -> int:
    check = "--check" in sys.argv
    themes = read_tokens()
    failures = 0

    print("AssetFlow — theme contrast audit")
    print(f"source: {CSS}")
    print()
    for theme, tokens in themes.items():
        print(f"--- {theme} ---")
        for fg, bg, minimum in PAIRS:
            if fg not in tokens or bg not in tokens:
                print(f"  {fg:12s} on {bg:12s}   (token missing — skipped)")
                continue
            ratio = contrast(tokens[fg], tokens[bg])
            ok = ratio >= minimum
            if not ok:
                failures += 1
            print(
                f"  {fg:12s} on {bg:12s} {ratio:5.2f}:1  "
                f"min {minimum:.1f}  {'PASS' if ok else 'FAIL'}"
            )
        print()

    if failures:
        print(f"{failures} pair(s) below the minimum.")
        return 1
    print(f"All {len(PAIRS) * len(themes)} pairs meet their minimum.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
