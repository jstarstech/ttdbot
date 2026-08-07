import { beforeEach, describe, expect, test, vi } from 'vitest';
import { AttachmentBuilder } from 'discord.js';
import fs from 'fs-extra';
import DiscordClient from '../DiscordClient';
import { Config } from '../Config.js';
import { ForwardPayload } from '../types.js';
import winston from 'winston';

const mocks = vi.hoisted(() => {
    const instance: {
        setSrc: ReturnType<typeof vi.fn>;
        setDst: ReturnType<typeof vi.fn>;
        convert: ReturnType<typeof vi.fn>;
        splitBySize: ReturnType<typeof vi.fn>;
    } = {
        setSrc: vi.fn(),
        setDst: vi.fn(),
        convert: vi.fn(),
        splitBySize: vi.fn()
    };

    return { instance, getCodec: vi.fn() };
});

vi.mock('fs-extra', () => ({
    default: {
        statSync: vi.fn(),
        createReadStream: vi.fn(),
        remove: vi.fn()
    }
}));

vi.mock('../MediaConvert', () => ({
    default: class {
        constructor() {
            return mocks.instance as never;
        }
        static getCodec = mocks.getCodec;
    }
}));

const statSync = fs.statSync as unknown as ReturnType<typeof vi.fn>;
const createReadStream = fs.createReadStream as unknown as ReturnType<typeof vi.fn>;

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

const mb = (size: number) => ({ size: size * 1024 * 1024 });

describe('DiscordClient', () => {
    let client: DiscordClient;

    beforeEach(() => {
        vi.clearAllMocks();

        mocks.instance.setSrc.mockReturnValue(mocks.instance);
        mocks.instance.setDst.mockReturnValue(mocks.instance);
        mocks.instance.convert.mockResolvedValue(true);
        mocks.instance.splitBySize.mockResolvedValue([]);
        mocks.getCodec.mockResolvedValue('h264');
        statSync.mockReturnValue(mb(1));
        createReadStream.mockReturnValue('STREAM');

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

describe('DiscordClient.prepareVideo', () => {
    let client: DiscordClient;

    beforeEach(() => {
        vi.clearAllMocks();

        mocks.instance.setSrc.mockReturnValue(mocks.instance);
        mocks.instance.setDst.mockReturnValue(mocks.instance);
        mocks.instance.convert.mockResolvedValue(true);
        mocks.instance.splitBySize.mockResolvedValue([]);
        mocks.getCodec.mockResolvedValue('h264');
        statSync.mockReturnValue(mb(1));
        createReadStream.mockReturnValue('STREAM');

        client = new DiscordClient(mockConfig, mockLogger);
    });

    test('attaches a small non-HEVC mp4 as-is', async () => {
        statSync.mockReturnValue(mb(2));

        const { files, remove } = await client.prepareVideo('/data/telegram_media/clip.mp4');

        expect(mocks.instance.convert).not.toHaveBeenCalled();
        expect(mocks.instance.splitBySize).not.toHaveBeenCalled();
        expect(remove).toEqual([]);
        expect(files).toHaveLength(1);
        expect(files[0]).toBeInstanceOf(AttachmentBuilder);
        expect(files[0].name).toBe('clip.mp4');
    });

    test('transcodes a small HEVC mp4 to H.264 and marks it for removal', async () => {
        statSync.mockReturnValue(mb(3));
        mocks.getCodec.mockResolvedValue('hevc');

        const { files, remove } = await client.prepareVideo('/data/telegram_media/clip.mp4');

        const converted = '/mock/data/dir/convert/clip-h264.mp4';
        expect(mocks.instance.setSrc).toHaveBeenCalledWith('/data/telegram_media/clip.mp4');
        expect(mocks.instance.setDst).toHaveBeenCalledWith(converted);
        expect(mocks.instance.convert).toHaveBeenCalled();
        expect(remove).toEqual([converted]);
        expect(files.map(f => f.name)).toEqual(['clip-h264.mp4']);
    });

    test('splits an oversized mp4 into parts', async () => {
        statSync.mockReturnValue(mb(20));
        mocks.instance.splitBySize.mockResolvedValue(['/p/clip-1.mp4', '/p/clip-2.mp4']);

        const { files, remove } = await client.prepareVideo('/data/telegram_media/clip.mp4');

        expect(mocks.instance.convert).not.toHaveBeenCalled();
        expect(mocks.instance.splitBySize).toHaveBeenCalled();
        expect(remove).toEqual(['/p/clip-1.mp4', '/p/clip-2.mp4']);
        expect(files.map(f => f.name)).toEqual(['clip-1.mp4', 'clip-2.mp4']);
    });

    test('logs and returns nothing when processing throws', async () => {
        statSync.mockImplementation(() => {
            throw new Error('no such file');
        });

        const { files, remove } = await client.prepareVideo('/data/telegram_media/clip.mp4');

        expect(files).toEqual([]);
        expect(remove).toEqual([]);
        expect(mockLogger.error).toHaveBeenCalledWith(
            'Failed to process video /data/telegram_media/clip.mp4',
            expect.anything()
        );
    });
});

describe('DiscordClient.buildChunks', () => {
    let client: DiscordClient;

    beforeEach(() => {
        vi.clearAllMocks();

        mocks.instance.setSrc.mockReturnValue(mocks.instance);
        mocks.instance.setDst.mockReturnValue(mocks.instance);
        mocks.instance.convert.mockResolvedValue(true);
        mocks.instance.splitBySize.mockResolvedValue([]);
        mocks.getCodec.mockResolvedValue('h264');
        statSync.mockReturnValue(mb(1));
        createReadStream.mockReturnValue('STREAM');

        client = new DiscordClient(mockConfig, mockLogger);
    });

    const payload = (mediaFiles: string[], over: Partial<ForwardPayload> = {}): ForwardPayload => ({
        title: 'My Channel',
        url: 'https://t.me/mychan/42',
        text: 'hello world',
        mediaFiles,
        ...over
    });

    test('builds embed and file chunks from a jpeg and an mp4', async () => {
        const chunks = await client.buildChunks(payload(['/data/telegram_media/a.jpeg', '/data/telegram_media/b.mp4']));

        expect(chunks.embedsChunks).toHaveLength(1);

        const [firstEmbed, jpegEmbed] = chunks.embedsChunks[0];
        expect(firstEmbed.title).toBe('My Channel');
        expect(firstEmbed.url).toBe('https://t.me/mychan/42');
        expect(firstEmbed.description).toBe('hello world');
        expect(jpegEmbed.image?.url).toBe('attachment://a.jpeg');

        const chunk = chunks.filesChunks[0];
        expect(chunk[0]).toBe('/data/telegram_media/a.jpeg');
        expect(chunk[1]).toBeInstanceOf(AttachmentBuilder);
        expect((chunk[1] as AttachmentBuilder).name).toBe('b.mp4');
    });

    test('uses the payload url for the embed', async () => {
        const chunks = await client.buildChunks(payload([], { url: 'https://example.org/' }));

        expect(chunks.embedsChunks[0][0].url).toBe('https://example.org/');
    });

    // Sizes by path: source videos are big, split parts ~9 MB, images small.
    const statSyncBySize = () =>
        statSync.mockImplementation((file: string) => {
            if (file.endsWith('.jpeg')) return { size: 500_000 };
            if (file.includes('/convert/')) return { size: 9_000_000 };
            return mb(200);
        });

    test('keeps every chunk at 10 or fewer attachments when images and split video parts combine', async () => {
        // Live failure (t.me/m4a1ks/201): 9 jpegs + a video split into 2 parts landed
        // 11 attachments in one message; Discord rejects >10 (50035 BASE_TYPE_MAX_LENGTH).
        statSyncBySize();
        mocks.instance.splitBySize.mockResolvedValue(['/mock/data/dir/convert/v-1.mp4', '/mock/data/dir/convert/v-2.mp4']);

        const jpegs = Array.from({ length: 9 }, (_, n) => `/data/telegram_media/img${n}.jpeg`);
        const chunks = await client.buildChunks(payload([...jpegs, '/data/telegram_media/v.mp4']));

        expect(chunks.filesChunks.length).toBe(chunks.embedsChunks.length);
        for (const files of chunks.filesChunks) {
            expect(files.length).toBeLessThanOrEqual(10);
        }
        expect(chunks.filesChunks.flat()).toHaveLength(11); // nothing dropped
    });

    test('keeps every chunk under the 25 MiB request cap: 3 nine-MB parts span two messages', async () => {
        // Discord: "The maximum request size when sending a message is 25 MiB".
        // 3 x 9 MB in one multipart request is ~27 MB — over the cap even though the
        // attachment count (3) is fine.
        statSyncBySize();
        mocks.instance.splitBySize.mockResolvedValue(
            Array.from({ length: 3 }, (_, n) => `/mock/data/dir/convert/v-${n + 1}.mp4`)
        );

        const chunks = await client.buildChunks(payload(['/data/telegram_media/v.mp4']));

        expect(chunks.filesChunks.map(files => files.length)).toEqual([2, 1]);
    });

    test('rolls an image to the next chunk when it would push the request over the byte budget', async () => {
        statSync.mockImplementation((file: string) => {
            if (file.endsWith('.jpeg')) return { size: 8_000_000 };
            if (file.includes('/convert/')) return { size: 9_000_000 };
            return mb(200);
        });
        mocks.instance.splitBySize.mockResolvedValue(
            Array.from({ length: 2 }, (_, n) => `/mock/data/dir/convert/v-${n + 1}.mp4`)
        );

        // 9 + 9 MB parts leave no room for an 8 MB image in the same request.
        const chunks = await client.buildChunks(
            payload(['/data/telegram_media/v.mp4', '/data/telegram_media/big.jpeg'])
        );

        expect(chunks.filesChunks.map(files => files.length)).toEqual([2, 1]);
        expect(chunks.embedsChunks[1][0].image?.url).toBe('attachment://big.jpeg');
    });

    test('spreads a video split into more than 10 parts across multiple chunks', async () => {
        statSyncBySize();
        mocks.instance.splitBySize.mockResolvedValue(
            Array.from({ length: 25 }, (_, n) => `/mock/data/dir/convert/v-${n + 1}.mp4`)
        );

        const chunks = await client.buildChunks(payload(['/data/telegram_media/v.mp4']));

        expect(chunks.filesChunks.length).toBe(chunks.embedsChunks.length);
        for (const files of chunks.filesChunks) {
            expect(files.length).toBeLessThanOrEqual(10);
        }
        expect(chunks.filesChunks.flat()).toHaveLength(25);
    });

    const withOverride = (override: { name?: string; url?: string }) =>
        new DiscordClient({ ...mockConfig, overrides: { '389': override } } as Config, mockLogger);

    test('applies a sender override: custom name + url (hyperlink)', async () => {
        const c = withOverride({ name: 'Maks', url: 'https://discord.com/users/1' });

        const embed = (await c.buildChunks(payload([], { sourceId: 389 }))).embedsChunks[0][0];

        expect(embed.title).toBe('Maks');
        expect(embed.url).toBe('https://discord.com/users/1');
    });

    test('sender override with name only renders plain text (no link)', async () => {
        const c = withOverride({ name: 'Maks' });

        const embed = (await c.buildChunks(payload([], { sourceId: 389 }))).embedsChunks[0][0];

        expect(embed.title).toBe('Maks');
        expect(embed.url).toBeUndefined();
    });

    test('sender override with empty name omits the title entirely', async () => {
        const c = withOverride({ name: '' });

        const embed = (await c.buildChunks(payload([], { sourceId: 389 }))).embedsChunks[0][0];

        expect(embed.title).toBeUndefined();
        expect(embed.url).toBeUndefined();
        expect(embed.description).toBe('hello world');
    });
});

describe('DiscordClient status emissions', () => {
    let client: DiscordClient;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.instance.setSrc.mockReturnValue(mocks.instance);
        mocks.instance.setDst.mockReturnValue(mocks.instance);
        mocks.instance.convert.mockResolvedValue(true);
        mocks.instance.splitBySize.mockResolvedValue(['/mock/data/dir/convert/v-1.mp4']);
        mocks.getCodec.mockResolvedValue('h264');
        statSync.mockImplementation((file: string) => (file.includes('/convert/') ? { size: 9_000_000 } : mb(20)));
        createReadStream.mockReturnValue('STREAM');
        client = new DiscordClient(mockConfig, mockLogger);
    });

    const payload = (mediaFiles: string[], over: Partial<ForwardPayload> = {}): ForwardPayload => ({
        title: 'My Channel',
        url: 'https://t.me/mychan/42',
        text: 'hello world',
        mediaFiles,
        ...over
    });

    test('emits converting when a video is split', async () => {
        const onStatus = vi.fn();
        await client.buildChunks(payload(['/data/telegram_media/v.mp4'], { onStatus }));
        expect(onStatus).toHaveBeenCalledWith({ stage: 'converting' });
    });

    test('does not emit converting for a small h264 video attached as-is', async () => {
        statSync.mockReturnValue(mb(1));
        const onStatus = vi.fn();
        await client.buildChunks(payload(['/data/telegram_media/v.mp4'], { onStatus }));
        expect(onStatus).not.toHaveBeenCalled();
    });

    test('emits uploading per chunk during postMessage', async () => {
        statSync.mockReturnValue(mb(1));
        const send = vi.fn().mockResolvedValue(undefined);
        vi.spyOn(client, 'getChannel').mockResolvedValue({ send } as never);
        const onStatus = vi.fn();
        await client.postMessage(payload(['/data/telegram_media/a.jpeg'], { onStatus }));
        expect(onStatus).toHaveBeenCalledWith({ stage: 'uploading', chunk: 1, totalChunks: 1 });
    });

    test('emits failed when a chunk send rejects', async () => {
        statSync.mockReturnValue(mb(1));
        const send = vi.fn().mockRejectedValue(new Error('boom'));
        vi.spyOn(client, 'getChannel').mockResolvedValue({ send } as never);
        const onStatus = vi.fn();
        await client.postMessage(payload([], { onStatus }));
        expect(onStatus).toHaveBeenCalledWith({ stage: 'failed', reason: 'Discord send error' });
    });

    test('a throwing onStatus callback never breaks buildChunks', async () => {
        const onStatus = vi.fn(() => {
            throw new Error('listener bug');
        });
        const chunks = await client.buildChunks(payload(['/data/telegram_media/v.mp4'], { onStatus }));
        expect(chunks.filesChunks.flat().length).toBeGreaterThan(0);
    });

    test('emits failed when the channel cannot be fetched', async () => {
        vi.spyOn(client, 'getChannel').mockResolvedValue(undefined);
        const onStatus = vi.fn();
        await client.postMessage(payload([], { onStatus }));
        expect(onStatus).toHaveBeenCalledWith({ stage: 'failed', reason: 'Discord channel unavailable' });
    });

    test('emits failed when buildChunks throws', async () => {
        vi.spyOn(client, 'getChannel').mockResolvedValue({ send: vi.fn() } as never);
        vi.spyOn(client, 'buildChunks').mockRejectedValue(new Error('boom'));
        const onStatus = vi.fn();
        await client.postMessage(payload([], { onStatus }));
        expect(onStatus).toHaveBeenCalledWith({ stage: 'failed', reason: 'Discord forwarding error' });
    });
});
