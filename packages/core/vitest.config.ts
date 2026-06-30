import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        exclude: [...configDefaults.exclude],
        sequence: {
            hooks: 'list'
        },
        watch: false,
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html'],
            include: ['src/**/*.ts'],
            exclude: ['src/tests/**', 'src/types.ts', 'src/main.ts'],
            // Floors set just below current coverage; raise as coverage grows.
            thresholds: {
                statements: 60,
                branches: 48,
                functions: 55,
                lines: 60
            }
        }
    }
});
