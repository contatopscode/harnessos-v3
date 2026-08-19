-- Migration 034: VOLUND FORGE — costs (LLM usage tracking)
--
-- One row per LLM call. Captures tokens + cost so the dashboards
-- can show TOTAL USD / TOTAL BR$ / RUNS / TOKENS and the breakdown
-- by project / pipeline / model.
--
-- The actual capture happens in packages/core/src/db/costs.ts
-- (the `recordCost` helper), called from the orchestrator / chat
-- loops. Each call writes one row with:
--   - run_id (FK to remote_agent_workflow_runs, NULL if ad-hoc)
--   - demand_id (FK to remote_agent_demands, NULL if pre-demand)
--   - codebase_id (FK to remote_agent_codebases, NULL otherwise)
--   - model, provider, kind (chat / completion / embedding / tool)
--   - tokens_in, tokens_out
--   - amount_usd (computed from model pricing)
--   - amount_brl (computed at write time from a fixed USD/BRL rate
--     recorded on the row; the conversion is informational — real
--     billing happens in USD)
--
-- Cost aggregation queries are in api-forge-costs.ts. We use a
-- partial index on (created_at DESC) so the dashboard's "last 30
-- days" query stays fast as the table grows.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS remote_agent_costs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES remote_agent_workflow_runs(id) ON DELETE SET NULL,
  demand_id UUID REFERENCES remote_agent_demands(id) ON DELETE SET NULL,
  codebase_id UUID REFERENCES remote_agent_codebases(id) ON DELETE SET NULL,
  model VARCHAR(128) NOT NULL,
  provider VARCHAR(64) NOT NULL,
  kind VARCHAR(32) NOT NULL DEFAULT 'chat' CHECK (kind IN (
    'chat', 'completion', 'embedding', 'tool', 'image'
  )),
  tokens_in INTEGER NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
  tokens_out INTEGER NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
  amount_usd NUMERIC(10, 6) NOT NULL DEFAULT 0 CHECK (amount_usd >= 0),
  usd_brl_rate NUMERIC(10, 4) NOT NULL DEFAULT 5.0,
  amount_brl NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (amount_brl >= 0),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_costs_created_at ON remote_agent_costs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_costs_run_id ON remote_agent_costs(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_costs_demand_id ON remote_agent_costs(demand_id) WHERE demand_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_costs_codebase_id ON remote_agent_costs(codebase_id) WHERE codebase_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_costs_model ON remote_agent_costs(model);
