/**
 * Tauri 2 IPC helpers.
 *
 * The HarnessOS UI ships in 2 modes:
 *
 * 1. **Browser** (default, hosted on VPS): no Tauri runtime — falls back to
 *    the browser's limited File System Access API (Chrome/Edge 86+ only).
 *    `isTauri === false`.
 *
 * 2. **Tauri desktop shell** (Mac/Windows app): the same web build runs
 *    inside a native WebView with Rust commands exposed via
 *    `window.__TAURI__.core.invoke(...)`. `isTauri === true` and the
 *    native folder/file pickers return absolute paths (Finder/Explorer).
 *
 * The helpers in this file detect which mode we're in and dispatch to the
 * right API. Components can call `pickDirectory()` / `pickFile()` and stay
 * mode-agnostic — the UX just works better inside the Tauri shell.
 *
 * The Tauri commands are defined in apps/tauri-shell/src-tauri/src/lib.rs
 * and whitelisted in apps/tauri-shell/src-tauri/capabilities/default.json.
 */

declare global {
  interface Window {
    __TAURI__?: {
      core: {
        invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
      };
    };
  }
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && window.__TAURI__ !== undefined;
}

/**
 * Internal accessor — returns the Tauri global or `null`. Avoids the
 * `@typescript-eslint/no-non-null-assertion` rule that forbids
 * `window.__TAURI__!.core` at every call site.
 */
function getTauri(): {
  core: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
} | null {
  if (typeof window === 'undefined') return null;
  return window.__TAURI__ ?? null;
}

/**
 * Open a native folder picker.
 * - Tauri: NSOpenPanel (mac) / IFileOpenDialog (Win) → returns absolute path
 * - Browser: showDirectoryPicker (Chrome/Edge 86+) → returns just the folder
 *   name; the caller must already have a parent path typed
 *
 * Returns `null` if the user cancelled.
 */
export async function pickDirectory(): Promise<string | null> {
  const t = getTauri();
  if (t !== null) {
    return await t.core.invoke<string | null>('pick_directory');
  }
  // Browser fallback — caller already handles the "browser returns just the
  // folder name" semantic; we just surface the raw FileSystemDirectoryHandle.
  const picker = (
    window as unknown as {
      showDirectoryPicker?: (opts: { mode: 'read' | 'readwrite' }) => Promise<{ name: string }>;
    }
  ).showDirectoryPicker;
  if (typeof picker !== 'function') return null;
  try {
    const handle = await picker({ mode: 'read' });
    return handle.name;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null;
    throw err;
  }
}

/**
 * Open a native file picker.
 * - Tauri: native dialog with optional title + extension filters
 * - Browser: `<input type="file">` equivalent — just the filename (no path)
 */
export async function pickFile(
  opts: { title?: string; filters?: { name: string; extensions: string[] }[] } = {}
): Promise<string | null> {
  const t = getTauri();
  if (t !== null) {
    const args: { title?: string; filters?: [string, string[]][] } = {};
    if (opts.title !== undefined) args.title = opts.title;
    if (opts.filters !== undefined) {
      args.filters = opts.filters.map(f => [f.name, f.extensions] as [string, string[]]);
    }
    return await t.core.invoke<string | null>('pick_file', args);
  }
  // Browser fallback — returns just the filename (no path). For the
  // codebase-add flow the file picker isn't used today; this stub keeps the
  // type signature stable and lets the browser not crash if a future UI
  // calls it.
  const input = document.createElement('input');
  input.type = 'file';
  if (opts.filters !== undefined) {
    input.accept = opts.filters.flatMap(f => f.extensions.map(e => `.${e}`)).join(',');
  }
  return new Promise(resolve => {
    input.onchange = (): void => {
      const file = input.files?.[0];
      resolve(file?.name ?? null);
    };
    input.oncancel = (): void => {
      resolve(null);
    };
    input.click();
  });
}

export interface PathInfo {
  path: string;
  exists: boolean;
  is_directory: boolean;
  is_file: boolean;
  canonical: string | null;
}

/** Validate that a path exists; canonicalize the absolute form. */
export async function validatePath(path: string): Promise<PathInfo> {
  const t = getTauri();
  if (t !== null) {
    return await t.core.invoke<PathInfo>('validate_path', { path });
  }
  // Browser: we don't have fs access. Return a best-effort shape.
  return { path, exists: false, is_directory: false, is_file: false, canonical: null };
}

export interface AppInfo {
  name: string;
  version: string;
  platform: 'macos' | 'windows' | 'linux' | 'unknown';
  arch: string;
  webview_url: string;
  is_dev: boolean;
}

/** App metadata — only meaningful in Tauri mode. */
export async function getAppInfo(): Promise<AppInfo | null> {
  const t = getTauri();
  if (t !== null) {
    return await t.core.invoke<AppInfo>('get_app_info');
  }
  return null;
}

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

/** List directory entries (dirs first, then alphabetical). Tauri only. */
export async function listDir(path: string): Promise<DirEntry[]> {
  const t = getTauri();
  if (t !== null) {
    return await t.core.invoke<DirEntry[]>('list_dir', { path });
  }
  return [];
}

/** Read a whitelisted env var (DATABASE_URL/PORT/HOSTNAME/NODE_ENV/LOG_LEVEL). */
export async function getEnv(key: string): Promise<string | null> {
  const t = getTauri();
  if (t !== null) {
    return await t.core.invoke<string | null>('get_env', { key });
  }
  // Browser fallback: nothing in the webview matches a process env var.
  return null;
}
