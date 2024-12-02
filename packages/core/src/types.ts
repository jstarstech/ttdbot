import { AttachmentBuilder } from 'discord.js';
import { NewMessageEvent } from 'telegram/events';

export interface eventsGrouped {
    events: NewMessageEvent[];
    mediaFiles: (string | AttachmentBuilder)[];
    ac: AbortController;
}

export type eventsGroupedResult = Omit<eventsGrouped, 'ac'>;
