import winston from 'winston';

// Telegram tolerates roughly one edit per second per chat; coalesce rapid stage
// changes (a many-chunk upload) into throttled edits of the latest text.
const EDIT_INTERVAL_MS = 1500;

/** Minimal structural slice of grammY's Api that StatusMessage needs. */
export interface StatusApi {
    sendMessage(
        chatId: number,
        text: string,
        other?: { reply_parameters: { message_id: number } }
    ): Promise<{ message_id: number }>;
    editMessageText(chatId: number, messageId: number, text: string): Promise<unknown>;
}

/**
 * One live-edited Telegram status message ("⬇️ Downloading… → ✅ Delivered").
 * All Telegram errors are logged and swallowed — status must never break forwarding.
 */
export default class StatusMessage {
    private latestText: string;
    private lastSentText: string;
    private lastEditAt: number;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private editPromise: Promise<void> = Promise.resolve();

    private constructor(
        private readonly api: StatusApi,
        private readonly chatId: number,
        private readonly messageId: number,
        initialText: string,
        private readonly logger: winston.Logger
    ) {
        this.latestText = initialText;
        this.lastSentText = initialText;
        this.lastEditAt = Date.now();
    }

    /**
     * Sends the initial status message; returns null (and logs) if Telegram rejects it.
     * Pass replyToMessageId to anchor the status as a reply to the submitted message, so
     * a user with several submissions in flight can tell which one each status belongs to.
     */
    static async create(
        api: StatusApi,
        chatId: number,
        text: string,
        logger: winston.Logger,
        replyToMessageId?: number
    ): Promise<StatusMessage | null> {
        try {
            const message =
                replyToMessageId === undefined
                    ? await api.sendMessage(chatId, text)
                    : await api.sendMessage(chatId, text, { reply_parameters: { message_id: replyToMessageId } });
            return new StatusMessage(api, chatId, message.message_id, text, logger);
        } catch (error) {
            logger.error('Failed to send status message', { error });
            return null;
        }
    }

    /** Throttled fire-and-forget edit; rapid calls coalesce to the latest text. */
    update(text: string): void {
        this.latestText = text;

        if (this.timer) {
            return;
        }

        const wait = this.lastEditAt + EDIT_INTERVAL_MS - Date.now();

        if (wait <= 0) {
            void this.edit();
            return;
        }

        this.timer = setTimeout(() => {
            this.timer = null;
            void this.edit();
        }, wait);
    }

    /** Final ✅/❌ edit: cancels any pending update and bypasses the throttle. */
    async finalize(text: string): Promise<void> {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        this.latestText = text;
        // Wait for any in-flight edit to complete before queueing the final one.
        await this.editPromise;
        await this.edit();
    }

    private async edit(): Promise<void> {
        // Serialize edits: queue this edit after any in-flight edits complete.
        this.editPromise = this.editPromise.then(() => this.performEdit());
        await this.editPromise;
    }

    private async performEdit(): Promise<void> {
        const text = this.latestText;

        // Telegram rejects no-op edits with a 400; skip them.
        if (text === this.lastSentText) {
            return;
        }

        // Record attempt time for throttle spacing (before API call).
        this.lastEditAt = Date.now();

        try {
            await this.api.editMessageText(this.chatId, this.messageId, text);
            // Only update lastSentText after the API call succeeds, so failed edits
            // are retryable and not falsely marked as sent.
            this.lastSentText = text;
        } catch (error) {
            this.logger.error('Failed to edit status message', { error });
        }
    }
}
