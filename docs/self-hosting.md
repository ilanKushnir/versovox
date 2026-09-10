# Self-hosting TandemLeaf

TandemLeaf is a single Docker container (plus an optional worker) in front of
your existing libraries. Your library folders are mounted **read-only** and
are never modified; everything TandemLeaf creates lives in its own volumes.

## Quick start (Docker Compose)

```bash
git clone https://github.com/YOUR_ORG/tandemleaf && cd tandemleaf
cp .env.example .env
# Required: set a session secret
sed -i "s/^TL_SESSION_SECRET=.*/TL_SESSION_SECRET=$(openssl rand -hex 32)/" .env
# Point the library mounts in docker-compose.yml at your real folders
docker compose up -d --build
```

Open `http://<host>:8383`, create the admin account (there are **no default
credentials**), and the first library scan starts automatically.

The stock compose file mounts the bundled sample library (original stories
with synthetic narration) so you can try the reader, player, pairing, and
exact two-way switching immediately.

## Volumes

| Mount                 | Purpose                                                  | Notes                                                                                                 |
| --------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `/data`               | SQLite database, derived reading indexes, progress       | **Local disk only.** Never place it on SMB/NFS — SQLite in WAL mode is unsafe on network filesystems. |
| `/cache`              | Covers, transcripts, alignment work                      | Safe to delete; rebuilt on demand.                                                                    |
| `/models`             | Optional speech model packs (experimental transcription) | Empty unless you use `whisper-cli`.                                                                   |
| `/library/ebooks`     | Your ebook library                                       | `:ro` — read-only, required posture.                                                                  |
| `/library/audiobooks` | Your audiobook library                                   | `:ro`                                                                                                 |

Your libraries can be the folders already used by Calibre / Calibre-Web
Automated (`.../Calibre Library`), Kavita, Audiobookshelf
(`Author/Title/*.m4b|mp3`), Shelfmark output, or any plain folder tree.
TandemLeaf detects `.epub` files and `.m4b/.mp3/.m4a/.flac/.ogg/.opus` audio
(one directory per multi-file book).

## Users, PUID/PGID, timezone

The container starts as root only to align its user with `PUID`/`PGID`
(default `1000:1000`) and own its writable volumes, then drops privileges
with `gosu`. Set them to the host user that owns your data volume. `TZ`
sets the container timezone. No Docker socket is mounted, no privileged mode
is used, and `no-new-privileges` is enabled in the compose file.

## Reverse proxy and HTTPS (required for the PWA)

Installable PWAs and service workers require HTTPS (or `localhost`). Put any
TLS-terminating proxy in front and set `TL_TRUST_HTTPS=1` so session cookies
are marked `Secure`.

Caddy example:

```
books.example.com {
    reverse_proxy tandemleaf:8383
}
```

nginx: proxy `/` to `tandemleaf:8383` with `proxy_set_header Host $host;`
and websocket defaults are not needed (no websockets). Body size defaults are
fine — clients never upload media.

After that, iPhone Safari → Share → **Add to Home Screen** gives a
standalone, offline-capable app.

## Resource and concurrency controls

- `TL_JOB_CONCURRENCY` (default 2) bounds simultaneous background jobs.
- The compose file sets container memory limits; adjust to taste.
- Alignment/transcription is CPU-bound only if you enable the experimental
  `whisper-cli` provider; the default install does no heavy compute.
- For big libraries, run the dedicated worker:
  `docker compose --profile worker up -d` with `TL_INLINE_WORKER=0` on the
  web service. Both share `/data` (same host volume) safely.

## Backup and restore

Everything TandemLeaf owns is in the `/data` volume (the `/cache` and
`/models` volumes are reproducible).

```bash
# Backup (container can stay up; SQLite is WAL with a single writer host)
docker compose stop tandemleaf   # optional but recommended for a clean copy
docker run --rm -v tandemleaf_tl-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/tandemleaf-data-$(date +%F).tar.gz -C /data .
docker compose start tandemleaf

# Restore
docker compose down
docker run --rm -v tandemleaf_tl-data:/data -v "$PWD":/backup alpine \
  sh -c "rm -rf /data/* && tar xzf /backup/tandemleaf-data-YYYY-MM-DD.tar.gz -C /data"
docker compose up -d
```

Your libraries are read-only sources and are not part of TandemLeaf backups.

## Upgrades and migrations

```bash
git pull            # or: docker pull ghcr.io/OWNER/tandemleaf:latest
docker compose up -d --build
```

Database schema migrations run automatically at startup (append-only,
recorded in `schema_migrations`). Downgrades are not supported — restore the
`/data` backup taken before upgrading instead.

## Troubleshooting

| Symptom                                                   | Likely cause / fix                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Library is empty after setup                              | Check the `:ro` mounts exist inside the container (`docker compose exec tandemleaf ls /library/ebooks`) and rescan from Settings.                                                                                                                                                                                                                  |
| Books stuck in "Indexing…"                                | See Settings → Background activity for the job error; `docker compose logs tandemleaf`.                                                                                                                                                                                                                                                            |
| A book shows "Indexing failed"                            | The EPUB may be malformed or DRM-protected. TandemLeaf does not remove DRM.                                                                                                                                                                                                                                                                        |
| "Add to Home Screen" gives a browser shortcut, not an app | You are not on HTTPS. See the reverse-proxy section.                                                                                                                                                                                                                                                                                               |
| m4b won't play in Firefox/Chromium                        | AAC decoding is missing from some open-source browser builds. Chrome, Edge and Safari play m4b/m4a; mp3/flac/ogg play everywhere.                                                                                                                                                                                                                  |
| Progress didn't sync from my phone                        | It is queued locally (IndexedDB) and reconciles on the next reachable sync; nothing is lost.                                                                                                                                                                                                                                                       |
| Login says "Too many attempts"                            | Login rate limit (10 tries / 5 min per IP). Wait a few minutes.                                                                                                                                                                                                                                                                                    |
| Reset the admin password                                  | Stop the stack, delete the `users`/`sessions` rows: `docker compose run --rm tandemleaf node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/tandemleaf.db');d.exec('DELETE FROM sessions; DELETE FROM users;')"` — the next visit shows first-run setup again. Reading progress and pair decisions are preserved. |
