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

    test('create anchors the status as a reply to the submitted message', async () => {
        const api = makeApi();

        const status = await StatusMessage.create(api, 7, 'start', mockLogger, 99);

        expect(api.sendMessage).toHaveBeenCalledWith(7, 'start', { reply_parameters: { message_id: 99 } });
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

    test('a failed edit is retryable: the text is not marked as sent on error', async () => {
        const api = makeApi();
        const status = (await StatusMessage.create(api, 7, 'start', mockLogger))!;
        // First attempt fails
        api.editMessageText.mockRejectedValueOnce(new Error('network error'));
        status.update('progress');
        await vi.advanceTimersByTimeAsync(1500);
        expect(api.editMessageText).toHaveBeenCalledTimes(1);
        expect(api.editMessageText).toHaveBeenCalledWith(7, 42, 'progress');
        // Second attempt with same text succeeds; should NOT be skipped as a no-op
        api.editMessageText.mockResolvedValueOnce(true);
        status.update('progress');
        await vi.advanceTimersByTimeAsync(1500);
        expect(api.editMessageText).toHaveBeenCalledTimes(2);
        expect(api.editMessageText).toHaveBeenLastCalledWith(7, 42, 'progress');
    });

    test('finalize waits for in-flight edits before completing', async () => {
        const api = makeApi();
        // Track call order
        const callOrder: string[] = [];
        let resolveFirstEdit: (() => void) | null = null;
        let callCount = 0;
        api.editMessageText.mockImplementation(() => {
            callCount++;
            const callNum = callCount;
            callOrder.push(`edit ${callNum} called`);
            return new Promise<true>((resolve) => {
                if (callNum === 1) {
                    // First edit hangs until we resolve it
                    resolveFirstEdit = () => {
                        callOrder.push(`edit ${callNum} resolved`);
                        resolve(true);
                    };
                } else {
                    // Subsequent edits resolve immediately
                    callOrder.push(`edit ${callNum} resolved`);
                    resolve(true);
                }
            });
        });
        const status = (await StatusMessage.create(api, 7, 'start', mockLogger))!;
        // Trigger an update to schedule the first edit
        status.update('progress');
        await vi.advanceTimersByTimeAsync(1500);
        expect(callOrder).toEqual(['edit 1 called']);
        // Call finalize while first edit is still in flight
        const finalizePromise = status.finalize('done');
        // Yield control
        await vi.advanceTimersByTimeAsync(0);
        // finalize should be blocked waiting for the first edit
        expect(callOrder).toEqual(['edit 1 called']);
        // Now resolve the first edit
        resolveFirstEdit?.();
        // Wait for finalize to complete
        await finalizePromise;
        // Now we should see the second edit was called and resolved
        expect(callOrder).toContain('edit 2 called');
        expect(api.editMessageText).toHaveBeenCalledTimes(2);
        expect(api.editMessageText).toHaveBeenLastCalledWith(7, 42, 'done');
    });
});
