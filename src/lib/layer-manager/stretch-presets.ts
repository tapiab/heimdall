/**
 * Contrast stretch presets, band histograms, and histogram equalization.
 * @module layer-manager/stretch-presets
 */

import { invoke } from '@tauri-apps/api/core';
import type { BandStats, HistogramData, StretchPreset, StretchSettings } from './types';

/** Bins requested for presets and equalization */
const HISTOGRAM_BINS = 1024;

export const STRETCH_PRESET_LABELS: Record<StretchPreset, string> = {
  p2: '2–98 %',
  p1: '1–99 %',
  minmax: 'Min / Max',
  bits: 'Full bit range',
  custom: 'Custom',
};

/** Preset for new layers: robust to hot pixels, saturation and padding */
export const DEFAULT_STRETCH_PRESET: StretchPreset = 'p2';

const histograms = new Map<string, Promise<HistogramData>>();
const loaded = new Map<string, HistogramData>();

function histogramKey(datasetId: string, band: number): string {
  return `${datasetId}|${band}`;
}

/** Band histogram with percentiles, fetched once per dataset band. */
export function getBandHistogram(datasetId: string, band: number): Promise<HistogramData> {
  const key = histogramKey(datasetId, band);
  let pending = histograms.get(key);
  if (!pending) {
    pending = invoke<HistogramData>('get_histogram', {
      id: datasetId,
      band,
      numBins: HISTOGRAM_BINS,
    }).then(
      histogram => {
        loaded.set(key, histogram);
        return histogram;
      },
      error => {
        histograms.delete(key);
        throw error;
      }
    );
    histograms.set(key, pending);
  }
  return pending;
}

/** Histogram if already fetched, without waiting. */
export function peekBandHistogram(datasetId: string, band: number): HistogramData | undefined {
  return loaded.get(histogramKey(datasetId, band));
}

/** Forget a dataset's histograms (closed, or its pixels changed). */
export function invalidateBandHistograms(datasetId: string): void {
  const prefix = `${datasetId}|`;
  for (const key of [...histograms.keys()]) {
    if (key.startsWith(prefix)) {
      histograms.delete(key);
      loaded.delete(key);
    }
  }
}

/** Range representable with `bits` unsigned bits, or null when unknown. */
export function bitRange(stats: BandStats | undefined): { min: number; max: number } | null {
  const bits = stats?.significant_bits;
  if (!bits || bits > 32) return null;
  return { min: 0, max: 2 ** bits - 1 };
}

/**
 * Stretch limits for a preset, or null when it can't apply (no percentiles,
 * unknown bit depth, or 'custom').
 */
export function presetLimits(
  preset: StretchPreset,
  stats: BandStats | undefined,
  histogram: HistogramData | undefined
): { min: number; max: number } | null {
  switch (preset) {
    case 'minmax':
      return stats ? { min: stats.min, max: stats.max } : null;
    case 'p1':
    case 'p2': {
      const p = histogram?.percentiles;
      if (!p) return null;
      const [min, max] = preset === 'p1' ? [p.p1, p.p99] : [p.p2, p.p98];
      // A near-constant band can put both percentiles on one value
      return max > min ? { min, max } : stats ? { min: stats.min, max: stats.max } : null;
    }
    case 'bits':
      return bitRange(stats);
    case 'custom':
      return null;
  }
}

/** Whether a preset needs the band histogram */
export function presetNeedsHistogram(preset: StretchPreset): boolean {
  return preset === 'p1' || preset === 'p2';
}

/**
 * Equalization table over the stretch window: entry `k` (the stretched value
 * 0..255) maps to 0..255 by the cumulative histogram of the samples inside
 * the window. Samples outside it are already clamped to 0 or 255.
 */
export function equalizationLut(
  histogram: HistogramData,
  stretch: StretchSettings
): Uint8Array<ArrayBuffer> {
  const lut = new Uint8Array(256);
  const range = stretch.max - stretch.min;
  const counts = new Float64Array(256);
  let total = 0;
  if (range > 0) {
    const { bin_edges: edges } = histogram;
    histogram.counts.forEach((count, i) => {
      if (!count) return;
      const center = (edges[i] + edges[i + 1]) / 2;
      const t = (center - stretch.min) / range;
      if (t < 0 || t > 1) return;
      counts[Math.min(255, Math.floor(t * 256))] += count;
      total += count;
    });
  }
  if (total === 0) {
    for (let k = 0; k < 256; k++) lut[k] = k;
    return lut;
  }
  let cumulative = 0;
  for (let k = 0; k < 256; k++) {
    cumulative += counts[k];
    lut[k] = Math.round((cumulative / total) * 255);
  }
  return lut;
}

/** Mean of the sampled band, from histogram bin centres; null when empty */
export function histogramMean(histogram: HistogramData): number | null {
  let sum = 0;
  let count = 0;
  histogram.counts.forEach((c, i) => {
    const lo = histogram.bin_edges[i];
    const hi = histogram.bin_edges[i + 1] ?? lo;
    sum += c * ((lo + hi) / 2);
    count += c;
  });
  return count > 0 ? sum / count : null;
}

/**
 * Grey-world white balance: keep each channel's black point and move its
 * white point so the channel means land on the same display level (the
 * average of their current levels, preserving overall brightness). Null when
 * a mean sits at or below its black point.
 */
export function greyWorldStretch(
  stretches: [StretchSettings, StretchSettings, StretchSettings],
  means: [number, number, number]
): [StretchSettings, StretchSettings, StretchSettings] | null {
  const levels = stretches.map((s, i) => (means[i] - s.min) / (s.max - s.min));
  if (levels.some(l => !Number.isFinite(l) || l <= 0)) return null;
  const target = levels.reduce((a, b) => a + b, 0) / 3;
  return stretches.map((s, i) => ({
    ...s,
    max: s.min + (means[i] - s.min) / target,
  })) as [StretchSettings, StretchSettings, StretchSettings];
}
