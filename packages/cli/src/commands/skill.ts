/**
 * Skill command - Install bundled Archon skill files into a project.
 *
 * Writes the bundled `archon` skill (SKILL.md, guides, references, examples) and
 * the focused `manage-run` skill into <targetPath>/.claude/skills/<skill>/ (for
 * Claude Code) and <targetPath>/.agents/skills/<skill>/ (the canonical Codex
 * project-level skill path) so both Claude Code and Codex pick them up.
 *
 * Always overwrites existing files to ensure the latest skill version
 * shipped with the current Archon binary is installed.
 *
 * The actual file-system work is delegated to `@archon/core/skills/install` so
 * the Web UI's "Install skills" button, the interactive setup wizard, and the
 * CLI all share one implementation — including the dynamic
 * `import { type: 'text' }` chunk indirection that keeps `archon --help` cheap
 * on linked-source installs.
 */
import { existsSync } from 'fs';
import { resolve } from 'path';
import { installArchonSkills } from '@archon/core';

/**
 * Install the bundled Archon skill into a project directory.
 *
 * Returns an exit code: 0 on success, 1 on failure.
 */
export async function skillInstallCommand(targetPath: string): Promise<number> {
  const absoluteTarget = resolve(targetPath);

  if (!existsSync(absoluteTarget)) {
    console.error(`Error: Directory does not exist: ${absoluteTarget}`);
    return 1;
  }

  try {
    const installTargets = [`${absoluteTarget}/.claude/skills`, `${absoluteTarget}/.agents/skills`];
    console.log(
      `Installing Archon skills (archon + manage-run) into ${installTargets.join(' and ')}`
    );

    const result = await installArchonSkills(absoluteTarget);
    console.log(
      `Wrote ${result.fileCount} files per destination. Restart Claude Code or Codex to load the skills.`
    );
    return 0;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    console.error(`Error: Failed to install skill: ${err.message}`);
    return 1;
  }
}

/**
 * Copy the bundled Archon skills into <targetPath> (file-system only, no console output).
 *
 * Thin wrapper around `@archon/core/skills/install.installArchonSkills` for the CLI's
 * `setup` test suite and any other programmatic caller that wants the install side-effect
 * without the `skillInstallCommand` CLI decorations. Returns when the files are written.
 */
export async function copyArchonSkill(targetPath: string): Promise<void> {
  await installArchonSkills(resolve(targetPath));
}
