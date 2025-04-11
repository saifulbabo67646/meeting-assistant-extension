import winston from 'winston';
import path from 'path';
import { createPath } from './path-helper';

// Create log directory if it doesn't exist
const logDir = createPath(['logs']);

const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss'
    }),
    winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}${info.stack ? '\n' + info.stack : ''}`)
  ),
  transports: [
    // Write all logs with level 'error' and below to error.log
    new winston.transports.File({ 
      filename: createPath(['logs', 'error.log']), 
      level: 'error' 
    }),
    // Write all logs with level 'info' and below to combined.log
    new winston.transports.File({ 
      filename: createPath(['logs', 'combined.log']) 
    }),
  ],
});

// If we're not in production, also log to the console
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`)
    ),
  }));
}

export default logger;