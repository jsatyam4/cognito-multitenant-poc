import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** In `npm run dev`, serve /runtime-config.json from the deployed stack outputs. */
function devRuntimeConfig(): Plugin {
  return {
    name: 'dev-runtime-config',
    configureServer(server) {
      server.middlewares.use('/runtime-config.json', (_req, res) => {
        // POC_API_URL points the SPA at `npm run local:api` (offline) instead of the deployed stack
        if (process.env.POC_API_URL) {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ apiUrl: process.env.POC_API_URL, region: 'ap-south-1' }));
          return;
        }
        const f = resolve(process.cwd(), '../.poc/outputs.json');
        if (!existsSync(f)) {
          res.statusCode = 404;
          res.end('{"error":"deploy first: .poc/outputs.json missing"}');
          return;
        }
        const o = JSON.parse(readFileSync(f, 'utf8')).CognitoPocPlatform;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ apiUrl: o.ApiUrl, region: o.Region }));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devRuntimeConfig()],
  // amazon-cognito-identity-js (SRP sign-in on our own login page) expects Node's `global`
  define: { global: 'globalThis' },
  server: { port: 5173, strictPort: true },
});
