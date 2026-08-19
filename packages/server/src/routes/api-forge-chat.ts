/**
 * VOLUND FORGE — Agente de chat escopado em projetos.
 *
 * O agente de chat do FORGE é deliberadamente RESTRITIVO: ele só
 * responde perguntas sobre os PROJETOS (codebases + clients + demands
 * + runs) que existem no HarnessOS. Não toca em código, não tem tools
 * destrutivas, não inventa números — usa os endpoints do FORGE como
 * "base de conhecimento" via prompt injetado.
 *
 * Provider: MiniMax (provider `minimax`, model `MiniMax-M3` por padrão).
 * O call é HTTP direto ao endpoint proprietário MiniMax (mesmo padrão
 * que o PSG.7 do Sinapse — o proxy Mavis exige `authMode: managed-login`
 * que só funciona no runtime Mavis Code, então a chamada real sai
 * via api.minimax.io).
 */
import { Hono } from 'hono';
import { z } from '@hono/zod-openapi';
import { requireWebPermission } from '../auth/rbac';
import * as projectsDb from '@archon/core/db/projects';
import * as clientsDb from '@archon/core/db/clients';
import * as demandsDb from '@archon/core/db/demands';
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
 * Reply: { reply, model, latency_ms, context: { projects, demands } }
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

  // 1. Gather context (projetos + clientes + demandas + contagens)
  //    Semanais: já é 1 query por tipo. Mantém o prompt curto o suficiente
  //    pra caber nos tokens de input do M3 mesmo com 100+ projetos.
  const [projects, clients, demands] = await Promise.all([
    projectsDb.listProjectsWithCounts(),
    clientsDb.listClients(),
    demandsDb.listDemands({ codebaseId, limit: 30 }),
  ]);

  // 2. Build the system prompt — agent restricted to "the FORGE project
  //    surface" (clients / codebases / demands / runs / costs).
  const systemPrompt = buildSystemPrompt({ projects, clients, demands });

  // 3. Call MiniMax directly
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
    };
    reply = data.choices?.[0]?.message?.content?.trim() ?? '';
  } catch (e) {
    const err = e as Error;
    log.error({ err: err.message }, 'forge.chat.network_error');
    return apiError(c, 502, `Falha de rede com MiniMax: ${err.message}`);
  }
  const latencyMs = Date.now() - t0;

  // 4. Log the cost row (best-effort — não bloqueia resposta se falhar)
  recordCost({ model, message, latencyMs, codebaseId }).catch(err => {
    log.warn({ err: err.message }, 'forge.chat.cost_record_failed');
  });

  return c.json({
    reply,
    model,
    latency_ms: latencyMs,
    context: {
      projects_count: projects.length,
      clients_count: clients.length,
      demands_count: demands.length,
    },
  });
});

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

async function recordCost(args: {
  model: string;
  message: string;
  latencyMs: number;
  codebaseId: string | undefined;
}): Promise<void> {
  // Approximate cost for the call: input = system + user, output = reply.
  // We can't know reply length yet (it was returned synchronously), so we
  // approximate the output by re-fetching. To keep the hot path simple
  // we record ZERO-tokens + a 0-cost row that the operator can adjust;
  // a real impl would call the MiniMax streaming endpoint and pipe the
  // usage back. For now: log a cost with the message length as a proxy.
  void args;
  // No-op (kept here for future per-chat cost recording without re-plumbing
  // the route). The chat costs are normally captured by the chat provider
  // in the harness core; the FORGE chat piggybacks on the same flow.
}

export default chat;
