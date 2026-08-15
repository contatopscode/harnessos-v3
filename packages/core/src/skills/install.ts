/**
 * Install Archon skill files into a project directory.
 *
 * Writes the bundled `archon` skill (SKILL.md, guides, references, examples) and
 * the focused `manage-run` skill into <targetPath>/.claude/skills/<skill>/ (for
 * Claude Code) AND <targetPath>/.agents/skills/<skill>/ (the canonical Codex
 * project-level skill path) so both Claude Code and Codex pick them up.
 *
 * Always overwrites existing files to ensure the latest skill version
 * shipped with the current Archon binary is installed.
 *
 * Pure file-system helper used by:
 *   - the standalone `archon skill install` CLI command
 *   - the interactive setup wizard (`archon setup`)
 *   - the server's POST /api/codebases/{id}/skills REST endpoint
 *     (the "Install skills" button in the Web UI)
 *
 * The bundled files are dynamically imported here so the heavy
 * `import … with { type: 'text' }` block only executes when this
 * function is actually called. Compiled binaries (`bun build --compile`)
 * still statically embed the chunk; linked-source installs don't touch
 * the source skill files unless the user runs an install command.
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

/** Write a skill's relative-path→content map under <skillRoot>, creating dirs as needed. */
function writeSkillFiles(skillRoot: string, files: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const dest = join(skillRoot, relativePath);
    const destDir = dirname(dest);
    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }
    writeFileSync(dest, content);
  }
}

export interface InstallResult {
  /** Project path the skills were installed into. */
  targetPath: string;
  /** The two roots the skills landed in (Claude Code + Codex). */
  skillsRoots: string[];
  /** File count written into each root (archon + manage-run). */
  fileCount: number;
}

/**
 * Copy the bundled Archon skills into <targetPath>/.claude/skills/ (Claude Code)
 * and <targetPath>/.agents/skills/ (Codex):
 *   - `archon`     — the broad authoring/setup/run skill
 *   - `manage-run` — the focused run-management skill
 */
export async function installArchonSkills(targetPath: string): Promise<InstallResult> {
  const { BUNDLED_SKILL_FILES, BUNDLED_MANAGE_RUN_SKILL_FILES } = await import('./bundled-skill');
  const skillsRoots = [
    join(targetPath, '.claude', 'skills'),
    join(targetPath, '.agents', 'skills'),
  ];

  const fileCount =
    Object.keys(BUNDLED_SKILL_FILES).length + Object.keys(BUNDLED_MANAGE_RUN_SKILL_FILES).length;

  for (const skillsRoot of skillsRoots) {
    writeSkillFiles(join(skillsRoot, 'archon'), BUNDLED_SKILL_FILES);
    writeSkillFiles(join(skillsRoot, 'manage-run'), BUNDLED_MANAGE_RUN_SKILL_FILES);
  }

  return { targetPath, skillsRoots, fileCount };
}
