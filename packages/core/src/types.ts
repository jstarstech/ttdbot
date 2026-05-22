import { AttachmentBuilder } from 'discord.js';
import { NewMessageEvent } from 'telegram/events/index.js';

export interface eventsGrouped {
    events: NewMessageEvent[];
    mediaFiles: (string | AttachmentBuilder)[];
    timeout: ReturnType<typeof setTimeout> | null;
}

export type eventsGroupedResult = Omit<eventsGrouped, 'timeout'>;
