import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  // Load env from repo root
  const env = loadEnv(mode, path.resolve(__dirname, '../..'), '');

  // Two separate URLs:
  //  - apiBaseUrl  → baked into the client at build time (auth-client + api wrapper)
  //  - proxyTarget → where the dev server forwards /api to
  //
  // Common setups:
  //  (1) Proxy mode (recommended for local dev): both envs empty.
  //      The client uses the FORGE's own origin so cookies are
  //      same-origin HTTP-friendly; the dev server forwards /api to
  //      `http://localhost:3090` (a local HarnessOS backend).
  //  (2) Dev with prod backend: leave VITE_FORGE_API_BASE_URL empty
  //      and set VITE_FORGE_PROXY_TARGET=https://harness-os.pscode.ia.br
  //      so the client uses the FORGE origin and the proxy reaches
  //      the prod backend (cookies are same-origin in the browser).
  //  (3) Real cross-origin (used in prod build): set
  //      VITE_FORGE_API_BASE_URL=https://harness-os.pscode.ia.br at
  //      build time. The client talks to the backend directly with
  //      SameSite=None; Secure cookies.

  const apiBaseUrl = env.VITE_FORGE_API_BASE_URL ?? '';
  const proxyTarget = env.VITE_FORGE_PROXY_TARGET ?? 'http://localhost:3090';

  return {
    plugins: [react(), tailwindcss()],
    define: {
      'import.meta.env.VITE_FORGE_API_BASE_URL': JSON.stringify(apiBaseUrl),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 5180,
      strictPort: true,
      host: '127.0.0.1',
      proxy: {
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
          secure: false,
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
  };
});
