import fs from 'node:fs/promises';
import path from 'node:path';
import { Bot, Context } from 'grammy';
import winston from 'winston';
import { Config } from './Config.js';
import _logger from './Logger.js';
import StatusMessage from './StatusMessage.js';
import TelegramSource from './TelegramSource.js';
import { ForwardPayload } from './types.js';

const GROUP_DEBOUNCE_MS = 5000;
const API_PROBE_TIMEOUT_MS = 5000;
const DEFAULT_API_ROOT = 'https://api.telegram.org';

interface AlbumBuffer {
    representative: Context;
    mediaFiles: string[];
    results: DownloadResult[];
    timeout: ReturnType<typeof setTimeout> | null;
}

export type MediaClassification =
    | { kind: 'supported'; ext: 'jpeg' | 'mp4'; fileId: string }
    | { kind: 'unsupported'; media: string } // media: 'sticker', 'voice', 'document(audio/mpeg)', …
    | { kind: 'none' };

export type DownloadResult =
    | { status: 'ok'; file: string }
    | { status: 'unsupported'; kind: string }
    | { status: 'none' }
    | { status: 'failed'; kind: string }; // supported type whose getFile/fetch threw

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

    return { title, url, text: msg.caption ?? msg.text ?? '', mediaFiles, sourceId: ctx.from?.id ?? ctx.chat?.id };
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
        await this.warnIfApiUnreachable();
        await this.bot.init();
        this.logger.info(`Running Telegram bot @${this.bot.botInfo.username}`);

        // start() long-polls until stopped; run it in the background so init() returns.
        void this.bot.start().catch(error => this.logger.error('Telegram bot polling stopped', { error }));
    }

    /**
     * An unreachable api_server otherwise fails silently: grammY retries the connection
     * forever, so the process looks healthy while receiving nothing at all. Probe once at
     * startup and say so loudly. Any HTTP response counts as reachable (a live Bot API
     * server 404s on its root path); only a connection failure is worth reporting.
     */
    private async warnIfApiUnreachable(): Promise<void> {
        try {
            await fetch(this.apiRoot, { signal: AbortSignal.timeout(API_PROBE_TIMEOUT_MS) });
        } catch (error) {
            this.logger.error(
                `Bot API unreachable at ${this.apiRoot} — the bot will receive no updates. ` +
                    'Check that the telegram-bot-api server is running ' +
                    '(.local/telegram-bot-api.compose.yml for local dev), or set bot.api_server to "" ' +
                    'to use the Telegram cloud API.',
                { error }
            );
        }
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
            if (ctx.from) {
                this.logger.info(
                    `Ignored non-allowlisted sender: id=${ctx.from.id} @${ctx.from.username ?? '?'} chat=${ctx.chat?.id}`
                );
            }
            return;
        }

        const groupId = ctx.msg.media_group_id;

        if (groupId !== undefined) {
            this.bufferAlbumItem(groupId, ctx, await this.downloadMedia(ctx));
            return;
        }

        await this.handleSingle(ctx);
    }

    private async handleSingle(ctx: Context): Promise<void> {
        const msg = ctx.msg!;
        const text = msg.caption ?? msg.text ?? '';
        const classification = this.classifyMedia(msg);
        const isDm = ctx.chat?.type === 'private';

        // Nothing forwardable: reject (DM) and never dispatch — no empty Discord messages.
        if (classification.kind !== 'supported' && !text) {
            if (isDm) {
                const media = classification.kind === 'unsupported' ? ` (${classification.media})` : '';
                await this.reply(ctx, `⚠️ Unsupported content${media} — nothing to forward`);
            }
            return;
        }

        const status =
            isDm && ctx.chat
                ? await StatusMessage.create(
                      ctx.api,
                      ctx.chat.id,
                      classification.kind === 'supported'
                          ? '⬇️ Downloading from Telegram…'
                          : '📤 Forwarding to Discord…',
                      this.logger
                  )
                : null;

        let file: string | null = null;
        let skippedNote = classification.kind === 'unsupported' ? `skipped: ${classification.media}` : null;

        if (classification.kind === 'supported') {
            const result = await this.downloadMedia(ctx);

            if (result.status === 'ok') {
                file = result.file;
            } else {
                if (!text) {
                    await status?.finalize(
                        `❌ Failed to fetch the ${classification.ext === 'jpeg' ? 'photo' : 'video'}`
                    );
                    return;
                }
                skippedNote = 'media download failed';
            }
        }

        const payload = toForwardPayload(ctx, file ? [file] : []);
        const failures: string[] = [];

        if (status) {
            payload.onStatus = s => {
                if (s.stage === 'converting') {
                    status.update('🎞️ Converting video…');
                } else if (s.stage === 'uploading') {
                    status.update(`📤 Sending to Discord (${s.chunk}/${s.totalChunks})…`);
                } else {
                    failures.push(s.reason);
                }
            };
        }

        await this.dispatch(payload);

        if (failures.length > 0) {
            await status?.finalize(`❌ Failed: ${failures[0]}`);
        } else {
            await status?.finalize(`✅ Delivered${skippedNote ? ` (text only; ${skippedNote})` : ''}`);
        }
    }

    /** DM reply that never breaks the pipeline on Telegram errors. */
    private async reply(ctx: Context, text: string): Promise<void> {
        try {
            await ctx.reply(text);
        } catch (error) {
            this.logger.error('Failed to send status reply', { error });
        }
    }

    /** Accumulates album items sharing a media_group_id, flushing 5 s after the last one. */
    private bufferAlbumItem(groupId: string, ctx: Context, result: DownloadResult): void {
        let album = this.albums.get(groupId);

        if (album === undefined) {
            album = { representative: ctx, mediaFiles: [], results: [], timeout: null };
            this.albums.set(groupId, album);
        }

        // Prefer the caption-bearing message as the representative (its text/url wins).
        const caption = ctx.msg?.caption ?? ctx.msg?.text;
        const repCaption = album.representative.msg?.caption ?? album.representative.msg?.text;
        if (caption && !repCaption) {
            album.representative = ctx;
        }

        album.results.push(result);
        if (result.status === 'ok') {
            album.mediaFiles.push(result.file);
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

        const rep = album.representative;
        const text = rep.msg?.caption ?? rep.msg?.text ?? '';
        const isDm = rep.chat?.type === 'private';
        const accepted = album.results.filter(r => r.status === 'ok').length;
        const skippedKinds = [
            ...new Set(
                album.results.flatMap(r => (r.status === 'unsupported' || r.status === 'failed' ? [r.kind] : []))
            )
        ];

        try {
            if (accepted === 0 && !text) {
                if (isDm) {
                    const kinds = skippedKinds.length > 0 ? ` (${skippedKinds.join(', ')})` : '';
                    await this.reply(rep, `⚠️ Unsupported content${kinds} — nothing to forward`);
                }
                return;
            }

            const status =
                isDm && rep.chat
                    ? await StatusMessage.create(
                          rep.api,
                          rep.chat.id,
                          `📤 Processing album (${accepted} items)…`,
                          this.logger
                      )
                    : null;

            const payload = toForwardPayload(rep, album.mediaFiles);
            const failures: string[] = [];

            if (status) {
                payload.onStatus = s => {
                    if (s.stage === 'converting') {
                        status.update('🎞️ Converting video…');
                    } else if (s.stage === 'uploading') {
                        status.update(`📤 Sending to Discord (${s.chunk}/${s.totalChunks})…`);
                    } else {
                        failures.push(s.reason);
                    }
                };
            }

            await this.dispatch(payload);

            if (failures.length > 0) {
                await status?.finalize(`❌ Failed: ${failures[0]}`);
            } else {
                const skipped = skippedKinds.length > 0 ? `; skipped: ${skippedKinds.join(', ')}` : '';
                await status?.finalize(`✅ Delivered ${accepted} of ${album.results.length} items${skipped}`);
            }
        } catch (error) {
            this.logger.error(`Failed to process album ${groupId}`, { error });
        }
    }

    /** Pure classification of a message's media — no I/O, cheap to call repeatedly. */
    private classifyMedia(msg: NonNullable<Context['msg']>): MediaClassification {
        if (msg.photo && msg.photo.length > 0) {
            return { kind: 'supported', ext: 'jpeg', fileId: msg.photo[msg.photo.length - 1].file_id };
        }
        if (msg.video) {
            return { kind: 'supported', ext: 'mp4', fileId: msg.video.file_id };
        }
        if (msg.animation) {
            // GIFs arrive as soundless mp4.
            return { kind: 'supported', ext: 'mp4', fileId: msg.animation.file_id };
        }
        if (msg.document) {
            const mime = msg.document.mime_type ?? '';
            if (mime.startsWith('video/')) {
                return { kind: 'supported', ext: 'mp4', fileId: msg.document.file_id };
            }
            if (mime.startsWith('image/')) {
                return { kind: 'supported', ext: 'jpeg', fileId: msg.document.file_id };
            }
            return { kind: 'unsupported', media: `document(${mime || 'unknown'})` };
        }

        const kind = (['sticker', 'audio', 'voice', 'video_note'] as const).find(k => msg[k] !== undefined);
        return kind ? { kind: 'unsupported', media: kind } : { kind: 'none' };
    }

    private async downloadMedia(ctx: Context): Promise<DownloadResult> {
        const msg = ctx.msg!;
        const classification = this.classifyMedia(msg);

        if (classification.kind === 'unsupported') {
            this.logger.info(`Skipping unsupported media: ${classification.media}`);
            return { status: 'unsupported', kind: classification.media };
        }
        if (classification.kind === 'none') {
            return { status: 'none' };
        }

        const { ext, fileId } = classification;
        const mediaName = ext === 'jpeg' ? 'photo' : 'video';

        try {
            const file = await ctx.api.getFile(fileId);

            if (!file.file_path) {
                this.logger.error('Bot media has no file_path (file too large for the cloud API?)');
                return { status: 'failed', kind: mediaName };
            }

            return { status: 'ok', file: await this.saveMediaFile(ext, await this.fetchFileBytes(file.file_path)) };
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            this.logger.error(`Failed to download bot media (${ext}): ${reason}`);
            return { status: 'failed', kind: mediaName };
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
