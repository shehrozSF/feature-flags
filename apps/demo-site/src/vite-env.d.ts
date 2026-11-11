/// <reference types="vite/client" />

// Build-time settings (optional; see config.ts for the defaults).
interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_DASHBOARD_URL?: string;
  readonly VITE_BACKEND_URL?: string;
}
