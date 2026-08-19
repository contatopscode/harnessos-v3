-- Migration 030: VOLUND FORGE — clients table
--
-- A client is the top-level entity in the PMO surface (Projeto → Demanda →
-- OS). Each codebase in the existing schema can be linked to a client
-- via `remote_agent_codebases.client_id` (added in 031).
--
-- Slugs are stable identifiers; the backfill adds a single default
-- client ("default") so the new column FK doesn't fail for existing
-- codebases. Operators can rename / split later.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + INSERT ... ON CONFLICT DO NOTHING
-- for the seed.

CREATE TABLE IF NOT EXISTS remote_agent_clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
  contact_email VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clients_status ON remote_agent_clients(status);
CREATE INDEX IF NOT EXISTS idx_clients_slug ON remote_agent_clients(slug);

-- Seed a default client so the FK on codebases doesn't fail for
-- pre-existing rows that have no client assignment yet.
INSERT INTO remote_agent_clients (slug, name, description)
VALUES ('default', 'Default', 'Catch-all client for codebases created before the PMO surface shipped.')
ON CONFLICT (slug) DO NOTHING;
