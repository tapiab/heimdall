/**
 * UI notification utilities for toast messages and loading indicators
 */

type ToastType = 'info' | 'error' | 'success';

let loadingCount = 0;

/**
 * Reset loading count (for testing purposes)
 */
export function resetLoadingCount(): void {
  loadingCount = 0;
}

/**
 * Show a toast notification
 * @param message - Message to display
 * @param type - Type of notification
 * @param duration - Duration in ms (default 4000, 0 for persistent)
 */
export function showToast(
  message: string,
  type: ToastType = 'info',
  duration: number = 4000
): HTMLDivElement | undefined {
  const container = document.getElementById('toast-container');
  if (!container) return undefined;

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
 * @param context - What was being attempted
 * @param error - The error that occurred
 */
export function showError(context: string, error: Error | string): void {
  const message = error instanceof Error ? error.message : String(error);
  // Simplify technical error messages for users
  const userMessage = simplifyErrorMessage(message);
  showToast(`${context}: ${userMessage}`, 'error', 6000);
}

/**
 * Simplify technical error messages for end users
 */
function simplifyErrorMessage(message: string): string {
  // Keep STAC-specific errors as-is (they're already informative)
  if (message.includes('STAC')) {
    // Truncate if too long but preserve the prefix
    if (message.length > 150) {
      return `${message.substring(0, 147)}...`;
    }
    return message;
  }
  // File not found
  if (message.includes('No such file') || message.includes('not found')) {
    return 'File not found';
  }
  // Permission denied
  if (message.includes('Permission denied') || message.includes('access denied')) {
    return 'Permission denied - check file permissions';
  }
  // Invalid format - only for local file operations, not API responses
  if (
    (message.includes('not a valid') ||
      message.includes('unsupported') ||
      message.includes('invalid')) &&
    !message.includes('parsing') &&
    !message.includes('response') &&
    !message.includes('HTTP')
  ) {
    return 'Unsupported file format';
  }
  // GDAL errors - but keep detailed remote file/COG errors
  if (
    (message.includes('GDAL') || message.includes('gdal')) &&
    !message.includes('remote') &&
    !message.includes('COG') &&
    !message.includes('vsicurl') &&
    !message.includes('Failed to open')
  ) {
    return 'Unable to read geospatial file';
  }
  // Network errors
  if (message.includes('fetch') || message.includes('network') || message.includes('timeout')) {
    return 'Network error - check your connection';
  }
  // Keep short messages as-is
  if (message.length < 100) {
    return message;
  }
  // Truncate long messages
  return `${message.substring(0, 97)}...`;
}

/**
 * Show loading indicator
 * @param message - Optional loading message
 */
export function showLoading(message: string = 'Loading...'): void {
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
export function hideLoading(): void {
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
 * @param promise - The async operation
 * @param loadingMessage - Message to show while loading
 * @returns The result of the operation
 */
export async function withLoading<T>(
  promise: Promise<T>,
  loadingMessage: string = 'Loading...'
): Promise<T> {
  showLoading(loadingMessage);
  try {
    return await promise;
  } finally {
    hideLoading();
  }
}

export type { ToastType };
