/**
 * VOLUND FORGE — Agente de chat escopado em projetos.
 *
 * O agente de chat do FORGE é deliberadamente RESTRITIVO: ele só
 * responde perguntas sobre os PROJETOS (codebases + clients + demands
 * + runs) que existem no HarnessOS. Não toca em código, não tem tools
 * destrutivas, não inventa números — usa os endpoints do FORGE como
 * "base de conhecimento" via prompt injetado.
 *
 * **Audit trail completo** (migration 036):
 *   - Cada mensagem (user + assistant) é persistida em
 *     `remote_agent_messages` dentro de uma conversation FORGE
 *   - Cada cost row é linkado à `message_id` + `conversation_id`
 *   - Se a mensagem cita um projeto, a conversa é linkada à demanda
 *     ativa daquele projeto e gera um activity row 'message' na
 *     `remote_agent_demand_activities`
 *
 * Provider: MiniMax (provider `minimax`, model `MiniMax-M3` por padrão).
 * O call é HTTP direto ao endpoint proprietário MiniMax.
 */
import { Hono } from 'hono';
import { z } from '@hono/zod-openapi';
import { requireWebPermission } from '../auth/rbac';
import { pool } from '@archon/core/db/connection';
import * as projectsDb from '@archon/core/db/projects';
import * as clientsDb from '@archon/core/db/clients';
import * as demandsDb from '@archon/core/db/demands';
import { recordActivity, listActivitiesForDemand, changeDemandStatus } from '@archon/core/db/demand-activities';
import { createLogger } from '@archon/paths';

const log = createLogger('forge.chat');

const chatBodySchema = z
  .object({
    message: z.string().min(1).max(4000),
    conversation_id: z.string().optional(),
    codebase_id: z.string().optional(),
  })
  .openapi('ForgeChatBody');

type ApiErrorStatus = 400 | 401 | 502 | 503;

function apiError(
  c: { json: (data: unknown, status?: number) => Response },
  status: ApiErrorStatus,
  message: string
): Response {
  return c.json({ error: message }, status);
}

const chat = new Hono();

/**
 * POST /api/forge/chat
 *
 * Body: { message, conversation_id?, codebase_id? }
 * Reply: { reply, model, latency_ms, context, conversation_id, message_id }
 */
chat.post('/', async c => {
  const guard = await requireWebPermission(c, 'admin:users');
  if ('error' in guard) return guard.error;

  const body = await c.req.json().catch(() => null);
  const parsed = chatBodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(c, 400, 'Invalid chat body');
  }
  const { message, codebase_id: codebaseId } = parsed.data;

  // 0. Resolve the user (FORGE sessions always have a web user from
  //    Better Auth, so we can persist the message + activities under
  //    their identity).
  const userId = guard.userId;

  // 1. Resolve or create the conversation. One conversation per
  //    (user, codebase_id) pair — keeps the "history" per project.
  //    If no codebase_id is provided, we fall back to a "global"
  //    conversation (codebase_id IS NULL).
  const conversationId = await getOrCreateConversation({
    userId,
    codebaseId: codebaseId ?? null,
    conversationId: parsed.data.conversation_id,
  });

  // 2. Persist the USER message BEFORE calling the LLM — that way
  //    we have a `message_id` to attach the cost row to, and the
  //    timeline shows the user input even if the LLM fails.
  const userMessageId = await insertMessage({
    conversationId,
    userId,
    role: 'user',
    content: message,
  });

  // 3. Gather context (projetos + clientes + demandas + contagens).
  const [projects, clients, demands] = await Promise.all([
    projectsDb.listProjectsWithCounts(),
    clientsDb.listClients(),
    demandsDb.listDemands({ codebaseId, limit: 30 }),
  ]);

  // 4. Build the system prompt + call MiniMax
  const systemPrompt = buildSystemPrompt({ projects, clients, demands });
  const apiKey = process.env.MINIMAX_API_KEY ?? '';
  const baseUrl = (process.env.MINIMAX_BASE_URL ?? 'https://api.minimax.io/v1').replace(/\/$/, '');
  const model = process.env.MINIMAX_MODEL ?? 'MiniMax-M3';

  if (!apiKey) {
    return apiError(c, 503, 'MINIMAX_API_KEY não configurada no servidor');
  }

  const t0 = Date.now();
  let reply: string;
  try {
    const resp = await fetch(`${baseUrl}/text/chatcompletion_v2`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', name: 'system', content: systemPrompt },
          { role: 'user', name: 'user', content: message },
        ],
        temperature: 0.3,
        max_tokens: 1024,
      }),
    });
    if (!resp.ok) {
      log.error({ status: resp.status, body: await resp.text() }, 'forge.chat.minimax_failed');
      return apiError(c, 502, `MiniMax retornou ${String(resp.status)}`);
    }
    const data = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    reply = data.choices?.[0]?.message?.content?.trim() ?? '';
    const usage = data.usage ?? {};
    const tokensIn = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : approxTokens(systemPrompt + message);
    const tokensOut = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : approxTokens(reply);

    // 5. Persist the ASSISTANT message + link to the cost row + log
    //    activities. All best-effort (don't fail the response if a
    //    write fails — the user got their answer).
    const latencyMs = Date.now() - t0;
    await persistAssistantTurn({
      conversationId,
      userId,
      userMessageId,
      reply,
      model,
      tokensIn,
      tokensOut,
      latencyMs,
      codebaseId: codebaseId ?? null,
    }).catch(err => {
      log.warn({ err: err.message }, 'forge.chat.persist_failed');
    });
  } catch (e) {
    const err = e as Error;
    log.error({ err: err.message }, 'forge.chat.network_error');
    return apiError(c, 502, `Falha de rede com MiniMax: ${err.message}`);
  }
  const latencyMs = Date.now() - t0;

  return c.json({
    reply,
    model,
    latency_ms: latencyMs,
    context: {
      projects_count: projects.length,
      clients_count: clients.length,
      demands_count: demands.length,
    },
    conversation_id: conversationId,
    user_message_id: userMessageId,
  });
});

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

interface PersistArgs {
  conversationId: string;
  userId: string;
  userMessageId: string;
  reply: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  codebaseId: string | null;
}

/**
 * Persist the assistant message + the cost row + a demand activity
 * (if the conversation is linked to a codebase that has active demands).
 */
async function persistAssistantTurn(args: PersistArgs): Promise<void> {
  // 1. Insert the assistant message
  const assistantMsg = await pool.query<{ id: string }>(
    `INSERT INTO remote_agent_messages
       (conversation_id, role, content, user_id, metadata)
     VALUES ($1, 'assistant', $2, $3, $4::jsonb)
     RETURNING id`,
    [
      args.conversationId,
      args.reply,
      args.userId,
      JSON.stringify({ model: args.model, latency_ms: args.latencyMs, source: 'forge_chat' }),
    ]
  );
  const assistantMessageId = assistantMsg.rows[0].id;

  // 2. Insert a cost row linked to both the assistant message and
  //    the conversation. We re-derive the cost from the tokens (M3 is
  //    $0.50/M input, $1.50/M output — see PSG.7 do Sinapse for the
  //    same pattern; update if the M3 pricing changes).
  const usdBrlRate = Number(process.env.USD_BRL_RATE ?? '5.0');
  const usdIn = (args.tokensIn / 1_000_000) * 0.5;
  const usdOut = (args.tokensOut / 1_000_000) * 1.5;
  const amountUsd = usdIn + usdOut;
  const amountBrl = amountUsd * usdBrlRate;
  await pool.query(
    `INSERT INTO remote_agent_costs
       (model, provider, kind, tokens_in, tokens_out, amount_usd, usd_brl_rate, amount_brl,
        codebase_id, message_id, conversation_id, metadata)
     VALUES ($1, $2, 'chat', $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
    [
      args.model,
      'minimax',
      args.tokensIn,
      args.tokensOut,
      amountUsd,
      usdBrlRate,
      amountBrl,
      args.codebaseId,
      assistantMessageId,
      args.conversationId,
      JSON.stringify({ latency_ms: args.latencyMs, source: 'forge_chat' }),
    ]
  );

  // 3. If this conversation is linked to a codebase, find the
  //    active demand for that codebase (the one currently in
  //    em_andamento, or the most recent non-concluido one) and log a
  //    'message' activity on it. This is what the user sees in the
  //    timeline: "the user asked X to the FORGE agent while this
  //    demand was being worked on".
  if (args.codebaseId) {
    const demandRow = await pool.query<{ id: string }>(
      `SELECT id FROM remote_agent_demands
       WHERE codebase_id = $1
         AND status NOT IN ('concluido', 'cancelado')
       ORDER BY
         CASE status
           WHEN 'em_andamento' THEN 0
           WHEN 'aprovacao_cliente' THEN 1
           WHEN 'requisitos' THEN 2
           WHEN 'triagem' THEN 3
           WHEN 'bloqueada' THEN 4
           WHEN 'backlog' THEN 5
           ELSE 6
         END,
         updated_at DESC
       LIMIT 1`,
      [args.codebaseId]
    );
    if (demandRow.rowCount && demandRow.rowCount > 0) {
      const demandId = demandRow.rows[0].id;
      await recordActivity({
        demandId,
        action: 'message',
        userId: args.userId,
        messageId: assistantMessageId,
        note: `Mensagem do chat: ${truncate(args.reply, 200)}`,
        metadata: {
          conversation_id: args.conversationId,
          message_role: 'assistant',
          tokens_in: args.tokensIn,
          tokens_out: args.tokensOut,
          model: args.model,
        },
      });
    }
  }
}

async function getOrCreateConversation(args: {
  userId: string;
  codebaseId: string | null;
  conversationId: string | undefined;
}): Promise<string> {
  // If a conversation_id was provided, just verify it exists and return it
  if (args.conversationId) {
    const existing = await pool.query<{ id: string }>(
      'SELECT id FROM remote_agent_conversations WHERE id = $1',
      [args.conversationId]
    );
    if (existing.rowCount && existing.rowCount > 0) {
      return args.conversationId;
    }
    // Stale id — fall through to create a new one
  }
  // Look for an active conversation matching (user, codebase)
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM remote_agent_conversations
     WHERE user_id = $1
       AND codebase_id IS NOT DISTINCT FROM $2
       AND deleted_at IS NULL
     ORDER BY last_activity_at DESC
     LIMIT 1`,
    [args.userId, args.codebaseId]
  );
  if (existing.rowCount && existing.rowCount > 0) {
    // Touch last_activity_at so the next call still finds it
    await pool.query(
      'UPDATE remote_agent_conversations SET last_activity_at = NOW() WHERE id = $1',
      [existing.rows[0].id]
    );
    return existing.rows[0].id;
  }
  // Create a new conversation
  const created = await pool.query<{ id: string }>(
    `INSERT INTO remote_agent_conversations
       (platform_type, platform_conversation_id, codebase_id, ai_assistant_type, user_id, title)
     VALUES ('forge', $1, $2, 'claude', $3, $4)
     RETURNING id`,
    [
      `forge-${args.userId}-${args.codebaseId ?? 'global'}-${String(Date.now())}`,
      args.codebaseId,
      args.userId,
      args.codebaseId ? `Chat do projeto ${args.codebaseId.slice(0, 8)}` : 'Chat geral do FORGE',
    ]
  );
  return created.rows[0].id;
}

async function insertMessage(args: {
  conversationId: string;
  userId: string;
  role: 'user' | 'assistant';
  content: string;
}): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO remote_agent_messages
       (conversation_id, role, content, user_id, metadata)
     VALUES ($1, $2, $3, $4, '{}'::jsonb)
     RETURNING id`,
    [args.conversationId, args.role, args.content, args.userId]
  );
  // Touch conversation timestamp
  await pool.query(
    'UPDATE remote_agent_conversations SET last_activity_at = NOW() WHERE id = $1',
    [args.conversationId]
  );
  return result.rows[0].id;
}

// ---------------------------------------------------------------------------
// System prompt (unchanged)
// ---------------------------------------------------------------------------

function buildSystemPrompt(args: {
  projects: {
    id: string;
    name: string;
    client_name: string | null;
    open_demands: number;
    total_demands: number;
    runs_count: number;
    default_branch: string | null;
    repository_url: string | null;
  }[];
  clients: { id: string; name: string; status: string }[];
  demands: { id: string; slug: string; title: string; status: string; priority: string }[];
}): string {
  const projectsBlock = args.projects
    .map(
      p =>
        `- ${p.name} (cliente: ${p.client_name ?? 'sem cliente'} | abertas: ${p.open_demands} | total: ${p.total_demands} | runs: ${p.runs_count}${p.default_branch ? ` | branch: ${p.default_branch}` : ''})`
    )
    .join('\n');

  const clientsBlock = args.clients.map(c => `- ${c.name} [${c.status}]`).join('\n');

  const demandsBlock = args.demands
    .slice(0, 30)
    .map(d => `- [${d.status.toUpperCase()}] ${d.slug} — ${d.title} (prioridade: ${d.priority})`)
    .join('\n');

  return `Você é o **Agente do HarnessOS Projetos** — um assistente conversacional focado EXCLUSIVAMENTE em responder perguntas sobre os projetos, clientes, demandas e execuções (runs) registrados no HarnessOS.

## Suas regras

1. **Escopo restrito**: você só responde sobre os dados que o HarnessOS Projetos gerencia — clientes, codebases/projetos, demandas, OS's, sprints e runs. Se o usuário perguntar algo fora desse escopo (ex: "qual a cotação do dólar hoje", "me ajude a escrever um email"), recuse educadamente dizendo que só responde sobre o HarnessOS Projetos.
2. **Não invente dados**: se a informação não estiver no contexto abaixo, diga que não tem essa informação e sugira onde ela estaria (qual tela / qual endpoint). Nunca chute números.
3. **Respostas concisas**: máximo 3-4 parágrafos curtos ou 1-2 listas com bullets. Use markdown leve.
4. **Cite IDs e slugs** quando relevante — o usuário vai clicar e abrir.
5. **Quando sugerir uma ação** (ex: "mova essa demanda pra em_andamento"), explique que ele precisa fazer no Kanban — você é read-only.

## Contexto atual (lido do banco agora)

### Projetos (${String(args.projects.length)})
${projectsBlock || '(nenhum projeto cadastrado)'}

### Clientes (${String(args.clients.length)})
${clientsBlock || '(nenhum cliente cadastrado)'}

### Demandas recentes (top ${String(Math.min(args.demands.length, 30))})
${demandsBlock || '(nenhuma demanda cadastrada)'}

Responda em português (PT-BR), a menos que o usuário escreva em outro idioma.`;
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function approxTokens(text: string): number {
  // Rough heuristic: ~4 chars per token for English/Portuguese mix.
  return Math.ceil(text.length / 4);
}

function truncate(text: string, n: number): string {
  if (text.length <= n) return text;
  return text.slice(0, n - 1) + '…';
}

// Re-export for the timeline endpoint
export { listActivitiesForDemand, changeDemandStatus };

export default chat;
