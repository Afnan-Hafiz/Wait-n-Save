-- Migration 002: Add password reset token columns to users
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS reset_token        TEXT,
  ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_reset_token ON users (reset_token)
  WHERE reset_token IS NOT NULL;
