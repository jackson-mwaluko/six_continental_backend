import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

// Pretty logs in dev, JSON in production. Redacts sensitive fields.
const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.passwordHash', '*.token'],
    censor: '[redacted]',
  },
  ...(isDev ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } } } : {}),
});

export default logger;
