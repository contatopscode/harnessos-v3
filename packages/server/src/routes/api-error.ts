/**
 * Shared API error helper. Returns a uniform JSON error response with the
 * standard shape `{ error, detail? }` so the web UI can branch on a single
 * structure regardless of which route emitted the error.
 *
 * Extracted from ./api where it was originally a closure inside
 * registerApiRoutes — sibling route files (e.g. ./api.admin-invites) need
 * the same shape and can't reach the closure.
 */
import type { Context } from 'hono';

export type ApiErrorStatus = 400 | 401 | 403 | 404 | 409 | 410 | 422 | 500 | 503;

export function apiError(
  c: Context,
  status: ApiErrorStatus,
  message: string,
  detail?: string
): Response {
  return c.json({ error: message, ...(detail ? { detail } : {}) }, status);
}
