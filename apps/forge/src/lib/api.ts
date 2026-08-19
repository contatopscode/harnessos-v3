/**
 * VOLUND FORGE — typed API client.
 *
 * Thin fetch wrapper around the HarnessOS `/api/forge/*` endpoints.
 * All requests send the Better Auth cookie (cross-origin OK because
 * the backend sets `SameSite=None; Secure`). Non-2xx responses throw
 * an `ApiError` so callers can `try/catch` and show a real message
 * (better than bare fetch's generic "Failed to fetch").
 */

const BASE_URL = import.meta.env.VITE_FORGE_API_BASE_URL ?? 'http://localhost:3090';

export class ApiError extends Error {
  readonly status: number;
  readonly detail?: string;
  constructor(status: number, message: string, detail?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

export class PermissionError extends ApiError {
  constructor(status: 401 | 403, message: string) {
    super(status, message);
    this.name = 'PermissionError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(path, BASE_URL);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export async function request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, signal } = opts;
  const url = buildUrl(path, query);

  const res = await fetch(url, {
    method,
    credentials: 'include', // send the cross-origin Better Auth cookie
    signal,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const parsed = text ? safeJson(text) : null;

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new PermissionError(res.status, extractMessage(parsed, res.status));
    }
    throw new ApiError(res.status, extractMessage(parsed, res.status), extractDetail(parsed));
  }

  return (parsed ?? {}) as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractMessage(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const b = body as { error?: string; message?: string };
    if (b.error) return b.error;
    if (b.message) return b.message;
  }
  return `Request failed with status ${String(status)}`;
}

function extractDetail(body: unknown): string | undefined {
  if (body && typeof body === 'object') {
    const b = body as { detail?: string };
    if (typeof b.detail === 'string') return b.detail;
  }
  return undefined;
}

// =========================================================================
// Typed endpoint wrappers (shape matches the Zod schemas in
// @archon/core/src/schemas/forge.ts — re-declared here so the front
// can stay decoupled from the server package)
// =========================================================================

export type ClientStatus = 'active' | 'inactive' | 'archived';
export interface Client {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: ClientStatus;
  contact_email: string | null;
  created_at: string;
  updated_at: string;
}

export type DemandStatus =
  | 'backlog'
  | 'triagem'
  | 'requisitos'
  | 'aprovacao_cliente'
  | 'em_andamento'
  | 'concluido'
  | 'cancelado';
export type DemandPriority = 'baixa' | 'media' | 'alta' | 'urgente';

export interface Demand {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  client_id: string;
  codebase_id: string | null;
  status: DemandStatus;
  priority: DemandPriority;
  metadata: Record<string, unknown>;
  due_date: string | null;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DemandBoard {
  columns: Array<{ status: DemandStatus; demands: Demand[] }>;
  total: number;
}

export type SprintStatus = 'planejado' | 'em_andamento' | 'concluido' | 'cancelado';
export interface Sprint {
  id: string;
  client_id: string;
  name: string;
  start_date: string;
  end_date: string;
  status: SprintStatus;
  goal: string | null;
  created_at: string;
  updated_at: string;
}

export type OsStatus = 'pendente' | 'em_andamento' | 'concluida' | 'cancelada' | 'bloqueada';
export interface Os {
  id: string;
  demand_id: string;
  title: string;
  description: string | null;
  status: OsStatus;
  priority: DemandPriority;
  assignee_user_id: string | null;
  estimated_hours: number | null;
  actual_hours: number | null;
  due_date: string | null;
  completed_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export type CostKind = 'chat' | 'completion' | 'embedding' | 'tool' | 'image';
export interface Cost {
  id: string;
  run_id: string | null;
  demand_id: string | null;
  codebase_id: string | null;
  model: string;
  provider: string;
  kind: CostKind;
  tokens_in: number;
  tokens_out: number;
  amount_usd: number;
  usd_brl_rate: number;
  amount_brl: number;
  created_at: string;
}

export interface CostSummary {
  total_usd: number;
  total_brl: number;
  runs_count: number;
  cost_rows_count: number;
  tokens_in_total: number;
  tokens_out_total: number;
  window_days: number;
}

export interface CostBreakdown {
  by_model: Array<{
    key: string;
    amount_usd: number;
    amount_brl: number;
    tokens_in: number;
    tokens_out: number;
    cost_rows_count: number;
  }>;
  by_codebase: Array<{
    key: string;
    amount_usd: number;
    amount_brl: number;
    tokens_in: number;
    tokens_out: number;
    cost_rows_count: number;
  }>;
  by_pipeline: Array<{
    key: string;
    amount_usd: number;
    amount_brl: number;
    tokens_in: number;
    tokens_out: number;
    cost_rows_count: number;
  }>;
  window_days: number;
}

export interface ProjectSummary {
  id: string;
  slug: string;
  name: string;
  client_id: string | null;
  client_name: string | null;
  status: string;
  default_branch: string | null;
  open_demands: number;
  total_demands: number;
  runs_count: number;
  repository_url: string | null;
}

// =========================================================================
// Domain wrappers
// =========================================================================

export const api = {
  clients: {
    list: (signal?: AbortSignal) => request<{ clients: Client[] }>('/api/forge/clients', { signal }),
    get: (id: string, signal?: AbortSignal) =>
      request<{ client: Client }>(`/api/forge/clients/${id}`, { signal }),
    create: (body: {
      slug: string;
      name: string;
      description?: string;
      contact_email?: string;
    }) => request<{ client: Client }>('/api/forge/clients', { method: 'POST', body }),
    update: (
      id: string,
      body: {
        name?: string;
        description?: string | null;
        contact_email?: string | null;
        status?: ClientStatus;
      }
    ) => request<{ client: Client }>(`/api/forge/clients/${id}`, { method: 'PATCH', body }),
  },
  demands: {
    list: (filter?: {
      clientId?: string;
      codebaseId?: string;
      status?: DemandStatus;
      search?: string;
    }) =>
      request<{ demands: Demand[] }>('/api/forge/demands', { query: filter }),
    board: (filter?: { clientId?: string; codebaseId?: string; search?: string }) =>
      request<DemandBoard>('/api/forge/demands/board', { query: filter }),
    get: (id: string) => request<{ demand: Demand }>(`/api/forge/demands/${id}`),
    create: (body: {
      slug: string;
      title: string;
      client_id: string;
      codebase_id?: string;
      description?: string;
      priority?: DemandPriority;
      due_date?: string;
    }) => request<{ demand: Demand }>('/api/forge/demands', { method: 'POST', body }),
    update: (
      id: string,
      body: {
        title?: string;
        description?: string | null;
        status?: DemandStatus;
        priority?: DemandPriority;
        codebase_id?: string | null;
        due_date?: string | null;
      }
    ) => request<{ demand: Demand }>(`/api/forge/demands/${id}`, { method: 'PATCH', body }),
    updateStatus: (id: string, status: DemandStatus) =>
      request<{ demand: Demand }>(`/api/forge/demands/${id}/status`, {
        method: 'PATCH',
        body: { status },
      }),
  },
  sprints: {
    list: (filter?: { clientId?: string }) =>
      request<{ sprints: Sprint[] }>('/api/forge/sprints', { query: filter }),
    get: (id: string) => request<{ sprint: Sprint }>(`/api/forge/sprints/${id}`),
    create: (body: {
      client_id: string;
      name: string;
      start_date: string;
      end_date: string;
      goal?: string;
    }) => request<{ sprint: Sprint }>('/api/forge/sprints', { method: 'POST', body }),
  },
  oss: {
    list: (filter?: { demandId?: string; status?: OsStatus; assigneeUserId?: string }) =>
      request<{ oss: Os[] }>('/api/forge/oss', { query: filter }),
    get: (id: string) => request<{ os: Os }>(`/api/forge/oss/${id}`),
    create: (body: {
      demand_id: string;
      title: string;
      description?: string;
      status?: OsStatus;
      priority?: DemandPriority;
      assignee_user_id?: string;
      estimated_hours?: number;
      due_date?: string;
    }) => request<{ os: Os }>('/api/forge/oss', { method: 'POST', body }),
    update: (
      id: string,
      body: Partial<{
        title: string;
        description: string | null;
        status: OsStatus;
        priority: DemandPriority;
        assignee_user_id: string | null;
        estimated_hours: number | null;
        actual_hours: number | null;
        due_date: string | null;
        completed_at: string | null;
      }>
    ) => request<{ os: Os }>(`/api/forge/oss/${id}`, { method: 'PATCH', body }),
  },
  costs: {
    list: (filter?: {
      runId?: string;
      demandId?: string;
      codebaseId?: string;
      model?: string;
      sinceDays?: number;
      limit?: number;
    }) => request<{ costs: Cost[] }>('/api/forge/costs', { query: filter }),
    summary: (windowDays = 30) =>
      request<CostSummary>('/api/forge/costs/summary', { query: { windowDays } }),
    breakdown: (windowDays = 30) =>
      request<CostBreakdown>('/api/forge/costs/breakdown', { query: { windowDays } }),
    record: (body: {
      run_id?: string;
      demand_id?: string;
      codebase_id?: string;
      model: string;
      provider: string;
      kind?: CostKind;
      tokens_in: number;
      tokens_out: number;
      amount_usd: number;
      usd_brl_rate?: number;
    }) => request<{ cost: Cost }>('/api/forge/costs', { method: 'POST', body }),
  },
  projects: {
    list: () => request<{ projects: ProjectSummary[] }>('/api/forge/projects'),
    get: (id: string) => request<{ project: ProjectSummary }>(`/api/forge/projects/${id}`),
  },
};
