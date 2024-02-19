import { APIEmbed, AttachmentBuilder, Client, GatewayIntentBits, TextChannel } from 'discord.js';
import fs from 'fs-extra';
import path from 'path';
import { Api } from 'telegram';
import winston from 'winston';
import MediaConvert from './MediaConvert.js';
import { Config, eventsGrouped, eventsGroupedResult } from './types.js';

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

    constructor(config: Config, logger: winston.Logger) {
        this.config = config;
        this.lastColor = this.colors[0];
        this.logger = logger;

        this.eventsGrouped = new Map<number, eventsGrouped>();

        this.discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });

        this.discordClient.on('ready', () => {
            this.logger.info('Running Discord.js client');
        });
    }

    async init() {
        await this.discordClient.login(this.config.discord_bot_token);

        await this.getLastMessageColor();
    }

    async getChannel(): Promise<TextChannel> {
        if (this.channel instanceof TextChannel) {
            return this.channel;
        }

        this.channel = (await this.discordClient.channels.fetch(this.config.discord_channel[0])) as TextChannel;

        if (this.channel === null) {
            this.logger.error(`Cannot fetch the channel ${this.config.discord_channel[0]}`);
        }

        return this.channel;
    }

    async getLastMessageColor() {
        const channel = await this.getChannel();

        await channel.messages.fetch({ limit: 1 }).then(messages => {
            const lastMessage = messages.first();
            if (!lastMessage || !lastMessage.author.bot || lastMessage.embeds.length === 0) {
                this.logger.warn(`Cannot fetch the last message color from the channel ${this.channel?.id}`);

                return;
            }

            if (lastMessage.embeds[0].color !== null && this.colors.includes(lastMessage.embeds[0].color)) {
                this.lastColor = lastMessage.embeds[0].color;

                this.logger.info(
                    `The last message color is #${this.lastColor.toString(16).padStart(6, '0')} in channel ${this
                        .channel?.id}`
                );
            }
        });
    }

    toggleColor(): number {
        this.lastColor = this.lastColor === this.colors[1] ? this.colors[0] : this.colors[1];

        return this.lastColor;
    }

    async postMessage(eventsGroupedResult: eventsGroupedResult) {
        const channel = await this.getChannel();
        const color = this.toggleColor();
        const embedsChunks: APIEmbed[][] = [];
        const filesChunks: (string | AttachmentBuilder)[][] = [];

        let embeds = embedsChunks[embedsChunks.push([]) - 1];
        let files = filesChunks[filesChunks.push([]) - 1];

        const events = eventsGroupedResult.events;
        const mediaFiles = eventsGroupedResult.mediaFiles;

        const _sender = (await events[0].message.getSender()) as Api.Channel;
        const _message = events[0].message.message;

        let url = 'https://example.org/';

        if (_sender.username !== null) {
            url = `https://t.me/${_sender.username}/${events[0].message.id}`;
        }

        const firstEmbed: APIEmbed = {
            color,
            title: _sender.title,
            url,
            description: _message
        };

        embeds.push(firstEmbed);

        const filePartsToRemove: string[] = [];

        const chunkSize = 4;
        for (let i = 0; i < mediaFiles.length; i += chunkSize) {
            const chunk = mediaFiles.slice(i, i + chunkSize);

            for (const mediaFile of chunk) {
                if (mediaFile instanceof AttachmentBuilder) {
                    continue;
                }

                if (mediaFile.endsWith('.mp4')) {
                    const fStat = fs.statSync(mediaFile);
                    let fSize = fStat.size / (1024 * 1024);
                    fSize = parseFloat(fSize.toFixed(2));

                    if (fSize <= 8.0) {
                        const attachment = new AttachmentBuilder(fs.createReadStream(mediaFile), {
                            name: path.basename(mediaFile)
                        });

                        files.push(attachment);
                    } else {
                        const mediaConvert = new MediaConvert(this.config, this.logger);

                        const fileParts: string[] = await mediaConvert.setSrc(mediaFile).splitBySize();

                        for (const file of fileParts) {
                            const attachment = new AttachmentBuilder(fs.createReadStream(file), {
                                name: path.basename(file)
                            });

                            files.push(attachment);
                        }

                        filePartsToRemove.push(...fileParts);
                    }

                    continue;
                }

                if (mediaFile.endsWith('.jpeg')) {
                    if (embeds.length % 10 === 0) {
                        embeds = embedsChunks[embedsChunks.push([]) - 1];
                        files = filesChunks[filesChunks.push([]) - 1];
                    }

                    const exampleEmbed: APIEmbed = {
                        color: color,
                        url: url + '#' + (i === 0 ? '' : i),
                        description: '',
                        image: {
                            url: `attachment://${path.basename(mediaFile)}`
                        }
                    };

                    embeds.push(exampleEmbed);
                    files.push(mediaFile);
                }
            }
        }

        try {
            for (const [i, embeds] of embedsChunks.entries()) {
                await channel.send({ embeds, files: filesChunks[i] });
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
}
