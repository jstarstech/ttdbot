import { beforeEach, describe, expect, test, vi } from 'vitest';
import TelegramClientBot from '../TelegramClientBot';
import { Config } from '../Config.js';
import winston from 'winston';

vi.mock('timers/promises', () => ({
    setTimeout: vi.fn().mockResolvedValue(undefined)
}));

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

describe('TelegramClientBot', () => {
    let telegramClientBot: TelegramClientBot;

    beforeEach(() => {
        telegramClientBot = Object.create(TelegramClientBot.prototype) as TelegramClientBot;
        telegramClientBot['config'] = mockConfig;
        telegramClientBot['logger'] = mockLogger;
        telegramClientBot['eventsGrouped'] = new Map<number, never>();
    });

    test('cleans up grouped state even if processing fails', async () => {
        const groupedId = 123;
        const event = {
            message: {
                groupedId: {
                    toJSNumber: () => groupedId
                },
                message: 'hello',
                id: 1
            }
        };

        vi.spyOn(telegramClientBot, 'downloadMedia').mockRejectedValue(new Error('boom'));
        const emitSpy = vi.spyOn(telegramClientBot, 'emit');

        await (telegramClientBot as any)._NewMessageGrouped(event);

        expect(telegramClientBot['eventsGrouped'].has(groupedId)).toBe(false);
        expect(emitSpy).not.toHaveBeenCalled();
        expect(mockLogger.error).toHaveBeenCalled();
    });
});
