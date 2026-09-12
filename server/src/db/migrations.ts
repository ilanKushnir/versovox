/**
 * Ordered schema migrations. Each entry runs once inside a transaction;
 * applied versions are recorded in schema_migrations. Never edit an entry
 * after release — append a new one.
 */
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hmac TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE books (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('ebook','audio')),
  root_dir TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  format TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT,
  series TEXT,
  series_idx REAL,
  language TEXT,
  identifiers_json TEXT NOT NULL DEFAULT '{}',
  duration_ms INTEGER,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  scan_state TEXT NOT NULL DEFAULT 'discovered',
  scan_error TEXT,
  scanned_at TEXT,
  cover_path TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}',
  added_at TEXT NOT NULL,
  UNIQUE (kind, root_dir, rel_path)
);

CREATE TABLE audio_tracks (
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  rel_path TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  format TEXT NOT NULL,
  title TEXT,
  start_ms_absolute INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (book_id, idx)
);

CREATE TABLE chapters (
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  title TEXT NOT NULL,
  spine_idx INTEGER,
  href TEXT,
  start_ms INTEGER,
  end_ms INTEGER,
  PRIMARY KEY (book_id, idx)
);

CREATE TABLE pairs (
  id TEXT PRIMARY KEY,
  ebook_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  audio_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('candidate','auto','confirmed','rejected')),
  score REAL NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  compat_json TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  UNIQUE (ebook_id, audio_id)
);

CREATE TABLE alignments (
  id TEXT PRIMARY KEY,
  pair_id TEXT NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  language TEXT NOT NULL,
  model TEXT NOT NULL,
  coverage REAL NOT NULL,
  mean_confidence REAL NOT NULL,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  gaps_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE (pair_id, version)
);

CREATE TABLE alignment_segments (
  alignment_id TEXT NOT NULL REFERENCES alignments(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  sentence_id TEXT NOT NULL,
  spine_idx INTEGER NOT NULL,
  sentence_ord INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  confidence REAL NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (alignment_id, ord)
);
CREATE INDEX idx_alignseg_sentence ON alignment_segments(alignment_id, sentence_id);
CREATE INDEX idx_alignseg_time ON alignment_segments(alignment_id, start_ms);

CREATE TABLE progress_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  session_uuid TEXT NOT NULL,
  seq INTEGER NOT NULL,
  intent TEXT NOT NULL,
  medium TEXT NOT NULL,
  locator_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0,
  reject_reason TEXT,
  UNIQUE (user_id, event_id)
);
CREATE INDEX idx_progress_events_book ON progress_events(user_id, book_id, received_at);

CREATE TABLE progress_state (
  user_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  locator_json TEXT NOT NULL,
  intent TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  session_uuid TEXT NOT NULL,
  device_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  finished INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, book_id)
);

CREATE TABLE annotations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('bookmark','highlight','note')),
  locator_json TEXT NOT NULL,
  end_locator_json TEXT,
  color TEXT,
  selected_text TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_annotations_book ON annotations(user_id, book_id);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT,
  state TEXT NOT NULL DEFAULT 'queued',
  progress REAL NOT NULL DEFAULT 0,
  detail TEXT,
  checkpoint_json TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  heartbeat_at TEXT
);
CREATE INDEX idx_jobs_state ON jobs(state, priority DESC, created_at);
CREATE UNIQUE INDEX idx_jobs_dedupe ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL AND state IN ('queued','running');

`,
  },
  {
    version: 2,
    sql: `
-- Renewable job leases: writes to a running job are conditional on holding
-- the current lease token, so a reclaimed job's old worker cannot corrupt it.
ALTER TABLE jobs ADD COLUMN lease_token TEXT;
ALTER TABLE jobs ADD COLUMN lease_expires_at TEXT;

-- Progress hardening: server-clamped effective time + the client's declared
-- base revision (causal ordering). occurred_at stays as raw client metadata.
ALTER TABLE progress_events ADD COLUMN effective_at TEXT;
ALTER TABLE progress_events ADD COLUMN base_revision INTEGER;

-- Durable login throttling (per account and per trusted IP), shared across
-- processes and restarts.
CREATE TABLE login_throttle (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL
);
`,
  },
  {
    version: 3,
    sql: `
-- Crash-safe re-indexing: derived reading indexes are immutable versioned
-- directories (derived/<bookId>/v-<jobId>); this pointer names the active
-- one and is switched in a single atomic UPDATE. NULL = legacy unversioned
-- layout directly under derived/<bookId>.
ALTER TABLE books ADD COLUMN derived_rev TEXT;
`,
  },
  {
    version: 4,
    sql: `
-- Per-pair narration language override (user-set) and the language that was
-- actually used/detected by the last alignment, so the speech model can be
-- chosen per language and "model missing" errors name the right one.
ALTER TABLE pairs ADD COLUMN language TEXT;
ALTER TABLE pairs ADD COLUMN detected_language TEXT;
`,
  },
  {
    version: 5,
    sql: `
-- People: display names, disable-without-delete, who added them, last sign-in.
ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN created_by TEXT;
ALTER TABLE users ADD COLUMN last_login_at TEXT;
-- Roles are now admin / curator / reader; the old catch-all 'user' reads only.
UPDATE users SET role = 'reader' WHERE role NOT IN ('admin', 'curator', 'reader');

-- Invitations: a one-time link creates an account with a preset role. Only
-- a hash of the token is stored, so a leaked database cannot mint accounts.
CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  display_name TEXT,
  username TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT
);
`,
  },
  {
    version: 6,
    sql: `
-- How far a segment's start may be wrong, in milliseconds, as the aligner
-- itself judged it. Sparse alignment interpolates between acoustic anchors,
-- so a timing is only as good as its distance to the nearest one, and the
-- read-to-listen handoff subtracts this so it lands on narration already
-- read instead of ahead of the reader. 0 = the engine offered no estimate.
ALTER TABLE alignment_segments ADD COLUMN uncertainty_ms INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    version: 7,
    sql: `
-- Speech recognition is gone: one model aligns every book, so the settings
-- that chose between engines, providers and per-language models have nothing
-- left to choose. Fold the survivors forward rather than silently resetting an
-- existing server to the defaults.
INSERT OR REPLACE INTO settings (key, value_json, updated_at)
  SELECT 'autoAlign', CASE WHEN value_json = '"manual"' THEN 'false' ELSE 'true' END,
         updated_at FROM settings WHERE key = 'processingMode';
UPDATE settings SET value_json = '"exact"'
  WHERE key = 'alignPrecision' AND value_json = '"thorough"';
UPDATE settings SET value_json = '"standard"'
  WHERE key = 'alignPrecision' AND value_json IN ('"fast"', '"careful"');
DELETE FROM settings WHERE key IN (
  'processingMode', 'transcribeProvider', 'whisperBin', 'whisperModel',
  'languageModels', 'autoDownloadDefaultModel', 'alignEngine', 'storageBudgetMb',
  'autoPairThreshold',
  -- Measured against a different method; the next alignment measures again.
  'transcribeSpeedRatio'
);
DROP TABLE IF EXISTS transcripts;

-- Portable alignments. A book's identity has to survive a rebuild, a move to
-- another host and a retagging pass, so it is derived from content rather than
-- from a path: the ebook from its own sentence ids (which are already content
-- hashes), the audiobook from the shape of its timeline. Both are filled in by
-- the indexing jobs; NULL means the book has not been re-indexed yet.
ALTER TABLE books ADD COLUMN text_fingerprint TEXT;
ALTER TABLE books ADD COLUMN audio_timeline_fingerprint TEXT;
`,
  },
];
