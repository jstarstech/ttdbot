import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import winston from 'winston';
import { Config } from './Config.js';
import { ForwardPayload } from './types.js';

const FILENAME_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Random filename (35 chars from [1..35] of FILENAME_CHARS, matching the legacy generator). */
function randomName(length = 35): string {
    let res = '';

    for (let i = 0; i < length; i++) {
        res += FILENAME_CHARS[Math.ceil(Math.random() * 35)];
    }

    return res;
}

/**
 * Base for Telegram ingest sources (gramjs user account, grammY bot, …). A source
 * collects media + metadata, normalizes it into a {@link ForwardPayload}, and emits
 * a `newMessage` event. The base handles listener dispatch, post-dispatch media
 * cleanup, and writing downloaded media to disk — the parts every source shares.
 */
export default abstract class TelegramSource extends EventEmitter {
    protected readonly config: Config;
    protected readonly logger: winston.Logger;

    constructor(config: Config, logger: winston.Logger) {
        super();

        this.config = config;
        this.logger = logger;
    }

    /** Connect/authenticate and start receiving messages. */
    abstract init(): Promise<unknown>;

    /**
     * Emits the payload to all `newMessage` listeners and waits for them to finish
     * before removing the downloaded media, so files are not deleted while a listener
     * is still reading them.
     */
    protected async dispatch(payload: ForwardPayload): Promise<void> {
        const listeners = this.listeners('newMessage') as ((payload: ForwardPayload) => unknown)[];

        await Promise.allSettled(listeners.map(listener => listener(payload)));

        await this.removeMediaFiles(payload.mediaFiles);
    }

    protected async removeMediaFiles(mediaFiles: ForwardPayload['mediaFiles']): Promise<void> {
        for (const mediaFile of mediaFiles) {
            if (typeof mediaFile !== 'string') {
                continue;
            }

            try {
                await fs.rm(mediaFile, { force: true });
            } catch (error) {
                this.logger.error(`Failed to remove media file ${mediaFile}`, { error });
            }
        }
    }

    /** Writes downloaded bytes to `dataDir/telegram_media` with a random name; returns the path. */
    protected async saveMediaFile(ext: 'jpeg' | 'mp4', data: Buffer | string): Promise<string> {
        const file = `${this.config.dataDir}/telegram_media/${randomName()}.${ext}`;

        if (Buffer.isBuffer(data)) {
            await fs.writeFile(file, new Uint8Array(data));
        } else {
            await fs.writeFile(file, data);
        }

        return file;
    }
}
