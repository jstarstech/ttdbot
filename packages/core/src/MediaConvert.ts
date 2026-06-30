import shell from 'any-shell-escape';
import pathToFfmpeg from 'ffmpeg-static';
import { path as pathToFfprobe } from 'ffprobe-static';
import { exec, spawn } from 'node:child_process';
import Path, { resolve } from 'node:path';
import process from 'node:process';
import winston from 'winston';
import { Config } from './Config.js';
import _logger from './Logger.js';

if (pathToFfmpeg === null) {
    _logger.error('The pathToFfmpeg is null. Please check module ffmpeg-static');
    process.exit(1);
}

// Discord's non-Nitro upload limit is 10 MB. Cap each split part below that,
// leaving headroom for multipart/embed overhead and ffmpeg's soft -fs overshoot.
const MAX_PART_SIZE_BYTES = 9_000_000;

export default class MediaConvert {
    private src = '';
    private dest = '';
    private config: Config;
    private logger: winston.Logger;
    private readonly pathToFfmpeg: string;

    constructor(config: Config, logger?: winston.Logger) {
        this.config = config;
        this.logger = logger || _logger;

        if (typeof pathToFfmpeg === 'string') {
            this.pathToFfmpeg = pathToFfmpeg;
        } else {
            throw new Error('The path to ffmpeg is null. Please check module ffmpeg-static');
        }
    }

    setSrc(src: string) {
        if (src === '') {
            throw new Error('Source filename is empty');
        }
        this.src = src;

        return this;
    }

    setDst(dest: string) {
        if (dest === '') {
            throw new Error('Destination filename is empty');
        }

        this.dest = dest;

        return this;
    }

    async convert(): Promise<boolean> {
        // prettier-ignore
        const ffmpegArgs = [
            '-i', resolve(process.cwd(), this.src),
            '-c:v', 'libx264',
            '-preset', 'medium',
            '-crf', '31',
            '-c:a', 'aac',
            '-qscale:a', '0.75',
            '-vf', 'scale=trunc(iw*1/2)*2:trunc(ih*1/2)*2',
            resolve(process.cwd(), this.dest)
        ];

        return this.runFfmpeg(ffmpegArgs);
    }

    async splitBySize(): Promise<string[]> {
        if (this.src === '') {
            throw new Error('Source filename is not set');
        }

        const basename: string = Path.parse(this.src).name;
        const extension = 'mp4';
        const totalDuration = await MediaConvert.getDuration(this.src);
        let i = 1;
        let currentDuration = 0;

        const resultFiles: string[] = [];

        while (currentDuration < totalDuration) {
            const nextFileName = `${this.config.dataDir}/convert/${basename}-${i}.${extension}`;

            await this.splitVideoPart(this.src, currentDuration, nextFileName);

            const partDuration: number = await MediaConvert.getDuration(nextFileName);

            this.logger.debug(`Duration of ${nextFileName}: ${partDuration}`);
            this.logger.debug(`Part No. ${i} starts at ${currentDuration}`);

            if (partDuration <= 0) {
                throw new Error(`Unable to split ${nextFileName}: ffprobe reported a non-positive duration`);
            }

            currentDuration += partDuration;

            resultFiles.push(nextFileName);

            i++;
        }

        return resultFiles;
    }

    async splitVideoPart(file: string, curDuration: number, nextfilename: string): Promise<void> {
        // prettier-ignore
        const ffmpegArgs = [
            '-y',
            '-i', resolve(process.cwd(), file),
            ...(curDuration > 0 ? ['-ss', curDuration.toString()] : []),
            '-fs', MAX_PART_SIZE_BYTES.toString(),
            '-c:v', 'libx264',
            '-preset', 'medium',
            '-crf', '31',
            '-c:a', 'aac',
            '-qscale:a', '0.75',
            '-vf', 'scale=trunc(iw*1/2)*2:trunc(ih*1/2)*2',
            resolve(process.cwd(), nextfilename)
        ];

        await this.runFfmpeg(ffmpegArgs);
    }

    private async runFfmpeg(args: string[]): Promise<boolean> {
        return await new Promise((resolve, reject) => {
            const child = spawn(this.pathToFfmpeg, args, {
                stdio: ['ignore', 'ignore', 'pipe']
            });

            let stderrTail = '';
            const maxStderr = 4000;

            child.stderr.on('data', (chunk: Buffer) => {
                stderrTail = (stderrTail + chunk.toString()).slice(-maxStderr);
            });

            child.once('error', reject);
            child.once('close', (code, signal) => {
                if (code === 0) {
                    resolve(true);
                    return;
                }

                const reason = signal ? `signal ${signal}` : `code ${code ?? 'null'}`;
                reject(new Error(`ffmpeg exited with ${reason}${stderrTail ? `: ${stderrTail.trim()}` : ''}`));
            });
        });
    }

    private static async probe(file: string): Promise<ProbeResult> {
        // prettier-ignore
        const ffprobeCmd = shell([
            pathToFfprobe,
            '-i', resolve(process.cwd(), file),
            '-v', 'quiet',
            '-print_format', 'json',
            '-show_streams',
            '-show_format',
        ]);

        const resultJson: string = await new Promise((resolve, reject) => {
            exec(ffprobeCmd, (err, stdout) => {
                if (err) {
                    return reject(err);
                }

                resolve(stdout);
            });
        });

        try {
            return JSON.parse(resultJson) as ProbeResult;
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);

            throw new Error(`Error parsing JSON from ffprobe output for file ${file}: ${reason}`, { cause: error });
        }
    }

    static async getDuration(file: string): Promise<number> {
        const json = await MediaConvert.probe(file);
        const duration = json.streams?.[0]?.duration ?? json.format?.duration;

        if (duration === undefined || isNaN(Number(duration))) {
            throw new Error('Unable to retrieve duration from ffprobe output');
        }

        return Number(duration);
    }

    static async getCodec(file: string): Promise<string | undefined> {
        const json = await MediaConvert.probe(file);

        return json.streams?.find(stream => stream.codec_type === 'video')?.codec_name;
    }
}

interface ProbeResult {
    streams?: { codec_name?: string; codec_type?: string; duration?: string }[];
    format?: { duration?: string };
}
