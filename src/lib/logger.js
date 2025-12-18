/**
 * Structured logging utility
 * Provides log levels and can be disabled in production
 */

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  NONE: 4,
};

class Logger {
  constructor() {
    // Default to INFO in production, DEBUG in development
    this.level = this.isProduction() ? LOG_LEVELS.INFO : LOG_LEVELS.DEBUG;
    this.prefix = '[Heimdall]';
  }

  /**
   * Check if running in production mode
   * @returns {boolean}
   */
  isProduction() {
    // Vite sets import.meta.env.PROD in production builds
    try {
      return import.meta.env?.PROD === true;
    } catch {
      return false;
    }
  }

  /**
   * Set the minimum log level
   * @param {'debug' | 'info' | 'warn' | 'error' | 'none'} level
   */
  setLevel(level) {
    const normalizedLevel = level.toUpperCase();
    if (normalizedLevel in LOG_LEVELS) {
      this.level = LOG_LEVELS[normalizedLevel];
    }
  }

  /**
   * Format a log message with optional context
   * @param {string} message - Log message
   * @param {Object} [context] - Additional context data
   * @returns {Array} Arguments for console methods
   */
  format(message, context) {
    const timestamp = new Date().toISOString().split('T')[1].slice(0, 12);
    const args = [`${this.prefix} ${timestamp} ${message}`];
    if (context && Object.keys(context).length > 0) {
      args.push(context);
    }
    return args;
  }

  /**
   * Log debug message (development only)
   * @param {string} message
   * @param {Object} [context]
   */
  debug(message, context) {
    if (this.level <= LOG_LEVELS.DEBUG) {
      console.debug(...this.format(message, context));
    }
  }

  /**
   * Log info message
   * @param {string} message
   * @param {Object} [context]
   */
  info(message, context) {
    if (this.level <= LOG_LEVELS.INFO) {
      console.info(...this.format(message, context));
    }
  }

  /**
   * Log warning message
   * @param {string} message
   * @param {Object} [context]
   */
  warn(message, context) {
    if (this.level <= LOG_LEVELS.WARN) {
      console.warn(...this.format(message, context));
    }
  }

  /**
   * Log error message
   * @param {string} message
   * @param {Error | Object} [errorOrContext]
   */
  error(message, errorOrContext) {
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
   * @param {string} component - Component name
   * @returns {Object} Logger-like object scoped to component
   */
  child(component) {
    const parent = this;
    return {
      debug: (msg, ctx) => parent.debug(`[${component}] ${msg}`, ctx),
      info: (msg, ctx) => parent.info(`[${component}] ${msg}`, ctx),
      warn: (msg, ctx) => parent.warn(`[${component}] ${msg}`, ctx),
      error: (msg, ctx) => parent.error(`[${component}] ${msg}`, ctx),
    };
  }
}

// Export singleton instance
export const logger = new Logger();

// Export class for testing
export { Logger, LOG_LEVELS };
