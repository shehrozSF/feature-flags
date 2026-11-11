import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Served by GitHub Pages at https://shehrozsf.github.io/feature-flags/dashboard/
// (plan decision 1); locally at http://localhost:5173/feature-flags/dashboard/.
export default defineConfig({
  base: '/feature-flags/dashboard/',
  plugins: [react()],
  server: { port: 5173, strictPort: true },
});
