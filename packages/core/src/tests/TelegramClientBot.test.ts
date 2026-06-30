import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Api } from 'telegram';
import fs from 'node:fs/promises';
import TelegramClientBot from '../TelegramClientBot';
import { Config } from '../Config.js';
import winston from 'winston';

vi.mock('node:fs/promises', () => ({
    default: { writeFile: vi.fn(), rm: vi.fn() }
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
        const onNewMessage = vi.fn();
        telegramClientBot.on('newMessage', onNewMessage);

        await (telegramClientBot as any)._NewMessageGrouped(event);
        await vi.advanceTimersByTimeAsync(5000);
        await Promise.resolve();

        expect(telegramClientBot['eventsGrouped'].has(groupedId)).toBe(true);
        expect(onNewMessage).not.toHaveBeenCalled();
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
        const onNewMessage = vi.fn();
        telegramClientBot.on('newMessage', onNewMessage);

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
        expect(onNewMessage).toHaveBeenCalledTimes(1);

        secondDownloadResolve();
        await Promise.resolve();

        await vi.advanceTimersByTimeAsync(5000);
        await Promise.resolve();
        await Promise.resolve();

        expect(downloadMediaSpy).toHaveBeenCalledTimes(2);
        expect(onNewMessage).toHaveBeenCalledTimes(2);
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
        const onNewMessage = vi.fn();
        telegramClientBot.on('newMessage', onNewMessage);

        await telegramClientBot._onNewMessage(makeChannelEvent(555) as never);

        expect(downloadMedia).toHaveBeenCalledTimes(1);
        expect(onNewMessage).toHaveBeenCalledWith(expect.objectContaining({ mediaFiles: [] }));
    });

    test('ignores a message from a channel that is not in the list', async () => {
        telegramClientBot = makeBot({ ...mockConfig, input_channel_ids: [555] });
        const downloadMedia = vi.spyOn(telegramClientBot, 'downloadMedia').mockResolvedValue(undefined);
        const onNewMessage = vi.fn();
        telegramClientBot.on('newMessage', onNewMessage);

        await telegramClientBot._onNewMessage(makeChannelEvent(999) as never);

        expect(downloadMedia).not.toHaveBeenCalled();
        expect(onNewMessage).not.toHaveBeenCalled();
    });

    test('routes a grouped message to the grouped handler', async () => {
        telegramClientBot = makeBot({ ...mockConfig, input_channel_ids: [555] });
        const grouped = vi.spyOn(telegramClientBot, '_NewMessageGrouped').mockResolvedValue(undefined);
        const onNewMessage = vi.fn();
        telegramClientBot.on('newMessage', onNewMessage);

        await telegramClientBot._onNewMessage(makeChannelEvent(555, { toJSNumber: () => 1 }) as never);

        expect(grouped).toHaveBeenCalledTimes(1);
        expect(onNewMessage).not.toHaveBeenCalled();
    });
});

describe('TelegramClientBot media cleanup', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('removes downloaded media only after all listeners finish', async () => {
        const bot = Object.create(TelegramClientBot.prototype) as TelegramClientBot;
        bot['config'] = mockConfig;
        bot['logger'] = mockLogger;
        bot['eventsGrouped'] = new Map<number, never>();

        const rm = fs.rm as unknown as ReturnType<typeof vi.fn>;
        rm.mockReset();

        const order: string[] = [];
        rm.mockImplementation(async () => {
            order.push('rm');
        });

        bot.on('newMessage', async () => {
            order.push('listener-start');
            await Promise.resolve();
            order.push('listener-end');
        });

        await (bot as any).dispatchNewMessage({
            events: [],
            mediaFiles: ['/data/telegram_media/a.jpeg', '/data/telegram_media/b.mp4']
        });

        // Listener fully completes before any file is removed.
        expect(order).toEqual(['listener-start', 'listener-end', 'rm', 'rm']);
        expect(rm).toHaveBeenCalledWith('/data/telegram_media/a.jpeg', { force: true });
        expect(rm).toHaveBeenCalledWith('/data/telegram_media/b.mp4', { force: true });
    });
});

describe('TelegramClientBot.downloadMedia', () => {
    const writeFile = fs.writeFile as unknown as ReturnType<typeof vi.fn>;

    function makeBot(client: unknown): TelegramClientBot {
        const bot = Object.create(TelegramClientBot.prototype) as TelegramClientBot;
        bot['config'] = mockConfig;
        bot['logger'] = mockLogger;
        bot['client'] = client as never;
        return bot;
    }

    const newGrouped = () => ({ events: [], mediaFiles: [] as string[], timeout: null });

    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('writes a downloaded photo to telegram_media and records its path', async () => {
        const bot = makeBot({ downloadMedia: vi.fn().mockResolvedValue(Buffer.from('img')) });
        const grouped = newGrouped();

        await (bot as any).downloadMedia({ message: { id: 1, photo: {} } }, grouped);

        expect(writeFile).toHaveBeenCalledTimes(1);
        const [writtenPath, data] = writeFile.mock.calls[0];
        expect(writtenPath).toMatch(/^\/mock\/data\/dir\/telegram_media\/[0-9A-Z]{35}\.jpeg$/);
        expect(data).toBeInstanceOf(Uint8Array);
        expect(grouped.mediaFiles).toEqual([writtenPath]);
    });

    test('writes a downloaded video as an mp4', async () => {
        const bot = makeBot({ downloadMedia: vi.fn().mockResolvedValue(Buffer.from('vid')) });
        const grouped = newGrouped();

        await (bot as any).downloadMedia({ message: { id: 2, video: {} } }, grouped);

        const [writtenPath] = writeFile.mock.calls[0];
        expect(writtenPath).toMatch(/^\/mock\/data\/dir\/telegram_media\/[0-9A-Z]{35}\.mp4$/);
        expect(grouped.mediaFiles).toEqual([writtenPath]);
    });

    test('writes a non-Buffer payload as-is', async () => {
        const bot = makeBot({ downloadMedia: vi.fn().mockResolvedValue('rawdata') });
        const grouped = newGrouped();

        await (bot as any).downloadMedia({ message: { id: 3, video: {} } }, grouped);

        const [, data] = writeFile.mock.calls[0];
        expect(data).toBe('rawdata');
    });

    test('logs and skips when no media could be downloaded', async () => {
        const bot = makeBot({ downloadMedia: vi.fn().mockResolvedValue(undefined) });
        const grouped = newGrouped();

        await (bot as any).downloadMedia({ message: { id: 7, photo: {} } }, grouped);

        expect(writeFile).not.toHaveBeenCalled();
        expect(grouped.mediaFiles).toEqual([]);
        expect(mockLogger.error).toHaveBeenCalledWith('Failed to download media', { messageId: 7 });
    });
});
