import { beforeEach, describe, expect, test, vi } from 'vitest';
import TelegramClientBot from '../TelegramClientBot';
import { Config } from '../Config.js';
import winston from 'winston';

type TimerEntry = {
    resolve: () => void;
    reject: (reason?: unknown) => void;
    settled: boolean;
};

const timerEntries: TimerEntry[] = [];

vi.mock('timers/promises', () => ({
    setTimeout: vi.fn((_ms, _value, options?: { signal?: AbortSignal }) => {
        return new Promise<void>((resolve, reject) => {
            const entry: TimerEntry = {
                resolve: () => {
                    if (!entry.settled) {
                        entry.settled = true;
                        resolve();
                    }
                },
                reject: reason => {
                    if (!entry.settled) {
                        entry.settled = true;
                        reject(reason);
                    }
                },
                settled: false
            };

            timerEntries.push(entry);

            if (options?.signal !== undefined) {
                if (options.signal.aborted) {
                    entry.reject(new Error('Aborted'));
                    return;
                }

                options.signal.addEventListener(
                    'abort',
                    () => {
                        entry.reject(new Error('Aborted'));
                    },
                    { once: true }
                );
            }
        });
    })
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

function resolveNextTimer() {
    const entry = timerEntries.find(timerEntry => !timerEntry.settled);

    if (entry === undefined) {
        throw new Error('No pending timer to resolve');
    }

    entry.resolve();
}

describe('TelegramClientBot', () => {
    let telegramClientBot: TelegramClientBot;

    beforeEach(() => {
        timerEntries.length = 0;
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
        resolveNextTimer();
        await Promise.resolve();
        await Promise.resolve();

        expect(telegramClientBot['eventsGrouped'].has(groupedId)).toBe(true);
        expect(emitSpy).not.toHaveBeenCalled();
        expect(mockLogger.error).toHaveBeenCalled();

        resolveNextTimer();
        await Promise.resolve();
        await Promise.resolve();

        expect(telegramClientBot['eventsGrouped'].has(groupedId)).toBe(false);
    });

    test('keeps late grouped events in a new batch while the previous batch is processing', async () => {
        const groupedId = 123;
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
        let firstDownloadResolve: () => void = () => undefined;
        let secondDownloadResolve: () => void = () => undefined;

        const downloadMediaSpy = vi
            .spyOn(telegramClientBot, 'downloadMedia')
            .mockImplementationOnce(async () => firstDownload)
            .mockImplementationOnce(async () => secondDownload);
        const emitSpy = vi.spyOn(telegramClientBot, 'emit');

        await (telegramClientBot as any)._NewMessageGrouped(event1);
        await Promise.resolve();
        resolveNextTimer();
        await Promise.resolve();

        await (telegramClientBot as any)._NewMessageGrouped(event2);
        await Promise.resolve();
        await Promise.resolve();

        resolveNextTimer();
        await Promise.resolve();

        firstDownloadResolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(telegramClientBot['eventsGrouped'].has(groupedId)).toBe(true);
        expect(downloadMediaSpy).toHaveBeenCalledTimes(2);
        expect(emitSpy).toHaveBeenCalledTimes(1);

        secondDownloadResolve();
        await Promise.resolve();

        resolveNextTimer();
        await Promise.resolve();
        await Promise.resolve();
    });
});
