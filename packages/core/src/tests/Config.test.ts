import { beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import { loadConfig, workspaceRoot } from '../Config';

vi.mock('node:fs/promises', () => ({
    default: { readFile: vi.fn() }
}));

const readFile = fs.readFile as unknown as ReturnType<typeof vi.fn>;

describe('loadConfig', () => {
    beforeEach(() => {
        readFile.mockReset();
    });

    test('parses YAML config into an object', async () => {
        readFile.mockResolvedValue('dataDir: data\nlogLevel: info\napi_id: 42\n');

        const config = await loadConfig('/some/config.yml');

        expect(config).toMatchObject({ dataDir: 'data', logLevel: 'info', api_id: 42 });
        expect(readFile).toHaveBeenCalledWith('/some/config.yml', 'utf8');
    });

    test('defaults to the workspace config.yml path', async () => {
        readFile.mockResolvedValue('dataDir: data\n');

        await loadConfig();

        expect(readFile).toHaveBeenCalledWith(workspaceRoot + '/config.yml', 'utf8');
    });

    test('rejects on invalid YAML', async () => {
        readFile.mockResolvedValue('foo: [unclosed');

        await expect(loadConfig('/bad.yml')).rejects.toBeInstanceOf(Error);
    });
});
