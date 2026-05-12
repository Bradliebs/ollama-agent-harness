export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let minLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export function log(level: LogLevel, component: string, message: string, data?: Record<string, unknown>): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel]) return;

  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase().padEnd(5)}] [${component}]`;
  const suffix = data ? ` ${JSON.stringify(data)}` : '';
  const line = `${prefix} ${message}${suffix}`;

  switch (level) {
    case 'error':
      console.error(line);
      break;
    case 'warn':
      console.warn(line);
      break;
    default:
      console.log(line);
  }
}

export const logger = {
  debug: (component: string, msg: string, data?: Record<string, unknown>) => log('debug', component, msg, data),
  info: (component: string, msg: string, data?: Record<string, unknown>) => log('info', component, msg, data),
  warn: (component: string, msg: string, data?: Record<string, unknown>) => log('warn', component, msg, data),
  error: (component: string, msg: string, data?: Record<string, unknown>) => log('error', component, msg, data),
};
