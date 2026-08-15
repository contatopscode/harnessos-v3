---
title: Memory
description: Persistent facts the orchestrator carries across sessions — search, route, and inject them automatically so the model "remembers" what you told it.
category: guides
area: orchestrator
audience: [user, developer]
status: current
sidebar:
  order: 10
---

Memory is the system that makes the orchestrator feel like it **remembers**.
Every chat turn can write a fact into the `remote_agent_memories` table; the
top-N relevant facts are then injected into the system prompt of every
follow-up turn via FTS5 recall. You can also browse, search, and edit
memories directly from the console (`m`).

Two ways to save a memory:

1. **Implicit (from the chat):** say "lembre que…" or "minha preferência é…"
   and the orchestrator persists the stripped text as a new row at the end
   of the turn. Best for ad-hoc facts while you work.
2. **Explicit (from the CLI or the console):** `archon memory add "…"` or
   the "Adicionar memória manualmente" form on `/console/memory`. Best for
   bulk import or one-off corrections.

Once saved, a memory can be recalled in any future turn within its scope —
no extra LLM call, no per-message cost.

## Quick Start

**Save a fact while chatting:**

```text
you:    lembre que esse projeto usa Bun como runtime e SQLite como database
you:    minha preferência é: nunca usar Anthropic SDK
you:    contexto do projeto: monorepo Turborepo, deploy via Easypanel
```

After each turn, the orchestrator runs `detectMemorySignal`, extracts the
text after the signal phrase, maps the kind from the prefix, and persists
it. Failures are logged but never break the chat.

**List, search, and forget from the CLI:**

```bash
# List all memories (user scope by default, latest first)
archon memory list

# Filter by scope/kind and free-text search
archon memory list --scope user --kind preference
archon memory list --search "postgres"

# FTS5 recall — the same query the orchestrator injects into the system prompt
archon memory search "setup do postgres local"

# Add a manual memory
archon memory add "default-cwd do projeto: ~/Documents/.../cortex" \
  --scope project --scope-id cortex --kind project_context --source manual

# Forget a memory by id (exit 2 if not found)
archon memory forget <id>
```

**Browse and edit from the console:**

Press `m` anywhere in the console to jump to `/console/memory`. The page
has three sections:

1. **Testar recall (FTS5)** — type a query and see the top-10 hits the
   orchestrator would inject, with `rank_confidence` (0-1, derived from
   bm25). Useful for tuning the signal phrases your team uses.
2. **Adicionar memória manualmente** — content + scope + kind, defaults
   to `user` + `note` + `manual`. Enter to submit.
3. **List with filters** — scope (Usuário / Agente / Projeto / Conversa)
   and kind (Nota / Preferência / Fato / Contexto do projeto / Feedback)
   chips, plus a free-text search across `content`. Each row has an
   "Esquecer" button with a confirm dialog.

## The 4 Scopes

| Scope | Resolves to | When to use |
|---|---|---|
| `user` | `scope_id = NULL` | A fact about the human (preferences, habits, your stack). Survives across projects and conversations. |
| `agent` | `scope_id = <agent-slug>` | Feedback for a specific persona (e.g. "test-writer should never use mocks"). Survives across projects. |
| `project` | `scope_id = <codebase-id>` | A fact about a specific project (its stack, its deploy target, its quirks). Survives across conversations. |
| `conversation` | `scope_id = <conversation-id>` | A fact that's only meaningful in the current thread. Auto-cleared when the conversation ends. |

The orchestrator's recall merges hits across **all four scopes** by
default. A `feedback` kind is auto-upgraded to `agent` scope (so it follows
the persona, not the human). A `project_context` kind is auto-upgraded to
`project` scope (so it follows the codebase, not the conversation).

## The 5 Kinds

| Kind | Auto-upgrade | Use it for |
|---|---|---|
| `note` | — | Generic observation, no upgrade. |
| `preference` | — | "I prefer X", "I always do Y", "I never use Z". |
| `fact` | — | Verifiable claim about the world ("Postgres is on port 5434"). |
| `project_context` | `project` scope | Setup, stack, deploy, or business rule of a specific project. |
| `feedback` | `agent` scope | Correction or direction for a specific persona. |

The kind drives two things:

1. **Display color** in the console (Preferência = brand-bright,
   Contexto do projeto = success, Feedback = warning, etc).
2. **Recall relevance** — kinds aren't weighted differently, but you can
   filter by kind in the console and the CLI.

## The 3 Sources

| Source | When it gets set |
|---|---|
| `chat` | The orchestrator detected a "lembre que…" signal and persisted automatically. |
| `manual` | You added the memory yourself via CLI, Web UI, or API. |
| `imported` | A future bulk-import flow (CSV, JSON, or another agent's export). |

Sources don't affect recall — they only show up as a tag in the console so
you can audit what's human-supplied vs auto-captured.

## Signal Phrases (PT-BR + EN)

The orchestrator looks for these at the start of a chat message. The
text **after** the signal is what gets saved. A bare "lembre que:" with
nothing after it is silently dropped (the regex guards against empty
content).

**PT-BR (case-insensitive, anchored at message start):**

| Phrase | Default kind |
|---|---|
| `lembre que …` / `lembrar que …` | `note` |
| `lembre como <preferencia\|fato\|contexto\|feedback\|nota>: …` | (mapped from word) |
| `nunca esqueça que …` / `nunca esquecer que …` | `preference` |
| `sempre lembre que …` / `sempre esqueça que …` | `preference` |
| `minha preferência é: …` / `minha preferência são: …` | `preference` |
| `meu setup é: …` / `meu setup são: …` | `preference` |
| `contexto do projeto: …` | `project_context` |
| `nota: …` / `nota importante: …` | `note` |

**EN (case-insensitive, anchored at message start):**

| Phrase | Default kind |
|---|---|
| `remember that …` / `remember …` | `note` |
| `remember this as a <preference\|fact\|context\|feedback\|note>: …` | (mapped from word) |
| `don't forget that …` / `do not forget that …` | `preference` |
| `always remember that …` | `preference` |
| `my preference is: …` / `my preference are: …` | `preference` |
| `my setup is: …` / `my setup are: …` | `preference` |
| `project context: …` | `project_context` |
| `note: …` | `note` |

The "lembra?" vs "lembre" disambiguation uses a character class
(`lembr[ae]`) — both conjugations match.

## CLI Quick Reference

```bash
# All 4 subcommands accept --json. Exit codes: 0 OK, 1 bad args, 2 not found.
archon memory list [--scope <user|agent|project|conversation>] \
                   [--kind <note|preference|fact|project_context|feedback>] \
                   [--search <text>] [--limit <n>]
archon memory add  <content> [--scope <scope>] [--scope-id <id>] \
                   [--kind <kind>] [--source <chat|manual|imported>]
archon memory search <query> [--scope <scope>] [--kind <kind>] \
                       [--limit <n>]
archon memory forget <id>
```

Examples:

```bash
# Show all your preferences
archon memory list --scope user --kind preference --json | jq '.[].content'

# See what the orchestrator would inject for a chat message
archon memory search "setup do postgres local"

# Bulk import from a CSV (one memory per line)
while IFS=, read -r scope kind content; do
  archon memory add "$content" --scope "$scope" --kind "$kind" --source imported
done < memories.csv
```

## Web UI

Open `http://localhost:5180/console/memory` (or press `m` from anywhere in
the console). Three sections:

1. **Testar recall (FTS5)** — top of the page. Type a query, press Enter,
   see the top-10 hits the orchestrator would inject. Useful for tuning
   the signal phrases your team uses.
2. **Adicionar memória manualmente** — content + scope + kind, Enter
   to submit. Defaults to `user` + `note` + `manual`.
3. **List with filters** — scope and kind chips, plus free-text search.
   Each row has the timestamps (`created_at`, `last_used_at`), `use_count`,
   and an "Esquecer" button with a confirm dialog.

The console also exposes the data via the `archon memory …` CLI — same
backend (FTS5 + bm25 → 0-1 confidence) drives both.

## Architecture (Contributor Notes)

**Storage:** `remote_agent_memories` (regular table) +
`remote_agent_memories_fts` (FTS5 virtual table) + 3 triggers
(`memories_ai` after insert, `memories_ad` after delete, `memories_au`
after update). The triggers keep the FTS index in sync without a separate
write path. See `migrations/025_memory.sql`.

**Recall pipeline (orchestrator):** `buildMemoryPromptSection` is called
on every chat turn after the agent persona is injected. It:

1. Builds the scope list: `user` always, plus `agent` (if routed),
   `project` (if conversation has a codebase), `conversation` (if a
   conversation id is known).
2. Calls `recallMemories({ query: <user message>, scopes, limit: 5 })`
   which does FTS5 `MATCH` with OR-quote-escaped tokens (so natural
   language queries with stopwords work).
3. Converts the bm25 rank to a 0-1 confidence via min/max normalization.
4. Formats the hits as a `## Recalled memories` Markdown section appended
   to `systemAppend`. The model is told to apply them silently and
   not announce that it remembered.

**On-recall bookkeeping:** `use_count` is incremented and `last_used_at`
is bumped (best-effort, not in the same transaction as the recall query).
This drives the "X memories are unused, consider cleaning" audit signal
in the console.

**Auto-upgrade on persist:** When the orchestrator persists a
`project_context` memory in a conversation tied to a codebase, the scope
is upgraded from `user` to `project` automatically. Same for `feedback`
in a conversation routed to an agent. This is what makes the kinds
"follow the right place" without you having to specify it.

**Why SQLite FTS5 and not pgvector:** zero new infra, no external
embeddings, diacritics-stripped `unicode61` tokenizer handles PT-BR well
enough for natural-language recall. The tradeoff is that recall is
keyword-based, not semantic — "Postgres port" matches "5434" but won't
match "the database listens on TCP 5432". For semantic recall we'd need
to add embeddings later (out of scope for Path B).

## Troubleshooting

**My memory doesn't show up in the system prompt.**

Check the recall preview at the top of `/console/memory`. If it's not
there either, the FTS5 query didn't match. Common causes:

- Diacritic mismatch (FTS5 uses `unicode61` with `remove_diacritics 2`,
  so `é` and `e` match, but the tokenizer doesn't lowercase — the
  signal phrases are case-insensitive but the content isn't auto-folded).
- Word stem mismatch (`configurando` vs `configuração` — Portuguese is
  rich, BRT/stemmer support is on the roadmap, not the current build).
- The memory was saved in a different scope than the current
  conversation. Try `archon memory search "<your query>"` to see all
  matches across scopes.

**The "lembre que…" signal didn't save anything.**

Check that the message starts with the signal phrase (anchored at
position 0, case-insensitive). The text **after** the signal must have
at least 3 non-whitespace characters. Try a few variants:

```text
# These all work
lembre que meu setup usa Bun
lembra: meu setup usa Bun
minha preferência é: nunca usar Anthropic

# These don't
lembre que:                                  # empty content, dropped
por favor lembre que...                    # the "por favor" is fine, but...
mas lembre também que...                     # anchored at "mas" — no match
```

**I want to mass-import memories from another system.**

Loop over your export with `archon memory add --source imported`. The
kind and scope must be one of the 5+4 allowed values; the FTS5 triggers
will populate the index automatically.

**Two memories say the same thing.**

The system doesn't dedupe automatically. Pick the better one and
`archon memory forget <id>` the other, or add a more specific version
(e.g. "Postgres está na porta 5434 apenas em dev — em prod é 5432")
to supersede the general one.

**`use_count` is high but I don't recognize the memory.**

That's a memory the orchestrator recalled multiple times during chats
but never surfaced to you. Browse the list with `use_count > 5` to find
stale-but-popular entries and `archon memory forget <id>` the ones that
are no longer useful.

## See Also

- [CLI reference](/reference/cli#archon-memory-listaddsearchforget) — full
  flag table for every subcommand
- [Database schema](/reference/database#remote_agent_memories) — DDL
  for `remote_agent_memories` and the FTS5 virtual table
- [Concepts: memory + recall](/getting-started/concepts#memory) — short
  intro in the getting-started guide
- [Agents](/guides/agents) — the routing layer that decides which
  persona's system prompt gets the `## Recalled memories` section
