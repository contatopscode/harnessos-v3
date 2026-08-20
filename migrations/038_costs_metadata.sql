-- Migration 038: Add metadata column to remote_agent_costs.
--
-- Paulo: "tudo, absolutamente tudo tem que ser registrado". The
-- audit-trail sprint's chat persistence code (api-forge-chat.ts
-- persistAssistantTurn) tried to insert a JSONB metadata blob
-- (latency_ms, source, etc) on the cost row, but the original
-- migration 034 didn't define a metadata column on costs — only
-- model/provider/kind/tokens/amount. Migration 036 (audit trail)
-- added message_id and conversation_id but missed metadata.
--
-- The insert was failing silently (the chat endpoint swallows
-- persistence errors so the user still gets their reply), so no
-- cost row + no message activity was being created for every
-- chat call. Add the column to fix.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.
ALTER TABLE remote_agent_costs
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
