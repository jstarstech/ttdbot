import process from 'node:process';
import winston from 'winston';
import { initConfig } from './Config.js';
import DiscordClient from './DiscordClient.js';
import TelegramClientBot from './TelegramClientBot.js';
import { Config } from './types.js';

(async () => {
    const logger = winston.createLogger({
        level: 'info',
        format: winston.format.combine(
            winston.format.timestamp({
                format: 'YYYY-MM-DD HH:mm:ss'
            }),
            winston.format.simple()
        ),
        transports: [
            new winston.transports.Console({
                format: winston.format.combine(
                    winston.format.colorize(),
                    winston.format.timestamp({
                        format: 'YYYY-MM-DD HH:mm:ss'
                    }),
                    winston.format.simple(),
                    winston.format.printf(info => {
                        return `${info.timestamp} ${info.level} ${info.message}`;
                    })
                )
            })
        ]
    });

    const config: Config = await initConfig().catch(e => {
        logger.error(e);

        process.exit(1);
    });

    // Validate log level
    if (!config.logLevel || !Object.keys(logger.levels).includes(config.logLevel)) {
        logger.error(`The "logLevel" not set or not in list: ${Object.keys(logger.levels).join(', ')}`);

        process.exit(1);
    }

    logger.level = config.logLevel;

    logger.add(
        new winston.transports.File({
            filename: config.dataDir + '/logs/error.log',
            level: 'error',
            format: winston.format.combine(
                winston.format.timestamp({
                    format: 'YYYY-MM-DD HH:mm:ss'
                }),
                winston.format.errors({ stack: true }),
                winston.format.metadata({ fillExcept: ['message', 'level', 'timestamp'] }),
                winston.format.json(),
                winston.format.prettyPrint()
            )
        })
    );

    logger.add(
        new winston.transports.File({
            filename: config.dataDir + '/logs/combined.log',
            format: winston.format.combine(
                winston.format.timestamp({
                    format: 'YYYY-MM-DD HH:mm:ss'
                }),
                winston.format.errors({ stack: true }),
                winston.format.metadata({ fillExcept: ['message', 'level', 'timestamp'] }),
                winston.format.json(),
                winston.format.prettyPrint()
            )
        })
    );

    logger.info(`Data directory ${config.dataDir}`);

    const telegramClientBot = new TelegramClientBot(config, logger);
    await telegramClientBot.init();
    const discordClient = new DiscordClient(config, logger);
    await discordClient.init();

    telegramClientBot.addListener('newMessage', discordClient.postMessage.bind(discordClient));
})();
