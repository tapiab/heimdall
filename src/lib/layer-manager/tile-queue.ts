/**
 * Tile request scheduler shared by all raster tile protocols.
 *
 * MapLibre fires every tile of a view at once and aborts the ones it no longer
 * needs when the view changes, but a Tauri `invoke` can't be cancelled once
 * sent. Without a queue, zooming leaves the backend rendering dozens of tiles
 * for views already left (seconds each on large rasters) ahead of the visible
 * ones. Here, requests wait in a queue, aborted ones are dropped before they
 * reach the backend, and the newest are served first.
 * @module layer-manager/tile-queue
 */

/**
 * Tiles in flight at once. Matches the backend's per-layer pool of dataset
 * handles (dataset_cache.rs POOL_SIZE), beyond which requests only block there.
 */
export const MAX_IN_FLIGHT_TILES = 8;

interface QueuedTile {
  signal: AbortSignal;
  run: () => void;
  reject: (reason: unknown) => void;
}

const queue: QueuedTile[] = [];
let inFlight = 0;

function abortError(): Error {
  // MapLibre treats an AbortError rejection as a cancelled tile, not a failure.
  const error = new Error('Tile request aborted');
  error.name = 'AbortError';
  return error;
}

function pump(): void {
  // Newest first: the latest requests belong to the view on screen.
  let next: QueuedTile | undefined;
  while (inFlight < MAX_IN_FLIGHT_TILES && (next = queue.pop())) {
    if (next.signal.aborted) {
      next.reject(abortError());
      continue;
    }
    inFlight++;
    next.run();
  }
}

/**
 * Run `request` when a slot is free, unless `signal` aborts first.
 * @param signal - Abort signal from MapLibre's tile request
 * @param request - Starts the backend call
 * @returns The request's result; rejects with an AbortError if aborted while queued
 */
export function scheduleTile<T>(signal: AbortSignal, request: () => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());

  return new Promise<T>((resolve, reject) => {
    const entry: QueuedTile = {
      signal,
      reject,
      run: () => {
        request()
          .then(resolve, reject)
          .finally(() => {
            inFlight--;
            pump();
          });
      },
    };
    queue.push(entry);

    // Settle aborted entries right away instead of when they'd reach the front.
    signal.addEventListener(
      'abort',
      () => {
        const index = queue.indexOf(entry);
        if (index !== -1) {
          queue.splice(index, 1);
          reject(abortError());
        }
      },
      { once: true }
    );

    pump();
  });
}

/** Number of tiles waiting for a slot (for tests and diagnostics). */
export function queuedTileCount(): number {
  return queue.length;
}
