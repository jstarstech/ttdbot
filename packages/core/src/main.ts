import config from './Config.js';
import DiscordClient from './DiscordClient.js';
import TelegramClientBot from './TelegramClientBot.js';
import logger from './Logger.js';

logger.info(`Data directory ${config.dataDir}`);

try {
    const telegramClientBot = new TelegramClientBot(config);
    await telegramClientBot.init();

    const discordClient = new DiscordClient(config);
    await discordClient.init();

    telegramClientBot.addListener('newMessage', discordClient.postMessage.bind(discordClient));
} catch (e) {
    logger.error(e);
}
