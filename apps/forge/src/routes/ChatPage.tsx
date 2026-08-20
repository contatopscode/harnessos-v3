/**
 * HarnessOS Projetos — Chat com o agente M3 escopado em projetos.
 *
 * Agente deliberadamente RESTRITIVO: o backend injeta no system prompt
 * a lista de projetos, clientes e demandas do HarnessOS, e o modelo
 * (MiniMax M3) só responde perguntas sobre esse universo. Não toca
 * em código, não inventa números, não toma ações destrutivas.
 *
 * Histórico fica em memória (não persiste entre reloads) — é um console
 * de exploração, não um chat log de produção. Cada mensagem registra
 * latência + model + contagem de contexto, pra dar confiança no que
 * o agente está "vendo".
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { Loader2, Send, Sparkles, User, Bot, AlertCircle, RotateCcw } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { cn } from '../lib/cn';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  model?: string;
  latencyMs?: number;
  context?: { projects_count: number; clients_count: number; demands_count: number };
  error?: string;
  createdAt: number;
}

const SUGGESTIONS = [
  'Quais projetos estão com mais demandas abertas?',
  'Quanto gastamos no M3 nos últimos 7 dias?',
  'Quais clientes estão ativos e quais estão arquivados?',
  'Me resume as demandas em status de aprovação',
];

export function ChatPage(): JSX.Element {
  const qc = useQueryClient();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  // Conversation is persisted in localStorage so the history survives a
  // page reload. The backend creates a new conversation per (user, codebase_id)
  // pair automatically and re-uses it across calls.
  const [conversationId, setConversationId] = useState<string | null>(() => {
    try {
      return localStorage.getItem('forge.chat.conversationId');
    } catch {
      return null;
    }
  });
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Persist conversation_id as it evolves
  useEffect(() => {
    try {
      if (conversationId) localStorage.setItem('forge.chat.conversationId', conversationId);
    } catch {
      // localStorage may be blocked (private mode) — fail silently
    }
  }, [conversationId]);

  const ask = useMutation({
    mutationFn: api.chat.ask,
    onSuccess: data => {
      setMessages(prev => [
        ...prev,
        {
          id: `assistant-${data.user_message_id ?? String(Date.now())}`,
          role: 'assistant',
          content: data.reply,
          model: data.model,
          latencyMs: data.latency_ms,
          context: data.context,
          createdAt: Date.now(),
        },
      ]);
      // Server may have created a new conversation on the first call —
      // save the id so the next call continues the same thread.
      if (data.conversation_id && data.conversation_id !== conversationId) {
        setConversationId(data.conversation_id);
      }
      // re-fetch custos pra refletir o novo cost row
      void qc.invalidateQueries({ queryKey: ['forge', 'costs'] });
    },
  });

  // auto-scroll pro fim
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length, ask.isPending]);

  function sendMessage(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || ask.isPending) return;
    setMessages(prev => [
      ...prev,
      {
        id: `user-${String(Date.now())}`,
        role: 'user',
        content: trimmed,
        createdAt: Date.now(),
      },
    ]);
    setInput('');
    // Pass the conversation_id so the server re-uses the same thread
    ask.mutate({ message: trimmed, ...(conversationId ? { conversation_id: conversationId } : {}) });
  }

  function onSubmit(e: React.FormEvent): void {
    e.preventDefault();
    sendMessage(input);
  }

  function onSuggestion(s: string): void {
    sendMessage(s);
  }

  function clearChat(): void {
    setMessages([]);
    // Start a new conversation thread on the server (next ask() will
    // get a new conversation_id back and the previous one stays in the
    // history for the timeline/audit trail).
    setConversationId(null);
    try {
      localStorage.removeItem('forge.chat.conversationId');
    } catch {
      // ignore
    }
  }

  return (
    <div className="flex h-[calc(100vh-72px)] flex-col">
      <header className="mb-4 flex items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold text-[var(--text-primary)]">Chat</h1>
          <p className="mt-1 text-[12.5px] text-[var(--text-tertiary)]">
            Agente M3 escopado em projetos — só responde sobre clientes, demandas, runs e custos do
            HarnessOS.
          </p>
        </div>
        {messages.length > 0 && (
          <button
            type="button"
            onClick={clearChat}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-[11.5px] font-medium text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]"
          >
            <RotateCcw className="h-3 w-3" aria-hidden />
            Limpar
          </button>
        )}
      </header>

      {/* Mensagens */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto rounded-[12px] border border-[var(--border)] bg-[var(--surface)] p-4"
      >
        {messages.length === 0 ? (
          <EmptyState onSuggestion={onSuggestion} disabled={ask.isPending} />
        ) : (
          <div className="space-y-4">
            {messages.map(m => (
              <MessageBubble key={m.id} message={m} />
            ))}
            {ask.isPending && <PendingBubble />}
            {ask.error && (
              <ErrorBubble
                error={ask.error instanceof ApiError ? ask.error.message : String(ask.error)}
              />
            )}
          </div>
        )}
      </div>

      {/* Input */}
      <form
        onSubmit={onSubmit}
        className="mt-3 flex items-end gap-2 rounded-[12px] border border-[var(--border)] bg-[var(--surface)] p-2"
      >
        <textarea
          value={input}
          onChange={e => {
            setInput(e.target.value);
          }}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSubmit(e);
            }
          }}
          placeholder="Pergunte sobre projetos, clientes, demandas, runs ou custos…"
          rows={1}
          disabled={ask.isPending}
          className="flex-1 resize-none bg-transparent px-2 py-1.5 text-[13.5px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={ask.isPending || !input.trim()}
          className="inline-flex items-center gap-1.5 rounded-md bg-[var(--brand-magenta)] px-3 py-1.5 text-[12.5px] font-semibold text-white transition hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {ask.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Send className="h-3.5 w-3.5" aria-hidden />
          )}
          Enviar
        </button>
      </form>
    </div>
  );
}

function EmptyState({
  onSuggestion,
  disabled,
}: {
  onSuggestion: (s: string) => void;
  disabled: boolean;
}): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 px-4 py-8 text-center">
      <div
        className="flex h-12 w-12 items-center justify-center rounded-full"
        style={{ background: 'var(--brand-gradient)' }}
      >
        <Sparkles className="h-5 w-5 text-white" aria-hidden />
      </div>
      <div className="max-w-[420px]">
        <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
          Agente escopado em projetos
        </h2>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--text-tertiary)]">
          As respostas vêm de um M3 com a base de projetos, clientes e demandas injetada no prompt.
          Ele não inventa números e recusa perguntas fora desse escopo.
        </p>
      </div>
      <div className="grid w-full max-w-[520px] grid-cols-1 gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map(s => (
          <button
            key={s}
            type="button"
            disabled={disabled}
            onClick={() => {
              onSuggestion(s);
            }}
            className="rounded-md border border-[var(--border)] bg-[var(--surface-inset)] px-3 py-2 text-left text-[12px] text-[var(--text-secondary)] transition hover:border-[var(--brand-magenta)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }): JSX.Element {
  const isUser = message.role === 'user';
  return (
    <div className={cn('flex gap-2.5', isUser ? 'justify-end' : 'justify-start')}>
      {!isUser && (
        <div
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
          style={{ background: 'var(--brand-gradient)' }}
        >
          <Bot className="h-3.5 w-3.5 text-white" aria-hidden />
        </div>
      )}
      <div className={cn('max-w-[78%] space-y-1.5', isUser ? 'items-end' : 'items-start')}>
        <div
          className={cn(
            'rounded-[10px] px-3.5 py-2.5 text-[13px] leading-relaxed',
            isUser
              ? 'bg-[var(--brand-magenta)] text-white'
              : 'bg-[var(--surface-inset)] text-[var(--text-primary)]'
          )}
        >
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
        </div>
        {!isUser && (message.model || message.context) && (
          <div className="flex flex-wrap items-center gap-2 px-1 text-[10.5px] text-[var(--text-tertiary)]">
            {message.model && <span className="font-mono">{message.model}</span>}
            {message.latencyMs !== undefined && <span>· {message.latencyMs}ms</span>}
            {message.context && (
              <span>
                · contexto: {message.context.projects_count} projeto
                {message.context.projects_count === 1 ? '' : 's'}, {message.context.demands_count}{' '}
                demanda{message.context.demands_count === 1 ? '' : 's'}
              </span>
            )}
          </div>
        )}
      </div>
      {isUser && (
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--surface-elevated)]">
          <User className="h-3.5 w-3.5 text-[var(--text-secondary)]" aria-hidden />
        </div>
      )}
    </div>
  );
}

function PendingBubble(): JSX.Element {
  return (
    <div className="flex gap-2.5">
      <div
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
        style={{ background: 'var(--brand-gradient)' }}
      >
        <Bot className="h-3.5 w-3.5 text-white" aria-hidden />
      </div>
      <div className="rounded-[10px] bg-[var(--surface-inset)] px-3.5 py-2.5 text-[12.5px] text-[var(--text-tertiary)]">
        <Loader2 className="mr-1.5 inline-block h-3 w-3 animate-spin" aria-hidden />
        pensando…
      </div>
    </div>
  );
}

function ErrorBubble({ error }: { error: string }): JSX.Element {
  return (
    <div className="flex gap-2.5">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--error)]/30 bg-[var(--error-soft)]">
        <AlertCircle className="h-3.5 w-3.5 text-[var(--error)]" aria-hidden />
      </div>
      <div className="rounded-[10px] border border-[var(--error)]/30 bg-[var(--error-soft)] px-3.5 py-2.5 text-[12.5px] text-[var(--error)]">
        {error}
      </div>
    </div>
  );
}
