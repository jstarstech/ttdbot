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
            exclude: ['src/tests/**', 'src/types.ts', 'src/main.ts']
        }
    }
});
