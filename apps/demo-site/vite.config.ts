import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Served by GitHub Pages at https://shehrozsf.github.io/feature-flags/demo/
// (plan decision 1); locally at http://localhost:5174/feature-flags/demo/.
export default defineConfig({
  base: '/feature-flags/demo/',
  plugins: [react()],
  server: { port: 5174, strictPort: true },
});
