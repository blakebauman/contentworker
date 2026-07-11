import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Proxy the API surfaces to the backend so the admin can run same-origin (used by
// the dev server and the Playwright e2e harness; set the connection baseUrl to "").
// /auth is included for GET /auth/me (connect gate + principal probe).
const apiTarget = process.env.CW_API_URL ?? 'http://localhost:8787';
const proxy = Object.fromEntries(
  ['/spaces', '/preview', '/delivery', '/auth'].map((p) => [
    p,
    { target: apiTarget, changeOrigin: true },
  ]),
);
// The e2e harness pins the port via CW_ADMIN_PORT; dev uses the default 5173.
const port = Number(process.env.CW_ADMIN_PORT ?? 5173);
const strictPort = Boolean(process.env.CW_ADMIN_PORT);
// In Docker, native fs events don't cross the bind mount reliably, so opt into
// polling for HMR (set VITE_USE_POLLING=true). No effect on local-host dev.
const watch = process.env.VITE_USE_POLLING ? { usePolling: true, interval: 200 } : undefined;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // `@/*` resolves to src/*; Vitest reads this same config so component tests
  // that import @/components/ui/* resolve too.
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: { port, strictPort, proxy, watch },
  preview: { port, strictPort, proxy },
  // Split rarely-changing vendor code into long-cacheable chunks so an app-code
  // change doesn't bust the framework bundle. (Route code is split via React.lazy.)
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) {
            return 'react-vendor';
          }
          if (id.includes('@radix-ui')) return 'radix';
          if (id.includes('recharts') || id.includes('/d3-') || id.includes('victory')) {
            return 'charts';
          }
          return undefined;
        },
      },
    },
  },
  // Unit/component tests live in test/; e2e/ is driven by Playwright, not Vitest.
  test: { include: ['test/**/*.test.{ts,tsx}'], environment: 'jsdom' },
});
