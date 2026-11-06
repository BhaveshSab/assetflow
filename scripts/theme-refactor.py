#!/usr/bin/env python3
"""
One-off refactor: the hard-coded dark palette → theme tokens.

The interface was built against a single dark palette (zinc/gray utilities and
five navy hexes). That makes a second theme impossible: `bg-zinc-950` can only
ever be near-black. This script rewrites those literals to the semantic tokens
declared in `src/index.css` + `tailwind.config.ts`, where the same class renders
a light value under `:root` and a dark value under `.dark`.

Rules, in order (order matters — the text-white check looks for the *token*
backgrounds, so the hue rewrite runs first):

  1. arbitrary hex classes   bg-[#1a1d2e]  -> bg-surface
  2. hue families            text-emerald-400 -> text-success
  3. neutral families        text-zinc-500 -> text-ink-subtle
  4. text-white              -> text-ink, unless the string paints a solid
                                status background behind it
  5. chart hexes             fill="#3b82f6" -> fill="hsl(var(--chart-1))"

Run from the repository root. Idempotent: a second run changes nothing.
"""
import re
import sys
from pathlib import Path

SRC = Path("src")
FILES = sorted([*SRC.rglob("*.tsx"), *SRC.rglob("*.ts")])
# A self-contained decorative panel: a purple gradient hero with white cards.
# It is designed to look the same in both themes, so it keeps its literals.
SKIP = {"src/index.css", "src/components/ui/auth-switch.tsx"}

counts: dict[str, int] = {}


def bump(key: str, n: int = 1) -> None:
    counts[key] = counts.get(key, 0) + n


# ── 1. the five navy hexes, as arbitrary-value classes ───────────────────────
HEX_CLASSES = {
    "#0f111a": {"bg": "canvas"},
    "#0a0c14": {"bg": "canvas"},
    "#161925": {"bg": "surface-2"},
    "#1a1d2e": {"bg": "surface"},
    "#1e2235": {"bg": "surface-3", "divide": "line"},
    "#22253a": {"bg": "surface-3"},
    "#2a2d3e": {"border": "line", "divide": "line"},
    "#3a3d4e": {"border": "line", "bg": "surface-3"},
}
HEX_RE = re.compile(
    r"(?P<prefix>(?:[a-z-]+:)*)(?P<util>bg|border|divide|text|ring|fill|stroke)-\[(?P<hex>#[0-9a-fA-F]{6})\]"
)

# ── 2./3. the colour families ────────────────────────────────────────────────
HUE_TOKENS = {
    "emerald": "success",
    "green": "success",
    "teal": "success",
    "amber": "warning",
    "yellow": "warning",
    "orange": "warning",
    "blue": "info",
    "sky": "info",
    "indigo": "info",
    "red": "danger",
    "rose": "danger",
    "purple": "violet",
    "violet": "violet",
    "fuchsia": "violet",
    "pink": "violet",
}

NEUTRAL_TOKENS = {
    # utility → {shade: token}
    "text": {
        50: "ink",
        100: "ink",
        200: "ink",
        300: "ink-soft",
        400: "ink-muted",
        500: "ink-subtle",
        600: "ink-faint",
        700: "ink",
        800: "ink",
        900: "ink",
        950: "ink",
    },
    "bg": {
        50: "surface-2",
        100: "surface-2",
        200: "surface-3",
        300: "surface-3",
        400: "ink-subtle",
        500: "ink-subtle",
        600: "line-strong",
        700: "surface-3",
        800: "surface-3",
        900: "canvas",
        950: "canvas",
    },
    "border": {
        50: "line",
        100: "line",
        200: "line",
        300: "line-strong",
        400: "line-strong",
        500: "line-strong",
        600: "line-strong",
        700: "line",
        800: "line",
        900: "line",
        950: "line",
    },
    "divide": {
        500: "line-strong",
        600: "line-strong",
        700: "line",
        800: "line",
        900: "line",
    },
    "ring": {300: "line-strong", 400: "line-strong", 500: "line-strong", 600: "line-strong", 700: "line-strong", 800: "line"},
    "ring-offset": {900: "canvas", 950: "canvas"},
    "fill": {400: "ink-muted", 500: "ink-subtle", 600: "ink-faint", 700: "ink"},
    "stroke": {400: "ink-muted", 500: "ink-subtle", 600: "ink-faint", 700: "ink"},
    "from": {700: "surface-3", 800: "surface-3", 900: "surface", 950: "canvas"},
    "via": {700: "surface-3", 800: "surface-3", 900: "surface", 950: "canvas"},
    "to": {700: "surface-3", 800: "surface-3", 900: "surface", 950: "canvas"},
    "placeholder": {400: "ink-muted", 500: "ink-subtle", 600: "ink-faint"},
    "decoration": {400: "ink-muted", 500: "ink-subtle"},
    "outline": {500: "line-strong", 600: "line-strong", 700: "line"},
}

FAMILY_RE = re.compile(
    r"(?P<prefix>(?:[a-z-]+:)*)"
    r"(?P<util>placeholder|ring-offset|ring|text|bg|border|divide|fill|stroke|from|via|to|decoration|outline)"
    r"-(?P<fam>zinc|gray|slate|neutral|stone|"
    r"emerald|green|teal|amber|yellow|orange|blue|sky|indigo|red|rose|purple|violet|fuchsia|pink)"
    r"-(?P<shade>\d{2,3})"
    r"(?P<alpha>/\d{1,3})?"
)

# ── 5. the chart colours Recharts is handed as literals ──────────────────────
CHART_LITERALS = {
    '"#1e2235"': '"hsl(var(--chart-grid))"',
    '"#2a2d3e"': '"hsl(var(--chart-grid))"',
    '"#6b7280"': '"hsl(var(--chart-tick))"',
    '"#9ca3af"': '"hsl(var(--chart-tick))"',
    '"#3b82f6"': '"hsl(var(--chart-1))"',
    '"#60a5fa"': '"hsl(var(--chart-2))"',
    '"#10b981"': '"hsl(var(--chart-3))"',
    '"#d1d5db"': '"hsl(var(--ink-soft))"',
}

# A string that paints a solid status background keeps its white text.
SOLID_BG_RE = re.compile(
    r"\bbg-(?:info|success|danger|warning|violet|primary|destructive)\b(?![/\d])"
)


def rewrite_hex_classes(text: str) -> str:
    def repl(m: re.Match) -> str:
        hex_ = m.group("hex").lower()
        util = m.group("util")
        mapped = HEX_CLASSES.get(hex_, {}).get(util)
        if not mapped:
            return m.group(0)
        bump(f"hex {util}-[{hex_}] -> {util}-{mapped}")
        return f"{m.group('prefix')}{util}-{mapped}"

    return HEX_RE.sub(repl, text)


def rewrite_families(text: str) -> str:
    def repl(m: re.Match) -> str:
        prefix, util, fam, shade, alpha = (
            m.group("prefix"),
            m.group("util"),
            m.group("fam"),
            int(m.group("shade")),
            m.group("alpha") or "",
        )
        if fam in HUE_TOKENS:
            token = HUE_TOKENS[fam]
            # A deep shade (900/950) or a pale one (50/100/200) is used as a
            # *tint* — an error banner's background, not a solid fill. The
            # token is a single colour, so the tint is expressed as alpha and
            # the theme decides which way it mixes.
            if util == "bg" and (shade >= 800 or shade <= 200):
                pct = int(alpha[1:]) if alpha else 100
                tint = max(4, round(pct / 4))
                bump(f"hue tint {util}-{fam}-{shade}{alpha} -> {util}-{token}/{tint}")
                return f"{prefix}{util}-{token}/{tint}"
            bump(f"hue {util}-{fam}-{shade} -> {util}-{token}")
            return f"{prefix}{util}-{token}{alpha}"
        table = NEUTRAL_TOKENS.get(util)
        if not table or shade not in table:
            return m.group(0)
        token = table[shade]
        bump(f"neutral {util}-{fam}-{shade} -> {util}-{token}")
        return f"{prefix}{util}-{token}{alpha}"

    return FAMILY_RE.sub(repl, text)


STRING_RE = re.compile(r'"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`')


def rewrite_white_text(text: str) -> str:
    """`text-white` becomes `text-ink`, except on a solid status background."""

    def repl(m: re.Match) -> str:
        s = m.group(0)
        if "text-white" not in s:
            return s
        if SOLID_BG_RE.search(s):
            bump("text-white kept (solid status background)")
            return s
        replaced = re.sub(r"\btext-white\b", "text-ink", s)
        bump("text-white -> text-ink")
        return replaced

    return STRING_RE.sub(repl, text)


def rewrite_chart_literals(text: str) -> str:
    for old, new in CHART_LITERALS.items():
        if old in text:
            n = text.count(old)
            text = text.replace(old, new)
            bump(f"chart {old} -> {new}", n)
    return text


def main() -> int:
    changed = []
    for path in FILES:
        if str(path) in SKIP or path.as_posix() in SKIP:
            continue
        original = path.read_text()
        text = original
        text = rewrite_hex_classes(text)
        text = rewrite_families(text)
        text = rewrite_chart_literals(text)
        text = rewrite_white_text(text)
        if text != original:
            path.write_text(text)
            changed.append(str(path))

    print(f"files rewritten: {len(changed)}")
    for key, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"  {n:5d}  {key}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
