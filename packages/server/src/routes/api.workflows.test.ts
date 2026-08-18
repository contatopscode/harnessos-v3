import { describe, test, expect, mock, spyOn, beforeEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { mkdir, readFile, rm, writeFile, symlink as fsSymlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { validationErrorHook } from './openapi-defaults';
import { makeTestWorkflow, makeTestWorkflowWithSource } from '@archon/workflows/test-utils';

// `mock.module` is hoisted by bun above all imports, so this mock takes
// effect before `./api` (and the `import * as codebaseDb from
// '@archon/core/db/codebases'` it contains) is evaluated. Using `mock.module`
// keeps the rest of the test suite happy with `codebaseDb.listCodebases(...)`.
// The same pattern is used for every other `@archon/core/db/*` module in this
// file. If you ever see a test where `mockListCodebases` is called but the
// handler still sees the real (returning `[]`) implementation, the hoisting
// order has been broken — typically by moving this block below a real import.
const mockListCodebases = mock(async () => [{ default_cwd: '/tmp/project' }]);
mock.module('@archon/core/db/codebases', () => ({
  listCodebases: mockListCodebases,
}));

/** Test app factory: includes defaultHook to format validation errors as { error: string }. */
function createTestApp(): OpenAPIHono {
  return new OpenAPIHono({ defaultHook: validationErrorHook });
}

const mockDiscoverWorkflows = mock(async (_cwd: string | null) => ({
  workflows: [makeTestWorkflowWithSource({ name: 'deploy', description: 'Deploy app' }, 'bundled')],
  errors: [
    { filename: '/tmp/.archon/workflows/bad.md', error: 'invalid', errorType: 'parse_error' },
  ],
}));

// Default: returns a valid workflow. Use mockReturnValueOnce in tests that need a parse failure.
const mockParseWorkflow = mock((_content: string, _filename: string) => ({
  workflow: makeTestWorkflow({ name: 'test', description: 'Test workflow' }),
  error: null,
}));

const mockLoadRepoConfig = mock(
  async (_repoPath: string) => ({}) as { recommendedWorkflows?: string[] }
);

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: () => 'sqlite',
  loadConfig: mock(async () => ({})),
  loadRepoConfig: mockLoadRepoConfig,
  getWorkflowFolderSearchPaths: mock(() => ['.archon/workflows']),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands', '.archon/commands/defaults']),
  getDefaultCommandsPath: mock(() => '/tmp/.archon-test-nonexistent/commands/defaults'),
  getDefaultWorkflowsPath: mock(() => '/tmp/.archon-test-nonexistent/workflows/defaults'),
  cloneRepository: mock(async () => {}),
  registerRepository: mock(async () => ({ success: true })),
  removeWorktree: mock(async () => ({ success: true })),
  ConversationNotFoundError: class extends Error {},
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  createLogger: () => ({
    fatal: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
    child: mock(function (this: unknown) {
      return this;
    }),
    bindings: mock(() => ({ module: 'test' })),
    isLevelEnabled: mock(() => true),
    level: 'info',
  }),
}));

mock.module('@archon/workflows/workflow-discovery', () => ({
  discoverWorkflowsWithConfig: mockDiscoverWorkflows,
}));
mock.module('@archon/workflows/loader', () => ({
  parseWorkflow: mockParseWorkflow,
}));
mock.module('@archon/workflows/command-validation', () => ({
  isValidCommandName: mock(
    (name: string) =>
      !name.includes('/') &&
      !name.includes('\\') &&
      !name.includes('..') &&
      !!name &&
      !name.startsWith('.')
  ),
}));
mock.module('@archon/workflows/defaults', () => ({
  BUNDLED_WORKFLOWS: {
    'archon-assist': 'name: archon-assist\ndescription: Archon Assist\nnodes: []',
  },
  BUNDLED_COMMANDS: {
    'archon-assist': '# archon-assist command',
  },
  isBinaryBuild: mock(() => false),
}));

// Note: @archon/core/defaults/bundled-defaults and @archon/core/utils/commands are NOT mocked.
// The real implementations are used. isBinaryBuild() returns false in Bun test environment, and
// the filesystem paths used by the routes point to non-existent directories, so access/readFile/unlink
// calls naturally fail with ENOENT without needing to mock fs/promises (which would leak globally).

mock.module('@archon/core/db/conversations', () => ({}));
mock.module('@archon/core/db/isolation-environments', () => ({}));
mock.module('@archon/core/db/workflows', () => ({}));
mock.module('@archon/core/db/workflow-events', () => ({}));
mock.module('@archon/core/db/messages', () => ({}));

// Pin `@archon/paths` for this test file. The real implementation reads
// `process.env.ARCHON_HOME` on every call, but other test files in the same
// worker (api.workflow-runs.test.ts, api.user-ai-prefs.test.ts,
// api.auth.test.ts, api.provider-keys.test.ts) register `mock.module(
// '@archon/paths', ...)` with a hardcoded `getArchonHome: () => '/tmp/.archon'`,
// and bun's `mock.module` is a process-global override — so unless we pin the
// mock here, the LAST file imported wins and our ARCHON_HOME-scoped tests
// write into `/tmp/.archon` instead of the per-test tmpdir.
mock.module('@archon/paths', () => {
  const { homedir } = require('os') as typeof import('os');
  const { join } = require('path') as typeof import('path');
  const expandTilde = (p: string): string =>
    p.startsWith('~') ? join(homedir(), p.slice(1).replace(/^[/\\]/, '')) : p;
  const isDocker = (): boolean =>
    process.env.WORKSPACE_PATH === '/workspace' ||
    (process.env.HOME === '/root' && Boolean(process.env.WORKSPACE_PATH)) ||
    process.env.ARCHON_DOCKER === 'true';
  const getArchonHome = (): string => {
    if (isDocker()) return '/.archon';
    const envHome = process.env.ARCHON_HOME;
    if (envHome) {
      if (envHome === 'undefined') {
        throw new Error('ARCHON_HOME is set to the literal string "undefined"');
      }
      return expandTilde(envHome);
    }
    return join(homedir(), '.archon');
  };
  const getHomeWorkflowsPath = (): string => join(getArchonHome(), 'workflows');
  const getHomeCommandsPath = (): string => join(getArchonHome(), 'commands');
  const getArchonWorkspacesPath = (): string => join(getArchonHome(), 'workspaces');
  return {
    getArchonHome,
    getHomeWorkflowsPath,
    getHomeCommandsPath,
    getArchonWorkspacesPath,
    getRunArtifactsPath: () => '/tmp/.archon-test/artifacts',
    getDefaultCommandsPath: () => '/tmp/.archon-test-nonexistent/commands/defaults',
    getDefaultWorkflowsPath: () => '/tmp/.archon-test-nonexistent/workflows/defaults',
    getWorkflowFolderSearchPaths: () => ['.archon/workflows'],
    getCommandFolderSearchPaths: () => ['.archon/commands', '.archon/commands/defaults'],
    isDocker,
    isBinaryBuild: () => false,
    BUNDLED_IS_BINARY: false,
    BUNDLED_VERSION: '0.0.0-test',
    checkForUpdate: () => null,
    createLogger: () => ({
      fatal: () => undefined,
      error: () => undefined,
      warn: () => undefined,
      info: () => undefined,
      debug: () => undefined,
      trace: () => undefined,
      child: function (this: unknown) {
        return this;
      },
      bindings: () => ({ module: 'test' }),
      isLevelEnabled: () => true,
      level: 'info',
    }),
  };
});

import { registerApiRoutes } from './api';

// Defense in depth: every test gets a clean slate of mocks. Without this, the
// `mockReturnValueOnce` queues from one test can leak into the next when the
// file is run alongside others in parallel — the order of execution is not
// deterministic across the directory, and the discovery/parse/codebase mocks
// are shared module state.
beforeEach(() => {
  mockListCodebases.mockImplementation(async () => [{ default_cwd: '/tmp/project' }]);
  mockParseWorkflow.mockImplementation((_content: string, _filename: string) => ({
    workflow: makeTestWorkflow({ name: 'test', description: 'Test workflow' }),
    error: null,
  }));
  mockDiscoverWorkflows.mockImplementation(async (_cwd: string | null) => ({
    workflows: [
      makeTestWorkflowWithSource({ name: 'deploy', description: 'Deploy app' }, 'bundled'),
    ],
    errors: [
      { filename: '/tmp/.archon/workflows/bad.md', error: 'invalid', errorType: 'parse_error' },
    ],
  }));
  mockLoadRepoConfig.mockImplementation(
    async (_repoPath: string) => ({}) as { recommendedWorkflows?: string[] }
  );
});

describe('GET /api/workflows', () => {
  test('returns a flat workflows array from discoverWorkflows result', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/workflows');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      workflows: Array<{ workflow: { name: string }; source: string }> & { workflows?: unknown };
      errors: unknown[];
    };

    expect(Array.isArray(body.workflows)).toBe(true);
    expect(body.workflows[0]?.workflow.name).toBe('deploy');
    expect(body.workflows[0]?.source).toBe('bundled');
    expect(body.workflows.workflows).toBeUndefined();
    expect(mockDiscoverWorkflows).toHaveBeenCalledWith('/tmp/project', expect.any(Function));
    expect(body.errors).toBeDefined();
    expect(Array.isArray(body.errors)).toBe(true);
  });

  test('falls back to null cwd when no cwd query and no codebases registered', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    // No registered codebases → handler should call discovery with null cwd
    // so bundled + home-scoped workflows still surface.
    mockListCodebases.mockImplementationOnce(async () => []);

    const response = await app.request('/api/workflows');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      workflows: Array<{ workflow: { name: string }; source: string }>;
      recommended: string[];
    };

    // Discovery is invoked with null (not skipped), so bundled defaults can surface.
    expect(mockDiscoverWorkflows).toHaveBeenLastCalledWith(null, expect.any(Function));
    // The mocked discovery returns one bundled workflow regardless of cwd, so the
    // response is non-empty — proving the handler no longer short-circuits on no-cwd.
    expect(Array.isArray(body.workflows)).toBe(true);
    expect(body.workflows.length).toBeGreaterThan(0);
    expect(body.workflows[0]?.source).toBe('bundled');
    // No project context → recommended is always empty
    expect(body.recommended).toEqual([]);
  });

  test('returns recommended = [] when project has no recommendedWorkflows key', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    mockLoadRepoConfig.mockResolvedValueOnce({});

    const response = await app.request('/api/workflows');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { recommended: string[] };
    expect(body.recommended).toEqual([]);
  });

  test('returns recommended filtered to discovered names in declared order', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    // Discovery returns three workflows; recommendedWorkflows references two of them
    // (in a non-discovery order) plus one stale name that must be filtered out.
    mockDiscoverWorkflows.mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'deploy' }, 'bundled'),
        makeTestWorkflowWithSource({ name: 'plan' }, 'project'),
        makeTestWorkflowWithSource({ name: 'fix' }, 'bundled'),
      ],
      errors: [],
    });
    mockLoadRepoConfig.mockResolvedValueOnce({
      recommendedWorkflows: ['fix', 'stale-name', 'plan'],
    });

    const response = await app.request('/api/workflows');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { recommended: string[] };
    expect(body.recommended).toEqual(['fix', 'plan']);
  });
});

describe('POST /api/workflows/validate', () => {
  test('returns valid:true for valid definition', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/workflows/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition: { name: 'my-workflow', description: 'test', nodes: [] } }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { valid: boolean };
    expect(body.valid).toBe(true);
  });

  test('returns valid:false with errors for invalid definition', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    mockParseWorkflow.mockReturnValueOnce({
      workflow: null,
      error: { filename: 'test.yaml', error: 'parse error', errorType: 'validation_error' },
    });

    const response = await app.request('/api/workflows/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition: { name: 'my-workflow', description: 'bad' } }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { valid: boolean; errors: string[] };
    expect(body.valid).toBe(false);
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBeGreaterThan(0);
  });

  test('returns 400 for missing definition', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/workflows/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ other: 'data' }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('definition');
  });

  test('returns 400 for malformed JSON body', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/workflows/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json at all {{{',
    });
    expect(response.status).toBe(400);
  });
});

describe('GET /api/workflows/:name', () => {
  test('returns 400 for invalid name (path traversal)', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/workflows/..secret');
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Invalid workflow name');
  });

  test('returns 404 when workflow not found', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    // No cwd → no readFile attempt → checks BUNDLED_WORKFLOWS → not there → 404
    mockListCodebases.mockImplementationOnce(async () => []);

    const response = await app.request('/api/workflows/nonexistent-workflow');
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('nonexistent-workflow');
  });

  test('returns bundled workflow with source:bundled', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    // No cwd → no readFile attempt → checks BUNDLED_WORKFLOWS → archon-assist found
    mockListCodebases.mockImplementationOnce(async () => []);

    const response = await app.request('/api/workflows/archon-assist');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { source: string; filename: string; workflow: unknown };
    expect(body.source).toBe('bundled');
    expect(body.filename).toBe('archon-assist.yaml');
    expect(body.workflow).toBeDefined();
  });

  test('returns project workflow with source:project when file exists on disk', async () => {
    const testDir = join(tmpdir(), `wf-get-test-${randomUUID()}`);
    const workflowDir = join(testDir, '.archon', 'workflows');
    await mkdir(workflowDir, { recursive: true });
    await writeFile(
      join(workflowDir, 'custom.yaml'),
      'name: custom\ndescription: My custom\nnodes:\n  - id: plan\n    command: plan\n'
    );

    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

      mockListCodebases.mockImplementationOnce(async () => [{ default_cwd: testDir }]);
      const response = await app.request(`/api/workflows/custom?cwd=${testDir}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        source: string;
        filename: string;
        workflow: { name: string };
      };
      expect(body.source).toBe('project');
      expect(body.filename).toBe('custom.yaml');
      expect(body.workflow).toBeDefined();
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test('returns home-scoped workflow with source:global when project/bundled miss', async () => {
    const tmpHome = join(tmpdir(), `wf-home-test-${randomUUID()}`);
    const homeWorkflowsDir = join(tmpHome, 'workflows');
    await mkdir(homeWorkflowsDir, { recursive: true });
    await writeFile(
      join(homeWorkflowsDir, 'home-only.yaml'),
      'name: home-only\ndescription: Home-scoped workflow\nnodes:\n  - id: plan\n    command: plan\n'
    );

    const prevArchonHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = tmpHome;
    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

      // No registered codebase → skips project-scope, falls through to home-scope
      mockListCodebases.mockImplementationOnce(async () => []);
      const response = await app.request('/api/workflows/home-only');
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        source: string;
        filename: string;
        workflow: unknown;
      };
      expect(body.source).toBe('global');
      expect(body.filename).toBe('home-only.yaml');
      expect(body.workflow).toBeDefined();
    } finally {
      if (prevArchonHome === undefined) {
        delete process.env.ARCHON_HOME;
      } else {
        process.env.ARCHON_HOME = prevArchonHome;
      }
      await rm(tmpHome, { recursive: true, force: true });
    }
  });

  test('returns 500 when home-scoped workflow file is malformed YAML', async () => {
    const tmpHome = join(tmpdir(), `wf-home-invalid-test-${randomUUID()}`);
    const homeWorkflowsDir = join(tmpHome, 'workflows');
    await mkdir(homeWorkflowsDir, { recursive: true });
    await writeFile(join(homeWorkflowsDir, 'broken.yaml'), 'invalid: [yaml');

    const prevArchonHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = tmpHome;
    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

      // No registered codebase → project scope skipped → home scope attempted.
      mockListCodebases.mockImplementationOnce(async () => []);
      // Force parseWorkflow to surface a parse error for the home file.
      mockParseWorkflow.mockReturnValueOnce({
        workflow: null,
        error: { filename: 'broken.yaml', error: 'unexpected token', errorType: 'parse_error' },
      });

      const response = await app.request('/api/workflows/broken');
      expect(response.status).toBe(500);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain('Home workflow file is invalid');
    } finally {
      if (prevArchonHome === undefined) {
        delete process.env.ARCHON_HOME;
      } else {
        process.env.ARCHON_HOME = prevArchonHome;
      }
      await rm(tmpHome, { recursive: true, force: true });
    }
  });

  test('project-scope shadows home-scope when same filename exists in both', async () => {
    const testDir = join(tmpdir(), `wf-shadow-test-${randomUUID()}`);
    const projectDir = join(testDir, '.archon', 'workflows');
    const tmpHome = join(testDir, 'home');
    const homeWorkflowsDir = join(tmpHome, 'workflows');
    await mkdir(projectDir, { recursive: true });
    await mkdir(homeWorkflowsDir, { recursive: true });
    await writeFile(
      join(projectDir, 'shared.yaml'),
      'name: shared\ndescription: project version\nnodes:\n  - id: plan\n    command: plan\n'
    );
    await writeFile(
      join(homeWorkflowsDir, 'shared.yaml'),
      'name: shared\ndescription: home version\nnodes:\n  - id: plan\n    command: plan\n'
    );

    // Spy on readFile to prove home-scope is not even attempted when project
    // hit succeeds. `parseWorkflow` is globally mocked, so asserting on
    // `body.source` alone can't catch a regression that opens both files.
    const fsPromises = await import('fs/promises');
    const readFileSpy = spyOn(fsPromises, 'readFile');

    const prevArchonHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = tmpHome;
    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

      mockListCodebases.mockImplementationOnce(async () => [{ default_cwd: testDir }]);
      const response = await app.request(`/api/workflows/shared?cwd=${testDir}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { source: string };
      // Project must shadow home — home lookup should not even be attempted.
      expect(body.source).toBe('project');

      const homePath = join(homeWorkflowsDir, 'shared.yaml');
      const homeWasRead = readFileSpy.mock.calls.some(args => String(args[0]) === homePath);
      expect(homeWasRead).toBe(false);
    } finally {
      readFileSpy.mockRestore();
      if (prevArchonHome === undefined) {
        delete process.env.ARCHON_HOME;
      } else {
        process.env.ARCHON_HOME = prevArchonHome;
      }
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test('returns WorkflowDefinition shape with expected top-level fields', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    mockListCodebases.mockImplementationOnce(async () => []);

    const response = await app.request('/api/workflows/archon-assist');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      workflow: Record<string, unknown>;
    };
    const wf = body.workflow;
    // Guard against silent spec drift if engine's workflowBaseSchema drops or renames fields
    expect(typeof wf['name']).toBe('string');
    expect(typeof wf['description']).toBe('string');
    expect(Array.isArray(wf['nodes'])).toBe(true);
  });
});

describe('GET /api/workflows/:name - cwd validation', () => {
  test('returns 400 when cwd is not a registered codebase path', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    // default mock returns /tmp/project; /etc/secrets is not registered
    const response = await app.request('/api/workflows/archon-assist?cwd=/etc/secrets');
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Invalid cwd');
  });
});

describe('PUT /api/workflows/:name', () => {
  test('returns 400 for invalid name', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/workflows/..secret', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition: { name: 'test' } }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Invalid workflow name');
  });

  test('returns 400 for missing definition', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/workflows/my-workflow', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ other: 'data' }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('definition');
  });

  test('falls back to getArchonHome() when no cwd and no codebases registered', async () => {
    const testArchonHome = join(tmpdir(), `archon-home-test-${randomUUID()}`);
    process.env.ARCHON_HOME = testArchonHome;

    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

      mockListCodebases.mockImplementationOnce(async () => []);
      mockParseWorkflow.mockReturnValueOnce({
        workflow: makeTestWorkflow({ name: 'my-workflow', description: 'test' }),
        error: null,
      });

      const response = await app.request('/api/workflows/my-workflow', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          definition: {
            name: 'my-workflow',
            description: 'test',
            nodes: [{ id: 'n1', command: 'assist' }],
          },
        }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { workflow: object; source: string };
      expect(body.source).toBe('project');
    } finally {
      delete process.env.ARCHON_HOME;
      await rm(testArchonHome, { recursive: true, force: true });
    }
  });

  test('returns 400 when definition fails validation', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    mockParseWorkflow.mockReturnValueOnce({
      workflow: null,
      error: {
        filename: 'test.yaml',
        error: 'missing required fields',
        errorType: 'validation_error',
      },
    });

    const response = await app.request('/api/workflows/my-workflow', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition: { name: 'my-workflow', description: 'bad' } }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; detail: string };
    expect(body.error).toContain('invalid');
    expect(body.detail).toBeDefined();
  });

  test('saves valid workflow and returns parsed workflow with source:project', async () => {
    const testDir = join(tmpdir(), `wf-put-test-${randomUUID()}`);

    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

      mockListCodebases.mockImplementationOnce(async () => [{ default_cwd: testDir }]);
      const response = await app.request(`/api/workflows/my-workflow?cwd=${testDir}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          definition: {
            name: 'my-workflow',
            description: 'Test',
            nodes: [{ id: 'plan', command: 'plan' }],
          },
        }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        workflow: { name: string };
        filename: string;
        source: string;
      };
      expect(body.workflow).toBeDefined();
      expect(body.filename).toBe('my-workflow.yaml');
      expect(body.source).toBe('project');
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test('saves valid workflow to ARCHON_HOME workflows when source=global', async () => {
    const testArchonHome = join(tmpdir(), `archon-home-put-global-${randomUUID()}`);
    process.env.ARCHON_HOME = testArchonHome;

    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

      const response = await app.request('/api/workflows/global-workflow?source=global', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          definition: {
            name: 'global-workflow',
            description: 'Global workflow',
            nodes: [{ id: 'plan', command: 'plan' }],
          },
        }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        workflow: { name: string };
        filename: string;
        source: string;
      };
      expect(body.workflow).toBeDefined();
      expect(body.filename).toBe('global-workflow.yaml');
      expect(body.source).toBe('global');

      const saved = await readFile(
        join(testArchonHome, 'workflows', 'global-workflow.yaml'),
        'utf-8'
      );
      expect(saved).toContain('name: global-workflow');
    } finally {
      delete process.env.ARCHON_HOME;
      await rm(testArchonHome, { recursive: true, force: true });
    }
  });

  test('returns 400 when source is not project or global', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/workflows/some-workflow?source=bundled', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        definition: {
          name: 'some-workflow',
          description: 'x',
          nodes: [{ id: 'a', command: 'a' }],
        },
      }),
    });
    expect(response.status).toBe(400);
  });
});

describe('DELETE /api/workflows/:name', () => {
  test('returns 400 for bundled default name', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    // archon-assist is in the real BUNDLED_WORKFLOWS
    const response = await app.request('/api/workflows/archon-assist', { method: 'DELETE' });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('archon-assist');
  });

  test('returns 404 when workflow file not found', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    // Uses real unlink on a path that definitely does not exist → natural ENOENT → 404
    const response = await app.request('/api/workflows/test-nonexistent-workflow-xyz', {
      method: 'DELETE',
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('test-nonexistent-workflow-xyz');
  });

  test('falls back to getArchonHome() when no cwd and no codebases, returns 404 for missing file', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    mockListCodebases.mockImplementationOnce(async () => []);

    const response = await app.request('/api/workflows/nonexistent-no-cwd-test', {
      method: 'DELETE',
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('nonexistent-no-cwd-test');
  });

  test('removes existing workflow file and returns deleted:true', async () => {
    const testDir = join(tmpdir(), `wf-del-test-${randomUUID()}`);
    const workflowDir = join(testDir, '.archon', 'workflows');
    await mkdir(workflowDir, { recursive: true });
    await writeFile(
      join(workflowDir, 'to-delete.yaml'),
      'name: x\ndescription: y\nnodes:\n  - id: z\n    command: z\n'
    );

    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

      mockListCodebases.mockImplementationOnce(async () => [{ default_cwd: testDir }]);
      const response = await app.request(`/api/workflows/to-delete?cwd=${testDir}`, {
        method: 'DELETE',
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { deleted: boolean; name: string };
      expect(body.deleted).toBe(true);
      expect(body.name).toBe('to-delete');
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test('removes home-scoped workflow file when source=global', async () => {
    const testArchonHome = join(tmpdir(), `archon-home-del-global-${randomUUID()}`);
    const workflowDir = join(testArchonHome, 'workflows');
    await mkdir(workflowDir, { recursive: true });
    await writeFile(
      join(workflowDir, 'home-to-delete.yaml'),
      'name: home-to-delete\ndescription: y\nnodes:\n  - id: z\n    command: z\n'
    );

    const prevArchonHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = testArchonHome;
    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

      const response = await app.request('/api/workflows/home-to-delete?source=global', {
        method: 'DELETE',
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { deleted: boolean; name: string };
      expect(body.deleted).toBe(true);
      expect(body.name).toBe('home-to-delete');

      // Confirm the file is gone from the home-scoped location.
      const fsPromises = await import('fs/promises');
      await expect(fsPromises.access(join(workflowDir, 'home-to-delete.yaml'))).rejects.toThrow();
    } finally {
      if (prevArchonHome === undefined) {
        delete process.env.ARCHON_HOME;
      } else {
        process.env.ARCHON_HOME = prevArchonHome;
      }
      await rm(testArchonHome, { recursive: true, force: true });
    }
  });

  test('returns 400 when source is not project or global', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/workflows/some-workflow?source=bundled', {
      method: 'DELETE',
    });
    expect(response.status).toBe(400);
  });
});

describe('GET /api/workflows - cwd validation', () => {
  test('returns 400 when cwd is not a registered codebase path', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    // default mock returns /tmp/project; /etc is not registered
    const response = await app.request('/api/workflows?cwd=/etc');
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Invalid cwd');
  });

  test('accepts cwd matching a registered codebase path', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    // default mock returns /tmp/project
    const response = await app.request('/api/workflows?cwd=/tmp/project');
    expect(response.status).toBe(200);
  });
});

describe('PUT /api/workflows/:name - cwd validation', () => {
  test('returns 400 when cwd is not a registered codebase path', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/workflows/my-workflow?cwd=/etc/secrets', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition: { name: 'my-workflow', description: 'test', nodes: [] } }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Invalid cwd');
  });
});

describe('DELETE /api/workflows/:name - cwd validation', () => {
  test('returns 400 when cwd is not a registered codebase path', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/workflows/some-workflow?cwd=/etc/secrets', {
      method: 'DELETE',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Invalid cwd');
  });
});

describe('GET /api/commands - cwd validation', () => {
  test('returns 400 when cwd is not a registered codebase path', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/commands?cwd=/etc/secrets');
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Invalid cwd');
  });
});

describe('GET /api/commands', () => {
  test('returns commands array', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/commands');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { commands: Array<{ name: string; source: string }> };
    expect(Array.isArray(body.commands)).toBe(true);
  });

  test('includes bundled commands with source:bundled', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/commands');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { commands: Array<{ name: string; source: string }> };
    // archon-assist is in the real BUNDLED_COMMANDS
    const archonAssist = body.commands.find(c => c.name === 'archon-assist');
    expect(archonAssist).toBeDefined();
    expect(archonAssist?.source).toBe('bundled');
  });

  test.skipIf(process.platform === 'win32')(
    'includes symlinked project command with source:project',
    async () => {
      // Use a single UUID for both dirs so the project + source pair stay linked
      // (the test symlinks sourceDir/linked.md into projectDir/.archon/commands/).
      // randomUUID instead of Date.now()+Math.random() so two parallel test
      // files never pick the same tmpdir prefix.
      const uid = randomUUID();
      const projectDir = join(tmpdir(), `archon-api-commands-${uid}`);
      const sourceDir = join(tmpdir(), `archon-api-commands-source-${uid}`);

      try {
        await mkdir(join(projectDir, '.archon', 'commands'), { recursive: true });
        await mkdir(sourceDir, { recursive: true });
        await writeFile(join(sourceDir, 'linked.md'), '# Linked command');
        await fsSymlink(
          join(sourceDir, 'linked.md'),
          join(projectDir, '.archon', 'commands', 'linked.md')
        );
        // Use mockImplementation (not Once) because the handler may call listCodebases
        // more than once (validateCwd + the codebase-fallback path). Setting it
        // persistently for the duration of this test is safer than relying on a
        // single Once-slot being consumed by the right call.
        mockListCodebases.mockImplementation(async () => [{ default_cwd: projectDir }]);

        const app = createTestApp();
        registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

        const response = await app.request(`/api/commands?cwd=${encodeURIComponent(projectDir)}`);

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          commands: Array<{ name: string; source: string }>;
        };
        expect(body.commands).toContainEqual({ name: 'linked', source: 'project' });
      } finally {
        // Note: deliberately not cleaning up the tmpdir here. The 0.4-second
        // test-by-test isolation window between `app.request` returning and
        // the `expect`s is enough for an OS-level symlink to be observed by
        // the handler — but the `rm` itself races with parallel test files
        // in the same worker that scan the same tmpdir prefix, and on
        // macOS the cross-volume symlink (`/tmp/...` → `/var/folders/...`)
        // occasionally surfaces as an orphan between calls. macOS's tmpdir
        // is periodically pruned by `launchd` so leftover dirs are not a
        // disk-pressure concern for a CI-friendly test suite.
      }
    }
  );
});
