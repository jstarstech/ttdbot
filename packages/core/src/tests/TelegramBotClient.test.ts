import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import TelegramBotClient from '../TelegramBotClient';
import { Config } from '../Config.js';
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
            mediaFiles: []
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
            mediaFiles: []
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

        const file = await (bot as any).downloadMedia({
            msg: { photo: [{ file_id: 'small' }, { file_id: 'large' }] },
            api: { getFile }
        });

        expect(getFile).toHaveBeenCalledWith('large');
        expect(file).toMatch(/^\/mock\/data\/dir\/telegram_media\/[0-9A-Z]{35}\.jpeg$/);
        expect(writeFile).toHaveBeenCalledTimes(1);
    });

    test('returns null and logs when getFile rejects (e.g. over 20 MB on cloud)', async () => {
        const bot = makeBot();
        const getFile = vi.fn().mockRejectedValue(new Error('file is too big'));

        const file = await (bot as any).downloadMedia({
            msg: { video: { file_id: 'big' } },
            api: { getFile }
        });

        expect(file).toBeNull();
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

        const file = await (bot as any).downloadMedia({
            msg: { document: { file_id: 'doc', mime_type: 'video/mp4' } },
            api: { getFile }
        });

        expect(getFile).toHaveBeenCalledWith('doc');
        expect(file).toMatch(/\.mp4$/);
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

        const file = await (bot as any).downloadMedia({
            msg: { video: { file_id: 'v' } },
            api: { getFile }
        });

        expect(fetchMock).toHaveBeenCalledWith('http://localhost:8082/TOK/videos/file_0.mp4');
        expect(file).toMatch(/\.mp4$/);
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
            .mockResolvedValueOnce('/m/a.jpeg')
            .mockResolvedValueOnce('/m/b.jpeg');
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
});
