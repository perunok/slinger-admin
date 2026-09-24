import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig(({ mode }) => ({
  plugins: [svelte()],
  server: { host: '0.0.0.0', port: 4173 },
  // Behind a reverse proxy the Host header is the public hostname.
  preview: { host: '0.0.0.0', port: 4173, allowedHosts: true },
  resolve: mode === 'test' ? { conditions: ['browser'] } : undefined,
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.ts'],
  },
}));
