/**
 * VOLUND FORGE — Better Auth client.
 *
 * The FORGE webapp runs at a different origin (forge.pscode.ia.br)
 * from the HarnessOS backend (harness-os.pscode.ia.br). Better
 * Auth cookies are scoped to the backend origin (`__Host-` prefix)
 * and have `SameSite=None; Secure` set by the backend so they're
 * sent on cross-origin XHR/fetch.
 *
 * Dev (proxy): VITE_FORGE_API_BASE_URL is empty (default), so the
 * client uses the FORGE's own origin and the Vite proxy forwards
 * /api to the backend — cookies behave as same-origin and work over
 * plain HTTP localhost.
 *
 * Prod (real cross-origin): set VITE_FORGE_API_BASE_URL to the
 * HarnessOS origin (https://harness-os.pscode.ia.br) at build time
 * so the client talks to the backend directly with `__Host-` cookies.
 */
import { createAuthClient } from 'better-auth/react';

const baseURL = import.meta.env.VITE_FORGE_API_BASE_URL;

export const authClient = createAuthClient({
  ...(baseURL ? { baseURL } : {}),
  basePath: '/api/auth',
});

export const { signIn, signUp, signOut, useSession, getSession } = authClient;
