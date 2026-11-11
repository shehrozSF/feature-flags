// Where the dashboard finds the API and the demo site: local servers under
// `pnpm dev`, the live deployments in a build. VITE_API_URL / VITE_DEMO_URL override.
const dev = import.meta.env.DEV;

export const API_URL: string =
  import.meta.env.VITE_API_URL ??
  (dev ? 'http://localhost:8787' : 'https://feature-flags-api.shehrozsf.workers.dev');

export const DEMO_URL: string =
  import.meta.env.VITE_DEMO_URL ??
  (dev
    ? 'http://localhost:5174/feature-flags/demo/'
    : 'https://shehrozsf.github.io/feature-flags/demo/');
