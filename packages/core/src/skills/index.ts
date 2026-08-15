/**
 * Skills public surface for `@archon/core/skills`.
 *
 * Re-exports the install helper + the bundled file maps so the CLI, server,
 * and tests can all reach the same code without reaching into private
 * subpaths. The bundled file maps (`BUNDLED_SKILL_FILES`,
 * `BUNDLED_MANAGE_RUN_SKILL_FILES`) are the literal text-import chunks the
 * install helper uses to populate the on-disk `.claude/skills/<name>/` and
 * `.agents/skills/<name>/` trees.
 */
export { installArchonSkills, type InstallResult } from './install';
export { BUNDLED_SKILL_FILES, BUNDLED_MANAGE_RUN_SKILL_FILES } from './bundled-skill';
