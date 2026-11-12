import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      'coverage/**',
      'docs/**',
      '.superpowers/**',
      '**/worker-configuration.d.ts',
      '**/.wrangler/**',
      '**/dist/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            'apps/*/vitest.config.ts',
            'apps/*/vitest.workers.config.ts',
            'packages/*/vitest.config.ts',
            'packages/*/vitest.workers.config.ts',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Allows `const { dropped, ...rest } = obj` to remove a field.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: globals.node,
    },
  },
  {
    // n8n Code node bodies (ADR 0040): scripts whose last statement is a top-level
    // return, run by n8n with $input and $env in scope.
    files: ['tools/n8n/code/*.js'],
    languageOptions: {
      sourceType: 'script',
      parserOptions: { ecmaFeatures: { globalReturn: true } },
      globals: {
        ...globals.node,
        $input: 'readonly',
        $env: 'readonly',
        $: 'readonly',
        $getWorkflowStaticData: 'readonly',
      },
    },
    // require() is how a Code node loads a built-in module (NODE_FUNCTION_ALLOW_BUILTIN).
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // Shared code runs in Node, Workers and browsers: Node-only modules are
    // allowed only in adapters, scripts, benchmarks and tests.
    files: ['packages/*/src/**', 'apps/*/src/**'],
    ignores: ['apps/*/src/adapters/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['node:*'], message: 'Node-only APIs belong in src/adapters/.' }] },
      ],
      // @types/pg pulls Node's globals into apps/api's typecheck, so tsc alone won't catch these.
      'no-restricted-globals': [
        'error',
        ...['Buffer', 'process', 'require', '__dirname', '__filename'].map((name) => ({
          name,
          message: 'Node-only global; use it in src/adapters/ only.',
        })),
      ],
    },
  },
  {
    // React apps: the rules of hooks, and complete effect dependencies.
    files: ['apps/*/src/**/*.tsx', 'apps/*/test/**/*.tsx'],
    ...reactHooks.configs.flat['recommended-latest'],
  },
  prettier,
);
