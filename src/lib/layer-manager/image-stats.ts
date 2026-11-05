/**
 * Image statistics panel: whole-band summary plus per-column and per-line
 * median and sigma charts, for spotting striping, dead or hot columns, and
 * line noise.
 * @module layer-manager/image-stats
 */

import { invoke } from '@tauri-apps/api/core';
import { logger } from '../logger';
import type { LayerManagerInterface, RasterLayer } from './types';

const log = logger.child('LayerManager:ImageStats');

/** One statistic per column or line; null where every sample is nodata */
export interface AxisSeries {
  median: Array<number | null>;
  mean: Array<number | null>;
  sigma: Array<number | null>;
}

/** Result of `get_image_statistics` */
export interface ImageStatistics {
  band: number;
  width: number;
  height: number;
  count: number;
  nodata_count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  median: number | null;
  sigma: number | null;
  snr: number | null;
  columns: AxisSeries;
  lines: AxisSeries;
  median_lines: number;
}

/** Index whose value strays from the series median */
export interface Outlier {
  index: number;
  value: number;
  deviation: number;
}

/** Min and max of each bucket when `values` is squeezed into `buckets` pixels */
export function bucketRange(
  values: Array<number | null>,
  buckets: number
): Array<{ min: number; max: number } | null> {
  const out: Array<{ min: number; max: number } | null> = [];
  const n = values.length;
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor((b * n) / buckets);
    const end = Math.max(start + 1, Math.floor(((b + 1) * n) / buckets));
    let min = Infinity;
    let max = -Infinity;
    for (let i = start; i < end && i < n; i++) {
      const v = values[i];
      if (v == null) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    out.push(min <= max ? { min, max } : null);
  }
  return out;
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Entries farther than `threshold` robust sigmas (1.4826 × MAD) from the
 * series median, largest deviation first, at most `limit`.
 */
export function findOutliers(values: Array<number | null>, limit = 5, threshold = 6): Outlier[] {
  const finite = values.filter((v): v is number => v != null).sort((a, b) => a - b);
  if (finite.length < 3) return [];
  const center = median(finite);
  const mad = median(finite.map(v => Math.abs(v - center)).sort((a, b) => a - b));
  const scale = 1.4826 * mad;
  const outliers: Outlier[] = [];
  values.forEach((value, index) => {
    if (value == null) return;
    const deviation = value - center;
    const strays = scale > 0 ? Math.abs(deviation) > threshold * scale : deviation !== 0;
    if (strays) outliers.push({ index, value, deviation });
  });
  return outliers.sort((a, b) => Math.abs(b.deviation) - Math.abs(a.deviation)).slice(0, limit);
}

const results = new Map<string, Promise<ImageStatistics>>();

function fetchStatistics(datasetId: string, band: number): Promise<ImageStatistics> {
  const key = `${datasetId}|${band}`;
  let pending = results.get(key);
  if (!pending) {
    pending = invoke<ImageStatistics>('get_image_statistics', { id: datasetId, band });
    pending.catch(() => results.delete(key));
    results.set(key, pending);
  }
  return pending;
}

/** Forget cached statistics of a dataset */
export function invalidateImageStatistics(datasetId: string): void {
  for (const key of [...results.keys()]) {
    if (key.startsWith(`${datasetId}|`)) results.delete(key);
  }
}

function formatValue(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (Number.isInteger(value)) return value.toLocaleString();
  return value.toFixed(Math.abs(value) >= 1000 ? 0 : digits);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

function renderSummary(stats: ImageStatistics): string {
  const rows: Array<[string, string]> = [
    ['Size', `${stats.width.toLocaleString()} × ${stats.height.toLocaleString()}`],
    ['Valid px', stats.count.toLocaleString()],
    ['Nodata px', stats.nodata_count.toLocaleString()],
    ['Min', formatValue(stats.min)],
    ['Max', formatValue(stats.max)],
    ['Mean', formatValue(stats.mean)],
    ['Median', formatValue(stats.median)],
    ['Sigma', formatValue(stats.sigma)],
    ['SNR (μ/σ)', formatValue(stats.snr)],
  ];
  return rows
    .map(
      ([label, value]) =>
        `<div class="image-stats-cell"><span>${label}</span><strong>${value}</strong></div>`
    )
    .join('');
}

function renderOutliers(label: string, outliers: Outlier[]): string {
  if (!outliers.length) return '';
  const items = outliers
    .map(o => `${o.index} (${o.deviation > 0 ? '+' : ''}${formatValue(o.deviation, 1)})`)
    .join(', ');
  return `<div class="image-stats-outliers"><span>${escapeHtml(label)}</span> ${items}</div>`;
}

interface ChartSpec {
  title: string;
  axis: 'Column' | 'Line';
  values: Array<number | null>;
}

/** Draw a series as one min–max bar per canvas pixel, so single spikes stay visible. */
function drawChart(canvas: HTMLCanvasElement, values: Array<number | null>): void {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);

  const buckets = bucketRange(values, Math.min(width, values.length));
  const finite = buckets.filter((b): b is { min: number; max: number } => b != null);
  if (!finite.length) return;
  let lo = Math.min(...finite.map(b => b.min));
  let hi = Math.max(...finite.map(b => b.max));
  if (hi === lo) {
    lo -= 1;
    hi += 1;
  }
  const pad = (hi - lo) * 0.05;
  lo -= pad;
  hi += pad;
  const y = (v: number) => height - ((v - lo) / (hi - lo)) * height;
  const step = width / buckets.length;

  ctx.strokeStyle = getComputedStyle(canvas).color || '#4a9eff';
  ctx.lineWidth = Math.max(1, dpr);
  ctx.beginPath();
  buckets.forEach((b, i) => {
    if (!b) return;
    const x = (i + 0.5) * step;
    ctx.moveTo(x, y(b.max));
    ctx.lineTo(x, Math.max(y(b.min), y(b.max) + ctx.lineWidth));
  });
  ctx.stroke();
}

function attachChart(container: HTMLElement, spec: ChartSpec): void {
  const block = document.createElement('div');
  block.className = 'image-stats-chart';
  block.innerHTML = `
    <div class="image-stats-chart-header">
      <span>${escapeHtml(spec.title)}</span>
      <span class="image-stats-readout"></span>
    </div>
    <canvas></canvas>`;
  container.appendChild(block);
  const canvas = block.querySelector('canvas') as HTMLCanvasElement;
  const readout = block.querySelector('.image-stats-readout') as HTMLElement;
  drawChart(canvas, spec.values);

  canvas.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    const n = spec.values.length;
    const buckets = Math.min(Math.round(rect.width), n) || 1;
    const bucket = Math.min(
      buckets - 1,
      Math.floor(((e.clientX - rect.left) / rect.width) * buckets)
    );
    const start = Math.floor((bucket * n) / buckets);
    const end = Math.max(start + 1, Math.floor(((bucket + 1) * n) / buckets));
    const [range] = bucketRange(spec.values.slice(start, end), 1);
    const where = end - start > 1 ? `${spec.axis}s ${start}–${end - 1}` : `${spec.axis} ${start}`;
    const value = !range
      ? '—'
      : range.min === range.max
        ? formatValue(range.min)
        : `${formatValue(range.min)} – ${formatValue(range.max)}`;
    readout.textContent = `${where}: ${value}`;
  });
  canvas.addEventListener('mouseleave', () => {
    readout.textContent = '';
  });
}

/**
 * Open the statistics panel for a raster band. The first request reads the
 * whole band at full resolution (about a second per 100 Mpx); results are
 * cached per dataset band.
 */
export async function showImageStatistics(
  manager: LayerManagerInterface,
  layerId: string,
  band: number
): Promise<void> {
  const layer = manager.layers.get(layerId) as RasterLayer | undefined;
  if (!layer || layer.type !== 'raster') return;

  const panel = document.getElementById('image-stats-panel');
  const title = document.getElementById('image-stats-title');
  const bandSelect = document.getElementById('image-stats-band') as HTMLSelectElement | null;
  const summary = document.getElementById('image-stats-summary');
  const charts = document.getElementById('image-stats-charts');
  const note = document.getElementById('image-stats-note');
  const closeBtn = document.getElementById('image-stats-close');
  if (!panel || !summary || !charts || !note) return;

  const datasetId = layer.sourceLayerId ?? layer.id;
  // A composition reads its source dataset, which may have more bands
  const source = manager.layers.get(datasetId) as RasterLayer | undefined;
  const bandCount = source?.type === 'raster' ? source.bands : layer.bands;
  const name = layer.path.split('/').pop()?.split('\\').pop() || 'Unknown';
  if (title) title.textContent = `Image Statistics - ${name}`;
  if (bandSelect) {
    bandSelect.innerHTML = Array.from(
      { length: bandCount },
      (_, i) =>
        `<option value="${i + 1}" ${band === i + 1 ? 'selected' : ''}>Band ${i + 1}</option>`
    ).join('');
    bandSelect.onchange = () => {
      void showImageStatistics(manager, layerId, parseInt(bandSelect.value, 10));
    };
  }
  if (closeBtn) closeBtn.onclick = () => panel.classList.remove('visible');

  panel.classList.add('visible');
  panel.dataset.request = `${datasetId}|${band}`;
  summary.innerHTML = '';
  charts.innerHTML = '';
  note.textContent = 'Reading the full band…';

  let stats: ImageStatistics;
  try {
    stats = await fetchStatistics(datasetId, band);
  } catch (error) {
    log.error('Image statistics failed', { error: String(error) });
    if (panel.dataset.request === `${datasetId}|${band}`) {
      note.textContent = `Failed: ${String(error)}`;
    }
    return;
  }
  // A newer request (other band or layer) owns the panel now
  if (panel.dataset.request !== `${datasetId}|${band}`) return;

  summary.innerHTML = renderSummary(stats);
  const sampled =
    stats.median_lines < stats.height
      ? `Medians use ${stats.median_lines.toLocaleString()} of ${stats.height.toLocaleString()} lines; means and sigmas use all. `
      : '';
  note.innerHTML =
    escapeHtml(sampled) +
    renderOutliers('Outlier columns:', findOutliers(stats.columns.median)) +
    renderOutliers('Outlier lines:', findOutliers(stats.lines.median));

  const specs: ChartSpec[] = [
    { title: 'Column median', axis: 'Column', values: stats.columns.median },
    { title: 'Column sigma', axis: 'Column', values: stats.columns.sigma },
    { title: 'Line median', axis: 'Line', values: stats.lines.median },
    { title: 'Line sigma', axis: 'Line', values: stats.lines.sigma },
  ];
  for (const spec of specs) attachChart(charts, spec);
}
