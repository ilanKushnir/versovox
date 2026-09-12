# Logo

The ReadPort mark is a bookmark ribbon with a play triangle knocked out of it:
the two halves of the app in one shape. The cream half is the page, the amber
half is the narration, and the triangle is a hole rather than a shape on top,
so the mark works in one colour on any ground.

## The source of truth

[`mark.mjs`](mark.mjs) holds the geometry — two path strings built from named
numbers, not a trace of a bitmap. Everything else is generated from it:

```bash
node scripts/generate-icons.mjs
```

That writes, and these files should not be hand-edited:

| Output                           | What it is                                   |
| -------------------------------- | -------------------------------------------- |
| `readport-mark.svg`              | The mono mark, for READMEs and release posts |
| `readport-tile.svg`              | The mark on its rounded ink tile             |
| `web/public/icons/favicon.svg`   | Browser tab                                  |
| `web/public/icons/icon-*.png`    | PWA icons, plain and maskable                |
| `web/public/icons/apple-touch-…` | iOS home screen                              |

Rasterizing uses whichever Chrome or Chromium is already installed; set
`CHROME=/path/to/chrome` if it lives somewhere unusual.

The one copy that is not generated is `ReadPortMark` in
[`web/src/components/icons.tsx`](../../web/src/components/icons.tsx), which
carries the same two paths inline so the React component has no build step.
`icons.test.tsx` fails if that copy drifts from `mark.mjs`.

## Colours

| Token | Hex       | Where                                   |
| ----- | --------- | --------------------------------------- |
| Cream | `#F4EFE3` | Leading half of the ribbon              |
| Amber | `#F5B31E` | Trailing half                           |
| Ink   | `#16120F` | The tile, and the app's dark background |

In the UI the mark is drawn in a single `currentColor`, so it takes the ember
copper of the light theme and the lighter ember of the dark one.
