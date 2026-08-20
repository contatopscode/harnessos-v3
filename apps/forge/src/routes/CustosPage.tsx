import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { JSX } from 'react';
import { api, ApiError, type Cost } from '../lib/api';
import { Loader2, Receipt, Sparkles, Coins, Calendar, Activity } from 'lucide-react';
import {
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';

const WINDOW_OPTIONS = [
  { value: 7, label: '7 dias' },
  { value: 30, label: '30 dias' },
  { value: 90, label: '90 dias' },
];

export function CustosPage(): JSX.Element {
  const [windowDays, setWindowDays] = useState(30);
  const {
    data: summary,
    isLoading: loadingSummary,
    error: summaryError,
  } = useQuery({
    queryKey: ['forge', 'costs', 'summary', windowDays],
    queryFn: () => api.costs.summary(windowDays),
  });
  const {
    data: breakdown,
    isLoading: loadingBreakdown,
    error: breakdownError,
  } = useQuery({
    queryKey: ['forge', 'costs', 'breakdown', windowDays],
    queryFn: () => api.costs.breakdown(windowDays),
  });
  const { data: recentCosts } = useQuery({
    queryKey: ['forge', 'costs', 'recent', windowDays],
    queryFn: () => api.costs.list({ sinceDays: windowDays, limit: 20 }),
  });

  const isLoading = loadingSummary || loadingBreakdown;
  const error = summaryError || breakdownError;

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center gap-2 text-[var(--text-tertiary)]">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-[13px]">Carregando custos…</span>
      </div>
    );
  }

  if (error) {
    return <ErrorState error={error} />;
  }

  const hasData = (summary?.runs_count ?? 0) > 0;

  return (
    <div>
      <header className="mb-5 flex items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold text-[var(--text-primary)]">Custos</h1>
          <p className="mt-1 text-[12.5px] text-[var(--text-tertiary)]">
            Gasto do HarnessOS em modelos LLM — USD e BRL, por modelo, projeto e pipeline.
          </p>
        </div>
        <div className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface)] p-0.5">
          <Calendar className="ml-1.5 h-3.5 w-3.5 text-[var(--text-tertiary)]" />
          {WINDOW_OPTIONS.map(o => (
            <button
              key={o.value}
              type="button"
              onClick={() => {
                setWindowDays(o.value);
              }}
              className={`rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
                windowDays === o.value
                  ? 'bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-sm'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </header>

      {!hasData && (
        <div className="mb-4 rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-4 text-[12px] text-[var(--text-secondary)]">
          <div className="flex items-center gap-2 text-[var(--text-primary)]">
            <Sparkles className="h-4 w-4 text-[var(--brand-magenta)]" />
            <span className="font-medium">Sem custos no período</span>
          </div>
          <p className="mt-1.5 text-[var(--text-tertiary)]">
            Os custos são registrados automaticamente toda vez que o HarnessOS roda um agente LLM
            (provider <code className="font-mono">pi</code> + modelo{' '}
            <code className="font-mono">minimax/MiniMax-M3</code> por padrão). Quando alguém usar o
            chat, rodar uma skill ou disparar um workflow, os valores aparecem aqui automaticamente.
          </p>
        </div>
      )}

      {/* KPIs */}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi
          label="TOTAL USD"
          value={summary?.total_usd ?? 0}
          prefix="$"
          decimals={4}
          icon={<Coins className="h-3.5 w-3.5" />}
        />
        <Kpi
          label="TOTAL BRL"
          value={summary?.total_brl ?? 0}
          prefix="R$ "
          decimals={2}
          accent="var(--success)"
          icon={<Coins className="h-3.5 w-3.5" />}
        />
        <Kpi
          label="RUNS"
          value={summary?.runs_count ?? 0}
          icon={<Activity className="h-3.5 w-3.5" />}
        />
        <Kpi
          label="TOKENS"
          value={(summary?.tokens_in_total ?? 0) + (summary?.tokens_out_total ?? 0)}
          compact
          icon={<Sparkles className="h-3.5 w-3.5" />}
        />
      </div>

      {/* Gráficos */}
      <div className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section title="Custo por modelo LLM (USD)">
          {(breakdown?.by_model ?? []).length === 0 ? (
            <EmptyChart text="Sem custos no período" />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={breakdown?.by_model ?? []}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis dataKey="key" tick={{ fill: 'var(--text-tertiary)', fontSize: 11 }} />
                <YAxis tick={{ fill: 'var(--text-tertiary)', fontSize: 11 }} />
                <Tooltip
                  contentStyle={{
                    background: 'var(--surface-elevated)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                />
                <Bar dataKey="amount_usd" fill="var(--brand-magenta)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Section>

        <Section title="Custo por projeto (USD)">
          {(breakdown?.by_codebase ?? []).length === 0 ? (
            <EmptyChart text="Sem custos por projeto no período" />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={breakdown?.by_codebase ?? []}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis
                  dataKey="key"
                  tick={{ fill: 'var(--text-tertiary)', fontSize: 10 }}
                  angle={-15}
                  textAnchor="end"
                  height={50}
                />
                <YAxis tick={{ fill: 'var(--text-tertiary)', fontSize: 11 }} />
                <Tooltip
                  contentStyle={{
                    background: 'var(--surface-elevated)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                />
                <Bar dataKey="amount_usd" fill="var(--brand-teal)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Section>
      </div>

      <Section title="Distribuição por modelo LLM (pizza)">
        {(breakdown?.by_model ?? []).length === 0 ? (
          <EmptyChart text="Sem dados" />
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={breakdown?.by_model ?? []}
                dataKey="amount_usd"
                nameKey="key"
                cx="50%"
                cy="50%"
                outerRadius={100}
                label={({ key, percent }) => `${key} ${(percent * 100).toFixed(0)}%`}
              >
                {(breakdown?.by_model ?? []).map((_, i) => (
                  <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  background: 'var(--surface-elevated)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  fontSize: 12,
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11, color: 'var(--text-secondary)' }} />
            </PieChart>
          </ResponsiveContainer>
        )}
      </Section>

      {/* Recent cost rows */}
      {(recentCosts?.costs ?? []).length > 0 && (
        <Section title={`Últimas ${String((recentCosts?.costs ?? []).length)} chamadas LLM`}>
          <div className="overflow-hidden rounded-md border border-[var(--border)]">
            <table className="w-full text-[11.5px]">
              <thead className="bg-[var(--surface-inset)] text-[var(--text-tertiary)]">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Quando</th>
                  <th className="px-3 py-2 text-left font-medium">Modelo</th>
                  <th className="px-3 py-2 text-left font-medium">Kind</th>
                  <th className="px-3 py-2 text-left font-medium">Demanda</th>
                  <th className="px-3 py-2 text-right font-medium">Tokens in / out</th>
                  <th className="px-3 py-2 text-right font-medium">USD</th>
                  <th className="px-3 py-2 text-right font-medium">BRL</th>
                </tr>
              </thead>
              <tbody>
                {(recentCosts?.costs ?? []).map((c: Cost) => (
                  <tr
                    key={c.id}
                    className="border-t border-[var(--border)] transition-colors hover:bg-[var(--surface-elevated)]"
                  >
                    <td className="px-3 py-1.5 text-[var(--text-tertiary)]">
                      {new Date(c.created_at).toLocaleString('pt-BR', {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-[var(--text-secondary)]">
                      {c.model}
                    </td>
                    <td className="px-3 py-1.5 text-[var(--text-secondary)]">{c.kind}</td>
                    <td className="px-3 py-1.5 font-mono text-[10.5px] text-[var(--text-tertiary)]">
                      {c.demand_id ? (
                        <span title={c.demand_id} className="cursor-help">
                          {c.demand_id.slice(0, 8)}…
                        </span>
                      ) : (
                        <span className="text-[var(--text-tertiary)]/50">—</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-[var(--text-secondary)] tabular-nums">
                      {compactNumber(c.tokens_in)} / {compactNumber(c.tokens_out)}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-[var(--text-primary)] tabular-nums">
                      ${c.amount_usd.toFixed(4)}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-[var(--text-primary)] tabular-nums">
                      R$ {c.amount_brl.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </div>
  );
}

const PIE_COLORS = [
  'var(--brand-magenta)',
  'var(--brand-violet)',
  'var(--brand-teal)',
  'var(--running)',
  'var(--warning)',
  'var(--error)',
];

function Kpi({
  label,
  value,
  prefix = '',
  decimals = 0,
  accent,
  compact,
  icon,
}: {
  label: string;
  value: number;
  prefix?: string;
  decimals?: number;
  accent?: string;
  compact?: boolean;
  icon?: React.ReactNode;
}): JSX.Element {
  return (
    <div className="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
        {icon}
        {label}
      </div>
      <div
        className="mt-1.5 font-mono text-[22px] font-semibold tabular-nums"
        style={{ color: accent ?? 'var(--text-primary)' }}
      >
        {prefix}
        {compact ? compactNumber(value) : value.toFixed(decimals)}
      </div>
    </div>
  );
}

function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-4">
      <h3 className="mb-3 text-[12.5px] font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
        {title}
      </h3>
      {children}
    </div>
  );
}

function EmptyChart({ text }: { text: string }): JSX.Element {
  return (
    <div className="flex h-[200px] flex-col items-center justify-center text-[var(--text-tertiary)]">
      <Receipt className="mb-2 h-6 w-6" />
      <div className="text-[12px]">{text}</div>
    </div>
  );
}

function ErrorState({ error }: { error: Error }): JSX.Element {
  const isApiError = error instanceof ApiError;
  return (
    <div className="rounded-[12px] border border-[var(--error)]/40 bg-[var(--error-soft)] p-5">
      <div className="text-[13px] font-semibold text-[var(--error)]">
        {isApiError ? `Erro ${String(error.status)}` : 'Erro inesperado'}
      </div>
      <div className="mt-1 text-[12px] text-[var(--text-secondary)]">{error.message}</div>
    </div>
  );
}
