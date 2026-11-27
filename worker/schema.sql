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
-- the link the rep gives his colleague (/z/<token>); one per account, the token itself only in the link
CREATE TABLE IF NOT EXISTS links (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS links_user ON links (user_id);
-- push notifications: each phone's subscription, and each account's reminder plan (items with due times) and what was sent when
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  user_id  TEXT NOT NULL,
  p256dh   TEXT NOT NULL,
  auth     TEXT NOT NULL,
  created  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_subs_user ON push_subs (user_id);
CREATE TABLE IF NOT EXISTS push_plan (
  user_id  TEXT PRIMARY KEY,
  items    TEXT NOT NULL,             -- [{k, t, due}]
  sent     TEXT NOT NULL DEFAULT '{}',-- {"k|t": when pushed}
  next_due INTEGER NOT NULL,          -- the cron looks at this account again from then
  updated  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_plan_due ON push_plan (next_due);
-- the recovery code for a forgotten password (no email): one per account, hash only, replaced every time it is used or remade
CREATE TABLE IF NOT EXISTS recovery (
  user_id TEXT PRIMARY KEY,
  hash    TEXT NOT NULL,
  created INTEGER NOT NULL
);
-- what broke on the phones (POST /api/err): one row per error + version, with a count; kept 60 days
CREATE TABLE IF NOT EXISTS errors (
  key     TEXT PRIMARY KEY,   -- sha-256 of message|file|line|version
  first   INTEGER NOT NULL,
  last    INTEGER NOT NULL,
  count   INTEGER NOT NULL,
  user_id TEXT,               -- when the phone was signed in
  ver     INTEGER, view TEXT, kind TEXT, msg TEXT, src TEXT, line INTEGER, col INTEGER, stack TEXT, ua TEXT
);
CREATE INDEX IF NOT EXISTS errors_last ON errors (last);
CREATE TABLE IF NOT EXISTS err_ips (
  ip  TEXT NOT NULL,
  day INTEGER NOT NULL,
  n   INTEGER NOT NULL,
  PRIMARY KEY (ip, day)
);
