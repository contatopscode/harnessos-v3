import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import * as skill from '../skills';
import type { Project } from '../primitives/project';

interface AddProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onAdded: (project: Project) => void;
}

type Mode = 'url' | 'path';

/** Detect support for the browser's native folder picker. Chrome/Edge 86+ only. */
function hasNativeFolderPicker(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

/** Strip the parent path from a full path (best-effort, OS-agnostic). */
function parentDir(fullPath: string): string {
  const sep = fullPath.includes('\\') && !fullPath.includes('/') ? '\\' : '/';
  const idx = fullPath.lastIndexOf(sep);
  if (idx <= 0) return fullPath;
  return fullPath.slice(0, idx);
}

/** Join a parent + a single segment with the right separator. */
function joinPath(parent: string, segment: string): string {
  if (parent === '') return segment;
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  const tail = parent.endsWith(sep) || parent.endsWith('/') || parent.endsWith('\\') ? '' : sep;
  return `${parent}${tail}${segment}`;
}

function GitHubIcon({ size = 15 }: { size?: 15 | 16 }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49 0-.24-.01-.88-.01-1.73-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.63.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.36 1.12 2.94.85.09-.66.35-1.12.63-1.37-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.7 0 0 .84-.28 2.75 1.05a9.36 9.36 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.4.2 2.44.1 2.7.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.8-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.6.69.49A10.06 10.06 0 0 0 22 12.25C22 6.58 17.52 2 12 2z" />
    </svg>
  );
}

function FolderIcon({ size = 15 }: { size?: 15 | 16 }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function LinkIcon({ size = 16 }: { size?: 15 | 16 }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

/** Derive an `owner/repo` preview from a GitHub URL for the clone-path hint. */
function parseGitHubUrl(value: string): { owner: string; repo: string } {
  const m = /github\.com[/:]+([^/]+)\/([^/#?]+)/i.exec(value);
  if (m === null) return { owner: 'owner', repo: 'repo' };
  return { owner: m[1], repo: m[2].replace(/\.git$/, '') };
}

/**
 * Add-project modal, design v4: blurred scrim, centered 520px card with a
 * brand-gradient top accent, segmented GitHub/Local control with a sliding
 * indicator, 46px icon input with magenta focus ring, and a live clone-path
 * hint derived from the typed URL. Esc, ✕, Cancel, and the backdrop close it.
 *
 * "Local path" mode extra affordances:
 *   - "Browse…" button: uses the browser's native folder picker (Chrome/Edge).
 *     Note: the File System Access API returns a handle name, not the full
 *     absolute path, so this only fills the last segment. The user still
 *     needs the parent path from somewhere else (text input, history).
 *   - "Create new folder" toggle: inline form (parent + name) → server
 *     `mkdir -p` → fills the path input with the new full path. Works in
 *     every browser, no native picker required.
 */
export function AddProjectDialog({
  open,
  onClose,
  onAdded,
}: AddProjectDialogProps): ReactElement | null {
  const [mode, setMode] = useState<Mode>('url');
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Local-path helpers
  const [showCreate, setShowCreate] = useState(false);
  const [newParent, setNewParent] = useState('');
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const createNameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return (): void => {
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  // When the user types a full path, pre-fill the create-form parent.
  // When the user opens the create form with nothing typed, default to home.
  useEffect(() => {
    if (!showCreate) return;
    if (newParent !== '') return;
    if (value.trim() !== '') {
      setNewParent(parentDir(value.trim()));
    }
  }, [showCreate, value, newParent]);

  if (!open) return null;

  const isGit = mode === 'url';
  const { owner, repo } = parseGitHubUrl(value);
  const canPickFolder = !isGit && hasNativeFolderPicker();

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const project = isGit
        ? await skill.addProjectByUrl(value.trim())
        : await skill.addProjectByPath(value.trim());
      onAdded(project);
      setValue('');
      setNewParent('');
      setNewName('');
      setShowCreate(false);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * Native folder picker (Chrome/Edge 86+). The API returns a
   * FileSystemDirectoryHandle whose `.name` is just the folder name (not
   * the absolute path — browsers won't expose that for security). We use
   * the typed parent path + the picked name to build the full path.
   */
  const onBrowse = async (): Promise<void> => {
    setError(null);
    try {
      // showDirectoryPicker may exist but not be callable (e.g. iframe without
      // permission). Wrap in a function reference so TS doesn't complain.
      const picker = window.showDirectoryPicker;
      if (typeof picker !== 'function') {
        setError('Native folder picker is not available in this browser. Type the path manually.');
        return;
      }
      const handle = await picker({ mode: 'read' });
      const baseParent = value.trim() !== '' ? parentDir(value.trim()) : '';
      const next = baseParent !== '' ? joinPath(baseParent, handle.name) : handle.name;
      setValue(next);
    } catch (err) {
      // User-cancelled (AbortError) — silent. Other errors: surface them.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Folder picker failed');
    }
  };

  /**
   * Inline "Create new folder" submit. Hits POST /api/codebases/mkdir,
   * then pre-fills the main path input with the new full path so the
   * user can immediately click "Add project" to register it.
   */
  const onCreateFolder = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setCreateError(null);
    const name = newName.trim();
    if (name === '') {
      setCreateError('Folder name is required');
      createNameRef.current?.focus();
      return;
    }
    const parent = newParent.trim();
    if (parent === '') {
      setCreateError('Parent path is required');
      return;
    }
    const fullPath = joinPath(parent, name);
    setCreating(true);
    try {
      const res = await fetch('/api/codebases/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: fullPath }),
      });
      if (!res.ok) {
        const body = await res.text();
        const truncated = body.length > 200 ? body.slice(0, 200) + '...' : body;
        throw new Error(`Server returned ${res.status}: ${truncated}`);
      }
      // Server returned { ok, path }; use the canonical resolved path
      const data = (await res.json()) as { ok: boolean; path: string };
      setValue(data.path);
      setShowCreate(false);
      setNewName('');
      // Keep newParent in place so the user can create siblings quickly.
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create folder');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[6px]"
      onMouseDown={onClose}
    >
      <form
        onSubmit={e => {
          void onSubmit(e);
        }}
        onMouseDown={e => {
          e.stopPropagation();
        }}
        className="relative w-full max-w-[520px] overflow-hidden rounded-2xl border bg-surface-elevated p-[22px] text-text-primary shadow-[0_30px_80px_-24px_rgba(0,0,0,0.8)]"
        // Inline because the console scope's wildcard border-color rule
        // repaints Tailwind border utilities (see theme.css).
        style={{ borderColor: 'var(--border-bright)' }}
      >
        {/* Brand gradient top accent */}
        <span aria-hidden className="brand-bar absolute left-0 right-0 top-0 h-[2px] opacity-90" />

        {/* Header */}
        <div className="mb-[18px] flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[18px] font-extrabold tracking-[-0.3px] text-text-primary">
              Add project
            </h2>
            <p className="mt-1 text-[13px] text-text-tertiary">
              Connect a repository or a local folder as a workspace.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            aria-label="Close"
            className="rounded-lg p-1.5 text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-primary"
          >
            <span aria-hidden className="block text-[14px] leading-none">
              ✕
            </span>
          </button>
        </div>

        {/* Segmented control with sliding indicator */}
        <div
          className="relative mb-5 grid grid-cols-2 rounded-[11px] border bg-surface p-1"
          style={{ borderColor: 'var(--border)' }}
        >
          <span
            aria-hidden
            className="absolute bottom-1 left-1 top-1 w-[calc(50%-4px)] rounded-lg border bg-surface-hover transition-transform duration-200 ease-out"
            style={{
              borderColor: 'var(--border-bright)',
              transform: isGit ? 'translateX(0)' : 'translateX(100%)',
            }}
          />
          {(['url', 'path'] as const).map(m => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
              }}
              aria-pressed={mode === m}
              className={`relative z-[1] flex items-center justify-center gap-2 rounded-lg px-3 py-[9px] text-[13px] font-semibold transition-colors ${
                mode === m ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              <span aria-hidden className="flex">
                {m === 'url' ? <GitHubIcon /> : <FolderIcon />}
              </span>
              {m === 'url' ? 'GitHub URL' : 'Local path'}
            </button>
          ))}
        </div>

        {/* Field */}
        <label className="mb-[9px] block font-mono text-[11px] font-semibold uppercase tracking-[0.09em] text-text-tertiary">
          {isGit ? 'Repository URL' : 'Local folder path'}
        </label>
        <div
          className="flex h-[46px] items-center gap-2.5 rounded-[11px] border bg-surface px-3.5 transition-all focus-within:shadow-[0_0_0_4px_color-mix(in_oklch,var(--brand-magenta),transparent_91%)]"
          style={{ borderColor: 'var(--border-bright)' }}
        >
          <span aria-hidden className="flex text-text-tertiary">
            {isGit ? <LinkIcon /> : <FolderIcon size={16} />}
          </span>
          <input
            type="text"
            value={value}
            onChange={e => {
              setValue(e.target.value);
            }}
            autoFocus
            spellCheck={false}
            placeholder={
              isGit ? 'https://github.com/owner/repo' : 'C:\\Users\\you\\projects\\my-repo'
            }
            className="min-w-0 flex-1 bg-transparent font-mono text-[14px] text-text-primary outline-none placeholder:text-text-tertiary"
            disabled={submitting}
          />
          {canPickFolder ? (
            <button
              type="button"
              onClick={() => {
                void onBrowse();
              }}
              disabled={submitting}
              title="Open the native folder picker (Chrome / Edge only)"
              className="rounded-md border px-2 py-1 text-[11px] font-semibold text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
              style={{ borderColor: 'var(--border)' }}
            >
              Browse…
            </button>
          ) : null}
        </div>

        {/* Hint + create-new-folder toggle (local-path mode only) */}
        {!isGit ? (
          <div className="mt-[11px] space-y-2 text-[12.5px] leading-relaxed text-text-tertiary">
            <p>
              HarnessOS will use this existing folder as the project source — nothing is copied or
              moved.
            </p>
            {!showCreate ? (
              <button
                type="button"
                onClick={() => {
                  setShowCreate(true);
                  setTimeout(() => createNameRef.current?.focus(), 50);
                }}
                className="inline-flex items-center gap-1.5 rounded border border-dashed px-2 py-1 text-[11.5px] font-semibold text-text-secondary transition-colors hover:border-solid hover:bg-surface-hover hover:text-text-primary"
                style={{ borderColor: 'var(--border-bright)' }}
              >
                <span aria-hidden>+</span> Create new folder
              </button>
            ) : (
              <div
                className="rounded-[10px] border bg-surface p-3"
                style={{ borderColor: 'var(--border-bright)' }}
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
                    New folder
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setShowCreate(false);
                      setCreateError(null);
                    }}
                    className="text-[11px] text-text-tertiary hover:text-text-primary"
                  >
                    Cancel
                  </button>
                </div>
                <div className="space-y-2">
                  <input
                    type="text"
                    value={newParent}
                    onChange={e => {
                      setNewParent(e.target.value);
                    }}
                    placeholder="Parent path — e.g. ~/projects or /Users/you/work"
                    spellCheck={false}
                    className="block w-full rounded-md border bg-surface-elevated px-2.5 py-1.5 font-mono text-[12.5px] text-text-primary outline-none placeholder:text-text-tertiary"
                    style={{ borderColor: 'var(--border)' }}
                    disabled={creating}
                  />
                  <div className="flex items-center gap-1.5 font-mono text-[12.5px] text-text-tertiary">
                    <span aria-hidden>+</span>
                    <input
                      ref={createNameRef}
                      type="text"
                      value={newName}
                      onChange={e => {
                        setNewName(e.target.value);
                      }}
                      placeholder="folder-name"
                      spellCheck={false}
                      className="flex-1 rounded-md border bg-surface-elevated px-2.5 py-1.5 font-mono text-[12.5px] text-text-primary outline-none placeholder:text-text-tertiary"
                      style={{ borderColor: 'var(--border)' }}
                      disabled={creating}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void onCreateFolder(e as unknown as FormEvent);
                        }
                      }}
                    />
                    <button
                      type="button"
                      onClick={e => {
                        void onCreateFolder(e as unknown as FormEvent);
                      }}
                      disabled={creating || newName.trim() === ''}
                      className="rounded-md bg-accent-primary px-2.5 py-1.5 text-[11.5px] font-bold text-on-accent disabled:opacity-50"
                    >
                      {creating ? 'Creating…' : 'Create'}
                    </button>
                  </div>
                </div>
                {createError !== null ? (
                  <p className="mt-2 rounded border border-error/40 bg-error/10 px-2 py-1.5 font-mono text-[10.5px] text-error">
                    {createError}
                  </p>
                ) : null}
              </div>
            )}
          </div>
        ) : (
          <p className="mt-[11px] text-[12.5px] leading-relaxed text-text-tertiary">
            HarnessOS will clone this repo to{' '}
            <code
              className="rounded border bg-surface px-1.5 py-0.5 font-mono text-[0.92em] text-text-secondary"
              style={{ borderColor: 'var(--border)' }}
            >
              ~/.archon/workspaces/{owner}/{repo}/source
            </code>
            .
          </p>
        )}

        {error !== null ? (
          <p className="mt-3 rounded border border-error/40 bg-error/10 px-2 py-1.5 font-mono text-[11px] text-error">
            {error}
          </p>
        ) : null}

        {/* Footer */}
        <div className="mt-[22px] flex items-center justify-end gap-[11px]">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-[10px] border bg-transparent px-[18px] py-2.5 text-[13px] font-semibold text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
            style={{ borderColor: 'var(--border-bright)' }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || value.trim().length === 0}
            className="brand-bar inline-flex items-center gap-[7px] rounded-[10px] px-[18px] py-2.5 text-[13px] font-bold text-white shadow-[0_8px_22px_-10px_color-mix(in_oklch,var(--brand-magenta),transparent_20%)] transition-all hover:-translate-y-px hover:brightness-110 disabled:translate-y-0 disabled:opacity-45 disabled:shadow-none"
          >
            <span aria-hidden className="text-[14px] leading-none">
              +
            </span>
            {submitting ? 'Adding…' : 'Add project'}
          </button>
        </div>
      </form>
    </div>
  );
}
