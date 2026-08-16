-- Migration 026: persistent auth invite allowlist
--
-- Why: ARCHON_AUTH_ALLOWED_EMAILS only reads from process.env, which
-- means every new invite requires an Easypanel env-var update + a
-- container restart. That's hostile to the team-use case (admin
-- wants to invite a teammate without an ops round-trip).
--
-- This table is the durable side of the allowlist. Emails in
-- `accepted_at IS NOT NULL` are treated as allowlist members for
-- the lifetime of the row. Rows with `accepted_at IS NULL` and
-- `expires_at > now()` are PENDING invites: a signup attempt with
-- that email will be accepted (the invite itself gets `accepted_at`
-- stamped). The env var continues to be respected as a static
-- baseline so the operator can pre-seed admins before any invites
-- are issued.
--
-- Idempotent: every CREATE uses IF NOT EXISTS so the bundled-schema
-- auto-apply on Postgres startup converges across restarts.
--
-- The token is what we put in the invite link. 32 bytes of randomness
-- in hex = 64 chars, same shape as Better Auth's own verification
-- tokens. Tokens are unique (UNIQUE constraint) so a single link
-- can't be reused after acceptance.

CREATE TABLE IF NOT EXISTS remote_agent_auth_invite (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL,
  role VARCHAR(16) NOT NULL DEFAULT 'member'
    CHECK (role IN ('admin', 'member')),
  token VARCHAR(128) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_by_user_id TEXT
    REFERENCES remote_agent_auth_user(id) ON DELETE SET NULL,
  created_by_user_id TEXT
    REFERENCES remote_agent_auth_user(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

-- Most common query: "is this email on the allowlist, either
-- pre-accepted or with a live pending invite?". Composite index on
-- (email) WHERE accepted_at IS NOT NULL OR (expires_at > now())
-- would need a partial-index per predicate, so we go with two
-- simpler indexes that the planner can combine as a BitmapOr.
CREATE INDEX IF NOT EXISTS idx_auth_invite_email
  ON remote_agent_auth_invite(email);
CREATE INDEX IF NOT EXISTS idx_auth_invite_token
  ON remote_agent_auth_invite(token)
  WHERE accepted_at IS NULL;
