import { APIEmbed, AttachmentBuilder, ChannelType, Client, GatewayIntentBits, TextChannel } from 'discord.js';
import fs from 'fs-extra';
import path from 'node:path';
import { throttledQueue } from 'throttled-queue';
import winston from 'winston';
import { Config } from './Config.js';
import _logger from './Logger.js';
import MediaConvert from './MediaConvert.js';
import { eventsGrouped, ForwardPayload, ForwardStatus } from './types.js';

// Discord permits roughly 5 message sends per 5 seconds per channel. Throttle
// proactively so bursts (large albums, several source channels) don't trip the limit.
const SEND_MAX_PER_INTERVAL = 5;
const SEND_INTERVAL_MS = 5000;

// One transient DNS/socket/TLS blip used to lose the chunk (and the video in it)
// permanently. Retry those; a real API error needs a fix, not another attempt.
const SEND_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;
const TRANSIENT_ERROR_CODES = new Set([
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT',
    'ETIMEDOUT',
    'ECONNRESET',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE'
]);

// Discord's non-Nitro upload limit is 10 MB. Attach files up to this size directly;
// larger ones are split. Kept below 10 MB for multipart/embed overhead.
const MAX_ATTACHMENT_MIB = 9;

// Discord rejects messages with more than 10 attachments (50035 BASE_TYPE_MAX_LENGTH)
// or more than 10 embeds, and caps the whole request at 25 MiB ("The maximum request
// size when sending a message is 25 MiB"). A chunk must stay within all three; the byte
// budget leaves headroom for payload_json and multipart boundaries.
const MAX_FILES_PER_MESSAGE = 10;
const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_REQUEST_BYTES = 24 * 1024 * 1024;

// Image types Discord renders in an embed; anything else is not attached.
const IMAGE_EXTENSIONS = new Set(['.jpeg', '.jpg', '.png', '.webp', '.gif']);

function HexColorToNumber(hexColor: string): number {
    return Number(hexColor.replace('#', '0x'));
}

/** True for a DNS/socket/TLS blip worth retrying; Discord API errors are permanent. */
function isTransientSendError(error: unknown): boolean {
    let current = error as { code?: unknown; cause?: unknown } | undefined;

    for (let depth = 0; current !== undefined && depth < 5; depth++) {
        if (typeof current.code === 'string' && TRANSIENT_ERROR_CODES.has(current.code)) {
            return true;
        }

        current = current.cause as typeof current;
    }

    return false;
}

export default class DiscordClient {
    private readonly config: Config;
    private eventsGrouped: Map<number, eventsGrouped>;
    private channel: TextChannel | undefined;
    private discordClient: Client;
    private colors: number[] = [HexColorToNumber('#0057b8'), HexColorToNumber('#ffd700')];
    private lastColor: number;
    private readonly logger: winston.Logger;
    private readonly sendThrottle: ReturnType<typeof throttledQueue>;

    constructor(config: Config, logger: winston.Logger | null = null) {
        this.config = config;
        this.lastColor = this.colors[0];
        this.logger = logger || _logger;

        this.eventsGrouped = new Map<number, eventsGrouped>();

        this.sendThrottle = throttledQueue({
            maxPerInterval: SEND_MAX_PER_INTERVAL,
            interval: SEND_INTERVAL_MS,
            evenlySpaced: true
        });

        this.discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });

        this.discordClient.on('error', err => {
            this.logger.error(err);
        });
    }

    /** Invokes the payload's optional status callback; a throwing callback must never break sending. */
    private emitStatus(payload: ForwardPayload | undefined, status: ForwardStatus): void {
        try {
            payload?.onStatus?.(status);
        } catch (error) {
            this.logger.error('onStatus callback failed', { error });
        }
    }

    async init(): Promise<void> {
        const { promise, resolve } = Promise.withResolvers<void>();

        this.discordClient.once('clientReady', () => {
            this.logger.info('Running Discord.js client');

            resolve();
        });

        await this.discordClient.login(this.config.discord_bot_token);

        await promise;

        await this.getLastMessageColor();
    }

    async getChannel(): Promise<TextChannel | undefined> {
        if (this.channel instanceof TextChannel) {
            return this.channel;
        }

        this.channel = this.discordClient.channels.cache.find((channel): channel is TextChannel => {
            return channel.id === this.config.discord_channel[0] && channel.type === ChannelType.GuildText;
        });

        if (this.channel === undefined) {
            this.logger.error(`Cannot fetch the channel ${this.config.discord_channel[0]}`);
        }

        return this.channel;
    }

    async getLastMessageColor(): Promise<void> {
        const channel = await this.getChannel();

        if (channel === undefined) {
            return;
        }

        await channel.messages.fetch({ limit: 1 }).then(messages => {
            const lastMessage = messages.first();

            if (!lastMessage || !lastMessage.author.bot || lastMessage.embeds.length === 0) {
                this.logger.warn(`Cannot fetch the last message color from the channel ${this.channel?.id}`);

                return;
            }

            if (lastMessage.embeds[0].color !== null && this.colors.includes(lastMessage.embeds[0].color)) {
                this.lastColor = lastMessage.embeds[0].color;

                this.logger.info(
                    `The last message color is #${this.lastColor.toString(16).padStart(6, '0')} in channel ${
                        this.channel?.id
                    }`
                );
            }
        });
    }

    /**
     * Toggles the color between the two predefined colors.
     * This is used to alternate the color of the embeds in the messages.
     */
    toggleColor(): number {
        this.lastColor = this.lastColor === this.colors[1] ? this.colors[0] : this.colors[1];

        return this.lastColor;
    }

    /** Sends one chunk through the throttle, retrying transient network failures with backoff. */
    private async sendChunk(send: () => Promise<unknown>): Promise<void> {
        for (let attempt = 1; ; attempt++) {
            try {
                await this.sendThrottle(send);

                return;
            } catch (error) {
                if (attempt >= SEND_ATTEMPTS || !isTransientSendError(error)) {
                    throw error;
                }

                this.logger.warn(`Retrying Discord send after transient error (attempt ${attempt}/${SEND_ATTEMPTS})`, {
                    error
                });
                await new Promise(resolve => setTimeout(resolve, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)));
            }
        }
    }

    async postMessage(payload: ForwardPayload): Promise<void> {
        const url = payload.url;
        let filePartsToRemove: string[] = [];
        let delivered = false;

        try {
            const channel = await this.getChannel();

            if (channel === undefined) {
                this.logger.error('Cannot fetch the channel');
                this.emitStatus(payload, { stage: 'failed', reason: 'Discord channel unavailable' });
            } else {
                const chunks = await this.buildChunks(payload);
                filePartsToRemove = chunks.filePartsToRemove;
                delivered = !chunks.failed;

                for (const [i, embeds] of chunks.embedsChunks.entries()) {
                    try {
                        this.emitStatus(payload, {
                            stage: 'uploading',
                            chunk: i + 1,
                            totalChunks: chunks.embedsChunks.length
                        });
                        await this.sendChunk(() => channel.send({ embeds, files: chunks.filesChunks[i] }));
                    } catch (error) {
                        this.logger.error(`Failed to send message chunk ${i}`, { error });
                        this.emitStatus(payload, { stage: 'failed', reason: 'Discord send error' });
                        delivered = false;
                    }
                }
            }
        } catch (e) {
            this.logger.error(`Error forwarding message ${url}`, { url, title: payload.title });
            this.logger.error(e);
            this.emitStatus(payload, { stage: 'failed', reason: 'Discord forwarding error' });
            delivered = false;
        }

        if (!delivered) {
            // Keep the undelivered parts so the media can be re-sent; the source
            // deletes its downloads only when every listener reports success.
            this.logger.error(`Failed to forward message ${url}`, { url, keptFiles: filePartsToRemove });
            throw new Error(`Failed to forward message ${url}`);
        }

        // Remove split video parts
        for (const file of filePartsToRemove) {
            try {
                await fs.remove(file);
            } catch (err) {
                this.logger.error(err);
            }
        }

        this.logger.info(`Message forwarded ${url}`, { url: url });
    }

    /**
     * Builds the Discord embed/attachment chunks for a forward payload. Each
     * embed chunk and its parallel file chunk are sent together by postMessage.
     */
    async buildChunks(payload: ForwardPayload): Promise<{
        embedsChunks: APIEmbed[][];
        filesChunks: (string | AttachmentBuilder)[][];
        filePartsToRemove: string[];
        failed: boolean;
    }> {
        const mediaFiles = payload.mediaFiles;
        const url = payload.url;
        const filePartsToRemove: string[] = [];
        let failed = false;

        const color = this.toggleColor();
        const embedsChunks: APIEmbed[][] = [];
        const filesChunks: (string | AttachmentBuilder)[][] = [];

        let embeds = embedsChunks[embedsChunks.push([]) - 1];
        let files = filesChunks[filesChunks.push([]) - 1];
        let chunkBytes = 0;

        const startNewChunk = () => {
            embeds = embedsChunks[embedsChunks.push([]) - 1];
            files = filesChunks[filesChunks.push([]) - 1];
            chunkBytes = 0;
        };

        // A chunk is full for the next attachment when it is at the file cap or the
        // extra bytes would push the request over the size cap (never roll an empty chunk).
        const chunkFullFor = (bytes: number) =>
            files.length >= MAX_FILES_PER_MESSAGE || (files.length > 0 && chunkBytes + bytes > MAX_REQUEST_BYTES);

        // Resolve the attribution shown at the top of the message. A per-source override
        // (by Telegram id) can replace the name and link; otherwise use the source defaults.
        const override = payload.sourceId !== undefined ? this.config.overrides?.[payload.sourceId] : undefined;
        const attribName = override ? (override.name ?? '') : payload.title;
        const attribUrl = override ? (override.url ?? '') : url;

        const firstEmbed: APIEmbed = { color, description: payload.text };
        if (attribName) {
            firstEmbed.title = attribName;
            if (attribUrl) {
                firstEmbed.url = attribUrl; // hyperlinked name; omit url -> plain-text name
            }
        }
        embeds.push(firstEmbed);

        const chunkSize = 4;
        for (let i = 0; i < mediaFiles.length; i += chunkSize) {
            const chunk = mediaFiles.slice(i, i + chunkSize);

            for (const mediaFile of chunk) {
                if (mediaFile instanceof AttachmentBuilder) {
                    continue;
                }

                if (mediaFile.endsWith('.mp4')) {
                    const {
                        files: videoFiles,
                        sizes,
                        remove,
                        failed: videoFailed
                    } = await this.prepareVideo(mediaFile, payload);
                    failed = failed || videoFailed;

                    for (const [n, videoFile] of videoFiles.entries()) {
                        if (chunkFullFor(sizes[n])) {
                            startNewChunk();
                        }

                        files.push(videoFile);
                        chunkBytes += sizes[n];
                    }

                    filePartsToRemove.push(...remove);

                    continue;
                }

                if (IMAGE_EXTENSIONS.has(path.extname(mediaFile).toLowerCase())) {
                    const imageBytes = fs.statSync(mediaFile).size;

                    if (embeds.length >= MAX_EMBEDS_PER_MESSAGE || chunkFullFor(imageBytes)) {
                        startNewChunk();
                    }

                    chunkBytes += imageBytes;

                    embeds.push({
                        color,
                        url: url + '#' + (i === 0 ? '' : i),
                        description: '',
                        image: {
                            url: `attachment://${path.basename(mediaFile)}`
                        }
                    });
                    files.push(mediaFile);
                }
            }
        }

        return { embedsChunks, filesChunks, filePartsToRemove, failed };
    }

    /**
     * Turns a single mp4 into Discord attachments: transcodes H.265/HEVC files
     * to H.264 so Discord can preview them, and splits files over the upload
     * limit. Returns the attachments, their byte sizes (parallel to files, so
     * buildChunks can budget the request size), and any derived files to clean up.
     */
    async prepareVideo(
        mediaFile: string,
        statusTarget?: ForwardPayload
    ): Promise<{ files: AttachmentBuilder[]; sizes: number[]; remove: string[]; failed: boolean }> {
        const files: AttachmentBuilder[] = [];
        const sizes: number[] = [];
        const remove: string[] = [];
        let failed = false;

        try {
            let videoFile = mediaFile;
            let fSize = parseFloat((fs.statSync(mediaFile).size / (1024 * 1024)).toFixed(2));

            // Discord cannot preview H.265/HEVC, so transcode small files to H.264.
            // Oversized files are re-encoded to H.264 by splitBySize() below regardless.
            const codec = await MediaConvert.getCodec(mediaFile);

            if (codec === 'hevc' && fSize <= MAX_ATTACHMENT_MIB) {
                this.emitStatus(statusTarget, { stage: 'converting' });
                videoFile = `${this.config.dataDir}/convert/${path.parse(mediaFile).name}-h264.mp4`;

                await new MediaConvert(this.config, this.logger).setSrc(mediaFile).setDst(videoFile).convert();
                remove.push(videoFile);

                fSize = parseFloat((fs.statSync(videoFile).size / (1024 * 1024)).toFixed(2));
            }

            if (fSize <= MAX_ATTACHMENT_MIB) {
                files.push(new AttachmentBuilder(fs.createReadStream(videoFile), { name: path.basename(videoFile) }));
                sizes.push(fs.statSync(videoFile).size);
            } else {
                this.emitStatus(statusTarget, { stage: 'converting' });
                const fileParts: string[] = await new MediaConvert(this.config, this.logger)
                    .setSrc(videoFile)
                    .splitBySize();

                for (const file of fileParts) {
                    files.push(new AttachmentBuilder(fs.createReadStream(file), { name: path.basename(file) }));
                    sizes.push(fs.statSync(file).size);
                }

                remove.push(...fileParts);
            }
        } catch (error) {
            this.logger.error(`Failed to process video ${mediaFile}`, { error });
            this.emitStatus(statusTarget, { stage: 'failed', reason: 'video processing failed' });
            failed = true;
        }

        return { files, sizes, remove, failed };
    }
}
