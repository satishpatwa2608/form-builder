import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * One lint setup for the whole workspace. It looks for mistakes (unused code,
 * broken hook usage, unsafe constructs), not for formatting.
 */
export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/*.config.{js,mjs,cjs,ts}', 'apps/api/test/node-environment.js', 'e2e/test-results/**', 'e2e/playwright-report/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // `_name` marks a variable deliberately unused (a field dropped by destructuring). Unused arguments are
      // allowed: handler and callback signatures often have to name ones they do not need.
      // Request objects and ported code use `any` in places; flagged, not blocking.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
    },
  },
  {
    // UI primitives copied in from the component library: kept as they came.
    files: ['apps/studio/src/ui/**'],
    rules: { '@typescript-eslint/ban-ts-comment': 'off', '@typescript-eslint/no-unused-vars': 'off' },
  },
  {
    files: ['apps/studio/**/*.{ts,tsx}', 'apps/runtime/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'warn' },
  },
);
