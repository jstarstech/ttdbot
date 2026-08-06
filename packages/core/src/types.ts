import { AttachmentBuilder } from 'discord.js';
import { NewMessageEvent } from 'telegram/events/index.js';

export interface eventsGrouped {
    events: NewMessageEvent[];
    mediaFiles: (string | AttachmentBuilder)[];
    timeout: ReturnType<typeof setTimeout> | null;
}

export type eventsGroupedResult = Omit<eventsGrouped, 'timeout'>;

export type ForwardStatus =
    | { stage: 'converting' }
    | { stage: 'uploading'; chunk: number; totalChunks: number }
    | { stage: 'failed'; reason: string };

/**
 * Source-agnostic message handed to DiscordClient. Any ingest source (gramjs
 * user account, grammY bot, …) normalizes its native message into this shape,
 * so DiscordClient stays decoupled from Telegram client internals.
 */
export interface ForwardPayload {
    /** Channel/sender title — used as the embed title. */
    title: string;
    /** Source link (t.me/<username>/<id>) or a default placeholder. */
    url: string;
    /** Caption / message text. */
    text: string;
    /** Local media file paths or pre-built Discord attachments. */
    mediaFiles: (string | AttachmentBuilder)[];
    /** Originating Telegram user/chat id — used to look up an attribution override. */
    sourceId?: number;
    /** Optional stage-transition callback so the source can show live progress. */
    onStatus?: (status: ForwardStatus) => void;
}
