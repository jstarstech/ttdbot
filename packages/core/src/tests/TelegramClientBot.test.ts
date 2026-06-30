import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Api } from 'telegram';
import TelegramClientBot from '../TelegramClientBot';
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

describe('TelegramClientBot', () => {
    let telegramClientBot: TelegramClientBot;

    beforeEach(() => {
        vi.useFakeTimers();
        telegramClientBot = Object.create(TelegramClientBot.prototype) as TelegramClientBot;
        telegramClientBot['config'] = mockConfig;
        telegramClientBot['logger'] = mockLogger;
        telegramClientBot['eventsGrouped'] = new Map<number, never>();
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
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
        await vi.advanceTimersByTimeAsync(5000);
        await Promise.resolve();

        expect(telegramClientBot['eventsGrouped'].has(groupedId)).toBe(true);
        expect(emitSpy).not.toHaveBeenCalled();
        expect(mockLogger.error).toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(5000);
        await Promise.resolve();

        expect(telegramClientBot['eventsGrouped'].has(groupedId)).toBe(false);
    });

    test('keeps late grouped events in a new batch while the previous batch is processing', async () => {
        const groupedId = 123;
        let firstDownloadResolve: () => void = () => undefined;
        let secondDownloadResolve: () => void = () => undefined;
        const firstDownload = new Promise<void>(resolve => {
            firstDownloadResolve = resolve;
        });
        const secondDownload = new Promise<void>(resolve => {
            secondDownloadResolve = resolve;
        });
        const event1 = {
            message: {
                groupedId: {
                    toJSNumber: () => groupedId
                },
                message: 'first',
                id: 1
            }
        };
        const event2 = {
            message: {
                groupedId: {
                    toJSNumber: () => groupedId
                },
                message: 'second',
                id: 2
            }
        };

        const downloadMediaSpy = vi
            .spyOn(telegramClientBot, 'downloadMedia')
            .mockImplementationOnce(async () => firstDownload)
            .mockImplementationOnce(async () => secondDownload);
        const emitSpy = vi.spyOn(telegramClientBot, 'emit');

        await (telegramClientBot as any)._NewMessageGrouped(event1);
        await vi.advanceTimersByTimeAsync(5000);
        await Promise.resolve();

        await (telegramClientBot as any)._NewMessageGrouped(event2);
        await Promise.resolve();
        await Promise.resolve();

        firstDownloadResolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(telegramClientBot['eventsGrouped'].has(groupedId)).toBe(true);
        expect(downloadMediaSpy).toHaveBeenCalledTimes(1);
        expect(emitSpy).toHaveBeenCalledTimes(1);

        secondDownloadResolve();
        await Promise.resolve();

        await vi.advanceTimersByTimeAsync(5000);
        await Promise.resolve();
        await Promise.resolve();

        expect(downloadMediaSpy).toHaveBeenCalledTimes(2);
        expect(emitSpy).toHaveBeenCalledTimes(2);
        expect(telegramClientBot['eventsGrouped'].has(groupedId)).toBe(true);

        await vi.advanceTimersByTimeAsync(5000);
        await Promise.resolve();
        await Promise.resolve();
    });
});

describe('TelegramClientBot._onNewMessage', () => {
    let telegramClientBot: TelegramClientBot;

    function makeBot(config: Config): TelegramClientBot {
        const bot = Object.create(TelegramClientBot.prototype) as TelegramClientBot;
        bot['config'] = config;
        bot['logger'] = mockLogger;
        bot['eventsGrouped'] = new Map<number, never>();
        return bot;
    }

    function makeChannelEvent(channelId: number, groupedId: unknown = null) {
        const sender = Object.create(Api.Channel.prototype);
        sender.id = { toJSNumber: () => channelId };

        return {
            message: {
                id: 1,
                groupedId,
                getSender: vi.fn().mockResolvedValue(sender)
            }
        };
    }

    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('forwards a message from a listed channel', async () => {
        telegramClientBot = makeBot({ ...mockConfig, input_channel_ids: [555] });
        const downloadMedia = vi.spyOn(telegramClientBot, 'downloadMedia').mockResolvedValue(undefined);
        const emit = vi.spyOn(telegramClientBot, 'emit');

        await telegramClientBot._onNewMessage(makeChannelEvent(555) as never);

        expect(downloadMedia).toHaveBeenCalledTimes(1);
        expect(emit).toHaveBeenCalledWith('newMessage', expect.objectContaining({ mediaFiles: [] }));
    });

    test('ignores a message from a channel that is not in the list', async () => {
        telegramClientBot = makeBot({ ...mockConfig, input_channel_ids: [555] });
        const downloadMedia = vi.spyOn(telegramClientBot, 'downloadMedia').mockResolvedValue(undefined);
        const emit = vi.spyOn(telegramClientBot, 'emit');

        await telegramClientBot._onNewMessage(makeChannelEvent(999) as never);

        expect(downloadMedia).not.toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
    });

    test('routes a grouped message to the grouped handler', async () => {
        telegramClientBot = makeBot({ ...mockConfig, input_channel_ids: [555] });
        const grouped = vi.spyOn(telegramClientBot, '_NewMessageGrouped').mockResolvedValue(undefined);
        const emit = vi.spyOn(telegramClientBot, 'emit');

        await telegramClientBot._onNewMessage(makeChannelEvent(555, { toJSNumber: () => 1 }) as never);

        expect(grouped).toHaveBeenCalledTimes(1);
        expect(emit).not.toHaveBeenCalled();
    });
});
