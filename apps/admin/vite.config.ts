import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Proxy the API surfaces to the backend so the admin can run same-origin (used by
// the dev server and the Playwright e2e harness; set the connection baseUrl to "").
const apiTarget = process.env.CW_API_URL ?? 'http://localhost:8787';
const proxy = Object.fromEntries(
  ['/spaces', '/preview', '/delivery'].map((p) => [p, { target: apiTarget, changeOrigin: true }]),
);
// The e2e harness pins the port via CW_ADMIN_PORT; dev uses the default 5173.
const port = Number(process.env.CW_ADMIN_PORT ?? 5173);
const strictPort = Boolean(process.env.CW_ADMIN_PORT);

export default defineConfig({
  plugins: [react()],
  server: { port, strictPort, proxy },
  preview: { port, strictPort, proxy },
  // Unit/component tests live in test/; e2e/ is driven by Playwright, not Vitest.
  test: { include: ['test/**/*.test.{ts,tsx}'] },
});
