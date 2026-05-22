import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import tseslint from 'typescript-eslint';

export default defineConfig([
    {
        ignores: ['dist/**', 'node_modules/**', 'tests/**', '**/*.test.*', '**/*.spec.*']
    },
    {
        languageOptions: {
            globals: {
                AbortController: 'readonly',
                Buffer: 'readonly',
                console: 'readonly',
                process: 'readonly'
            }
        }
    },
    js.configs.recommended,
    tseslint.configs.recommended,
    {
        rules: {
            'no-var': 'error',
            'prefer-const': 'warn',
            eqeqeq: 'error',
            'class-methods-use-this': 'warn',
            'prettier/prettier': 'error',
            'no-eval': 'error',
            'no-multi-spaces': 'error'
        }
    },
    prettierRecommended
]);
