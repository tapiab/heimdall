/**
 * Tests for LRU Cache
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LRUCache } from '../lru-cache.js';

describe('LRUCache', () => {
  let cache;

  beforeEach(() => {
    cache = new LRUCache(3); // Small cache for testing
  });

  describe('basic operations', () => {
    it('should store and retrieve values', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      expect(cache.get('a')).toBe(1);
      expect(cache.get('b')).toBe(2);
    });

    it('should return undefined for missing keys', () => {
      expect(cache.get('nonexistent')).toBeUndefined();
    });

    it('should check if key exists', () => {
      cache.set('a', 1);
      expect(cache.has('a')).toBe(true);
      expect(cache.has('b')).toBe(false);
    });

    it('should delete keys', () => {
      cache.set('a', 1);
      expect(cache.delete('a')).toBe(true);
      expect(cache.has('a')).toBe(false);
      expect(cache.delete('nonexistent')).toBe(false);
    });

    it('should clear all entries', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      cache.clear();
      expect(cache.size).toBe(0);
    });

    it('should report correct size', () => {
      expect(cache.size).toBe(0);
      cache.set('a', 1);
      expect(cache.size).toBe(1);
      cache.set('b', 2);
      expect(cache.size).toBe(2);
    });
  });

  describe('LRU eviction', () => {
    it('should evict oldest entry when capacity is exceeded', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      // Cache is full now
      cache.set('d', 4); // Should evict 'a'

      expect(cache.has('a')).toBe(false);
      expect(cache.has('b')).toBe(true);
      expect(cache.has('c')).toBe(true);
      expect(cache.has('d')).toBe(true);
    });

    it('should update LRU order on get', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);

      // Access 'a' to make it most recently used
      cache.get('a');

      // Add new entry, should evict 'b' (oldest unused)
      cache.set('d', 4);

      expect(cache.has('a')).toBe(true); // Still present (was accessed)
      expect(cache.has('b')).toBe(false); // Evicted
      expect(cache.has('c')).toBe(true);
      expect(cache.has('d')).toBe(true);
    });

    it('should update LRU order on set of existing key', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);

      // Update 'a' to make it most recently used
      cache.set('a', 10);

      // Add new entry, should evict 'b'
      cache.set('d', 4);

      expect(cache.get('a')).toBe(10);
      expect(cache.has('b')).toBe(false);
    });
  });

  describe('statistics', () => {
    it('should track hits and misses', () => {
      cache.set('a', 1);
      cache.get('a'); // hit
      cache.get('a'); // hit
      cache.get('b'); // miss

      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBeCloseTo(66.67, 1);
    });

    it('should track evictions', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.set('d', 4); // evicts 'a'
      cache.set('e', 5); // evicts 'b'

      const stats = cache.getStats();
      expect(stats.evictions).toBe(2);
    });

    it('should report size and maxSize', () => {
      cache.set('a', 1);
      cache.set('b', 2);

      const stats = cache.getStats();
      expect(stats.size).toBe(2);
      expect(stats.maxSize).toBe(3);
    });

    it('should reset statistics', () => {
      cache.set('a', 1);
      cache.get('a');
      cache.get('missing');

      cache.resetStats();

      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.evictions).toBe(0);
    });

    it('should handle zero total requests', () => {
      const stats = cache.getStats();
      expect(stats.hitRate).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('should handle cache size of 1', () => {
      const tinyCache = new LRUCache(1);
      tinyCache.set('a', 1);
      tinyCache.set('b', 2);

      expect(tinyCache.has('a')).toBe(false);
      expect(tinyCache.get('b')).toBe(2);
    });

    it('should use default size of 500', () => {
      const defaultCache = new LRUCache();
      expect(defaultCache.getStats().maxSize).toBe(500);
    });

    it('should handle various value types', () => {
      const largeCache = new LRUCache(10);
      largeCache.set('string', 'hello');
      largeCache.set('number', 42);
      largeCache.set('object', { foo: 'bar' });
      largeCache.set('array', [1, 2, 3]);
      largeCache.set('null', null);

      expect(largeCache.get('string')).toBe('hello');
      expect(largeCache.get('number')).toBe(42);
      expect(largeCache.get('object')).toEqual({ foo: 'bar' });
      expect(largeCache.get('array')).toEqual([1, 2, 3]);
      expect(largeCache.get('null')).toBe(null);
    });
  });
});
