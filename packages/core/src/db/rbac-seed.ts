/**
 * Idempotent RBAC seed — runs on server startup after the schema is
 * applied. Creates the default permissions catalog, the four
 * system roles, and the role↔permission bindings.
 *
 * Calling seed() on a database that already has the catalog is a
 * no-op (INSERT ... ON CONFLICT DO NOTHING / DO UPDATE). Removing
 * a permission from the seed does NOT remove it from existing
 * role_permissions rows — operator-managed bindings outlive the
 * seed. This matches the standard "seed vs config" pattern.
 *
 * Where the seed runs:
 *   - Postgres: invoked from packages/server startup after the
 *     bundled-schema apply (gen_random_uuid() is available).
 *   - SQLite: invoked from the SQLite adapter's createSchema
 *     bootstrap path.
 */
import { pool, getDatabaseType } from './connection';
import { createLogger } from '@archon/paths';
import * as rolesDb from './roles';
import * as permsDb from './permissions';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.rbac-seed');
  return cachedLog;
}

// The seed is fully idempotent (INSERT OR IGNORE / ON CONFLICT DO NOTHING)
// but it is NOT cheap — 24 perms + 4 roles + 60 bindings, each requiring
// 2-3 SELECT/INSERT queries against the DB. The first call after process
// boot runs it; every subsequent call is a no-op. This is critical for
// tests: every test that constructs an adapter triggers a fresh
// initSchema() and would otherwise re-run the seed against the singleton
// real DB, causing cascading slow-downs.
let seedPromise: Promise<{
  permissionsCreated: number;
  rolesCreated: number;
  bindingsCreated: number;
}> | null = null;

/**
 * The closed catalog of permission slugs the gate helper knows how
 * to interpret. New permissions go here; the admin UI does NOT
 * create new ones (it only toggles which roles hold each one).
 *
 * Conventions:
 *   - 'chat:*'         — direct chat access (send messages, read history)
 *   - 'memory:*'       — Memory system (Path B)
 *   - 'sandbox:*'      — Sandbox Mode (create/merge/discard)
 *   - 'git:*'          — Git Turbo (revert, publish)
 *   - 'codebases:*'    — register / read codebases
 *   - 'workflows:*'    — run / list workflow runs
 *   - 'agents:*'       — install / configure agents
 *   - 'admin:invites'  — create/revoke invites
 *   - 'admin:users'    — manage users + role assignments
 *   - 'admin:roles'    — manage roles + permission bindings
 */
export const SEED_PERMISSIONS: readonly {
  slug: string;
  name: string;
  description: string;
  category: string;
}[] = [
  // Chat
  {
    slug: 'chat:send',
    name: 'Send chat messages',
    description: 'Post messages in any conversation the user owns.',
    category: 'Chat',
  },
  {
    slug: 'chat:read',
    name: 'Read chat history',
    description: 'List and read past messages in any conversation.',
    category: 'Chat',
  },

  // Memory
  {
    slug: 'memory:read',
    name: 'Read memory',
    description: 'Recall facts the agent has stored across sessions.',
    category: 'Memory',
  },
  {
    slug: 'memory:write',
    name: 'Write memory',
    description: 'Persist new facts (preferences, project context, feedback).',
    category: 'Memory',
  },
  {
    slug: 'memory:delete',
    name: 'Delete memory',
    description: 'Remove a stored fact.',
    category: 'Memory',
  },

  // Sandbox
  {
    slug: 'sandbox:create',
    name: 'Create sandbox',
    description: 'Open a new branch+worktree for safe experimentation.',
    category: 'Sandbox',
  },
  {
    slug: 'sandbox:list',
    name: 'List sandboxes',
    description: 'See all active sandboxes for a project.',
    category: 'Sandbox',
  },
  {
    slug: 'sandbox:diff',
    name: 'View sandbox diff',
    description: 'Read the stat + preview of a sandbox vs its base branch.',
    category: 'Sandbox',
  },
  {
    slug: 'sandbox:merge',
    name: 'Approve / merge sandbox',
    description: 'Merge a sandbox into its base branch.',
    category: 'Sandbox',
  },
  {
    slug: 'sandbox:discard',
    name: 'Discard sandbox',
    description: 'Delete a sandbox without merging.',
    category: 'Sandbox',
  },

  // Git
  {
    slug: 'git:revert',
    name: 'Revert last commit',
    description: 'Undo the most recent commit on a codebase worktree.',
    category: 'Git',
  },
  {
    slug: 'git:publish',
    name: 'Publish branch',
    description: 'git push --set-upstream origin HEAD on a sandbox branch.',
    category: 'Git',
  },

  // Codebases
  {
    slug: 'codebases:read',
    name: 'Read codebases',
    description: 'List and inspect registered codebases.',
    category: 'Codebases',
  },
  {
    slug: 'codebases:write',
    name: 'Register / update codebases',
    description: 'Add new projects, update paths, remove old ones.',
    category: 'Codebases',
  },
  {
    slug: 'codebases:env',
    name: 'Manage codebase env vars',
    description: 'Edit per-codebase environment variables.',
    category: 'Codebases',
  },

  // Workflows
  {
    slug: 'workflows:read',
    name: 'Read workflow runs',
    description: 'List and inspect past and active runs.',
    category: 'Workflows',
  },
  {
    slug: 'workflows:run',
    name: 'Run workflows',
    description: 'Kick off a new workflow run.',
    category: 'Workflows',
  },
  {
    slug: 'workflows:cancel',
    name: 'Cancel / abandon runs',
    description: 'Stop a non-terminal run.',
    category: 'Workflows',
  },
  {
    slug: 'workflows:approve',
    name: 'Approve / reject gates',
    description: 'Resolve a paused approval gate.',
    category: 'Workflows',
  },

  // Agents
  {
    slug: 'agents:read',
    name: 'Read installed agents',
    description: 'List the agent catalog and routing audit.',
    category: 'Agents',
  },
  {
    slug: 'agents:install',
    name: 'Install / remove agents',
    description: 'Add or remove agents from the local catalog.',
    category: 'Agents',
  },

  // Admin
  {
    slug: 'admin:invites',
    name: 'Manage invites',
    description: 'Create, list, and revoke auth invites.',
    category: 'Admin',
  },
  {
    slug: 'admin:users',
    name: 'Manage users',
    description: 'Edit users, assign roles, set per-user permission overrides.',
    category: 'Admin',
  },
  {
    slug: 'admin:roles',
    name: 'Manage roles',
    description: 'Create / edit / delete roles and bind permissions to them.',
    category: 'Admin',
  },
];

/**
 * The four system roles. All four are is_system=true (the operator
 * cannot delete them from the admin UI). Their permission sets are
 * the "starter template" — operators can extend them with custom
 * permissions and roles, but the seed leaves the four in place.
 *
 * `admin` is the only role that can manage OTHER users (admin:users,
 * admin:roles). `member` is the baseline: chat, own memory, own
 * workflows. `sandbox-user` adds the git+sandbox powers to member.
 * `viewer` is read-only.
 */
export const SEED_ROLES: readonly {
  slug: string;
  name: string;
  description: string;
  permissions: readonly string[];
}[] = [
  {
    slug: 'admin',
    name: 'Administrator',
    description: 'Full access — manages users, roles, codebases, and every privileged action.',
    permissions: SEED_PERMISSIONS.map(p => p.slug),
  },
  {
    slug: 'member',
    name: 'Member',
    description:
      'Default role for any accepted user. Chat, read history, manage own memory, run workflows, view codebases.',
    permissions: [
      'chat:send',
      'chat:read',
      'memory:read',
      'memory:write',
      'codebases:read',
      'workflows:read',
      'workflows:run',
      'workflows:cancel',
      'workflows:approve',
      'sandbox:list',
      'sandbox:diff',
      'agents:read',
    ],
  },
  {
    slug: 'sandbox-user',
    name: 'Sandbox User',
    description: 'Member + the ability to create, merge, and discard sandboxes + git operations.',
    permissions: [
      // member subset
      'chat:send',
      'chat:read',
      'memory:read',
      'memory:write',
      'codebases:read',
      'workflows:read',
      'workflows:run',
      'workflows:cancel',
      'workflows:approve',
      'sandbox:list',
      'sandbox:diff',
      'agents:read',
      // + sandbox writes + git
      'sandbox:create',
      'sandbox:merge',
      'sandbox:discard',
      'git:revert',
      'git:publish',
    ],
  },
  {
    slug: 'viewer',
    name: 'Viewer',
    description: 'Read-only. Cannot send chat, modify memory, or touch codebases.',
    permissions: [
      'chat:read',
      'memory:read',
      'codebases:read',
      'workflows:read',
      'sandbox:list',
      'sandbox:diff',
      'agents:read',
    ],
  },
];

/**
 * Idempotent INSERT for a permission. Uses ON CONFLICT (slug) DO
 * NOTHING on Postgres and INSERT OR IGNORE on SQLite — both converge
 * to the same "row present" state without throwing on a duplicate.
 *
 * The pool.query is the public one from connection.ts: it auto-routes
 * to the right adapter. We branch the SQL by getDatabaseType() rather
 * than relying on the adapter to translate `ON CONFLICT` because the
 * SQLite adapter only translates `$N` placeholders, not the conflict
 * clause itself.
 */
async function insertPermissionIdempotent(perm: {
  slug: string;
  name: string;
  description: string;
  category: string;
}): Promise<void> {
  if (getDatabaseType() === 'postgresql') {
    await pool.query(
      `INSERT INTO remote_agent_permissions (slug, name, description, category)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (slug) DO NOTHING`,
      [perm.slug, perm.name, perm.description, perm.category]
    );
  } else {
    // SQLite: use the native IGNORE form. We do NOT use ON CONFLICT
    // because the SQLite adapter does not translate the clause —
    // older SQLite (<3.24) lacks the syntax and would throw.
    await pool.query(
      `INSERT OR IGNORE INTO remote_agent_permissions (slug, name, description, category)
       VALUES (?, ?, ?, ?)`,
      [perm.slug, perm.name, perm.description, perm.category]
    );
  }
}

async function insertRoleIdempotent(role: {
  slug: string;
  name: string;
  description: string;
}): Promise<void> {
  if (getDatabaseType() === 'postgresql') {
    await pool.query(
      `INSERT INTO remote_agent_roles (slug, name, description, is_system)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (slug) DO NOTHING`,
      [role.slug, role.name, role.description]
    );
  } else {
    await pool.query(
      `INSERT OR IGNORE INTO remote_agent_roles (slug, name, description, is_system)
       VALUES (?, ?, ?, 1)`,
      [role.slug, role.name, role.description]
    );
  }
}

async function insertRolePermissionIdempotent(
  roleId: string,
  permissionId: string
): Promise<boolean> {
  if (getDatabaseType() === 'postgresql') {
    const result = await pool.query(
      `INSERT INTO remote_agent_role_permissions (role_id, permission_id)
       VALUES ($1, $2)
       ON CONFLICT (role_id, permission_id) DO NOTHING`,
      [roleId, permissionId]
    );
    return (result.rowCount ?? 0) > 0;
  }
  const result = await pool.query(
    `INSERT OR IGNORE INTO remote_agent_role_permissions (role_id, permission_id)
     VALUES (?, ?)`,
    [roleId, permissionId]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Run the seed. Safe to call on every startup — the underlying
 * queries use ON CONFLICT (Postgres) / INSERT OR IGNORE (SQLite) to
 * converge. Returns counts of created vs already-present rows for
 * the startup log line.
 *
 * Per-process memoization: the seed itself is idempotent, but running
 * it 37 times in a test suite (once per PostgresAdapter constructed
 * by beforeEach) cascades SQLite lock contention and blows the 45s
 * bun:test timeout. The memoized promise makes the first call do the
 * work and every subsequent call return the same result immediately.
 *
 * If the seed throws, the cached promise is cleared so a later call
 * can retry — we do not want a transient DB error to brick the gate
 * helper for the rest of the process lifetime.
 */
export function seedRbac(): Promise<{
  permissionsCreated: number;
  rolesCreated: number;
  bindingsCreated: number;
}> {
  if (seedPromise) return seedPromise;
  seedPromise = runSeed().catch(err => {
    seedPromise = null;
    throw err;
  });
  return seedPromise;
}

async function runSeed(): Promise<{
  permissionsCreated: number;
  rolesCreated: number;
  bindingsCreated: number;
}> {
  let permissionsCreated = 0;
  let rolesCreated = 0;
  let bindingsCreated = 0;

  // 1. Permissions — idempotent insert. Self-heal name/description/category
  //    so renaming a permission in the seed propagates on next deploy
  //    without a manual migration.
  for (const perm of SEED_PERMISSIONS) {
    const before = await permsDb.getPermissionBySlug(perm.slug);
    await insertPermissionIdempotent(perm);
    if (before === null) permissionsCreated += 1;
    // Self-heal the human-facing fields. INSERT OR IGNORE / ON CONFLICT
    // DO NOTHING above leaves existing rows untouched; the UPDATE here
    // is what makes the seed re-runnable across renames.
    if (getDatabaseType() === 'postgresql') {
      await pool.query(
        `UPDATE remote_agent_permissions
         SET name = $1, description = $2, category = $3
         WHERE slug = $4`,
        [perm.name, perm.description, perm.category, perm.slug]
      );
    } else {
      await pool.query(
        `UPDATE remote_agent_permissions
         SET name = ?, description = ?, category = ?
         WHERE slug = ?`,
        [perm.name, perm.description, perm.category, perm.slug]
      );
    }
  }

  // 2. Roles — idempotent. is_system=true for the four seeds.
  for (const role of SEED_ROLES) {
    const before = await rolesDb.getRoleBySlug(role.slug);
    await insertRoleIdempotent(role);
    if (before === null) rolesCreated += 1;
    // Self-heal name + description + is_system flag.
    if (getDatabaseType() === 'postgresql') {
      await pool.query(
        `UPDATE remote_agent_roles
         SET name = $1, description = $2, is_system = TRUE
         WHERE slug = $3`,
        [role.name, role.description, role.slug]
      );
    } else {
      await pool.query(
        `UPDATE remote_agent_roles
         SET name = ?, description = ?, is_system = 1
         WHERE slug = ?`,
        [role.name, role.description, role.slug]
      );
    }
  }

  // 3. Role ↔ Permission bindings — one row per (role, permission)
  //    in the seed. Existing bindings are preserved; new ones are
  //    added. We never DELETE a binding here so operator edits to
  //    the role's permission set survive the next startup.
  for (const role of SEED_ROLES) {
    const r = await rolesDb.getRoleBySlug(role.slug);
    if (r === null) continue;
    for (const permSlug of role.permissions) {
      const p = await permsDb.getPermissionBySlug(permSlug);
      if (p === null) continue;
      const created = await insertRolePermissionIdempotent(r.id, p.id);
      if (created) bindingsCreated += 1;
    }
  }

  getLog().info({ permissionsCreated, rolesCreated, bindingsCreated }, 'rbac_seed_completed');
  return { permissionsCreated, rolesCreated, bindingsCreated };
}
