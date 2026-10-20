export default [
  {
    files: ['tools/governance/**/*.mjs', 'tests/governance/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: { ecmaVersion: 2025, sourceType: 'module' },
    rules: {
      'no-unreachable': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-dupe-args': 'error',
      'no-dupe-keys': 'error',
      'valid-typeof': 'error',
    },
  },
];
