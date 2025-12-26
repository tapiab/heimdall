/**
 * Tests for notification utilities
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Create mock DOM elements
function createMockDOM() {
  const toastContainer = document.createElement('div');
  toastContainer.id = 'toast-container';
  document.body.appendChild(toastContainer);

  const loadingIndicator = document.createElement('div');
  loadingIndicator.id = 'loading-indicator';
  loadingIndicator.innerHTML = '<span>Loading...</span>';
  document.body.appendChild(loadingIndicator);

  return { toastContainer, loadingIndicator };
}

function cleanupMockDOM() {
  const toastContainer = document.getElementById('toast-container');
  const loadingIndicator = document.getElementById('loading-indicator');
  if (toastContainer) toastContainer.remove();
  if (loadingIndicator) loadingIndicator.remove();
}

// Import after DOM setup
let showToast, showError, showLoading, hideLoading, withLoading, resetLoadingCount;

describe('Notifications', () => {
  beforeEach(async () => {
    cleanupMockDOM();
    createMockDOM();
    // Dynamic import to get fresh module state
    const module = await import('../notifications.js');
    showToast = module.showToast;
    showError = module.showError;
    showLoading = module.showLoading;
    hideLoading = module.hideLoading;
    withLoading = module.withLoading;
    resetLoadingCount = module.resetLoadingCount;
    // Reset state between tests
    resetLoadingCount();
  });

  afterEach(() => {
    cleanupMockDOM();
  });

  describe('showToast', () => {
    it('should create a toast element', () => {
      showToast('Test message');
      const toast = document.querySelector('.toast');
      expect(toast).toBeTruthy();
      expect(toast.textContent).toBe('Test message');
    });

    it('should add correct class for error type', () => {
      showToast('Error message', 'error');
      const toast = document.querySelector('.toast.error');
      expect(toast).toBeTruthy();
    });

    it('should add correct class for success type', () => {
      showToast('Success message', 'success');
      const toast = document.querySelector('.toast.success');
      expect(toast).toBeTruthy();
    });

    it('should append to toast container', () => {
      showToast('Message 1');
      showToast('Message 2');
      const container = document.getElementById('toast-container');
      expect(container.children.length).toBe(2);
    });

    it('should return the toast element', () => {
      const toast = showToast('Test');
      expect(toast).toBeTruthy();
      expect(toast.classList.contains('toast')).toBe(true);
    });
  });

  describe('showLoading', () => {
    it('should show loading indicator', () => {
      showLoading();
      const indicator = document.getElementById('loading-indicator');
      expect(indicator.classList.contains('visible')).toBe(true);
    });

    it('should set custom loading message', () => {
      showLoading('Processing...');
      const indicator = document.getElementById('loading-indicator');
      const span = indicator.querySelector('span');
      expect(span.textContent).toBe('Processing...');
    });
  });

  describe('hideLoading', () => {
    it('should hide loading indicator when count reaches 0', () => {
      showLoading();
      hideLoading();
      const indicator = document.getElementById('loading-indicator');
      expect(indicator.classList.contains('visible')).toBe(false);
    });

    it('should track multiple loading calls', () => {
      showLoading();
      showLoading();
      hideLoading();
      const indicator = document.getElementById('loading-indicator');
      // Should still be visible because one loading is still active
      expect(indicator.classList.contains('visible')).toBe(true);
      hideLoading();
      expect(indicator.classList.contains('visible')).toBe(false);
    });
  });

  describe('withLoading', () => {
    it('should show and hide loading around async operation', async () => {
      const indicator = document.getElementById('loading-indicator');

      const promise = withLoading(
        new Promise(resolve => setTimeout(() => resolve('result'), 10)),
        'Test loading'
      );

      // Should be visible during operation
      expect(indicator.classList.contains('visible')).toBe(true);

      const result = await promise;
      expect(result).toBe('result');

      // Should be hidden after completion
      expect(indicator.classList.contains('visible')).toBe(false);
    });

    it('should hide loading even if promise rejects', async () => {
      const indicator = document.getElementById('loading-indicator');

      const promise = withLoading(Promise.reject(new Error('Test error')), 'Test loading');

      await expect(promise).rejects.toThrow('Test error');
      expect(indicator.classList.contains('visible')).toBe(false);
    });
  });

  describe('showError', () => {
    it('should show error toast', () => {
      showError('Loading file', new Error('File not found'));
      const toast = document.querySelector('.toast.error');
      expect(toast).toBeTruthy();
      expect(toast.textContent).toContain('Loading file');
    });

    it('should simplify file not found errors', () => {
      showError('Opening', new Error('No such file or directory'));
      const toast = document.querySelector('.toast.error');
      expect(toast.textContent).toContain('File not found');
    });

    it('should simplify permission errors', () => {
      showError('Reading', new Error('Permission denied'));
      const toast = document.querySelector('.toast.error');
      expect(toast.textContent).toContain('Permission denied');
    });

    it('should handle string errors', () => {
      showError('Operation', 'Something went wrong');
      const toast = document.querySelector('.toast.error');
      expect(toast.textContent).toContain('Something went wrong');
    });
  });
});
