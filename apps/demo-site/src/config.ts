// Where the demo shop finds the API, the dashboard and its pricing backend: local
// servers under `pnpm dev`, the live deployments in a build. VITE_* variables override.
const dev = import.meta.env.DEV;

export const API_URL: string =
  import.meta.env.VITE_API_URL ??
  (dev ? 'http://localhost:8787' : 'https://feature-flags-api.shehrozsf.workers.dev');

export const DASHBOARD_URL: string =
  import.meta.env.VITE_DASHBOARD_URL ??
  (dev
    ? 'http://localhost:5173/feature-flags/dashboard/'
    : 'https://shehrozsf.github.io/feature-flags/dashboard/');

export const BACKEND_URL: string =
  import.meta.env.VITE_BACKEND_URL ??
  (dev ? 'http://localhost:8790' : 'https://feature-flags-demo-backend.shehrozsf.workers.dev');
