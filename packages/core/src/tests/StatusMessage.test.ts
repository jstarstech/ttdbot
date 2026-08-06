import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import StatusMessage from '../StatusMessage.js';
import winston from 'winston';

const mockLogger = { error: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn() } as unknown as winston.Logger;

const makeApi = () => ({
    sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
    editMessageText: vi.fn().mockResolvedValue(true)
});

describe('StatusMessage', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('create sends the initial message and remembers its id', async () => {
        const api = makeApi();
        const status = await StatusMessage.create(api, 7, 'start', mockLogger);
        expect(api.sendMessage).toHaveBeenCalledWith(7, 'start');
        expect(status).not.toBeNull();
    });

    test('create returns null and logs when Telegram rejects the send', async () => {
        const api = makeApi();
        api.sendMessage.mockRejectedValue(new Error('403'));
        const status = await StatusMessage.create(api, 7, 'start', mockLogger);
        expect(status).toBeNull();
        expect(mockLogger.error).toHaveBeenCalled();
    });

    test('rapid updates coalesce into one throttled edit with the latest text', async () => {
        const api = makeApi();
        const status = (await StatusMessage.create(api, 7, 'start', mockLogger))!;
        status.update('a');
        status.update('b');
        status.update('c');
        expect(api.editMessageText).not.toHaveBeenCalled(); // still inside the 1.5 s window after create
        await vi.advanceTimersByTimeAsync(1500);
        expect(api.editMessageText).toHaveBeenCalledTimes(1);
        expect(api.editMessageText).toHaveBeenCalledWith(7, 42, 'c');
    });

    test('an update identical to the last sent text is skipped', async () => {
        const api = makeApi();
        const status = (await StatusMessage.create(api, 7, 'start', mockLogger))!;
        status.update('start');
        await vi.advanceTimersByTimeAsync(3000);
        expect(api.editMessageText).not.toHaveBeenCalled();
    });

    test('finalize cancels pending updates and edits immediately', async () => {
        const api = makeApi();
        const status = (await StatusMessage.create(api, 7, 'start', mockLogger))!;
        status.update('progress');
        await status.finalize('done');
        expect(api.editMessageText).toHaveBeenCalledTimes(1);
        expect(api.editMessageText).toHaveBeenCalledWith(7, 42, 'done');
        await vi.advanceTimersByTimeAsync(3000);
        expect(api.editMessageText).toHaveBeenCalledTimes(1); // pending timer was cancelled
    });

    test('edit errors are swallowed and logged', async () => {
        const api = makeApi();
        api.editMessageText.mockRejectedValue(new Error('400'));
        const status = (await StatusMessage.create(api, 7, 'start', mockLogger))!;
        await status.finalize('done');
        expect(mockLogger.error).toHaveBeenCalled();
    });
});
