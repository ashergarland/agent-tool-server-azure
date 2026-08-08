import { pino, type Logger, type LoggerOptions } from 'pino';
import type { AppConfig } from '../config/index.js';

export type { Logger };

const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'headers.authorization',
  'headers["x-api-key"]',
  'apiKey',
  'password',
  'secret',
  'token',
  '*.password',
  '*.secret',
  '*.token',
];

export const createLogger = (config: AppConfig): Logger => {
  const options: LoggerOptions = {
    level: config.logLevel,
    base: {
      service: config.service.name,
      version: config.service.version,
      env: config.env,
    },
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return pino(options);
};
