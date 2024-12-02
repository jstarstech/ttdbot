import winston from 'winston';
import config from './Config.js';

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

export default logger;
