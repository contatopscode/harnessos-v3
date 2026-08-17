import { requestJson } from '../lib/http';

/** A single git commit as returned by /api/codebases/{id}/git-log. */
export interface CommitSummary {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  timestamp: number;
}

export interface GitLogResult {
  branch: string;
  totalCommits: number;
  commits: CommitSummary[];
  dirty: boolean;
}

export function getGitLog(codebaseId: string): Promise<GitLogResult> {
  return requestJson<GitLogResult>(`/api/codebases/${encodeURIComponent(codebaseId)}/git-log`);
}

export function revertLastCommit(
  codebaseId: string
): Promise<{ reverted: { sha: string; subject: string } }> {
  return requestJson<{ reverted: { sha: string; subject: string } }>(
    `/api/codebases/${encodeURIComponent(codebaseId)}/git-revert`,
    { method: 'POST' }
  );
}

export function publishBranch(
  codebaseId: string
): Promise<{ branch: string; remote: string; ref: string }> {
  return requestJson<{ branch: string; remote: string; ref: string }>(
    `/api/codebases/${encodeURIComponent(codebaseId)}/git-publish`,
    { method: 'POST' }
  );
}
