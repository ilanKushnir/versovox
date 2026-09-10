# TandemLeaf style lock

Mood: elegant / literary-calm (generated seed 47, elegant mood, then brand-adjusted: paper neutrals kept, primary swapped to leaf green, bronze retained as the audio-secondary accent). All values re-validated with check_contrast --matrix.

## Color contract

### Light (default)

| role                    | value   |
| ----------------------- | ------- |
| text                    | #1F2620 |
| bg                      | #FAF6EF |
| surface                 | #F1EBE1 |
| primary (leaf)          | #2F5D48 |
| accent (bronze / audio) | #8C6A40 |
| border                  | #E2DACC |
| on-primary              | #FFFFFF |

Text-safe (>=4.5): text/on-primary, text/bg, text/surface, text/border, primary/on-primary, bg/primary, surface/primary, primary/border, accent/on-primary, bg/accent.
UI-safe (>=3.0): surface/accent, accent/border, text/accent.
Everything else decorative only.

### Dark (night)

| role                             | value   |
| -------------------------------- | ------- |
| text                             | #EDE7DA |
| bg                               | #101412 |
| surface                          | #1A201B |
| primary (leaf fill)              | #3E7258 |
| accent (light leaf, interactive) | #93C7AA |
| border                           | #2A322C |
| on-primary                       | #FFFFFF |

Text-safe: bg/on-primary, surface/on-primary, text/bg, text/surface, border/on-primary, text/border, bg/accent, surface/accent, accent/border, primary/on-primary, text/primary.
UI-safe: bg/primary.
Dark rule: interactive text/icons use accent; primary is a fill with on-primary labels; never accent-on-primary.

## Typography

- Reading: Literata (variable, OFL, bundled) — also the display face for headings/wordmark.
- UI: system font stack (-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif) for native standalone-PWA feel.
- Reader font choices offered to users: Literata, system serif (Iowan Old Style/Georgia), system sans.

## Density & spacing

4px base scale: 4/8/12/16/24/32/48/64. Cards >= 16px internal padding; inter-group gap >= 2x intra-group. Radius: 10px cards, 8px controls, 999px pills. Shadows: two soft layered neutrals max, no colored glows.

## Motion

Purposeful only: page-turn slide (reader), sheet slide-up, chrome fade. 150–260ms, ease-out. Full prefers-reduced-motion support (no movement, opacity only). No scroll-storytelling — this is an app shell product.

## Assets

- Logo: original geometric mark (two leaves forming an open book), drawn in-house SVG, primary green on paper.
- Icons: single hand-drawn stroke set (1.5px stroke, 24px grid) kept in web/src/components/icons.tsx — no emoji-as-icons.
- Covers for sample books: generated typographic covers (SVG), no external imagery.
- Illustration/photography: none — app product; empty states use the icon set + copy.

## App states

Every surface designs: loading (skeleton), empty, error, offline; controls have hover/focus-visible/active/disabled.
