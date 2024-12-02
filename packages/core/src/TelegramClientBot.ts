import fs from 'fs-extra';
import { EventEmitter } from 'node:events';
import prompts from 'prompts';
import { Api, TelegramClient } from 'telegram';
import { DownloadMediaInterface } from 'telegram/client/downloads';
import { NewMessage, NewMessageEvent } from 'telegram/events/index.js';
import { LogLevel, Logger } from 'telegram/extensions/Logger.js';
import { StringSession } from 'telegram/sessions/index.js';
import { setTimeout } from 'timers/promises';
import winston from 'winston';
import { eventsGrouped, eventsGroupedResult } from './types.js';
import { Config } from './Config.js';
import _logger from './Logger.js';

function NumberMx(n: number) {
    // prettier-ignore
    const chars = [
		'0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E', 'F',	'G', 'H',
		'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'
	];

    let res = '';

    for (let i = 0; i < n; i++) {
        const id = Math.ceil(Math.random() * 35);
        res += chars[id];
    }

    return res;
}

class CustomLogger extends Logger {
    private logger: winston.Logger;
    constructor(logger: winston.Logger) {
        super();
        this.logger = logger;
    }

    log(level: LogLevel, message: string) {
        this.logger.log(level, message);
    }
}

export default class TelegramClientBot extends EventEmitter {
    private config: Config;
    private readonly stringSession: StringSession;
    private client: TelegramClient;
    private eventsGrouped: Map<number, eventsGrouped>;
    private readonly logger: winston.Logger;

    constructor(config: Config, logger: winston.Logger | null = null) {
        super();

        this.logger = logger || _logger;

        this.config = config;
        this.eventsGrouped = new Map<number, eventsGrouped>();

        this.stringSession = new StringSession(this.config.session_name);

        this.client = new TelegramClient(this.stringSession, this.config.api_id, this.config.api_hash, {
            connectionRetries: 5,
            baseLogger: new CustomLogger(this.logger)
        });
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
            const fileName = NumberMx(35);
            const file = this.config.dataDir + `/telegram_media/${fileName}.jpeg`;

            await fs.writeFile(file, <NodeJS.ArrayBufferView>buffer);

            eventsGrouped.mediaFiles.push(file);
        }

        if (event.message.video) {
            const fileName = NumberMx(35);
            const file = this.config.dataDir + `/telegram_media/${fileName}.mp4`;

            await fs.writeFile(file, <NodeJS.ArrayBufferView>buffer);

            eventsGrouped.mediaFiles.push(file);
        }
    }

    async _NewMessageGrouped(event: NewMessageEvent) {
        const msg = event.message;
        if (msg.groupedId === null || msg.groupedId === undefined) {
            return;
        }

        const groupedId = msg.groupedId.toJSNumber();
        const ac = new AbortController();

        if (!this.eventsGrouped.has(groupedId)) {
            this.eventsGrouped.set(groupedId, {
                events: [event],
                mediaFiles: [],
                ac
            });
        } else {
            const eventsGrouped = this.eventsGrouped.get(groupedId) as eventsGrouped;
            eventsGrouped.ac.abort();

            if (msg.message !== undefined && msg.message !== '') {
                // Add event with a message text first
                eventsGrouped.events.unshift(event);
            } else {
                eventsGrouped.events.push(event);
            }
            eventsGrouped.ac = ac;
        }

        try {
            await setTimeout(5000, null, { signal: ac.signal });
        } catch (e) {
            this.logger.debug('New grouped event received', { groupedId: groupedId });
            return;
        }

        // All events are collected, now process them.

        const eventsGrouped = this.eventsGrouped.get(groupedId) as eventsGrouped;

        for (const _event of eventsGrouped.events) {
            await this.downloadMedia(_event, eventsGrouped);
        }

        const eventsGroupedResult: eventsGroupedResult = {
            events: eventsGrouped.events,
            mediaFiles: eventsGrouped.mediaFiles
        };

        this.emit('newMessage', eventsGroupedResult);

        this.eventsGrouped.delete(groupedId);
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

        this.emit('newMessage', eventsGroupedResult);
    }
}
