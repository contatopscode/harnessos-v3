/**
 * Augmentations for browser APIs not yet in the default TS lib.
 *
 * The File System Access API (`showDirectoryPicker`) is available in
 * Chrome/Edge 86+ but not in TS's built-in `lib.dom.d.ts` for our target.
 * Declare the minimal surface we use (just the function and the returned
 * handle's `name`).
 *
 * The `hasNativeFolderPicker()` helper in AddProjectDialog runtime-checks
 * `typeof window.showDirectoryPicker === 'function'` before invoking it,
 * so Firefox/Safari users (where the API doesn't exist) just don't see
 * the "Browse…" button. The TS declaration here makes the call site
 * type-check.
 */
interface FileSystemDirectoryHandle {
  readonly name: string;
}

interface Window {
  showDirectoryPicker?: (options?: {
    mode?: 'read' | 'readwrite';
  }) => Promise<FileSystemDirectoryHandle>;
}
