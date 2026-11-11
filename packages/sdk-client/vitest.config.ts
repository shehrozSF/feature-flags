import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@ff/sdk-client',
    // A simulated browser (window, localStorage, document) for unit tests; the
    // resilience tests opt back into Node with a per-file comment.
    environment: 'happy-dom',
  },
});
