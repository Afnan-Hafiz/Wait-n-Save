-- ============================================================
--  Wait-n-Save · Initial Database Migration
--  Run once: psql $DATABASE_URL -f 001_init.sql
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── users ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email               TEXT        UNIQUE NOT NULL,
  password_hash       TEXT        NOT NULL,
  reset_token         TEXT,
  reset_token_expires TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_reset_token ON users(reset_token);

-- ── tracked_items ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tracked_items (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- URL fields
  product_url           TEXT          NOT NULL,
  -- Canonical key: UTM params stripped, variant params kept
  product_key           TEXT          NOT NULL,
  -- JSON blob of variant state e.g. {"color":"red","size":"M"}
  variant_hint          JSONB,

  -- Product metadata captured at star time
  title                 TEXT,
  image_url             TEXT,
  -- Currency and geo as seen in the user's browser
  currency              TEXT          NOT NULL DEFAULT 'USD',
  geo_hint              TEXT,

  -- Price tracking
  original_price        NUMERIC(12,2) NOT NULL,
  current_price         NUMERIC(12,2),
  lowest_price          NUMERIC(12,2),
  -- Dedup: last price we actually sent a notification for
  last_notified_price   NUMERIC(12,2),

  -- Health / operational state
  last_checked_at       TIMESTAMPTZ,
  consecutive_fails     SMALLINT      NOT NULL DEFAULT 0,
  -- 'ok' | 'bot_blocked' | 'delisted' | 'parse_error' | 'login_gated' | 'currency_mismatch'
  fetch_status          TEXT          NOT NULL DEFAULT 'ok',
  is_active             BOOLEAN       NOT NULL DEFAULT TRUE,

  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),

  -- Cross-device dedup: same user + canonical URL = one row
  UNIQUE(user_id, product_key)
);

CREATE INDEX IF NOT EXISTS idx_tracked_items_user     ON tracked_items(user_id);
CREATE INDEX IF NOT EXISTS idx_tracked_items_active   ON tracked_items(is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_tracked_items_checked  ON tracked_items(last_checked_at);

-- ── price_history ────────────────────────────────────────────
-- Written on EVERY check cycle (even failed ones), so gaps are visible.
CREATE TABLE IF NOT EXISTS price_history (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id          UUID          NOT NULL REFERENCES tracked_items(id) ON DELETE CASCADE,
  -- NULL means extraction failed this cycle
  price            NUMERIC(12,2),
  currency         TEXT,
  -- Raw badge text from page e.g. "Clearance", "Black Friday Deal"
  sale_badge       TEXT,
  -- Retailer's own strikethrough price (displayed in email but NOT used as baseline)
  retailer_original_price NUMERIC(12,2),
  fetch_status     TEXT          NOT NULL DEFAULT 'ok',
  -- Short HTML excerpt for debugging selector failures
  raw_html_snippet TEXT,
  checked_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_price_history_item_checked
  ON price_history(item_id, checked_at DESC);

-- ── notifications_sent ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications_sent (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id     UUID          NOT NULL REFERENCES tracked_items(id) ON DELETE CASCADE,
  sent_price  NUMERIC(12,2),
  -- 'price_drop' | 'clearance' | 'seasonal' | 'delisted' | 'extraction_failure'
  event_type  TEXT          NOT NULL,
  sent_at     TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notif_item_sent
  ON notifications_sent(item_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_user_sent
  ON notifications_sent(user_id, sent_at DESC);
