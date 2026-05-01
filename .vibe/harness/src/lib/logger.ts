export type LogLevel = 'info' | 'warn' | 'error';

function format(level: LogLevel, message: string): string {
  const stamp = new Date().toISOString();
  return `[${stamp}] [${level.toUpperCase()}] ${message}`;
}

function log(level: LogLevel, message: string): void {
  const line = format(level, message);
  if (level === 'error') {
    console.error(line);
    return;
  }

  console.log(line);
}

export const logger = {
  info(message: string): void {
    log('info', message);
  },
  warn(message: string): void {
    log('warn', message);
  },
  error(message: string): void {
    log('error', message);
  },
};
