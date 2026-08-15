-- Memory system (Path B — Memory + RAG)
-- Append-only store of facts the agent should remember across sessions.
-- Searchable via SQLite FTS5 (bundled in bun:sqlite, zero new infra).
--
-- Scope model:
--   'user'         — applies to the user globally (scope_id NULL in single-user)
--   'agent'        — applies when this agent persona is active (scope_id = slug)
--   'project'      — applies to one codebase (scope_id = codebase id)
--   'conversation' — scoped to one chat (scope_id = conversation id)
--
-- A memory can match multiple scopes (e.g. a project fact is also relevant
-- when the user chats about that project from any conversation). The recall
-- layer queries each scope and unions the top-N results — see
-- `packages/core/src/db/memories.ts`.

CREATE TABLE IF NOT EXISTS remote_agent_memories (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  scope VARCHAR(16) NOT NULL CHECK (scope IN ('user', 'agent', 'project', 'conversation')),
  scope_id TEXT,
  kind VARCHAR(32) NOT NULL CHECK (kind IN ('preference', 'fact', 'project_context', 'feedback', 'note')),
  content TEXT NOT NULL,
  source VARCHAR(16) NOT NULL DEFAULT 'manual' CHECK (source IN ('chat', 'manual', 'imported')),
  confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_memories_scope ON remote_agent_memories(scope, scope_id);
CREATE INDEX IF NOT EXISTS idx_memories_kind ON remote_agent_memories(kind);
CREATE INDEX IF NOT EXISTS idx_memories_created_at ON remote_agent_memories(created_at DESC);

-- Full-text search via SQLite FTS5. The base table holds the canonical row;
-- this virtual table mirrors `content` for ranked matching. We keep them in
-- sync with explicit triggers (the external-content table mode) so any
-- INSERT / UPDATE / DELETE on the base table flows to the index.
--
-- Tokenizer: porter — handles English stemming. PT-BR isn't natively
-- stemmed by porter but the Unicode61 fallback (lowercase + diacritics
-- stripped via `categories 'L* N* Co'`) is good enough for our phrases
-- ("prefiro X", "sempre uso Y", "meu setup é Z"). Stemming quality is
-- acceptable for MVP; we can swap in a PT-BR stemmer later without
-- touching the schema.
CREATE VIRTUAL TABLE IF NOT EXISTS remote_agent_memories_fts USING fts5(
  content,
  content='remote_agent_memories',
  content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 2'
);

-- Triggers: keep the FTS index in sync with the base table.
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON remote_agent_memories BEGIN
  INSERT INTO remote_agent_memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON remote_agent_memories BEGIN
  INSERT INTO remote_agent_memories_fts(remote_agent_memories_fts, rowid, content)
    VALUES('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON remote_agent_memories BEGIN
  INSERT INTO remote_agent_memories_fts(remote_agent_memories_fts, rowid, content)
    VALUES('delete', old.rowid, old.content);
  INSERT INTO remote_agent_memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;

COMMENT ON TABLE remote_agent_memories IS
  'Cross-session memory store. Each row is a fact the orchestrator can recall when relevant. scope determines when the memory applies; kind categorizes it for UI filtering. Append-only: use deleteMemory to forget, never UPDATE content (use add + delete if you need to change).';
