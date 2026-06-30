import fs from 'node:fs/promises';
import path from 'node:path';
import { Bot, Context } from 'grammy';
import winston from 'winston';
import { Config } from './Config.js';
import _logger from './Logger.js';
import TelegramSource from './TelegramSource.js';
import { ForwardPayload } from './types.js';

const GROUP_DEBOUNCE_MS = 5000;
const DEFAULT_API_ROOT = 'https://api.telegram.org';

interface AlbumBuffer {
    representative: Context;
    mediaFiles: string[];
    timeout: ReturnType<typeof setTimeout> | null;
}

async function downloadUrl(url: string): Promise<Buffer> {
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`file download failed: ${response.status}`);
    }

    return Buffer.from(await response.arrayBuffer());
}

/** Normalizes a grammY message context into a source-agnostic ForwardPayload. */
function toForwardPayload(ctx: Context, mediaFiles: string[]): ForwardPayload {
    const msg = ctx.msg!;
    const chat = ctx.chat;
    const senderName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ');
    const title = chat?.title ?? (senderName || 'Telegram');
    const username = chat?.username;
    const url = username ? `https://t.me/${username}/${msg.message_id}` : 'https://example.org/';

    return { title, url, text: msg.caption ?? msg.text ?? '', mediaFiles };
}

/**
 * Bot API ingest source (grammY). Receives content sent/forwarded to the bot (DMs)
 * and posts from channels where the bot is an administrator (`channel_post`), and
 * forwards them to Discord via the shared {@link TelegramSource} pipeline.
 *
 * Only messages from allow-listed chats/users are accepted (deny by default).
 * Media download uses the configured API endpoint — the cloud API caps downloads
 * at 20 MB; a self-hosted Bot API server raises that to 2 GB.
 */
export default class TelegramBotClient extends TelegramSource {
    private readonly bot: Bot;
    private readonly token: string;
    private readonly apiRoot: string;
    private readonly albums = new Map<string, AlbumBuffer>();

    constructor(config: Config, logger: winston.Logger | null = null) {
        super(config, logger || _logger);

        if (!config.bot?.token) {
            throw new Error('bot.token is required when the bot source is enabled');
        }

        this.token = config.bot.token;
        this.apiRoot = config.bot.api_server || DEFAULT_API_ROOT;
        this.bot = new Bot(this.token, { client: { apiRoot: this.apiRoot } });
    }

    async init(): Promise<void> {
        this.bot.on(['message', 'channel_post'], ctx => this.handle(ctx));
        this.bot.catch(err => this.logger.error('Telegram bot error', { error: err }));

        this.logger.info(`Telegram bot API endpoint: ${this.apiRoot}`);
        await this.bot.init();
        this.logger.info(`Running Telegram bot @${this.bot.botInfo.username}`);

        // start() long-polls until stopped; run it in the background so init() returns.
        void this.bot.start().catch(error => this.logger.error('Telegram bot polling stopped', { error }));
    }

    /** Deny by default: accept only allow-listed channels (chat id) or DM submitters (user id). */
    private isAllowed(ctx: Context): boolean {
        const allowedChats = this.config.bot?.allowed_chat_ids ?? [];
        const allowedUsers = this.config.bot?.allowed_user_ids ?? [];

        if (ctx.chat && allowedChats.includes(ctx.chat.id)) {
            return true;
        }

        return ctx.from !== undefined && allowedUsers.includes(ctx.from.id);
    }

    private async handle(ctx: Context): Promise<void> {
        if (ctx.msg === undefined || !this.isAllowed(ctx)) {
            return;
        }

        const file = await this.downloadMedia(ctx);
        const groupId = ctx.msg.media_group_id;

        if (groupId === undefined) {
            await this.dispatch(toForwardPayload(ctx, file ? [file] : []));
            return;
        }

        this.bufferAlbumItem(groupId, ctx, file);
    }

    /** Accumulates album items sharing a media_group_id, flushing 5 s after the last one. */
    private bufferAlbumItem(groupId: string, ctx: Context, file: string | null): void {
        let album = this.albums.get(groupId);

        if (album === undefined) {
            album = { representative: ctx, mediaFiles: [], timeout: null };
            this.albums.set(groupId, album);
        }

        // Prefer the caption-bearing message as the representative (its text/url wins).
        const caption = ctx.msg?.caption ?? ctx.msg?.text;
        const repCaption = album.representative.msg?.caption ?? album.representative.msg?.text;
        if (caption && !repCaption) {
            album.representative = ctx;
        }

        if (file) {
            album.mediaFiles.push(file);
        }

        if (album.timeout) {
            clearTimeout(album.timeout);
        }
        album.timeout = setTimeout(() => void this.flushAlbum(groupId), GROUP_DEBOUNCE_MS);
    }

    private async flushAlbum(groupId: string): Promise<void> {
        const album = this.albums.get(groupId);
        if (album === undefined) {
            return;
        }
        this.albums.delete(groupId);

        try {
            await this.dispatch(toForwardPayload(album.representative, album.mediaFiles));
        } catch (error) {
            this.logger.error(`Failed to process album ${groupId}`, { error });
        }
    }

    private async downloadMedia(ctx: Context): Promise<string | null> {
        const msg = ctx.msg;
        let ext: 'jpeg' | 'mp4' | null = null;
        let fileId: string | undefined;

        if (msg?.photo && msg.photo.length > 0) {
            ext = 'jpeg';
            fileId = msg.photo[msg.photo.length - 1].file_id; // largest size
        } else if (msg?.video) {
            ext = 'mp4';
            fileId = msg.video.file_id;
        } else if (msg?.animation) {
            // GIFs arrive as soundless mp4.
            ext = 'mp4';
            fileId = msg.animation.file_id;
        } else if (msg?.document) {
            // Media sent/forwarded "as a file".
            const mime = msg.document.mime_type ?? '';
            if (mime.startsWith('video/')) {
                ext = 'mp4';
                fileId = msg.document.file_id;
            } else if (mime.startsWith('image/')) {
                ext = 'jpeg';
                fileId = msg.document.file_id;
            }
        }

        if (ext === null || fileId === undefined) {
            const kinds = (
                ['photo', 'video', 'animation', 'document', 'sticker', 'audio', 'voice', 'video_note'] as const
            ).filter(k => msg?.[k] !== undefined);
            if (kinds.length > 0) {
                this.logger.info(`Skipping unsupported media: ${kinds.join(', ')}`);
            }
            return null;
        }

        try {
            const file = await ctx.api.getFile(fileId);

            if (!file.file_path) {
                this.logger.error('Bot media has no file_path (file too large for the cloud API?)');
                return null;
            }

            return await this.saveMediaFile(ext, await this.fetchFileBytes(file.file_path));
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            this.logger.error(`Failed to download bot media (${ext}): ${reason}`);
            return null;
        }
    }

    private async fetchFileBytes(filePath: string): Promise<Buffer> {
        // A --local Bot API server returns an absolute in-container path (its data dir).
        if (path.isAbsolute(filePath)) {
            const serverDir = this.config.bot?.api_server_dir;
            const filesUrl = this.config.bot?.api_files_url;

            // Served over HTTP by a sidecar (nginx): strip the data-dir prefix and fetch.
            if (serverDir && filesUrl) {
                const rel = path.relative(serverDir, filePath);
                return downloadUrl(`${filesUrl.replace(/\/+$/, '')}/${rel}`);
            }

            // Otherwise the app shares the server's filesystem (e.g. both in Docker).
            return fs.readFile(filePath);
        }

        // Cloud or non-local server: download from the standard /file path.
        return downloadUrl(`${this.apiRoot}/file/bot${this.token}/${filePath}`);
    }
}
