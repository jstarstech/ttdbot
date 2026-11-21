import { describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    initUserSource: vi.fn(),
    initBotSource: vi.fn(),
    config: {
        dataDir: './data',
        logLevel: 'info',
        user_client: { enabled: true },
        bot: { enabled: true } // enabled without a token: the constructor throws
    }
}));

vi.mock('../Config', () => ({
    loadConfig: async () => mocks.config,
    workspaceRoot: '/tmp/ttdbot'
}));

vi.mock('fs-extra', () => ({
    default: { ensureDir: vi.fn() }
}));

vi.mock('../Logger', () => ({
    default: mocks.logger,
    configureLogger: vi.fn()
}));

vi.mock('../DiscordClient', () => ({
    default: class {
        init = vi.fn();
    }
}));

vi.mock('../TelegramClientBot', () => ({
    default: class {
        addListener = vi.fn();
        init = mocks.initUserSource;
    }
}));

vi.mock('../TelegramBotClient', () => ({
    default: class {
        constructor() {
            throw new Error('bot.token is required when the bot source is enabled');
        }
        addListener = vi.fn();
        init = mocks.initBotSource;
    }
}));

describe('main', () => {
    test('starts the user-account source when the optional bot source is misconfigured', async () => {
        await import('../main');

        expect(mocks.initUserSource).toHaveBeenCalledTimes(1);
        expect(mocks.initBotSource).not.toHaveBeenCalled();
        expect(mocks.logger.error).toHaveBeenCalledWith(
            'Failed to start a Telegram source',
            expect.objectContaining({ error: expect.any(Error) })
        );
    });
});
