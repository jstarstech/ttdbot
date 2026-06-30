import { afterEach, describe, expect, test, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
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

    test('should report the video stream codec', async () => {
        const exec = (await import('node:child_process')).exec as unknown as ReturnType<typeof vi.fn>;

        exec.mockImplementation((command, callback) => {
            callback(
                null,
                JSON.stringify({
                    streams: [
                        { codec_type: 'audio', codec_name: 'aac' },
                        { codec_type: 'video', codec_name: 'hevc' }
                    ]
                }),
                ''
            );
            return {} as never;
        });

        await expect(MediaConvert.getCodec('source.mp4')).resolves.toBe('hevc');
    });

    test('should reject with the exit signal and stderr tail when ffmpeg crashes', async () => {
        const spawn = (await import('node:child_process')).spawn as unknown as ReturnType<typeof vi.fn>;

        const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
        child.stderr = new EventEmitter();
        spawn.mockReturnValue(child as never);

        mediaConvert.setSrc('source.mp4').setDst('destination.mp4');
        const promise = mediaConvert.convert();

        child.stderr.emit('data', Buffer.from('Segmentation fault'));
        child.emit('close', null, 'SIGSEGV');

        await expect(promise).rejects.toThrow(/signal SIGSEGV.*Segmentation fault/s);
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
