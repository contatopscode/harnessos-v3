import { useState, type ReactElement } from 'react';
import { Beaker, ChevronDown, X } from 'lucide-react';
import { invalidate, useEntity } from '../store/cache';
import { K } from '../store/keys';
import {
  clearConversationSandbox,
  getConversationSandbox,
  setConversationSandbox,
  type SandboxStateResponse,
} from '../skills/conversationSandbox';
import { listSandboxes, type SandboxListResponse } from '../skills/sandboxes';

interface SandboxBadgeProps {
  conversationId: string;
  /** Codebase id — gates the badge UI on scoped chats only. */
  codebaseId: string | null;
}

/**
 * Console-side sandbox selector that lives above the chat composer.
 *
 * Three states:
 * - `null` codebase (unscoped chat): render nothing.
 * - no active sandbox: a small "Sandbox" button. Clicking it opens a
 *   popover with the list of active sandboxes for the codebase;
 *   picking one pins the conversation via the POST endpoint.
 * - active sandbox: a "Em sandbox: <slug>" badge with an "X" button
 *   that clears the conversation's cwd (the chat falls back to main
 *   on the next turn).
 *
 * Console-specific contract: the spike's own `useEntity` is used
 * (NOT @tanstack/react-query) and the `requestJson`-based
 * `conversationSandbox` skill (NOT `@/lib/api`) — per the
 * experiments/console/README.md isolation rules.
 */
export function SandboxBadge({
  conversationId,
  codebaseId,
}: SandboxBadgeProps): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: state, refetch: refetchState } = useEntity<SandboxStateResponse>(
    K.sandboxState(conversationId),
    (): Promise<SandboxStateResponse> => getConversationSandbox(conversationId)
  );

  // Hide the badge entirely when the chat is unscoped — there is no
  // codebase to scope a sandbox to.
  if (codebaseId === null) return null;

  const sandboxListKey = K.sandboxes(codebaseId);
  const { data: list, refetch: refetchList } = useEntity<SandboxListResponse>(
    open ? sandboxListKey : '__sandbox-list-idle__',
    (): Promise<SandboxListResponse> => listSandboxes(codebaseId)
  );

  // Defensive: invalidate stale state on unmount so a remounted chat
  // starts fresh — the conversation may have changed its sandbox
  // pointer since the last view.
  invalidate(K.sandboxState(conversationId));

  const onSelect = async (sandboxId: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await setConversationSandbox(conversationId, sandboxId);
      setOpen(false);
      refetchState();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onClear = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await clearConversationSandbox(conversationId);
      refetchState();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (state?.active && state.sandbox) {
    return (
      <div className="mb-[8px] flex items-center gap-[6px]">
        <span
          className="inline-flex items-center gap-[5px] rounded-full border px-[9px] py-[2px] font-mono text-[10.5px] text-text-primary"
          style={{ borderColor: 'var(--brand-magenta)' }}
          title={`Working dir: ${state.sandbox.worktreePath}`}
        >
          <Beaker aria-hidden className="h-3 w-3" />
          sandbox: {state.sandbox.slug}
        </span>
        <button
          type="button"
          onClick={(): void => {
            void onClear();
          }}
          disabled={busy}
          title="Sair do sandbox (volta pro main)"
          className="rounded p-[2px] text-text-tertiary transition-colors hover:bg-[color:var(--surface-hover)] hover:text-text-primary disabled:opacity-50"
        >
          <X aria-hidden className="h-3 w-3" />
        </button>
        {error !== null && <span className="text-[10.5px] text-error">{error}</span>}
      </div>
    );
  }

  const sandboxes = list?.sandboxes ?? [];

  return (
    <div className="mb-[8px] flex items-center gap-[6px]">
      <button
        type="button"
        onClick={(): void => {
          setOpen(!open);
          if (!open) refetchList();
        }}
        disabled={busy}
        title="Pin this chat to a sandbox (or main)"
        className="inline-flex items-center gap-[4px] rounded-full border px-[9px] py-[2px] font-mono text-[10.5px] text-text-tertiary transition-colors hover:bg-[color:var(--surface-hover)] hover:text-text-primary disabled:opacity-50"
        style={{ borderColor: 'var(--border-bright)' }}
      >
        <Beaker aria-hidden className="h-3 w-3" />
        sandbox
        <ChevronDown aria-hidden className="h-3 w-3" />
      </button>
      {open && (
        <div
          className="absolute z-50 mt-[28px] max-h-[260px] min-w-[220px] overflow-auto rounded-[8px] border bg-[color:var(--surface-elevated)] py-[4px] text-[11.5px] shadow-lg"
          style={{ borderColor: 'var(--border-bright)' }}
        >
          {sandboxes.length === 0 && (
            <p className="px-[10px] py-[6px] text-text-tertiary">
              Nenhum sandbox ativo. Crie um pelo painel Sandboxes na sidebar.
            </p>
          )}
          {sandboxes.map(s => (
            <button
              key={s.id}
              type="button"
              onClick={(): void => {
                void onSelect(s.id);
              }}
              disabled={busy}
              className="flex w-full items-center gap-[6px] px-[10px] py-[5px] text-left hover:bg-[color:var(--surface-hover)] disabled:opacity-50"
            >
              <span className="flex-1 truncate font-mono text-text-primary">{s.slug}</span>
              <span className="text-[10px] text-text-tertiary">{s.branch}</span>
            </button>
          ))}
        </div>
      )}
      {error !== null && <span className="text-[10.5px] text-error">{error}</span>}
    </div>
  );
}
