import { requestJson } from '../lib/http';

/** Minimal sandbox summary as returned by GET /api/codebases/{id}/sandboxes. */
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

/** Diff payload from GET /api/sandboxes/{id}/diff. */
export interface SandboxDiff {
  branch: string;
  baseBranch: string;
  /** `git diff --stat` output — single line per file. */
  stat: string;
  /** First 200 lines of `git diff -U0`. */
  preview: string;
  aheadBy: number;
  behindBy: number;
}

export interface SandboxDetail {
  id: string;
  slug: string;
  branch: string;
  worktreePath: string;
  createdAt: string;
  status: string;
}

export function listSandboxes(codebaseId: string): Promise<SandboxListResponse> {
  return requestJson<SandboxListResponse>(
    `/api/codebases/${encodeURIComponent(codebaseId)}/sandboxes`
  );
}

export function createSandbox(
  codebaseId: string,
  body: { slug?: string; baseBranch?: string } = {}
): Promise<{ id: string; branch: string; worktreePath: string }> {
  return requestJson<{ id: string; branch: string; worktreePath: string }>(
    `/api/codebases/${encodeURIComponent(codebaseId)}/sandboxes`,
    { method: 'POST', body: JSON.stringify(body) }
  );
}

export function getSandboxDiff(sandboxId: string): Promise<SandboxDiff> {
  return requestJson<SandboxDiff>(`/api/sandboxes/${encodeURIComponent(sandboxId)}/diff`);
}

export function mergeSandbox(
  sandboxId: string
): Promise<{ merged: boolean; fastForward: boolean }> {
  return requestJson<{ merged: boolean; fastForward: boolean }>(
    `/api/sandboxes/${encodeURIComponent(sandboxId)}/merge`,
    { method: 'POST' }
  );
}

export function discardSandbox(sandboxId: string): Promise<{ discarded: boolean }> {
  return requestJson<{ discarded: boolean }>(
    `/api/sandboxes/${encodeURIComponent(sandboxId)}/discard`,
    { method: 'POST' }
  );
}
