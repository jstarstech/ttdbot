import shell from 'any-shell-escape';
import pathToFfmpeg from 'ffmpeg-static';
import { path as pathToFfprobe } from 'ffprobe-static';
import { exec } from 'node:child_process';
import Path, { resolve } from 'node:path';
import process from 'node:process';
import winston from 'winston';
import { Config } from './Config.js';
import _logger from './Logger.js';

if (pathToFfmpeg === null) {
    _logger.error('The pathToFfmpeg is null. Please check module ffmpeg-static');
    process.exit(1);
}

export default class MediaConvert {
    private src = '';
    private dest = '';
    private config: Config;
    private logger: winston.Logger;
    private readonly pathToFfmpeg: string;

    constructor(config: Config, logger: winston.Logger) {
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
            throw new Error('Destination filename is empty');
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
        const ffmpegCmd = shell([
			this.pathToFfmpeg,
			'-i', resolve(process.cwd(), this.src),
			'-c:v', 'libx264',
			'-preset', 'medium',
			'-crf', '31',
			'-c:a', 'aac',
			'-qscale:a', '0.75',
			'-vf', 'scale=trunc(iw*1/2)*2:trunc(ih*1/2)*2',
			resolve(process.cwd(), this.dest)
		]);

        return new Promise((resolve, reject) => {
            exec(ffmpegCmd, err => {
                if (err) {
                    return reject(err);
                }

                resolve(true);
            });
        });
    }

    async splitBySize(): Promise<string[]> {
        if (this.src === '') {
            throw new Error('Destination filename is not set');
        }

        const basename: string = Path.parse(this.src).name;
        const extension = 'mp4';
        let i = 1;
        let nextFileName = `${this.config.dataDir}/convert/${basename}-${i}.${extension}`;
        let currentDuration = 0;
        const duration = await this.getDuration(this.src);

        const resultFiles: string[] = [];

        while (currentDuration < duration) {
            await this.splitVideoPart(this.src, currentDuration, nextFileName);

            const new_duration: number = await this.getDuration(nextFileName);
            currentDuration = currentDuration + new_duration;

            resultFiles.push(nextFileName);

            // console.log(`Duration of ${nextfilename}: ${new_duration}`)
            // console.log(`Part No. ${i} starts at ${cur_duration}`)

            i++;
            nextFileName = `${this.config.dataDir}/convert/${basename}-${i}.${extension}`;
        }

        return resultFiles;
    }

    async splitVideoPart(file: string, cur_duration: number, nextfilename: string): Promise<string> {
        // prettier-ignore
        const ffmpegCmd = shell([
			this.pathToFfmpeg,
			'-y',
			'-i', resolve(process.cwd(), file),
			...(cur_duration > 0? ['-ss', cur_duration.toString()]: []),
			'-fs', '7920000',
			'-c:v', 'libx264',
			'-preset', 'medium',
			'-crf', '31',
			'-c:a', 'aac',
			'-qscale:a', '0.75',
			'-vf', 'scale=trunc(iw*1/2)*2:trunc(ih*1/2)*2',
			resolve(process.cwd(), nextfilename)
		]);

        return await new Promise((resolve, reject) => {
            exec(ffmpegCmd, (err, stdout) => {
                if (err) {
                    return reject(err);
                }

                resolve(stdout);
            });
        });
    }

    async getDuration(file: string): Promise<number> {
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

        const json = JSON.parse(resultJson);

        const duration = json.streams?.[0]?.duration;

        if (duration === undefined || isNaN(Number(duration))) {
            throw new Error('Unable to retrieve duration from ffprobe output');
        }

        return Math.trunc(Number(duration));
    }
}
