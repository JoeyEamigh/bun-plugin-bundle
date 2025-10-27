import eslint from '@eslint/js';
import importPlugin from 'eslint-plugin-import';
import prettierPlugin from 'eslint-plugin-prettier/recommended';
import tseslint from 'typescript-eslint';

/**
 * A shared ESLint configuration for the repository.
 *
 * @type {import("eslint").Linter.Config[]}
 * */
export default [
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettierPlugin,
  {
    plugins: {
      import: importPlugin,
    },
    rules: {
      'import/no-default-export': 'warn',
    },
  },
  {
    languageOptions: {
      parserOptions: {
        // projectService: true,
        // EXPERIMENTAL_useProjectService: true,
        project: ['./tsconfig.json', './apps/*/tsconfig.json', './packages/*/tsconfig.json'],
      },
    },
    rules: {
      // custom rules
      'arrow-body-style': 'off',
      'prefer-arrow-callback': 'off',
      'no-debugger': 'warn',
      'prefer-const': 'warn',
      'prettier/prettier': ['warn', {}, { usePrettierrc: true }],
      // typescript-eslint rules
      '@typescript-eslint/interface-name-prefix': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/consistent-type-assertions': ['warn', { assertionStyle: 'as' }],
      '@typescript-eslint/no-unsafe-type-assertion': 'error',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/require-await': 'warn',
    },
  },
  {
    ignores: [
      'dist/**',
      'node_modules',
      '.prettierrc.*js',
      'eslint.config.*js',
      'src/test/app.ts',
      'src/test/assets/**/*',
      'src/test/dist/**/*',
    ],
  },
];
