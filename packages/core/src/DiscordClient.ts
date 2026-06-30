import { APIEmbed, AttachmentBuilder, ChannelType, Client, GatewayIntentBits, TextChannel } from 'discord.js';
import fs from 'fs-extra';
import path from 'node:path';
import { Api } from 'telegram';
import { throttledQueue } from 'throttled-queue';
import winston from 'winston';
import { Config } from './Config.js';
import _logger from './Logger.js';
import MediaConvert from './MediaConvert.js';
import { eventsGrouped, eventsGroupedResult } from './types.js';

// Discord permits roughly 5 message sends per 5 seconds per channel. Throttle
// proactively so bursts (large albums, several source channels) don't trip the limit.
const SEND_MAX_PER_INTERVAL = 5;
const SEND_INTERVAL_MS = 5000;

const getCircularReplacer = () => {
    const seen = new WeakSet();

    return (key: string, value: unknown) => {
        if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) {
                return;
            }

            seen.add(value);
        }
        return value;
    };
};

function HexColorToNumber(hexColor: string): number {
    return Number(hexColor.replace('#', '0x'));
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

    async postMessage(eventsGroupedResult: eventsGroupedResult): Promise<void> {
        const events = eventsGroupedResult.events;
        let url = 'https://example.org/';
        let filePartsToRemove: string[] = [];

        try {
            const channel = await this.getChannel();

            if (channel === undefined) {
                this.logger.error('Cannot fetch the channel');

                return;
            }

            const payload = await this.buildPayload(eventsGroupedResult);
            url = payload.url;
            filePartsToRemove = payload.filePartsToRemove;

            for (const [i, embeds] of payload.embedsChunks.entries()) {
                try {
                    await this.sendThrottle(() => channel.send({ embeds, files: payload.filesChunks[i] }));
                } catch (error) {
                    this.logger.error(`Failed to send message chunk ${i}`, { error });
                }
            }
        } catch (e) {
            this.logger.error(`Error forwarding message ${url}`, {
                url: url,
                events: JSON.parse(JSON.stringify(events, getCircularReplacer()))
            });
            this.logger.error(e);
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
     * Builds the Discord embed/attachment chunks for a grouped message. Each
     * embed chunk and its parallel file chunk are sent together by postMessage.
     */
    async buildPayload(eventsGroupedResult: eventsGroupedResult): Promise<{
        embedsChunks: APIEmbed[][];
        filesChunks: (string | AttachmentBuilder)[][];
        filePartsToRemove: string[];
        url: string;
    }> {
        const events = eventsGroupedResult.events;
        const mediaFiles = eventsGroupedResult.mediaFiles;
        let url = 'https://example.org/';
        const filePartsToRemove: string[] = [];

        const color = this.toggleColor();
        const embedsChunks: APIEmbed[][] = [];
        const filesChunks: (string | AttachmentBuilder)[][] = [];

        let embeds = embedsChunks[embedsChunks.push([]) - 1];
        let files = filesChunks[filesChunks.push([]) - 1];

        const _sender = (await events[0].message.getSender()) as Api.Channel;
        const _message = events[0].message.message;

        if (_sender.username !== null) {
            url = `https://t.me/${_sender.username}/${events[0].message.id}`;
        }

        embeds.push({ color, title: _sender.title, url, description: _message });

        const chunkSize = 4;
        for (let i = 0; i < mediaFiles.length; i += chunkSize) {
            const chunk = mediaFiles.slice(i, i + chunkSize);

            for (const mediaFile of chunk) {
                if (mediaFile instanceof AttachmentBuilder) {
                    continue;
                }

                if (mediaFile.endsWith('.mp4')) {
                    const { files: videoFiles, remove } = await this.prepareVideo(mediaFile);

                    files.push(...videoFiles);
                    filePartsToRemove.push(...remove);

                    continue;
                }

                if (mediaFile.endsWith('.jpeg')) {
                    if (embeds.length % 10 === 0) {
                        embeds = embedsChunks[embedsChunks.push([]) - 1];
                        files = filesChunks[filesChunks.push([]) - 1];
                    }

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

        return { embedsChunks, filesChunks, filePartsToRemove, url };
    }

    /**
     * Turns a single mp4 into Discord attachments: transcodes H.265/HEVC files
     * to H.264 so Discord can preview them, and splits files over the 8 MiB
     * upload limit. Returns the attachments plus any derived files to clean up.
     */
    async prepareVideo(mediaFile: string): Promise<{ files: AttachmentBuilder[]; remove: string[] }> {
        const files: AttachmentBuilder[] = [];
        const remove: string[] = [];

        try {
            let videoFile = mediaFile;
            let fSize = parseFloat((fs.statSync(mediaFile).size / (1024 * 1024)).toFixed(2));

            // Discord cannot preview H.265/HEVC, so transcode small files to H.264.
            // Oversized files are re-encoded to H.264 by splitBySize() below regardless.
            const codec = await MediaConvert.getCodec(mediaFile);

            if (codec === 'hevc' && fSize <= 8.0) {
                videoFile = `${this.config.dataDir}/convert/${path.parse(mediaFile).name}-h264.mp4`;

                await new MediaConvert(this.config, this.logger).setSrc(mediaFile).setDst(videoFile).convert();
                remove.push(videoFile);

                fSize = parseFloat((fs.statSync(videoFile).size / (1024 * 1024)).toFixed(2));
            }

            if (fSize <= 8.0) {
                files.push(new AttachmentBuilder(fs.createReadStream(videoFile), { name: path.basename(videoFile) }));
            } else {
                const fileParts: string[] = await new MediaConvert(this.config, this.logger)
                    .setSrc(videoFile)
                    .splitBySize();

                for (const file of fileParts) {
                    files.push(new AttachmentBuilder(fs.createReadStream(file), { name: path.basename(file) }));
                }

                remove.push(...fileParts);
            }
        } catch (error) {
            this.logger.error(`Failed to process video ${mediaFile}`, { error });
        }

        return { files, remove };
    }
}
