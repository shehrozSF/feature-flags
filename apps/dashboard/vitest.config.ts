import react from '@vitejs/plugin-react';
import { defineProject } from 'vitest/config';

export default defineProject({
  plugins: [react()],
  test: {
    name: '@ff/dashboard',
    // A simulated browser for component tests: render, click, read what a person sees.
    environment: 'happy-dom',
    setupFiles: ['./test/setup.ts'],
  },
});
