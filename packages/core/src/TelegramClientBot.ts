import prompts from 'prompts';
import { Api, TelegramClient } from 'telegram';
import { DownloadMediaInterface } from 'telegram/client/downloads.js';
import { NewMessage, NewMessageEvent } from 'telegram/events/index.js';
import { LogLevel, Logger } from 'telegram/extensions/Logger.js';
import { StringSession } from 'telegram/sessions/index.js';
import winston from 'winston';
import { Config } from './Config.js';
import _logger from './Logger.js';
import TelegramSource from './TelegramSource.js';
import { eventsGrouped, eventsGroupedResult, ForwardPayload } from './types.js';

class CustomLogger extends Logger {
    private readonly logger: winston.Logger;

    constructor(logger: winston.Logger) {
        super();
        this.logger = logger;
    }

    override log(level: LogLevel, message: string) {
        this.logger.log(level, message);
    }
}

/**
 * Normalizes grouped gramjs events into a source-agnostic ForwardPayload
 * (channel title, t.me url, caption text, downloaded media).
 */
async function buildForwardPayload(eventsGroupedResult: eventsGroupedResult): Promise<ForwardPayload> {
    const first = eventsGroupedResult.events[0];
    const sender = (await first.message.getSender()) as Api.Channel;
    let url = 'https://example.org/';

    if (sender.username !== null) {
        url = `https://t.me/${sender.username}/${first.message.id}`;
    }

    return {
        title: sender.title,
        url,
        text: first.message.message,
        mediaFiles: eventsGroupedResult.mediaFiles
    };
}

export default class TelegramClientBot extends TelegramSource {
    private readonly stringSession: StringSession;
    private client: TelegramClient;
    private eventsGrouped: Map<number, eventsGrouped>;

    constructor(config: Config, logger: winston.Logger | null = null) {
        super(config, logger || _logger);

        this.eventsGrouped = new Map<number, eventsGrouped>();

        this.stringSession = new StringSession(this.config.session_name);

        this.client = new TelegramClient(this.stringSession, this.config.api_id, this.config.api_hash, {
            connectionRetries: 5,
            baseLogger: new CustomLogger(this.logger)
        });
    }

    private scheduleGroupedMessageProcessing(groupedId: number, groupedEvents: eventsGrouped): void {
        if (groupedEvents.timeout !== null) {
            clearTimeout(groupedEvents.timeout);
        }

        groupedEvents.timeout = setTimeout(() => {
            groupedEvents.timeout = null;
            void this.processGroupedMessage(groupedId, groupedEvents);
        }, 5000);
    }

    private async processGroupedMessage(groupedId: number, groupedEvents: eventsGrouped): Promise<void> {
        const currentGroupedEvents = this.eventsGrouped.get(groupedId);

        if (groupedEvents.events.length === 0) {
            if (currentGroupedEvents === groupedEvents) {
                this.eventsGrouped.delete(groupedId);
            }

            return;
        }

        const nextGroupedEvents: eventsGrouped = {
            events: [],
            mediaFiles: [],
            timeout: null
        };

        if (currentGroupedEvents === groupedEvents) {
            this.eventsGrouped.set(groupedId, nextGroupedEvents);
            this.scheduleGroupedMessageProcessing(groupedId, nextGroupedEvents);
        }

        try {
            // All events are collected, now process them.
            for (const _event of groupedEvents.events) {
                await this.downloadMedia(_event, groupedEvents);
            }

            const eventsGroupedResult: eventsGroupedResult = {
                events: groupedEvents.events,
                mediaFiles: groupedEvents.mediaFiles
            };

            await this.dispatchNewMessage(eventsGroupedResult);
        } catch (error) {
            this.logger.error(`Failed to process grouped message ${groupedId}`, { error });
        }
    }

    init() {
        this.client.setLogLevel(<LogLevel>'error');

        this.client.addEventHandler(this._onNewMessage.bind(this), new NewMessage({}));

        return this.client.start({
            phoneNumber: async () => {
                const response = await prompts({
                    type: 'text',
                    name: 'phoneNumber',
                    message: 'Please enter your number: '
                });

                return response.phoneNumber;
            },
            password: async () => {
                const response = await prompts({
                    type: 'text',
                    name: 'password',
                    message: 'Please enter your password: '
                });

                return response.password;
            },
            phoneCode: async () => {
                const response = await prompts({
                    type: 'text',
                    name: 'phoneCode',
                    message: 'Please enter the code you received: '
                });

                return response.phoneCode;
            },
            onError: err => console.log(err)
        });
    }

    async downloadMedia(event: NewMessageEvent, eventsGrouped: eventsGrouped | eventsGroupedResult) {
        const buffer = await this.client.downloadMedia(event.message, <DownloadMediaInterface>{ workers: 1 });

        if (!buffer) {
            this.logger.error('Failed to download media', { messageId: event.message.id });
            return;
        }

        if (event.message.photo) {
            eventsGrouped.mediaFiles.push(await this.saveMediaFile('jpeg', buffer));
        }

        if (event.message.video) {
            eventsGrouped.mediaFiles.push(await this.saveMediaFile('mp4', buffer));
        }
    }

    async _NewMessageGrouped(event: NewMessageEvent) {
        const msg = event.message;
        if (msg.groupedId === null || msg.groupedId === undefined) {
            return;
        }

        const groupedId = msg.groupedId.toJSNumber();

        if (!this.eventsGrouped.has(groupedId)) {
            const groupedEvents: eventsGrouped = {
                events: [event],
                mediaFiles: [],
                timeout: null
            };

            this.eventsGrouped.set(groupedId, groupedEvents);
            this.scheduleGroupedMessageProcessing(groupedId, groupedEvents);
        } else {
            const groupedEvents = this.eventsGrouped.get(groupedId) as eventsGrouped;
            if (msg.message !== undefined && msg.message !== '') {
                // Add event with a message text first
                groupedEvents.events.unshift(event);
            } else {
                groupedEvents.events.push(event);
            }
            this.scheduleGroupedMessageProcessing(groupedId, groupedEvents);
        }
    }

    async _onNewMessage(event: NewMessageEvent) {
        const msg = event.message;
        const sender = await msg.getSender();

        let isFromList = false;

        if (sender instanceof Api.Channel) {
            if (this.config.input_channel_ids.includes(sender.id.toJSNumber())) {
                isFromList = true;
            }
        }

        if (!isFromList) {
            return;
        }

        if (msg.groupedId !== null) {
            return this._NewMessageGrouped(event);
        }

        const eventsGroupedResult: eventsGroupedResult = {
            events: [event],
            mediaFiles: []
        };

        await this.downloadMedia(event, eventsGroupedResult);

        await this.dispatchNewMessage(eventsGroupedResult);
    }

    /** Normalizes the grouped events and dispatches to listeners (then cleans up media). */
    private async dispatchNewMessage(eventsGroupedResult: eventsGroupedResult): Promise<void> {
        await this.dispatch(await buildForwardPayload(eventsGroupedResult));
    }
}
