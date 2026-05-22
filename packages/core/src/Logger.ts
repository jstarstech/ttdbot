import winston from 'winston';
import type { Config } from './Config.js';

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

let fileTransportAdded = false;

export function configureLogger(config: Config): void {
    // Validate log level
    if (!config.logLevel || !Object.keys(logger.levels).includes(config.logLevel)) {
        throw new Error(`The "logLevel" not set or not in list: ${Object.keys(logger.levels).join(', ')}`);
    }

    logger.level = config.logLevel;

    if (fileTransportAdded) {
        return;
    }

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

    fileTransportAdded = true;
}

export default logger;
