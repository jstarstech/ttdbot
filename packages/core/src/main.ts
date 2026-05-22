import config from './Config.js';
import DiscordClient from './DiscordClient.js';
import logger from './Logger.js';
import TelegramClientBot from './TelegramClientBot.js';

logger.info(`Data directory ${config.dataDir}`);

try {
    const telegramClientBot = new TelegramClientBot(config);
    await telegramClientBot.init();

    const discordClient = new DiscordClient(config);
    await discordClient.init();

    telegramClientBot.addListener('newMessage', eventsGroupedResult => {
        void discordClient.postMessage(eventsGroupedResult).catch(error => {
            logger.error(error);
        });
    });
} catch (e) {
    logger.error(e);
}
