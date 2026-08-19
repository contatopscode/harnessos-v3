import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  // Load env from repo root
  const env = loadEnv(mode, path.resolve(__dirname, '../..'), '');
  // FORGE talks to the HarnessOS backend at this base URL.
  // In dev: localhost. In prod: forge.pscode.ia.br → harness-os.pscode.ia.br
  const apiBaseUrl = env.VITE_FORGE_API_BASE_URL ?? 'http://localhost:3090';

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
        // Proxy /api to the HarnessOS backend so cookies/auth work
        // (vite preserves the Host header so the backend sees the
        // FORGE origin and the Better Auth cookie is sent cross-origin)
        '/api': {
          target: apiBaseUrl,
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
