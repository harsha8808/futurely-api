-- ============================================================
--  Futurely — D1 Database Schema
--  Run with: wrangler d1 execute futurely-db --file=schema.sql
-- ============================================================

-- Users
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  email      TEXT UNIQUE NOT NULL,
  name       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  plan       TEXT NOT NULL DEFAULT 'free'   -- free | plus | vault
);

-- Letters
CREATE TABLE IF NOT EXISTS letters (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft',  -- draft | sealed | delivered

  -- Content
  salutation      TEXT,
  body            TEXT NOT NULL,
  sign_off        TEXT,

  -- Styling
  font_family     TEXT    DEFAULT 'EB Garamond, serif',
  font_size       INTEGER DEFAULT 16,
  paper_style     TEXT    DEFAULT 'lined',   -- lined | plain | aged | ivory

  -- Delivery
  delivery_channel   TEXT NOT NULL DEFAULT 'email',  -- email | telegram
  recipient_name     TEXT,
  recipient_email    TEXT,   -- required when channel = email
  recipient_telegram TEXT,   -- required when channel = telegram (@username or chat_id)
  deliver_on         TEXT NOT NULL,  -- ISO date YYYY-MM-DD

  -- Timestamps
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  sealed_at    TEXT,
  delivered_at TEXT,

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Waitlist
CREATE TABLE IF NOT EXISTS waitlist (
  id        TEXT PRIMARY KEY,
  email     TEXT UNIQUE NOT NULL,
  name      TEXT,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  notified  INTEGER NOT NULL DEFAULT 0
);

-- Delivery log
CREATE TABLE IF NOT EXISTS delivery_log (
  id           TEXT PRIMARY KEY,
  letter_id    TEXT NOT NULL,
  channel      TEXT,            -- email | telegram
  attempted_at TEXT NOT NULL DEFAULT (datetime('now')),
  success      INTEGER NOT NULL DEFAULT 0,
  error_msg    TEXT,
  FOREIGN KEY (letter_id) REFERENCES letters(id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_letters_user    ON letters(user_id);
CREATE INDEX IF NOT EXISTS idx_letters_status  ON letters(status);
CREATE INDEX IF NOT EXISTS idx_letters_deliver ON letters(deliver_on);
CREATE INDEX IF NOT EXISTS idx_letters_due     ON letters(status, deliver_on) WHERE status = 'sealed';
