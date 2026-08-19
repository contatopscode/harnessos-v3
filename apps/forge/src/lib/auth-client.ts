/**
 * VOLUND FORGE — Better Auth client.
 *
 * The FORGE webapp runs at a different origin (forge.pscode.ia.br)
 * from the HarnessOS backend (harness-os.pscode.ia.br). Better
 * Auth cookies are scoped to the backend origin (`__Host-` prefix)
 * and have `SameSite=None; Secure` set by the backend so they're
 * sent on cross-origin XHR/fetch.
 *
 * The auth client just needs to know the backend base URL — cookies
 * are managed by the browser.
 */
import { createAuthClient } from 'better-auth/react';

const baseURL = import.meta.env.VITE_FORGE_API_BASE_URL ?? 'http://localhost:3090';

export const authClient = createAuthClient({
  baseURL,
  basePath: '/api/auth',
});

export const { signIn, signUp, signOut, useSession, getSession } = authClient;
