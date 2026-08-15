---
title: Agents
description: Persona layer that auto-routes chat messages to the right specialist (code-reviewer, test-writer, bug-investigator, or your own).
category: guides
area: orchestrator
audience: [user, developer]
status: current
sidebar:
  order: 9
---

Every chat message is routed to an **agent** — a named persona with its own
system prompt, keywords, examples, and allowed tools. The orchestrator
auto-detects the right one from your message, or you can pin it explicitly
with `agent:slug`.

Four specialists ship bundled with HarnessOS:

| Slug | Use it when… |
|---|---|
| `code-reviewer` | You want a strict, read-only review (file:line, verdict, suggestions). |
| `test-writer` | You want fast, deterministic tests (table-driven, well-named). |
| `bug-investigator` | You hit a failure and need root-cause analysis, not a "try this" patch. |
| `general-assistant` | Catch-all for off-topic or ambiguous messages. |

The router picks the right one in **< 5 ms** — no extra LLM call, no per-turn
cost. If you're not sure, just chat normally and the system will pick for you.

## Quick Start

**Implicit routing (recommended for most use):**

```text
you:    revisa esse PR #234
router: code-reviewer (auto_heuristic, conf 0.58, 1 ms)

you:    como faço pra escrever um teste unitário em Python?
router: test-writer (auto_heuristic, conf 0.83, 1 ms)

you:    tá dando erro 500 com stack trace NullPointerException
router: bug-investigator (auto_heuristic, conf 0.67, 0 ms)
```

**Explicit override (when you know what you want):**

```text
you:    agent:code-reviewer olha esse diff antes de eu commitar
you:    agent:test-writer me dá cobertura do módulo auth/
you:    agent:bug-investigator a query está lenta, investiga
```

The `agent:slug` prefix is **stripped before the model sees it** — the
model only ever sees the persona + your actual message.

## The 5-Stage Routing Flow

When a chat message comes in, the router walks this in order. First match
wins.

```
┌─────────────────────────────────────────────────────────────────────┐
│  1. agent:slug override                                             │
│     Did the user write `agent:foo` at the start? Use foo (or fall    │
│     through if foo isn't installed).                                 │
│     Decision label: `override`                                       │
├─────────────────────────────────────────────────────────────────────┤
│  2. Codebase default                                                 │
│     Is there a default agent pinned in the codebase's                │
│     `.archon/config.yaml`? Use it. (Reserved — not wired yet.)       │
│     Decision label: `codebase_default`                               │
├─────────────────────────────────────────────────────────────────────┤
│  3. Heuristic                                                        │
│     Score every installed agent by keyword / description / example   │
│     overlap. Pick the highest scorer if it beats 0.5.               │
│     Decision label: `auto_heuristic`                                 │
├─────────────────────────────────────────────────────────────────────┤
│  4. LLM fallback                                                    │
│     If heuristic is ambiguous (best < 0.5), ask a small model to     │
│     classify. (Stub today — wires in once M3-small is in place.)     │
│     Decision label: `auto_llm`                                       │
├─────────────────────────────────────────────────────────────────────┤
│  5. Default fallback                                                 │
│     Otherwise: `general-assistant` (or the first available agent    │
│     if general-assistant was somehow uninstalled).                    │
│     Decision label: `default_fallback`                               │
└─────────────────────────────────────────────────────────────────────┘
```

The decision label and confidence are written to the `agent_runs` audit
table after every chat turn so you can later ask "why did this go to X?".

## CLI Quick Reference

```bash
# List installed agents
archon agent list                          # all
archon agent list --source bundled          # just the 4 ships-with
archon agent list --source local --search "doc"   # find a local agent

# Show one agent's full definition
archon agent show code-reviewer

# Install from a YAML file on disk
archon agent install ~/.archon/agents/docs-writer.yaml

# Uninstall (refuses bundled — they re-seed on every server boot)
archon agent uninstall docs-writer

# Simulate routing for a message (no actual chat)
archon agent run "como faço pra escrever um teste?"
# → Routed to: test-writer (auto_heuristic, 0.83, 1 ms)
#   Reason: test-writer (score 0.83: matched 2 keyword(s))

# Audit log of recent routing decisions
archon agent runs --limit 20
archon agent runs --slug code-reviewer     # just one agent
```

All subcommands accept `--json` for machine-readable output and exit
codes 0 (success) / 1 (bad args) / 2 (not found) so they slot into shell
pipelines.

## Web UI

The Console at `/console/agents` (keyboard shortcut: `a`) gives you:

- A list pane with source-filter chips (All / Bundled / Local / Installed)
- A detail pane showing the full system prompt, keywords, examples, and tools
- An install bar to upload a YAML path
- A bottom panel showing the last 20 routing decisions from the audit log

Bundled agents show a "Bundled — protected" label in place of the
Uninstall button (they re-seed on every server boot — you can't remove
them, only override them with a same-slug local file).

## Authoring a Custom Agent

Create a YAML file anywhere on disk (`.archon/agents/<slug>.yaml` is the
convention) with this shape:

```yaml
slug: docs-writer                  # kebab-case, unique
name: Docs Writer                  # human-readable
version: 1.0.0
description: >                     # one-line summary, used in the list UI
  Technical writer who produces clear, well-structured documentation.
  Specializes in README files, API references, and ADRs.
systemPrompt: |
  You are a senior technical writer. Avoid marketing language, emoji, and
  filler. Use concrete file:line references when explaining where things
  live. Structure every doc with: (1) one-sentence summary, (2) prerequisites,
  (3) step-by-step, (4) failure modes / troubleshooting.
tags: [docs, readme, api]          # free-form labels, shown in the UI
keywords:                          # 5–15 phrases; router scores 1.0 per match
  - documentação
  - documenta isso
  - escreve o readme
  - api reference
  - write docs
examples:                          # 3–6 short user messages that should route here
  - escreve o README desse projeto
  - documenta essa API
  - me ajuda a escrever um ADR
allowedTools:                      # tools the agent should prefer; advisory only
  - Read
  - Write
  - Edit
  - Grep
  - Glob
author: paulo-siqueira             # optional
model: pi/MiniMax-M3               # optional override (default: inherits from chat)
```

The schema is validated by `agentDefinitionSchema` (Zod) on load. Bad
files are reported per-file in the loader's `errors` array and skipped —
the rest of the agents still load.

### Keyword tuning tips

- **5–15 keywords is the sweet spot.** Fewer = false negatives, more =
  overlapping matches that defeat the overlap-coefficient scoring.
- **Use the user's actual phrasing** — `"tá dando erro"`, not
  `"error occurred"`. PT-BR tokenization is built in (`áàâãéèêíïóôõúüç`).
- **Imperative and infinitive both work** — the router matches the
  query as a substring inside the keyword, so `teste` and `escrever um
  teste` are both covered by `"escrever um teste"`.
- **Don't repeat yourself across agents.** If `test-writer` and
  `docs-writer` both claim the keyword `escrever`, the router will
  fall through to the catch-all.

## Architecture (Contributor Notes)

```
┌──────────────────────────────────────────────────────────────────────┐
│  agents/defaults/*.yaml   bundled: 4 ships-with agents               │
│  ~/.archon/agents/*.yaml  global:  per-machine overrides              │
│  <cwd>/.archon/agents/    local:   per-project overrides              │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ loadAllAgents()
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  loader.ts           3-scope precedence, schema-validated             │
│                      returns Map<slug, LoadedAgent>                   │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ routeMessage(input, agents)
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  router.ts           5-stage flow (see above)                         │
│                      < 5 ms for heuristic, no LLM by default         │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ RoutingResult
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  orchestrator-integration.ts                                          │
│    - strips `agent:slug` prefix from the message                      │
│    - injects agent's systemPrompt into the orchestrator prompt        │
│    - records the decision in agent_runs on the success path           │
└──────────────────────────────────────────────────────────────────────┘
```

| Component | Lives in | Test surface |
|---|---|---|
| Bundled YAMLs | `packages/core/src/agents/defaults/*.yaml` | 4 files, manually authored |
| Schema | `packages/core/src/schemas/agent.ts` | Zod-derived, 10 schemas |
| Loader | `packages/core/src/agents/loader.ts` | 3-scope precedence, IO wrappers for test safety |
| Router | `packages/core/src/agents/router.ts` | 5-stage flow, `LlmClassifier` interface for the future |
| Bootstrap | `packages/core/src/agents/bootstrap.ts` | idempotent seed on server boot |
| DB store | `packages/core/src/db/agents.ts` + `db/agent-runs.ts` | CRUD + append-only audit |
| Orchestrator hook | `packages/core/src/agents/orchestrator-integration.ts` | safe by default (skip on error) |
| CLI | `packages/cli/src/commands/agent.ts` | 6 subcommands, `--json` everywhere |
| API | `packages/server/src/routes/api.ts` (6 routes) | `/api/agents` + variants |
| Web | `packages/web/src/experiments/console/routes/AgentsPage.tsx` | list / detail / install / audit |
| Migration | `migrations/024_agents.sql` | 2 tables, append-only audit |

## Troubleshooting

**"No agent matched heuristic (best=0.X); used general-assistant"** —
your message didn't match any specialist's keywords strongly enough
(score < 0.5). Either rephrase the message, or tune the agent's
keywords to include the phrasing you actually use.

**`agent:foo` doesn't pin to `foo`** — the slug you typed isn't
installed. Run `archon agent list` to see what's available. Slug is
case-insensitive (`agent:Code-Reviewer` works).

**Bundled agent keeps reappearing after `agent uninstall`** — by
design. Bundled agents re-seed on every server boot. To override,
install a same-slug YAML from a local file (source becomes `local`).

**"agent_runs" table empty** — only chat messages that go through the
orchestrator are recorded. The CLI's `agent run` simulator also writes
to it. Slash commands (`/foo`) and out-of-band processes don't.

**`/api/agents/runs` returns 404** — make sure the route is registered
BEFORE `/api/agents/{slug}` in `packages/server/src/routes/api.ts`.
Hono matches the parameterized route first otherwise.
