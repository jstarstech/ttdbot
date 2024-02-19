import { AttachmentBuilder } from 'discord.js';
import { NewMessageEvent } from 'telegram/events';

export interface Config {
    dataDir: string;
    logLevel: string;
    api_id: number;
    api_hash: string;
    discord_bot_token: string;
    session_name: string;
    input_channel_names: [];
    input_channel_ids: number[];
    output_channel_ids: [];
    discord_channel: string[];
}

export interface eventsGrouped {
    events: NewMessageEvent[];
    mediaFiles: (string | AttachmentBuilder)[];
    ac: AbortController;
}

export type eventsGroupedResult = Omit<eventsGrouped, 'ac'>;
