import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'data/**',
      'packages/db/migrations/**',
      'demo/**/public/**',
      'docs/samples/**',
      '.claude/**',
      'apps/desktop/.stage/**',
      'apps/desktop/release/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Run inside the browser page (recorder toolbar, manual testing panel), not in Node.
    files: ['packages/recorder/src/injected.js', 'apps/server/src/runner/manual-toolbar.js'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        location: 'readonly',
        CSS: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        Promise: 'readonly',
      },
    },
  },
  {
    // CommonJS: the demo desktop app's main process and preload, and the desktop app's electron-builder settings.
    files: ['demo/desktop-app/**/*.cjs', 'apps/desktop/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { require: 'readonly', __dirname: 'readonly', module: 'writable' },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['demo/desktop-app/renderer.js'],
    languageOptions: { sourceType: 'script', globals: { window: 'readonly', document: 'readonly' } },
  },
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly', setTimeout: 'readonly' },
    },
  },
  {
    // The desktop app's Electron main process (Node).
    files: ['apps/desktop/src/**/*.mjs', 'apps/desktop/scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        fetch: 'readonly',
        AbortSignal: 'readonly',
        clearTimeout: 'readonly',
        encodeURIComponent: 'readonly',
      },
    },
  },
);
