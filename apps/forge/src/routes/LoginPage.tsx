import { useState } from 'react';
import { signIn, signUp } from '../lib/auth-client';
import { Flame } from 'lucide-react';

/**
 * Login page — Better Auth email+password against the HarnessOS
 * backend. Cross-origin via cookies (SameSite=None; Secure).
 */
export function LoginPage() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (mode === 'signin') {
        const result = await signIn.email({ email, password });
        if (result.error) {
          setError(result.error.message ?? 'Falha ao entrar');
          return;
        }
      } else {
        const result = await signUp.email({ email, password, name });
        if (result.error) {
          setError(result.error.message ?? 'Falha ao cadastrar');
          return;
        }
      }
      window.location.href = '/';
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--background)] p-6">
      <div className="w-full max-w-[420px]">
        <div className="mb-8 flex flex-col items-center text-center">
          <div
            className="mb-3 flex h-12 w-12 items-center justify-center rounded-lg"
            style={{ background: 'var(--brand-gradient)' }}
          >
            <Flame className="h-6 w-6 text-white" aria-hidden />
          </div>
          <h1 className="text-xl font-semibold text-[var(--text-primary)]">VOLUND FORGE</h1>
          <p className="mt-1 text-[12.5px] text-[var(--text-tertiary)]">
            PMO surface do HarnessOS
          </p>
        </div>

        <div className="rounded-[12px] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl">
          {/* Mode toggle */}
          <div className="mb-5 flex rounded-md bg-[var(--surface-inset)] p-0.5">
            {(['signin', 'signup'] as const).map(m => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setMode(m);
                  setError(null);
                }}
                className={
                  'flex-1 rounded-[6px] px-3 py-1.5 text-[12.5px] font-medium transition-colors ' +
                  (mode === m
                    ? 'bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-sm'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]')
                }
              >
                {m === 'signin' ? 'Entrar' : 'Criar conta'}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="space-y-3.5">
            {mode === 'signup' && (
              <Field
                label="Nome"
                type="text"
                value={name}
                onChange={setName}
                placeholder="Paulo Siqueira"
                required
              />
            )}
            <Field
              label="E-mail"
              type="email"
              value={email}
              onChange={setEmail}
              placeholder="voce@empresa.com"
              required
            />
            <Field
              label="Senha"
              type="password"
              value={password}
              onChange={setPassword}
              placeholder="••••••••"
              required
            />

            {error && (
              <div className="rounded-md border border-[var(--error)]/40 bg-[var(--error-soft)] px-3 py-2 text-[12px] text-[var(--error)]">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="flex w-full items-center justify-center rounded-md bg-[var(--brand-magenta)] px-4 py-2.5 text-[13px] font-semibold text-white shadow-sm transition hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? 'Enviando…' : mode === 'signin' ? 'Entrar' : 'Criar conta'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

interface FieldProps {
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
}

function Field({ label, type, value, onChange, placeholder, required }: FieldProps) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11.5px] font-medium text-[var(--text-secondary)]">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        className="w-full rounded-md border border-[var(--border)] bg-[var(--surface-inset)] px-3 py-2 text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:border-[var(--brand-magenta)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-ring)]"
      />
    </label>
  );
}
