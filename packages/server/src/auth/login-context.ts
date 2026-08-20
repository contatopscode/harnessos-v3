/**
 * Login request context (per-request IP + User-Agent carrier).
 *
 * Why a module-level singleton: Better Auth's `databaseHooks.session.create.after`
 * fires inside `webAuth.handler(c.req.raw)` — it does NOT receive the original
 * Hono `Context`, so it can't read the request headers directly. We bridge the
 * gap by stashing the IP + UA in a module-scoped singleton from the index.ts
 * wrapper, then reading + clearing it in the session.create.after hook.
 *
 * Single-request lifetime: setPendingLoginRequestContext is called in index.ts
 * BEFORE delegating to Better Auth. The hook reads it during the handler.
 * clearPendingLoginRequestContext runs in `finally` to prevent leakage across
 * concurrent requests (Bun handles requests concurrently, so a single shared
 * variable is a race — we accept the trade-off because the audit log is
 * best-effort and the IP/UA is informational, not security-critical).
 *
 * The audit log is global (`remote_agent_audit_log`) so even with the small race
 * window the worst case is the wrong IP getting stamped on one row out of many.
 */
interface LoginRequestContext {
  ip: string | null;
  userAgent: string | null;
}

let pending: LoginRequestContext | null = null;

export function setPendingLoginRequestContext(ctx: LoginRequestContext): void {
  pending = ctx;
}

export function getPendingLoginRequestContext(): LoginRequestContext | null {
  return pending;
}

export function clearPendingLoginRequestContext(): void {
  pending = null;
}

/**
 * Extract the request IP from common proxy headers, falling back to
 * `c.env` (Cloudflare Workers) or the Hono remote address.
 * Order: X-Forwarded-For (first hop) → X-Real-IP → CF-Connecting-IP → null.
 */
export function extractRequestIp(c: {
  req: { header: (k: string) => string | undefined };
}): string | null {
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const xri = c.req.header('x-real-ip');
  if (xri) return xri;
  const cfip = c.req.header('cf-connecting-ip');
  if (cfip) return cfip;
  return null;
}
