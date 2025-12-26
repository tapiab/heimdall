/**
 * Structured logging utility
 * Provides log levels and can be disabled in production
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'none';
type LogLevelValue = 0 | 1 | 2 | 3 | 4;

interface LogContext {
  [key: string]: unknown;
}

interface ChildLogger {
  debug: (message: string, context?: LogContext) => void;
  info: (message: string, context?: LogContext) => void;
  warn: (message: string, context?: LogContext) => void;
  error: (message: string, errorOrContext?: Error | LogContext) => void;
}

const LOG_LEVELS: Record<Uppercase<LogLevel>, LogLevelValue> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  NONE: 4,
};

class Logger {
  private level: LogLevelValue;
  private prefix: string;

  constructor() {
    // Default to INFO in production, DEBUG in development
    this.level = this.isProduction() ? LOG_LEVELS.INFO : LOG_LEVELS.DEBUG;
    this.prefix = '[Heimdall]';
  }

  /**
   * Check if running in production mode
   */
  private isProduction(): boolean {
    // Vite sets import.meta.env.PROD in production builds
    try {
      return import.meta.env?.PROD === true;
    } catch {
      return false;
    }
  }

  /**
   * Set the minimum log level
   */
  setLevel(level: LogLevel): void {
    const normalizedLevel = level.toUpperCase() as Uppercase<LogLevel>;
    if (normalizedLevel in LOG_LEVELS) {
      this.level = LOG_LEVELS[normalizedLevel];
    }
  }

  /**
   * Format a log message with optional context
   */
  private format(message: string, context?: LogContext): unknown[] {
    const timestamp = new Date().toISOString().split('T')[1].slice(0, 12);
    const args: unknown[] = [`${this.prefix} ${timestamp} ${message}`];
    if (context && Object.keys(context).length > 0) {
      args.push(context);
    }
    return args;
  }

  /**
   * Log debug message (development only)
   */
  debug(message: string, context?: LogContext): void {
    if (this.level <= LOG_LEVELS.DEBUG) {
      console.debug(...this.format(message, context));
    }
  }

  /**
   * Log info message
   */
  info(message: string, context?: LogContext): void {
    if (this.level <= LOG_LEVELS.INFO) {
      console.info(...this.format(message, context));
    }
  }

  /**
   * Log warning message
   */
  warn(message: string, context?: LogContext): void {
    if (this.level <= LOG_LEVELS.WARN) {
      console.warn(...this.format(message, context));
    }
  }

  /**
   * Log error message
   */
  error(message: string, errorOrContext?: Error | LogContext): void {
    if (this.level <= LOG_LEVELS.ERROR) {
      if (errorOrContext instanceof Error) {
        console.error(
          ...this.format(message, { error: errorOrContext.message, stack: errorOrContext.stack })
        );
      } else {
        console.error(...this.format(message, errorOrContext));
      }
    }
  }

  /**
   * Create a child logger with a specific component prefix
   */
  child(component: string): ChildLogger {
    return {
      debug: (msg: string, ctx?: LogContext) => this.debug(`[${component}] ${msg}`, ctx),
      info: (msg: string, ctx?: LogContext) => this.info(`[${component}] ${msg}`, ctx),
      warn: (msg: string, ctx?: LogContext) => this.warn(`[${component}] ${msg}`, ctx),
      error: (msg: string, ctx?: Error | LogContext) => this.error(`[${component}] ${msg}`, ctx),
    };
  }
}

// Export singleton instance
export const logger = new Logger();

// Export class for testing
export { Logger, LOG_LEVELS };
export type { LogLevel, LogContext, ChildLogger };
