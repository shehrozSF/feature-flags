import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', 'coverage/**', 'docs/**', '.superpowers/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['apps/*/vitest.config.ts'] },
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
    // Shared code runs in Node, Workers and browsers: Node-only modules are
    // allowed only in adapters, scripts, benchmarks and tests.
    files: ['packages/*/src/**', 'apps/*/src/**'],
    ignores: ['apps/*/src/adapters/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['node:*'], message: 'Node-only APIs belong in src/adapters/.' }] },
      ],
    },
  },
  prettier,
);
