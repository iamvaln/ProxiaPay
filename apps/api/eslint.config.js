// @ts-check
const tseslint = require('typescript-eslint');
const noMoneyArithmetic = require('./eslint-rules/no-money-arithmetic');

module.exports = tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'src/db/schema.generated.ts'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    plugins: { proxiapay: { rules: { 'no-money-arithmetic': noMoneyArithmetic } } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-require-imports': 'off',
      'no-console': ['error', { allow: ['error'] }],
      'proxiapay/no-money-arithmetic': 'error',
    },
  },
  { files: ['src/money/**', 'src/**/*.test.ts', 'src/test/**', 'src/cli/**'], rules: { 'proxiapay/no-money-arithmetic': 'off', 'no-console': 'off' } },
);
