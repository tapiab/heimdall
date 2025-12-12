/**
 * UI notification utilities for toast messages and loading indicators
 */

let loadingCount = 0;

/**
 * Reset loading count (for testing purposes)
 */
export function resetLoadingCount() {
  loadingCount = 0;
}

/**
 * Show a toast notification
 * @param {string} message - Message to display
 * @param {'info' | 'error' | 'success'} type - Type of notification
 * @param {number} duration - Duration in ms (default 4000, 0 for persistent)
 */
export function showToast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;

  container.appendChild(toast);

  if (duration > 0) {
    setTimeout(() => {
      toast.style.animation = 'fadeOut 0.3s ease forwards';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  return toast;
}

/**
 * Show an error toast with the error message
 * @param {string} context - What was being attempted
 * @param {Error|string} error - The error that occurred
 */
export function showError(context, error) {
  const message = error instanceof Error ? error.message : String(error);
  // Simplify technical error messages for users
  const userMessage = simplifyErrorMessage(message);
  showToast(`${context}: ${userMessage}`, 'error', 6000);
}

/**
 * Simplify technical error messages for end users
 */
function simplifyErrorMessage(message) {
  // File not found
  if (message.includes('No such file') || message.includes('not found')) {
    return 'File not found';
  }
  // Permission denied
  if (message.includes('Permission denied') || message.includes('access denied')) {
    return 'Permission denied - check file permissions';
  }
  // Invalid format
  if (message.includes('not a valid') || message.includes('unsupported') || message.includes('invalid')) {
    return 'Unsupported file format';
  }
  // GDAL errors
  if (message.includes('GDAL') || message.includes('gdal')) {
    return 'Unable to read geospatial file';
  }
  // Network errors
  if (message.includes('fetch') || message.includes('network') || message.includes('timeout')) {
    return 'Network error - check your connection';
  }
  // Keep short messages as-is
  if (message.length < 60) {
    return message;
  }
  // Truncate long messages
  return message.substring(0, 57) + '...';
}

/**
 * Show loading indicator
 * @param {string} message - Optional loading message
 */
export function showLoading(message = 'Loading...') {
  loadingCount++;
  const indicator = document.getElementById('loading-indicator');
  if (indicator) {
    const textEl = indicator.querySelector('span');
    if (textEl) textEl.textContent = message;
    indicator.classList.add('visible');
  }
}

/**
 * Hide loading indicator (only hides when all loading operations complete)
 */
export function hideLoading() {
  loadingCount = Math.max(0, loadingCount - 1);
  if (loadingCount === 0) {
    const indicator = document.getElementById('loading-indicator');
    if (indicator) {
      indicator.classList.remove('visible');
    }
  }
}

/**
 * Execute an async operation with loading indicator
 * @param {Promise} promise - The async operation
 * @param {string} loadingMessage - Message to show while loading
 * @returns {Promise} - The result of the operation
 */
export async function withLoading(promise, loadingMessage = 'Loading...') {
  showLoading(loadingMessage);
  try {
    return await promise;
  } finally {
    hideLoading();
  }
}
