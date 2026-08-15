import { requestJson } from '../lib/http';

/**
 * Per-project skill install — powers the "Install skills" button in the
 * project menu. Writes the bundled `archon` + `manage-run` skills to the
 * project's `.claude/skills/` and `.agents/skills/` trees so both Claude
 * Code and Codex pick them up on the next session.
 *
 * The server's `POST /api/codebases/{id}/skills` handler is the single
 * source of truth — same code path as `archon skill install <path>` on the
 * CLI, just resolved against a registered codebase instead of a raw path.
 */
interface InstallSkillsResponse {
  ok: boolean;
  targetPath: string;
  skillsRoots: string[];
  fileCount: number;
}

export async function installProjectSkills(projectId: string): Promise<InstallSkillsResponse> {
  return requestJson<InstallSkillsResponse>(
    `/api/codebases/${encodeURIComponent(projectId)}/skills`,
    { method: 'POST' }
  );
}
