import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { Loader2, Receipt } from 'lucide-react';
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

export function CustosPage() {
  const { data: summary, isLoading: loadingSummary, error: summaryError } = useQuery({
    queryKey: ['forge', 'costs', 'summary', 30],
    queryFn: () => api.costs.summary(30),
  });
  const { data: breakdown, isLoading: loadingBreakdown, error: breakdownError } = useQuery({
    queryKey: ['forge', 'costs', 'breakdown', 30],
    queryFn: () => api.costs.breakdown(30),
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
    return <ErrorState error={error as Error} />;
  }

  return (
    <div>
      <header className="mb-5">
        <h1 className="text-[22px] font-semibold text-[var(--text-primary)]">Custos</h1>
        <p className="mt-1 text-[12.5px] text-[var(--text-tertiary)]">
          Gasto em USD e BRL (com pipeline por período, projeto e tipo).
        </p>
      </header>

      {/* KPIs */}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="TOTAL USD" value={summary?.total_usd ?? 0} prefix="$" decimals={4} />
        <Kpi
          label="TOTAL BRL"
          value={summary?.total_brl ?? 0}
          prefix="R$ "
          decimals={2}
          accent="var(--success)"
        />
        <Kpi label="RUNS" value={summary?.runs_count ?? 0} />
        <Kpi
          label="TOKENS"
          value={(summary?.tokens_in_total ?? 0) + (summary?.tokens_out_total ?? 0)}
          compact
        />
      </div>

      {/* Gráficos */}
      <div className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section title="Custo por modelo LLM (USD)">
          {(breakdown?.by_model ?? []).length === 0 ? (
            <EmptyChart text="Sem custos no período" />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={breakdown!.by_model}>
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
              <BarChart data={breakdown!.by_codebase}>
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
                data={breakdown!.by_model}
                dataKey="amount_usd"
                nameKey="key"
                cx="50%"
                cy="50%"
                outerRadius={100}
                label={({ key, percent }) => `${key} ${(percent * 100).toFixed(0)}%`}
              >
                {breakdown!.by_model.map((_, i) => (
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
}: {
  label: string;
  value: number;
  prefix?: string;
  decimals?: number;
  accent?: string;
  compact?: boolean;
}) {
  return (
    <div className="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-4">
      <h3 className="mb-3 text-[12.5px] font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
        {title}
      </h3>
      {children}
    </div>
  );
}

function EmptyChart({ text }: { text: string }) {
  return (
    <div className="flex h-[200px] flex-col items-center justify-center text-[var(--text-tertiary)]">
      <Receipt className="mb-2 h-6 w-6" />
      <div className="text-[12px]">{text}</div>
    </div>
  );
}

function ErrorState({ error }: { error: Error }) {
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
