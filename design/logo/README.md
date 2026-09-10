# Logo

The Versovox mark was generated with OpenAI's image API
(`gpt-image-2.5-sunburst`) via `scripts/generate-logo-openai.mjs`, which
writes one candidate per concept. Three were produced:

| File                | Concept                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| `book-wave.png`     | **Chosen.** An open book: the left page carries lines of text, the right page rises into a sound wave. |
| `spine-wave.png`    | A closed book whose spine becomes a waveform.                                                          |
| `bookmark-wave.png` | A rounded tile holding a book and a ribbon that turns into a waveform.                                 |

`book-wave.png` was then traced by hand into a single-colour vector so the
mark stays crisp at 20px and inherits `currentColor` in both themes. The
vector lives in three places and they must stay in step:

- `web/src/components/icons.tsx` — `VersoMark`, used throughout the UI
- `web/public/icons/favicon.svg` — browser tab
- `scripts/generate-icons.mjs` — the artwork for the PWA/App icon PNGs
  (`node scripts/generate-icons.mjs` regenerates `web/public/icons/*.png`)

To try new concepts: `OPENAI_API_KEY=… node scripts/generate-logo-openai.mjs`
(`VX_LOGO_CONCEPT` renders just one, `VX_IMAGE_MODEL` pins a model).
