// Lint config for the whole repo (ESLint 9 flat config). Rules focus on real bugs:
// undefined variables, unused code, React hook mistakes. Formatting is not linted.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

const unused = ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }];

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', 'capture/output/**', 'capture/vendor/**', '.data/**', '**/*.tsbuildinfo'] },
  {
    files: ['server/**/*.js', 'capture/**/*.js', 'scripts/**/*.mjs', 'eslint.config.js'],
    extends: [js.configs.recommended],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
    rules: { 'no-unused-vars': unused, 'no-empty': ['error', { allowEmptyCatch: true }] },
  },
  {
    // capture scripts run some functions inside the browser page
    files: ['capture/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['web/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { ecmaVersion: 2024, globals: { ...globals.browser } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': unused,
      '@typescript-eslint/no-explicit-any': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
);
