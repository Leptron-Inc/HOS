import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

/**
 * Shared ESLint flat configuration: typed linting with typescript-eslint.
 * Tool configuration files are type-checked by their packages' typecheck scripts instead.
 * @param {{ tsconfigRootDir: string }} options
 */
export function hosEslintConfig({ tsconfigRootDir }) {
  return defineConfig(
    {
      ignores: [
        '**/dist/**',
        '**/node_modules/**',
        '**/coverage/**',
        '**/.turbo/**',
        '**/*.config.ts',
        '**/*.config.js',
        '**/*.cjs',
        'eslint.config.js',
        'packages/config/**',
      ],
    },
    tseslint.configs.recommendedTypeChecked,
    {
      languageOptions: {
        parserOptions: { projectService: true, tsconfigRootDir },
      },
      rules: {
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/no-misused-promises': 'error',
        '@typescript-eslint/switch-exhaustiveness-check': 'error',
        eqeqeq: ['error', 'always'],
        'no-console': ['error', { allow: ['error'] }],
      },
    },
  );
}
