import { beforeEach, describe, expect, test, vi } from 'vitest';
import DiscordClient from '../DiscordClient';
import { Config } from '../Config.js';
import winston from 'winston';

const mockConfig: Config = {
    dataDir: '/mock/data/dir',
    logLevel: '',
    api_id: 0,
    api_hash: '',
    discord_bot_token: '',
    session_name: '',
    input_channel_names: [],
    input_channel_ids: [],
    output_channel_ids: [],
    discord_channel: []
};

const mockLogger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    log: vi.fn()
} as unknown as winston.Logger;

describe('DiscordClient', () => {
    let client: DiscordClient;

    beforeEach(() => {
        client = new DiscordClient(mockConfig, mockLogger);
    });

    test('initializes with the first brand color', () => {
        expect(client['lastColor']).toBe(client['colors'][0]);
    });

    test('uses the Ukrainian flag blue and yellow as brand colors', () => {
        expect(client['colors']).toEqual([0x0057b8, 0xffd700]);
    });

    test('toggleColor alternates between the two brand colors', () => {
        const [blue, yellow] = client['colors'];

        expect(client.toggleColor()).toBe(yellow);
        expect(client.toggleColor()).toBe(blue);
        expect(client.toggleColor()).toBe(yellow);
    });

    test('routes sends through a throttle that returns the callback result', async () => {
        await expect(client['sendThrottle'](() => 'sent')).resolves.toBe('sent');
    });
});
