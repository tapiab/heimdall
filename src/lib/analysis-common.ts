/**
 * Helpers shared by the analysis tools (value profile, region statistics,
 * pixel inspector): picking the raster to analyse, converting map positions
 * to backend coordinates, band colors, a multi-series line chart and CSV.
 * @module analysis-common
 */

import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { showToast, showError } from './notifications';

/** Pixel extent of the synthetic coordinate system of non-georeferenced images */
export interface PixelExtentLike {
  scale?: number;
  offsetX?: number;
  offsetY?: number;
}

/** The parts of MapManager the analysis tools use */
export interface AnalysisMapManager {
  map: MapLibreMap;
  isPixelCoordMode: () => boolean;
  pixelExtent: PixelExtentLike | null;
}

/** The parts of a raster layer the analysis tools use */
export interface AnalysisRasterLayer {
  id: string;
  type: 'raster';
  visible: boolean;
  path: string;
  displayName?: string;
  bounds?: [number, number, number, number] | null;
  bands?: number;
  band?: number;
  displayMode?: string;
  rgbBands?: { r: number; g: number; b: number };
  sourceLayerId?: string;
  isCrossLayerComposition?: boolean;
}

/** The parts of LayerManager the analysis tools use */
export interface AnalysisLayerManager {
  layerOrder: string[];
  layers: Map<string, { type: string } | AnalysisRasterLayer>;
}

/** Raster an analysis runs on */
export interface AnalysisTarget {
  layer: AnalysisRasterLayer;
  /** Dataset holding the samples (a composition's source) */
  datasetId: string;
  /** Bands of that dataset */
  bandCount: number;
  name: string;
}

function isRaster(layer: { type: string } | undefined): layer is AnalysisRasterLayer {
  return layer?.type === 'raster';
}

function inBounds(layer: AnalysisRasterLayer, lng: number, lat: number): boolean {
  const b = layer.bounds;
  if (!b || b.length !== 4) return true;
  return lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3];
}

/** Display name of a layer: its custom name, else the file name */
export function layerName(layer: AnalysisRasterLayer): string {
  return layer.displayName || layer.path.split('/').pop()?.split('\\').pop() || 'Unknown';
}

/**
 * Topmost visible raster backed by a single dataset, optionally containing a
 * point. Cross-layer compositions mix datasets and are skipped.
 */
export function findAnalysisTarget(
  layerManager: AnalysisLayerManager,
  at?: { lng: number; lat: number }
): AnalysisTarget | null {
  for (const id of [...layerManager.layerOrder].reverse()) {
    const layer = layerManager.layers.get(id);
    if (!isRaster(layer) || !layer.visible || layer.isCrossLayerComposition) continue;
    if (at && !inBounds(layer, at.lng, at.lat)) continue;
    const datasetId = layer.sourceLayerId ?? layer.id;
    const source = layerManager.layers.get(datasetId);
    const bandCount = (isRaster(source) ? source.bands : layer.bands) ?? 1;
    return { layer, datasetId, bandCount, name: layerName(layer) };
  }
  return null;
}

/**
 * Coordinates for the backend: lon/lat as given, or fractional pixel/line
 * positions when the map shows non-georeferenced images.
 */
export function toBackendCoords(
  mapManager: AnalysisMapManager,
  points: Array<[number, number]>
): { coords: Array<[number, number]>; pixel: boolean } {
  const extent = mapManager.pixelExtent;
  if (!mapManager.isPixelCoordMode() || !extent) {
    return { coords: points, pixel: false };
  }
  const scale = extent.scale || 0.01;
  const offsetX = extent.offsetX || 0;
  const offsetY = extent.offsetY || 0;
  return {
    coords: points.map(([lng, lat]) => [(lng + offsetX) / scale, (offsetY - lat) / scale]),
    pixel: true,
  };
}

const BAND_PALETTE = [
  '#58a6ff',
  '#f0883e',
  '#3fb950',
  '#d2a8ff',
  '#ff7b72',
  '#e3b341',
  '#39c5cf',
  '#f778ba',
  '#a5d6ff',
  '#7ee787',
];

/**
 * Color of a band in charts: red/green/blue for the bands an RGB layer
 * displays, a categorical palette otherwise.
 */
export function bandColor(layer: AnalysisRasterLayer, band: number): string {
  if (layer.displayMode === 'rgb' && layer.rgbBands) {
    if (band === layer.rgbBands.r) return '#ff5c5c';
    if (band === layer.rgbBands.g) return '#4cd964';
    if (band === layer.rgbBands.b) return '#5c8dff';
  }
  return BAND_PALETTE[(band - 1) % BAND_PALETTE.length];
}

/** Bands shown by default: the ones the layer displays */
export function displayedBands(layer: AnalysisRasterLayer, bandCount: number): number[] {
  const valid = (b: number) => b >= 1 && b <= bandCount;
  if (layer.displayMode === 'rgb' && layer.rgbBands) {
    const { r, g, b } = layer.rgbBands;
    const bands = [...new Set([r, g, b])].filter(valid);
    if (bands.length) return bands;
  }
  const band = layer.band ?? 1;
  return valid(band) ? [band] : [1];
}

/** Compact number formatting for readouts and tables */
export function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (Number.isInteger(value)) return value.toLocaleString('en-US');
  const abs = Math.abs(value);
  if (abs >= 1e6 || abs < 1e-3) return value.toExponential(3);
  return value.toFixed(abs >= 1000 ? 1 : digits);
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

// ==================== CSV ====================

function csvCell(value: string | number | null | undefined): string {
  if (value == null || (typeof value === 'number' && !Number.isFinite(value))) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** CSV text from a header and rows; null and non-finite numbers are empty cells */
export function toCsv(header: string[], rows: Array<Array<string | number | null>>): string {
  return [header, ...rows].map(row => row.map(csvCell).join(',')).join('\n') + '\n';
}

/** Ask for a file name and write CSV text to it */
export async function saveCsv(defaultName: string, csv: string): Promise<void> {
  try {
    const filePath = await save({
      defaultPath: defaultName,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (!filePath) return;
    await writeTextFile(filePath, csv);
    showToast('CSV saved', 'success', 2000);
  } catch (error) {
    showError('Could not save CSV', error instanceof Error ? error : String(error));
  }
}

/** Copy text to the clipboard with a toast */
export async function copyText(text: string, what = 'Values'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`${what} copied`, 'success', 1500);
  } catch (error) {
    showError('Copy failed', error instanceof Error ? error : String(error));
  }
}

/** File name stem without extension, safe for a default save name */
export function fileStem(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'export';
}

// ==================== Line chart ====================

export interface ChartSeries {
  color: string;
  values: Array<number | null>;
}

export interface ChartLayout {
  /** Plot area in CSS pixels, relative to the canvas */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Data index under a CSS x position, or null outside the plot */
  indexAt: (cssX: number) => number | null;
  /** CSS x of a data index */
  xOf: (index: number) => number;
}

export interface ChartOptions {
  /** X value of each index (distance, band number); defaults to the index */
  x?: number[];
  /** Axis label for the x range ends */
  formatX?: (x: number) => string;
  formatY?: (y: number) => string;
  /** Draw a vertical marker at this index */
  cursor?: number | null;
  /** Mark each sample with a dot (few samples) */
  dots?: boolean;
}

/** Finite min and max over every series, padded 5 %; null when empty */
export function seriesRange(series: ChartSeries[]): { lo: number; hi: number } | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series) {
    for (const v of s.values) {
      if (v == null || !Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (lo > hi) return null;
  if (lo === hi) return { lo: lo - 1, hi: hi + 1 };
  const pad = (hi - lo) * 0.05;
  return { lo: lo - pad, hi: hi + pad };
}

/**
 * Draw series as lines (gaps at nulls) sized to the canvas' CSS box, with a
 * y axis and x range labels. Returns the layout for hover handling.
 */
export function drawLineChart(
  canvas: HTMLCanvasElement,
  series: ChartSeries[],
  options: ChartOptions = {}
): ChartLayout {
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = Math.max(1, canvas.clientWidth);
  const cssHeight = Math.max(1, canvas.clientHeight);
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  const n = Math.max(0, ...series.map(s => s.values.length));
  const pad = { left: 56, right: 12, top: 10, bottom: 22 };
  const plotW = Math.max(1, cssWidth - pad.left - pad.right);
  const plotH = Math.max(1, cssHeight - pad.top - pad.bottom);
  const xOf = (i: number) => pad.left + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  const layout: ChartLayout = {
    left: pad.left,
    top: pad.top,
    width: plotW,
    height: plotH,
    xOf,
    indexAt: cssX => {
      if (n === 0 || cssX < pad.left - 4 || cssX > pad.left + plotW + 4) return null;
      const i = n > 1 ? Math.round(((cssX - pad.left) / plotW) * (n - 1)) : 0;
      return Math.min(n - 1, Math.max(0, i));
    },
  };

  const ctx = canvas.getContext('2d');
  if (!ctx) return layout;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const style = getComputedStyle(canvas);
  const muted = style.getPropertyValue('--text-tertiary').trim() || '#8b949e';
  const grid = style.getPropertyValue('--border-subtle').trim() || '#30363d';
  ctx.font = '10px ui-monospace, monospace';

  const range = seriesRange(series);
  if (!range) {
    ctx.fillStyle = muted;
    ctx.textAlign = 'center';
    ctx.fillText('No valid data', cssWidth / 2, cssHeight / 2);
    return layout;
  }
  const yOf = (v: number) => pad.top + plotH - ((v - range.lo) / (range.hi - range.lo)) * plotH;
  const formatY = options.formatY ?? (v => formatNumber(v));

  // Grid and y labels
  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  ctx.fillStyle = muted;
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = range.lo + ((range.hi - range.lo) * i) / 4;
    const y = Math.round(yOf(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();
    ctx.fillText(formatY(v), pad.left - 4, y + 3);
  }

  // X range labels
  if (n > 0) {
    const x = options.x;
    const formatX = options.formatX ?? (v => formatNumber(v));
    ctx.textAlign = 'left';
    ctx.fillText(formatX(x ? x[0] : 0), pad.left, cssHeight - 6);
    ctx.textAlign = 'right';
    ctx.fillText(formatX(x ? x[n - 1] : n - 1), pad.left + plotW, cssHeight - 6);
  }

  // Series
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.beginPath();
    let drawing = false;
    s.values.forEach((v, i) => {
      if (v == null || !Number.isFinite(v)) {
        drawing = false;
        return;
      }
      if (drawing) ctx.lineTo(xOf(i), yOf(v));
      else ctx.moveTo(xOf(i), yOf(v));
      drawing = true;
    });
    ctx.stroke();
    if (options.dots) {
      ctx.fillStyle = s.color;
      s.values.forEach((v, i) => {
        if (v == null || !Number.isFinite(v)) return;
        ctx.beginPath();
        ctx.arc(xOf(i), yOf(v), 2.5, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  }

  if (options.cursor != null && options.cursor < n) {
    const x = Math.round(xOf(options.cursor)) + 0.5;
    ctx.strokeStyle = muted;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, pad.top + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  return layout;
}
