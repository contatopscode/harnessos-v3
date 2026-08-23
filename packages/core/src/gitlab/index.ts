/**
 * GitLab integration — public surface.
 *
 * Re-exports the client + settings store so server-side code can
 * `import { GitlabClient, getGitlabSettings, saveGitlabSettings,
 * testGitlabConnection, buildGitlabClient } from '@archon/core/gitlab'`
 * and stay agnostic of the internal file layout.
 */
export {
  GitlabClient,
  GitlabApiError,
  type GitlabUser,
  type GitlabProject,
  type GitlabIssue,
  type CreateIssueParams,
  type UpdateIssueParams,
  type ListIssuesParams,
  type GitlabClientOptions,
} from './client';

export {
  getGitlabSettings,
  saveGitlabSettings,
  testGitlabConnection,
  buildGitlabClient,
  type GitlabSettingsView,
  type SaveGitlabSettingsParams,
  type TestGitlabConnectionResult,
} from './settings-store';
