import { afterEach, describe, expect, test, beforeEach, vi } from 'vitest';
import MediaConvert from '../MediaConvert';
import { Config } from '../Config.js';
import winston from 'winston';

vi.mock('node:child_process', () => ({
    exec: vi.fn(),
    spawn: vi.fn()
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

const mockLogger = winston.createLogger({
    level: 'info',
    transports: [new winston.transports.Console()]
});

describe('MediaConvert', () => {
    let mediaConvert: MediaConvert;

    beforeEach(() => {
        mediaConvert = new MediaConvert(mockConfig, mockLogger);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('should set source file', () => {
        mediaConvert.setSrc('source.mp4');
        expect(mediaConvert['src']).toBe('source.mp4');
    });

    test('should throw error when setting empty source file', () => {
        expect(() => mediaConvert.setSrc('')).toThrow('Source filename is empty');
    });

    test('should set destination file', () => {
        mediaConvert.setDst('destination.mp4');
        expect(mediaConvert['dest']).toBe('destination.mp4');
    });

    test('should throw error when setting empty destination file', () => {
        expect(() => mediaConvert.setDst('')).toThrow('Destination filename is empty');
    });

    test('should split video by size with fractional durations', async () => {
        mediaConvert.setSrc('source.mp4');

        const getDurationSpy = vi.spyOn(MediaConvert, 'getDuration').mockImplementation(async file => {
            return file === 'source.mp4' ? 1.1 : 0.4;
        });
        const splitVideoPartSpy = vi.spyOn(mediaConvert, 'splitVideoPart').mockResolvedValue('ok');

        const result = await mediaConvert.splitBySize();

        expect(result).toEqual([
            '/mock/data/dir/convert/source-1.mp4',
            '/mock/data/dir/convert/source-2.mp4',
            '/mock/data/dir/convert/source-3.mp4'
        ]);
        expect(getDurationSpy).toHaveBeenCalledTimes(4);
        expect(splitVideoPartSpy).toHaveBeenCalledTimes(3);
    });

    test('should use container duration when stream duration is missing', async () => {
        const exec = (await import('node:child_process')).exec as unknown as ReturnType<typeof vi.fn>;

        exec.mockImplementation((command, callback) => {
            callback(null, JSON.stringify({ format: { duration: '12.5' } }), '');
            return {} as never;
        });

        await expect(MediaConvert.getDuration('source.mp4')).resolves.toBe(12.5);
        expect(exec).toHaveBeenCalled();
    });

    // @TODO Enable these tests after adding source.mp4 file
    /*     test('should get video duration', async () => {
        const duration = await MediaConvert.getDuration('source.mp4');
        expect(duration).toBe(60);
        expect(exec).toHaveBeenCalled();
    });

    test('should convert video', async () => {
        mediaConvert.setSrc('source.mp4').setDst('destination.mp4');
        const result = await mediaConvert.convert();
        expect(result).toBe(true);
        expect(exec).toHaveBeenCalled();
    }, 600000);

    test('should split video by size', async () => {
        mediaConvert.setSrc('source.mp4');
        const result = await mediaConvert.splitBySize();
        expect(result).toEqual(['/mock/data/dir/convert/source-1.mp4', '/mock/data/dir/convert/source-2.mp4']);
        expect(exec).toHaveBeenCalledTimes(3); // 1 for getDuration and 2 for splitVideoPart
    }); */
});
