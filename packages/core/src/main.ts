import fs from 'fs-extra';
import path from 'node:path';
import { loadConfig, workspaceRoot } from './Config.js';
import DiscordClient from './DiscordClient.js';
import logger, { configureLogger } from './Logger.js';
import TelegramClientBot from './TelegramClientBot.js';

try {
    const config = await loadConfig();
    config.dataDir = path.resolve(workspaceRoot, config.dataDir);

    await fs.ensureDir(config.dataDir);
    await fs.ensureDir(config.dataDir + '/logs');
    await fs.ensureDir(config.dataDir + '/telegram_media');
    await fs.ensureDir(config.dataDir + '/convert');

    configureLogger(config);

    logger.info(`Data directory ${config.dataDir}`);

    const telegramClientBot = new TelegramClientBot(config);
    await telegramClientBot.init();

    const discordClient = new DiscordClient(config);
    await discordClient.init();

    telegramClientBot.addListener('newMessage', eventsGroupedResult =>
        discordClient.postMessage(eventsGroupedResult).catch(error => {
            logger.error(error);
        })
    );
} catch (e) {
    logger.error(e);
}
