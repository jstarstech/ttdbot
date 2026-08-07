import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import TelegramBotClient from '../TelegramBotClient';
import { Config } from '../Config.js';
import { ForwardPayload } from '../types.js';
import winston from 'winston';

vi.mock('node:fs/promises', () => ({
    default: { writeFile: vi.fn(), rm: vi.fn() }
}));

const mockLogger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    log: vi.fn()
} as unknown as winston.Logger;

const baseConfig = {
    dataDir: '/mock/data/dir',
    logLevel: '',
    api_id: 0,
    api_hash: '',
    discord_bot_token: '',
    session_name: '',
    input_channel_names: [],
    input_channel_ids: [],
    output_channel_ids: [],
    discord_channel: [],
    bot: { token: 'x', allowed_user_ids: [111], allowed_chat_ids: [-100222] }
} as unknown as Config;

// Build an instance without running the constructor (which creates a real grammY Bot).
function makeBot(config: Config = baseConfig): TelegramBotClient {
    const bot = Object.create(TelegramBotClient.prototype) as TelegramBotClient;
    bot['config'] = config;
    bot['logger'] = mockLogger;
    bot['albums'] = new Map();
    bot['token'] = 'TEST_TOKEN';
    bot['apiRoot'] = 'https://api.telegram.org';
    return bot;
}

const flush = async (n = 6): Promise<void> => {
    for (let i = 0; i < n; i++) {
        await Promise.resolve();
    }
};

describe('TelegramBotClient allowlist', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('forwards a text DM from an allow-listed user', async () => {
        const bot = makeBot();
        const onNewMessage = vi.fn();
        bot.on('newMessage', onNewMessage);

        await (bot as any).handle({
            msg: { message_id: 5, text: 'hello' },
            chat: { id: 111, type: 'private' },
            from: { id: 111, first_name: 'Max' }
        });

        expect(onNewMessage).toHaveBeenCalledWith({
            title: 'Max',
            url: 'https://example.org/',
            text: 'hello',
            mediaFiles: [],
            sourceId: 111
        });
    });

    test('accepts a channel post from an allow-listed chat', async () => {
        const bot = makeBot();
        const onNewMessage = vi.fn();
        bot.on('newMessage', onNewMessage);

        await (bot as any).handle({
            msg: { message_id: 9, text: 'news' },
            chat: { id: -100222, type: 'channel', title: 'My Channel', username: 'mychan' }
        });

        expect(onNewMessage).toHaveBeenCalledWith({
            title: 'My Channel',
            url: 'https://t.me/mychan/9',
            text: 'news',
            mediaFiles: [],
            sourceId: -100222
        });
    });

    test('ignores messages from non-allow-listed sources', async () => {
        const bot = makeBot();
        const onNewMessage = vi.fn();
        bot.on('newMessage', onNewMessage);

        await (bot as any).handle({
            msg: { message_id: 1, text: 'spam' },
            chat: { id: 999, type: 'private' },
            from: { id: 999 }
        });

        expect(onNewMessage).not.toHaveBeenCalled();
    });
});

describe('TelegramBotClient.downloadMedia', () => {
    const writeFile = fs.writeFile as unknown as ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    test('downloads the largest photo and saves it', async () => {
        const bot = makeBot();
        const getFile = vi.fn().mockResolvedValue({ file_path: 'photos/file.jpg' });
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer })
        );

        const result = await (bot as any).downloadMedia({
            msg: { photo: [{ file_id: 'small' }, { file_id: 'large' }] },
            api: { getFile }
        });

        expect(getFile).toHaveBeenCalledWith('large');
        expect(result).toEqual({
            status: 'ok',
            file: expect.stringMatching(/^\/mock\/data\/dir\/telegram_media\/[0-9A-Z]{35}\.jpeg$/)
        });
        expect(writeFile).toHaveBeenCalledTimes(1);
    });

    test('returns failed and logs when getFile rejects (e.g. over 20 MB on cloud)', async () => {
        const bot = makeBot();
        const getFile = vi.fn().mockRejectedValue(new Error('file is too big'));

        const result = await (bot as any).downloadMedia({
            msg: { video: { file_id: 'big' } },
            api: { getFile }
        });

        expect(result).toEqual({ status: 'failed', kind: 'video' });
        expect(writeFile).not.toHaveBeenCalled();
        expect(mockLogger.error).toHaveBeenCalled();
    });

    test('downloads a video sent as a document (file)', async () => {
        const bot = makeBot();
        const getFile = vi.fn().mockResolvedValue({ file_path: 'documents/file.mp4' });
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer })
        );

        const result = await (bot as any).downloadMedia({
            msg: { document: { file_id: 'doc', mime_type: 'video/mp4' } },
            api: { getFile }
        });

        expect(getFile).toHaveBeenCalledWith('doc');
        expect(result).toEqual({ status: 'ok', file: expect.stringMatching(/\.mp4$/) });
    });

    test('fetches a --local absolute path from api_files_url, stripping the server dir', async () => {
        const bot = makeBot({
            ...baseConfig,
            bot: {
                ...baseConfig.bot,
                api_server_dir: '/var/lib/telegram-bot-api',
                api_files_url: 'http://localhost:8082'
            }
        } as unknown as Config);
        const getFile = vi.fn().mockResolvedValue({ file_path: '/var/lib/telegram-bot-api/TOK/videos/file_0.mp4' });
        const fetchMock = vi
            .fn()
            .mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2]).buffer });
        vi.stubGlobal('fetch', fetchMock);

        const result = await (bot as any).downloadMedia({
            msg: { video: { file_id: 'v' } },
            api: { getFile }
        });

        expect(fetchMock).toHaveBeenCalledWith('http://localhost:8082/TOK/videos/file_0.mp4');
        expect(result).toEqual({ status: 'ok', file: expect.stringMatching(/\.mp4$/) });
    });

    test('returns unsupported for a sticker', async () => {
        const bot = makeBot();

        const result = await (bot as any).downloadMedia({
            msg: { sticker: {} },
            api: { getFile: vi.fn() }
        });

        expect(result).toEqual({ status: 'unsupported', kind: 'sticker' });
    });

    test('returns unsupported for a document with a non-media mime type', async () => {
        const bot = makeBot();

        const result = await (bot as any).downloadMedia({
            msg: { document: { file_id: 'd', mime_type: 'audio/mpeg' } },
            api: { getFile: vi.fn() }
        });

        expect(result).toEqual({ status: 'unsupported', kind: 'document(audio/mpeg)' });
    });

    test('returns none when the message has no media', async () => {
        const bot = makeBot();

        const result = await (bot as any).downloadMedia({
            msg: { text: 'no media here' },
            api: { getFile: vi.fn() }
        });

        expect(result).toEqual({ status: 'none' });
    });
});

describe('TelegramBotClient album grouping', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    test('batches media_group items and dispatches once after the debounce', async () => {
        const bot = makeBot();
        vi.spyOn(bot as any, 'downloadMedia')
            .mockResolvedValueOnce({ status: 'ok', file: '/m/a.jpeg' })
            .mockResolvedValueOnce({ status: 'ok', file: '/m/b.jpeg' });
        const onNewMessage = vi.fn();
        bot.on('newMessage', onNewMessage);

        const item = (id: number, caption?: string) => ({
            msg: { message_id: id, media_group_id: 'G', caption, photo: [{ file_id: `f${id}` }] },
            chat: { id: -100222, username: 'mychan' }
        });

        await (bot as any).handle(item(1, 'album caption'));
        await (bot as any).handle(item(2));

        expect(onNewMessage).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(5000);
        await flush();

        expect(onNewMessage).toHaveBeenCalledTimes(1);
        const payload = onNewMessage.mock.calls[0][0];
        expect(payload.mediaFiles).toEqual(['/m/a.jpeg', '/m/b.jpeg']);
        expect(payload.text).toBe('album caption');
        expect(payload.url).toBe('https://t.me/mychan/1');
    });

    const makeApi = () => ({
        sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
        editMessageText: vi.fn().mockResolvedValue(true),
        getFile: vi.fn()
    });

    const dmCtx = (msg: object, api = makeApi()) => ({
        msg: { message_id: 5, ...msg },
        chat: { id: 111, type: 'private' },
        from: { id: 111, first_name: 'Max' },
        api,
        reply: vi.fn().mockResolvedValue(undefined)
    });

    test('mixed album: one summary status message', async () => {
        vi.useFakeTimers();
        const bot = makeBot();
        bot.on('newMessage', vi.fn());
        const api = makeApi();
        // First item: ok photo; second: unsupported audio. Stub downloadMedia directly.
        vi.spyOn(bot as any, 'downloadMedia')
            .mockResolvedValueOnce({ status: 'ok', file: '/mock/a.jpeg' })
            .mockResolvedValueOnce({ status: 'unsupported', kind: 'audio' });

        await (bot as any).handle(dmCtx({ media_group_id: 'g1', caption: 'trip' }, api));
        await (bot as any).handle(dmCtx({ media_group_id: 'g1', audio: {} }, api));
        await vi.advanceTimersByTimeAsync(5000);

        expect(api.sendMessage).toHaveBeenCalledTimes(1);
        expect(api.sendMessage).toHaveBeenCalledWith(111, '📤 Processing album (1 items)…');
        expect(api.editMessageText).toHaveBeenCalledWith(111, 42, '✅ Delivered 1 of 2 items; skipped: audio');
        vi.useRealTimers();
    });

    test('all-unsupported album with no caption: reject reply, no dispatch', async () => {
        vi.useFakeTimers();
        const bot = makeBot();
        const onNewMessage = vi.fn();
        bot.on('newMessage', onNewMessage);
        const api = makeApi();
        vi.spyOn(bot as any, 'downloadMedia').mockResolvedValue({ status: 'unsupported', kind: 'audio' });

        const ctx = dmCtx({ media_group_id: 'g2', audio: {} }, api);
        await (bot as any).handle(ctx);
        await vi.advanceTimersByTimeAsync(5000);

        expect(ctx.reply).toHaveBeenCalledWith('⚠️ Unsupported content (audio) — nothing to forward');
        expect(onNewMessage).not.toHaveBeenCalled();
        expect(api.sendMessage).not.toHaveBeenCalled();
        vi.useRealTimers();
    });
});

describe('TelegramBotClient API reachability', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    test('logs an actionable error when the Bot API endpoint is unreachable', async () => {
        const bot = makeBot();
        bot['apiRoot'] = 'http://localhost:8081';
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));

        await (bot as any).warnIfApiUnreachable();

        expect(mockLogger.error).toHaveBeenCalledWith(
            expect.stringContaining('Bot API unreachable at http://localhost:8081'),
            expect.anything()
        );
    });

    test('stays quiet when the endpoint responds at all', async () => {
        const bot = makeBot();
        // A live Bot API server 404s on its root path — reachable is all that matters.
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));

        await (bot as any).warnIfApiUnreachable();

        expect(mockLogger.error).not.toHaveBeenCalled();
    });
});

describe('TelegramBotClient DM status replies', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    const makeApi = () => ({
        sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
        editMessageText: vi.fn().mockResolvedValue(true),
        getFile: vi.fn()
    });

    const dmCtx = (msg: object, api = makeApi()) => ({
        msg: { message_id: 5, ...msg },
        chat: { id: 111, type: 'private' },
        from: { id: 111, first_name: 'Max' },
        api,
        reply: vi.fn().mockResolvedValue(undefined)
    });

    test('unsupported DM with no caption: reject reply, no dispatch', async () => {
        const bot = makeBot();
        const onNewMessage = vi.fn();
        bot.on('newMessage', onNewMessage);
        const ctx = dmCtx({ sticker: {} });

        await (bot as any).handle(ctx);

        expect(ctx.reply).toHaveBeenCalledWith('⚠️ Unsupported content (sticker) — nothing to forward');
        expect(onNewMessage).not.toHaveBeenCalled();
        expect(ctx.api.sendMessage).not.toHaveBeenCalled();
    });

    test('text-only DM: status message created and finalized ✅ Delivered', async () => {
        const bot = makeBot();
        bot.on('newMessage', vi.fn());
        const ctx = dmCtx({ text: 'hello' });

        await (bot as any).handle(ctx);

        expect(ctx.api.sendMessage).toHaveBeenCalledWith(111, '📤 Forwarding to Discord…');
        expect(ctx.api.editMessageText).toHaveBeenCalledWith(111, 42, '✅ Delivered');
    });

    test('unsupported media with caption: caption forwards, final notes the skip', async () => {
        const bot = makeBot();
        const onNewMessage = vi.fn();
        bot.on('newMessage', onNewMessage);
        const ctx = dmCtx({ sticker: {}, caption: 'look' });

        await (bot as any).handle(ctx);

        expect(onNewMessage).toHaveBeenCalledWith(expect.objectContaining({ text: 'look', mediaFiles: [] }));
        expect(ctx.api.editMessageText).toHaveBeenCalledWith(111, 42, '✅ Delivered (text only; skipped: sticker)');
    });

    test('listener failure status surfaces as ❌ final', async () => {
        const bot = makeBot();
        bot.on('newMessage', (payload: ForwardPayload) => {
            payload.onStatus?.({ stage: 'failed', reason: 'Discord send error' });
        });
        const ctx = dmCtx({ text: 'hello' });

        await (bot as any).handle(ctx);

        expect(ctx.api.editMessageText).toHaveBeenCalledWith(111, 42, '❌ Failed: Discord send error');
    });

    test('channel post gets no replies or status messages', async () => {
        const bot = makeBot();
        bot.on('newMessage', vi.fn());
        const api = makeApi();
        const ctx = {
            msg: { message_id: 9, text: 'news' },
            chat: { id: -100222, type: 'channel', title: 'My Channel', username: 'mychan' },
            api,
            reply: vi.fn()
        };

        await (bot as any).handle(ctx);

        expect(ctx.reply).not.toHaveBeenCalled();
        expect(api.sendMessage).not.toHaveBeenCalled();
    });

    test('empty channel post (no text, no media) is not dispatched', async () => {
        const bot = makeBot();
        const onNewMessage = vi.fn();
        bot.on('newMessage', onNewMessage);

        await (bot as any).handle({
            msg: { message_id: 9 },
            chat: { id: -100222, type: 'channel' },
            api: makeApi(),
            reply: vi.fn()
        });

        expect(onNewMessage).not.toHaveBeenCalled();
    });

    test('video download fails with no caption: status finalizes ❌ Failed, no dispatch', async () => {
        const bot = makeBot();
        const onNewMessage = vi.fn();
        bot.on('newMessage', onNewMessage);
        vi.spyOn(bot as any, 'downloadMedia').mockResolvedValue({ status: 'failed', kind: 'video' });
        const ctx = dmCtx({ video: { file_id: 'v' } });

        await (bot as any).handle(ctx);

        expect(ctx.api.editMessageText).toHaveBeenCalledWith(111, 42, '❌ Failed to fetch the video');
        expect(onNewMessage).not.toHaveBeenCalled();
    });

    test('video download fails but caption present: dispatches text-only, ✅ Delivered notes the failure', async () => {
        const bot = makeBot();
        const onNewMessage = vi.fn();
        bot.on('newMessage', onNewMessage);
        vi.spyOn(bot as any, 'downloadMedia').mockResolvedValue({ status: 'failed', kind: 'video' });
        const ctx = dmCtx({ video: { file_id: 'v' }, caption: 'look' });

        await (bot as any).handle(ctx);

        expect(onNewMessage).toHaveBeenCalledWith(expect.objectContaining({ text: 'look', mediaFiles: [] }));
        expect(ctx.api.editMessageText).toHaveBeenCalledWith(111, 42, '✅ Delivered (text only; media download failed)');
    });
});
