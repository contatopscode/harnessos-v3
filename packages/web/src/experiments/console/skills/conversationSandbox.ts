import { requestJson } from '../lib/http';

export interface SandboxSummary {
  id: string;
  slug: string;
  branch: string;
  worktreePath: string;
  createdAt: string;
}

export interface SandboxListResponse {
  sandboxes: SandboxSummary[];
}

/** Returned by GET /api/conversations/{id}/sandbox. */
export interface SandboxStateResponse {
  active: boolean;
  sandbox: SandboxSummary | null;
}

export function getConversationSandbox(conversationId: string): Promise<SandboxStateResponse> {
  return requestJson<SandboxStateResponse>(
    `/api/conversations/${encodeURIComponent(conversationId)}/sandbox`
  );
}

export function setConversationSandbox(
  conversationId: string,
  sandboxId: string
): Promise<SandboxSummary> {
  return requestJson<SandboxSummary>(
    `/api/conversations/${encodeURIComponent(conversationId)}/sandbox`,
    { method: 'POST', body: JSON.stringify({ sandboxId }) }
  );
}

export function clearConversationSandbox(conversationId: string): Promise<{ cleared: boolean }> {
  return requestJson<{ cleared: boolean }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/sandbox`,
    { method: 'DELETE' }
  );
}
