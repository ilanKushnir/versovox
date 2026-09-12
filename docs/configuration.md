# Configuration

## Precedence

1. **Environment variables** (`VX_*`) — pin values in Compose; the settings
   they pin are shown read-only ("env") in the admin UI.
2. **In-app admin settings** — stored in the database, editable in
   Settings; only for keys not pinned by env.
3. **Built-in defaults.**

Every `VX_*` variable also accepts a `VX_*_FILE` variant whose value is a
path to a file containing the value (Docker secrets friendly), e.g.
`VX_SESSION_SECRET_FILE=/run/secrets/vx_session_secret`.

`.env.example` is an annotated copy of everything below, and is what the
bundled `docker-compose.yml` reads.

## Variables

| Variable                   | Default                            | Description                                                                                                                                                                                             |
| -------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VX_PORT`                  | `8383`                             | HTTP port.                                                                                                                                                                                              |
| `VX_HOST`                  | `127.0.0.1` (image sets `0.0.0.0`) | Bind address.                                                                                                                                                                                           |
| `VX_DATA_DIR`              | `./data` (image: `/data`)          | SQLite, derived ebook indexes, reading progress, and the fallback alignment folder. Local disk only — never SMB/NFS.                                                                                    |
| `VX_CACHE_DIR`             | `./cache` (image: `/cache`)        | Cover images. Reproducible: safe to delete.                                                                                                                                                             |
| `VX_MODELS_DIR`            | `./models` (image: `/models`)      | The alignment model, in `mms-fa/` (317 MB, one download for every language). Reproducible: safe to delete and fetch again.                                                                              |
| `VX_EBOOK_DIRS`            | —                                  | Comma-separated ebook roots, up to 16, mounted `:ro`. Optional: when unset, the setup wizard / Settings → Libraries store the roots in the database.                                                    |
| `VX_AUDIOBOOK_DIRS`        | —                                  | Comma-separated audiobook roots, as above.                                                                                                                                                              |
| `VX_ALIGNMENT_DIRS`        | —                                  | Comma-separated folders that finished alignments are written into — the only library folders Versovox writes to, so no `:ro`. Unset means `<data>/alignments`. See below.                               |
| `VX_SESSION_SECRET`        | auto-generated                     | HMAC key for session tokens. Set explicitly in production; rotating it signs everyone out. If unset, one is generated and persisted at `<data>/session-secret` (0600).                                  |
| `VX_SETUP_TOKEN`           | auto-generated                     | One-time first-run bootstrap token required to create the admin account. If unset, generated on first start, printed in the log, stored at `<data>/setup-token` (0600). Consumed when the admin exists. |
| `VX_TRUST_PROXY`           | `0`                                | Proxy trust for client IPs. `0` (default): forwarded headers ignored. `1`: trust local/private-network proxies. Otherwise: comma-separated proxy IPs/CIDRs.                                             |
| `VX_TRUST_HTTPS`           | `0`                                | Set `1` behind HTTPS: marks session cookies `Secure`.                                                                                                                                                   |
| `VX_SESSION_DAYS`          | `30`                               | Session lifetime, 1–365.                                                                                                                                                                                |
| `VX_INLINE_WORKER`         | `1`                                | Run background jobs in the web process. Set `0` when using the dedicated worker container.                                                                                                              |
| `VX_JOB_CONCURRENCY`       | `2`                                | Simultaneous **alignments** (1–8). Two more slots are always free: one for the model download, one for scans/indexing/pairing, so a long alignment never blocks the library. See below.                 |
| `VX_ALIGN_THREADS`         | `4`                                | Threads **one** alignment may give the model (1–32). Should track the container's CPU allowance, not the host's core count. See below.                                                                  |
| `VX_DEFAULT_LANGUAGE`      | `en`                               | BCP-47 language of last resort, used when nothing about a book says what it is in.                                                                                                                      |
| `VX_SCAN_INTERVAL_MINUTES` | `60`                               | Minutes between automatic library rescans so titles added in Calibre/Audiobookshelf appear on their own; `0` disables (manual/API rescans only). Maximum a week.                                        |
| `VX_PROXY_AUTH_HEADER`     | —                                  | Reverse-proxy SSO: header carrying the signed-in username (e.g. `x-authentik-username`). Empty = disabled. See docs/security.md.                                                                        |
| `VX_PROXY_AUTH_SOURCES`    | —                                  | Comma-separated proxy IPs/CIDRs whose header is trusted (checked on the TCP peer). Required for proxy SSO.                                                                                              |
| `VX_PROXY_AUTH_ADMINS`     | —                                  | Comma-separated usernames (as sent by the proxy) that get the admin role. On an empty instance the first proxied user is admin regardless.                                                              |
| `VX_LOG_LEVEL`             | `info`                             | fatal/error/warn/info/debug/trace.                                                                                                                                                                      |
| `PUID` / `PGID` / `TZ`     | `1000`/`1000`/`Etc/UTC`            | Container user mapping and timezone (entrypoint).                                                                                                                                                       |

There is deliberately no variable for how closely the aligner listens or for
whether it starts on its own. Those two decide what the server does with the
next book rather than how it boots, and changing your mind about them should
not cost a container restart, so they live in the database only.

## In-app settings

Seven keys, the whole of `settingsSchema`. `GET /api/settings` returns them
with the list of those an environment variable has pinned; `PUT` writes the
rest, admin only.

| Setting           | Default    | Set in                               | Pinned by             |
| ----------------- | ---------- | ------------------------------------ | --------------------- |
| `defaultLanguage` | `en`       | Settings → Alignment → Language      | `VX_DEFAULT_LANGUAGE` |
| `ebookDirs`       | none       | Settings → Libraries, and the wizard | `VX_EBOOK_DIRS`       |
| `audiobookDirs`   | none       | Settings → Libraries, and the wizard | `VX_AUDIOBOOK_DIRS`   |
| `alignmentDirs`   | none       | Settings → Libraries, and the wizard | `VX_ALIGNMENT_DIRS`   |
| `alignPrecision`  | `standard` | Settings → Alignment                 | —                     |
| `autoAlign`       | `true`     | Settings → Alignment, and the wizard | —                     |
| `alignSpeedRatio` | `0`        | nowhere — the worker measures it     | —                     |

`alignSpeedRatio` is how many seconds of audio this machine aligns per second
of wall clock, and it is the only setting nobody is meant to touch: the Pairing
page's time estimates come from what the worker actually did on this hardware
rather than from a number someone guessed. A run wildly unlike the stored
average replaces it outright instead of being blended in, so changing precision
does not leave every estimate wrong for the next several books.

### The fallback language

`defaultLanguage` is the last of five answers, not the first. An alignment asks,
in order: a language set on the pair itself, the EPUB's `dc:language`, the
audiobook's tags, the ebook's own prose, and only then this setting. Reading it
from the prose needs no model — a non-Latin script settles Cyrillic, Hebrew,
Arabic or Greek outright, and a few dozen function words separate the Latin
languages, which barely share them — and it abstains rather than guess when the
evidence is thin.

Getting it wrong is cheap by design. The language decides only how numbers,
currency and abbreviations are spelled out for matching; transliteration is
keyed on the characters themselves. A Russian book aligned as English still
matches its Cyrillic, and loses anchors around numbers and nowhere else. A
single book can always be overridden on the Pairing page.

### Where alignments are written

An alignment is hours of CPU, and until it is written down it lives only in the
container's database, where a from-scratch redeploy throws it away.
`VX_ALIGNMENT_DIRS` (or Settings → Libraries) points at a folder in your own
library, mounted read-write, and every finished alignment is saved there as one
gzipped `.vxalign` file. A fresh install scans that folder and imports whatever
it recognises, so a rebuilt container is immediately as capable as the one it
replaced.

Files are matched to books by fingerprint — of the ebook's sentence ids and of
the audiobook's track durations — never by path or filename, none of which
survive a reinstall. That is also why nothing is ever imported halfway: a file
either describes a pair on this server or it does not.

Leaving it unset is supported and is not the recommendation: alignments then go
to `<data>/alignments`, which survives a restart but not a rebuild that discards
the volume. The one setup mistake worth watching for is the opposite of the
usual one — every other library line in the stock Compose file ends in `:ro`,
and copying that pattern here gives you a folder Versovox cannot write to. The
folder tester in the wizard and in Settings catches it by actually writing a
probe file, because a bind mount can report friendly permission bits and still
refuse.

### How much of the machine an alignment may use

Two numbers multiply, and only their product matters to the CPU allowance:

- `VX_JOB_CONCURRENCY` is how many books may be aligned at the same time. The
  worker runs three lanes — this many heavy slots, one slot for the model
  download, one for everything light (scans, indexing, pairing) — so an
  alignment that runs for half an hour cannot stop a new book appearing in the
  library. The worker reads it from the environment at startup and from
  nowhere else: it is in `settingsSchema` because the settings page reports it,
  not because it can be set there, and a value written through the API is
  stored and then ignored. Set it in Compose.
- `VX_ALIGN_THREADS` is how many threads each of those alignments gives the
  model. Past the container's CPU allowance the model gets slower rather than
  faster, so this should track the allowance and not the host's core count.

The published timings were measured with four threads on a six-CPU container.
If you would rather one book finished sooner than two books finished together,
lower the concurrency rather than raising the threads.

### How closely it listens

`alignPrecision` is the one knob with a real cost attached.

| `alignPrecision`     | What goes through the model                                                                             | Cost                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `standard` (default) | A short probe every 150 seconds, plus refinement passes over the stretches where the timing looks wrong | About six minutes for a six-hour audiobook |
| `exact`              | Every sample                                                                                            | Roughly fifteen times that                 |

Sampling works because narration is close to a constant rate over a couple of
minutes: the aligner does not need to hear a book to time it, only to find
enough places where the audio and the text provably agree that everything
between them can be interpolated. Where that assumption breaks — a chapter
break, a pause at a heading, a passage the narration skips, a producer's credit
— the implied reading rate goes visibly wrong, and the refinement rounds spend
their probes there and leave the steady parts alone.

What `standard` costs you is certainty about the last few seconds. Switching
from reading to listening deliberately lands _behind_ where you were by
however far the aligner says its own timing could be off, a median of about
7.6 seconds, because hearing a sentence twice is free and hearing one you have
not read yet is a spoiler. Going the other way needs no such margin.
`exact` is worth its fifteenfold bill only if you follow the narration word by
word on the page. Full measurements are in docs/alignment.md.

### When it runs

`autoAlign` (on by default) lets a library scan start an alignment without
being asked: a strong metadata match queues one at low priority, behind
anything else waiting. Metadata alone never links two editions — the alignment
_is_ the edition check, and a pair whose narration does not match the text is
handed back undecided rather than aligned wrongly — so leaving this on is how
most libraries sort themselves out overnight.

Turn it off and nothing is computed until you press Start on the Pairing page,
individually, over a multi-select, or with "Start all". Either way, a scan first
queues an import from the alignment folder, ahead of the alignments it just
queued, so a redeploy restores rather than recomputes.

### What is deliberately not a setting

The confidence at which two files are taken to be the same work without asking
is fixed at 0.92 (`AUTO_PAIR_THRESHOLD` in `server/src/domain/settings.ts`).
Nobody can pick a better number for their library than that one without data
they do not have, and the alignment behind it is the real check anyway.

## First run

With no accounts yet, the app shows a four-step wizard: welcome (bootstrap
token) → admin account → books → ready.

The books step asks for all three folder kinds at once — ebooks, audiobooks,
and the alignment folder — plus the language most of your books are in. Each
folder is tested where the server sees it: existence, readability, a shallow
count of the matching files, and, for the alignment folder, whether a file can
actually be created in it. A picker lists what the container has mounted, read
from the kernel rather than guessed, so the paths offered are the ones that can
possibly work. Folders pinned by `VX_EBOOK_DIRS`, `VX_AUDIOBOOK_DIRS` or
`VX_ALIGNMENT_DIRS` are shown read-only.

The ready step reviews all of that, offers the alignment model download and the
"align new matches automatically" switch, and runs the readiness report from
`POST /api/preflight` — ffmpeg, the ONNX runtime, the model, free disk,
writable folders, library folders. Finishing does not advance to another
screen: it turns into the live progress of the first scan and, if you asked for
it, of the download. Everything chosen there is editable later under Settings.

An admin who skipped the folders, or who never had any, sees the same flow
later without its first two steps.
