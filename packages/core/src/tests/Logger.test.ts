import { afterEach, describe, expect, test, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import logger, { configureLogger } from '../Logger';
import { Config } from '../Config.js';

const baseConfig: Config = {
    dataDir: path.join(os.tmpdir(), 'ttdbot-logger-test'),
    logLevel: 'info',
    api_id: 0,
    api_hash: '',
    discord_bot_token: '',
    session_name: '',
    input_channel_names: [],
    input_channel_ids: [],
    output_channel_ids: [],
    discord_channel: []
};

describe('configureLogger', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('throws when logLevel is empty', () => {
        expect(() => configureLogger({ ...baseConfig, logLevel: '' })).toThrow(/logLevel/);
    });

    test('throws when logLevel is not a known level', () => {
        expect(() => configureLogger({ ...baseConfig, logLevel: 'bogus' })).toThrow(/logLevel/);
    });

    test('applies the configured level and adds the file transport only once', () => {
        const add = vi.spyOn(logger, 'add');

        configureLogger({ ...baseConfig, logLevel: 'debug' });
        expect(logger.level).toBe('debug');

        const callsAfterFirst = add.mock.calls.length;

        configureLogger({ ...baseConfig, logLevel: 'warn' });
        expect(logger.level).toBe('warn');
        expect(add.mock.calls.length).toBe(callsAfterFirst);
    });
});
