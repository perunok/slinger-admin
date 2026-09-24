import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// `npm run dev` serves the dashboard on http://localhost:5173 and proxies /api/* to the API with the /api prefix
// stripped (same as Caddy in the compose stack), so the browser sees ONE origin: no CORS, first-party cookies.
// Point it at another API with SLINGER_API_PROXY. To exercise real cross-origin CORS instead, set
// VITE_API_BASE_URL=http://localhost:8080 and start the server with SLINGER_ALLOWED_ORIGINS=http://localhost:5173.
export default defineConfig(({ mode }) => {
  const apiTarget = loadEnv(mode, '.', '').SLINGER_API_PROXY || 'http://localhost:8080';
  return {
    plugins: [svelte()],
    server: {
      host: 'localhost',
      port: 5173,
      proxy: { '/api': { target: apiTarget, changeOrigin: false, rewrite: (p) => p.replace(/^\/api/, '') } },
    },
    // Behind a reverse proxy the Host header is the public hostname.
    preview: { host: '0.0.0.0', port: 4173, allowedHosts: true },
    resolve: mode === 'test' ? { conditions: ['browser'] } : undefined,
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['src/test/setup.ts'],
      include: ['src/**/*.test.ts'],
    },
  };
});
