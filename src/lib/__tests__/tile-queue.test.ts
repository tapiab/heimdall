/**
 * Tests for the tile request scheduler
 */

import { describe, it, expect } from 'vitest';
import { scheduleTile, queuedTileCount, MAX_IN_FLIGHT_TILES } from '../layer-manager/tile-queue';

/** A request whose completion the test controls. */
function deferred() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let pending promise callbacks (slot release, queue pump) run. */
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('scheduleTile', () => {
  it('caps requests in flight and serves the newest queued first', async () => {
    const started: number[] = [];
    const gates = Array.from({ length: MAX_IN_FLIGHT_TILES + 2 }, () => deferred());
    const results = gates.map((gate, i) =>
      scheduleTile(new AbortController().signal, () => {
        started.push(i);
        return gate.promise;
      })
    );

    expect(started).toHaveLength(MAX_IN_FLIGHT_TILES);
    expect(queuedTileCount()).toBe(2);

    gates[0].resolve('done');
    await results[0];
    await flush();
    // Newest (last scheduled) goes next.
    expect(started.at(-1)).toBe(MAX_IN_FLIGHT_TILES + 1);

    gates.forEach(g => g.resolve('done'));
    await Promise.all(results);
    await flush();
    expect(queuedTileCount()).toBe(0);
  });

  it('drops requests aborted while queued without calling the backend', async () => {
    const gates = Array.from({ length: MAX_IN_FLIGHT_TILES }, () => deferred());
    const busy = gates.map(gate => scheduleTile(new AbortController().signal, () => gate.promise));

    const controller = new AbortController();
    let called = false;
    const stale = scheduleTile(controller.signal, async () => {
      called = true;
      return 'stale';
    });
    controller.abort();

    await expect(stale).rejects.toMatchObject({ name: 'AbortError' });
    expect(queuedTileCount()).toBe(0);

    gates.forEach(g => g.resolve('done'));
    await Promise.all(busy);
    await flush();
    expect(called).toBe(false);
  });

  it('rejects immediately when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(scheduleTile(controller.signal, async () => 'x')).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('frees the slot when a request fails', async () => {
    await expect(
      scheduleTile(new AbortController().signal, async () => {
        throw new Error('backend error');
      })
    ).rejects.toThrow('backend error');
    await expect(scheduleTile(new AbortController().signal, async () => 'ok')).resolves.toBe('ok');
  });
});
