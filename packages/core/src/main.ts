import fs from 'fs-extra';
import path from 'node:path';
import { loadConfig, workspaceRoot } from './Config.js';
import DiscordClient from './DiscordClient.js';
import logger, { configureLogger } from './Logger.js';
import TelegramSource from './TelegramSource.js';
import TelegramClientBot from './TelegramClientBot.js';
import TelegramBotClient from './TelegramBotClient.js';

try {
    const config = await loadConfig();
    config.dataDir = path.resolve(workspaceRoot, config.dataDir);

    await fs.ensureDir(config.dataDir);
    await fs.ensureDir(config.dataDir + '/logs');
    await fs.ensureDir(config.dataDir + '/telegram_media');
    await fs.ensureDir(config.dataDir + '/convert');

    configureLogger(config);

    logger.info(`Data directory ${config.dataDir}`);

    const discordClient = new DiscordClient(config);
    await discordClient.init();

    // Build the enabled ingest sources. The user-account source is on unless
    // explicitly disabled; the bot source is off unless explicitly enabled.
    const sourceFactories: (() => TelegramSource)[] = [];
    if (config.user_client?.enabled !== false) {
        sourceFactories.push(() => new TelegramClientBot(config));
    }
    if (config.bot?.enabled) {
        sourceFactories.push(() => new TelegramBotClient(config));
    }

    for (const createSource of sourceFactories) {
        // A broken config or failed init of one source must not take down the others.
        try {
            const source = createSource();
            // Rejections are collected by TelegramSource.dispatch, which then keeps the media.
            source.addListener('newMessage', payload => discordClient.postMessage(payload));
            await source.init();
        } catch (error) {
            logger.error('Failed to start a Telegram source', { error });
        }
    }
} catch (e) {
    logger.error(e);
}
