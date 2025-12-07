import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        exclude: [...configDefaults.exclude],
        sequence: {
            hooks: 'list'
        },
        watch: false
    }
});
