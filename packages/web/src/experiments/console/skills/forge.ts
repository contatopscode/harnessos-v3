/**
 * FORGE demand surface for the HarnessOS Console.
 *
 * Reuses the existing `/api/forge/*` endpoints that the FORGE webapp also
 * hits — same backend, same Better Auth session, same `admin:users` permission
 * gate. The console shows a read+write Kanban (status changes are allowed
 * here because the user is acting as a PM/Builder, not a cliente).
 *
 * Why a separate `console/forge` wrapper instead of importing from
 * `apps/forge`? apps/forge is a separate Vite build (the FORGE webapp) and
 * is not on the console's import graph. Duplicating the typed shape is
 * cheaper than wiring a cross-package import that pulls in the FORGE
 * CSS/theme tokens.
 */
import { requestJson } from '../lib/http';

export type DemandStatus =
  | 'backlog'
  | 'triagem'
  | 'requisitos'
  | 'aprovacao_cliente'
  | 'em_andamento'
  | 'bloqueada'
  | 'concluido'
  | 'cancelado';

export interface Demand {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  client_id: string;
  codebase_id: string | null;
  status: DemandStatus;
  priority: 'baixa' | 'media' | 'alta' | 'urgente';
  metadata: Record<string, unknown>;
  due_date: string | null;
  created_at: string;
  updated_at: string;
  // Audit-trail summary
  last_activity_at: string | null;
  last_run_id: string | null;
  last_run_status: string | null;
  runs_count: number;
  messages_count: number;
}

export interface DemandBoardColumn {
  status: DemandStatus;
  demands: Demand[];
}

export interface DemandBoard {
  columns: DemandBoardColumn[];
  total: number;
}

export interface Client {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'inactive' | 'archived';
}

export interface ProjectSummary {
  id: string;
  slug: string;
  name: string;
  client_id: string | null;
  client_name: string | null;
  status: string;
  open_demands: number;
  total_demands: number;
  runs_count: number;
}

export interface DemandActivity {
  id: string;
  demand_id: string;
  action: string;
  from_status: string | null;
  to_status: string | null;
  note: string | null;
  actor_email: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface DemandTimelineEntry {
  kind: 'activity' | 'run' | 'cost' | 'message';
  at: string;
  title: string;
  detail: string | null;
  // activity shape (full row when kind=activity)
  activity?: DemandActivity;
  // run shape
  run_id?: string;
  run_status?: string;
  run_workflow_name?: string;
  // cost shape
  cost_id?: string;
  cost_model?: string;
  cost_tokens_in?: number;
  cost_tokens_out?: number;
  cost_amount_usd?: number;
  cost_amount_brl?: number;
  // message shape
  message_id?: string;
  message_role?: string;
  message_preview?: string;
}

export interface DemandTimeline {
  demand: Demand;
  entries: DemandTimelineEntry[];
  totals: {
    activities: number;
    runs: number;
    cost_calls: number;
    cost_total_usd: number;
    cost_total_brl: number;
    messages: number;
  };
}

export async function listClients(): Promise<Client[]> {
  const data = await requestJson<{ clients: Client[] }>('/api/forge/clients');
  return data.clients;
}

export async function listForgeProjects(): Promise<ProjectSummary[]> {
  const data = await requestJson<{ projects: ProjectSummary[] }>('/api/forge/projects');
  return data.projects;
}

export async function getDemandBoard(filter: {
  clientId?: string;
  codebaseId?: string;
  search?: string;
}): Promise<DemandBoard> {
  const query: Record<string, string> = {};
  if (filter.clientId) query.clientId = filter.clientId;
  if (filter.codebaseId) query.codebaseId = filter.codebaseId;
  if (filter.search) query.search = filter.search;
  const qs = new URLSearchParams(query).toString();
  return requestJson<DemandBoard>(`/api/forge/demands/board${qs ? `?${qs}` : ''}`);
}

export async function updateDemandStatus(id: string, status: DemandStatus): Promise<Demand> {
  const data = await requestJson<{ demand: Demand }>(`/api/forge/demands/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
  return data.demand;
}

export async function getDemandTimeline(id: string, limit = 100): Promise<DemandTimeline> {
  return requestJson<DemandTimeline>(`/api/forge/demands/${id}/timeline?limit=${String(limit)}`);
}

export async function addNote(id: string, note: string): Promise<{ activity: DemandActivity }> {
  return requestJson<{ activity: DemandActivity }>(`/api/forge/demands/${id}/activities`, {
    method: 'POST',
    body: JSON.stringify({ action: 'note', note }),
  });
}
