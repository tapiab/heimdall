/**
 * Tests for Logger utility
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger, LOG_LEVELS } from '../logger.js';

describe('Logger', () => {
  let logger;
  let consoleSpy;

  beforeEach(() => {
    logger = new Logger();
    // Set to DEBUG to capture all levels in tests
    logger.setLevel('debug');
    consoleSpy = {
      debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
      info: vi.spyOn(console, 'info').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('log levels', () => {
    it('should have correct level values', () => {
      expect(LOG_LEVELS.DEBUG).toBe(0);
      expect(LOG_LEVELS.INFO).toBe(1);
      expect(LOG_LEVELS.WARN).toBe(2);
      expect(LOG_LEVELS.ERROR).toBe(3);
      expect(LOG_LEVELS.NONE).toBe(4);
    });

    it('should set level correctly', () => {
      logger.setLevel('warn');
      expect(logger.level).toBe(LOG_LEVELS.WARN);
    });

    it('should handle case-insensitive level names', () => {
      logger.setLevel('WARN');
      expect(logger.level).toBe(LOG_LEVELS.WARN);

      logger.setLevel('error');
      expect(logger.level).toBe(LOG_LEVELS.ERROR);
    });

    it('should ignore invalid level names', () => {
      const originalLevel = logger.level;
      logger.setLevel('invalid');
      expect(logger.level).toBe(originalLevel);
    });
  });

  describe('debug', () => {
    it('should log debug messages at DEBUG level', () => {
      logger.setLevel('debug');
      logger.debug('test message');
      expect(consoleSpy.debug).toHaveBeenCalled();
    });

    it('should not log debug messages at INFO level', () => {
      logger.setLevel('info');
      logger.debug('test message');
      expect(consoleSpy.debug).not.toHaveBeenCalled();
    });

    it('should include context in debug messages', () => {
      logger.debug('test', { foo: 'bar' });
      expect(consoleSpy.debug).toHaveBeenCalledWith(expect.stringContaining('test'), {
        foo: 'bar',
      });
    });
  });

  describe('info', () => {
    it('should log info messages at INFO level', () => {
      logger.setLevel('info');
      logger.info('test message');
      expect(consoleSpy.info).toHaveBeenCalled();
    });

    it('should not log info messages at WARN level', () => {
      logger.setLevel('warn');
      logger.info('test message');
      expect(consoleSpy.info).not.toHaveBeenCalled();
    });
  });

  describe('warn', () => {
    it('should log warn messages at WARN level', () => {
      logger.setLevel('warn');
      logger.warn('test warning');
      expect(consoleSpy.warn).toHaveBeenCalled();
    });

    it('should not log warn messages at ERROR level', () => {
      logger.setLevel('error');
      logger.warn('test warning');
      expect(consoleSpy.warn).not.toHaveBeenCalled();
    });
  });

  describe('error', () => {
    it('should log error messages', () => {
      logger.error('test error');
      expect(consoleSpy.error).toHaveBeenCalled();
    });

    it('should handle Error objects', () => {
      const error = new Error('Something went wrong');
      logger.error('Operation failed', error);
      expect(consoleSpy.error).toHaveBeenCalledWith(
        expect.stringContaining('Operation failed'),
        expect.objectContaining({
          error: 'Something went wrong',
          stack: expect.any(String),
        })
      );
    });

    it('should not log at NONE level', () => {
      logger.setLevel('none');
      logger.error('test error');
      expect(consoleSpy.error).not.toHaveBeenCalled();
    });
  });

  describe('formatting', () => {
    it('should include prefix in messages', () => {
      logger.info('test');
      expect(consoleSpy.info).toHaveBeenCalledWith(expect.stringContaining('[Heimdall]'));
    });

    it('should include timestamp in messages', () => {
      logger.info('test');
      // Timestamp format: HH:MM:SS.mmm
      expect(consoleSpy.info).toHaveBeenCalledWith(
        expect.stringMatching(/\d{2}:\d{2}:\d{2}\.\d{3}/)
      );
    });

    it('should not include context if empty', () => {
      logger.info('test', {});
      expect(consoleSpy.info).toHaveBeenCalledWith(expect.stringContaining('test'));
      // Should only have one argument (no context object)
      expect(consoleSpy.info.mock.calls[0].length).toBe(1);
    });
  });

  describe('child logger', () => {
    it('should create child logger with component prefix', () => {
      const childLogger = logger.child('MapManager');
      childLogger.info('initialized');
      expect(consoleSpy.info).toHaveBeenCalledWith(expect.stringContaining('[MapManager]'));
    });

    it('should support all log levels in child', () => {
      const child = logger.child('Test');
      child.debug('debug');
      child.info('info');
      child.warn('warn');
      child.error('error');

      expect(consoleSpy.debug).toHaveBeenCalled();
      expect(consoleSpy.info).toHaveBeenCalled();
      expect(consoleSpy.warn).toHaveBeenCalled();
      expect(consoleSpy.error).toHaveBeenCalled();
    });

    it('should respect parent log level', () => {
      logger.setLevel('error');
      const child = logger.child('Test');
      child.info('info');
      child.error('error');

      expect(consoleSpy.info).not.toHaveBeenCalled();
      expect(consoleSpy.error).toHaveBeenCalled();
    });
  });
});
