-- Migration 035: VOLUND FORGE — demand ↔ pipeline links
--
-- A demand can be linked to one or more HarnessOS workflow
-- pipelines. When a pipeline run is created from a demand, the
-- link is inserted here; the kanban UI uses the link list to
-- render the pipeline chips under the demand card.
--
-- The relationship is m:n (a pipeline can serve multiple demands
-- if it's a reusable workflow like `fsw` or `vigília`).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS remote_agent_demand_pipeline_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  demand_id UUID NOT NULL REFERENCES remote_agent_demands(id) ON DELETE CASCADE,
  pipeline VARCHAR(255) NOT NULL,
  pipeline_version VARCHAR(32),
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE (demand_id, pipeline, pipeline_version)
);

CREATE INDEX IF NOT EXISTS idx_demand_pipeline_links_demand
  ON remote_agent_demand_pipeline_links(demand_id);
CREATE INDEX IF NOT EXISTS idx_demand_pipeline_links_pipeline
  ON remote_agent_demand_pipeline_links(pipeline);
