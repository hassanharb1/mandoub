-- SalesGo by MESTK — cloud accounts and sync on Cloudflare D1
-- Create once:  npx wrangler d1 execute salesgo --remote --file worker/schema.sql
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  pass       TEXT NOT NULL,              -- pbkdf2$<iterations>$<salt b64>$<hash b64>
  name       TEXT,
  seq        INTEGER NOT NULL DEFAULT 0, -- bumped on every write; rows carry it so phones pull "after N"
  fails      INTEGER NOT NULL DEFAULT 0, -- wrong passwords in a row
  lock_until INTEGER NOT NULL DEFAULT 0,
  off        INTEGER NOT NULL DEFAULT 0, -- 1 = account stopped
  created    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,           -- sha-256 of the token; the token itself only lives on the phone
  user_id    TEXT NOT NULL,
  created    INTEGER NOT NULL,
  seen       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
CREATE TABLE IF NOT EXISTS records (
  user_id TEXT NOT NULL,
  kind    TEXT NOT NULL,                 -- customers | orders | payments | handovers | adjusts | requests | settings | cat | meta | img
  id      TEXT NOT NULL,
  data    TEXT,                          -- the record as JSON (null once deleted)
  deleted INTEGER NOT NULL DEFAULT 0,
  rev     INTEGER NOT NULL,              -- when the phone changed it (ms): the newest change wins
  sv      INTEGER NOT NULL,              -- users.seq at the time it was written
  PRIMARY KEY (user_id, kind, id)
);
CREATE INDEX IF NOT EXISTS records_pull ON records (user_id, sv);
-- one row per account opened from the app, to cap sign-ups per address per day
CREATE TABLE IF NOT EXISTS signups (
  ip TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS signups_ip ON signups (ip, at);
