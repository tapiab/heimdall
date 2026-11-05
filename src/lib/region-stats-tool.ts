/**
 * Region statistics tool: drag a box over a raster to get per-band mean,
 * median, sigma, SNR, min/max and 2–98 % percentiles of the pixels inside
 * (flat-field SNR, calibration targets, comparing areas), or click a pixel
 * for its spectrum. Multi-band results include a mean ± sigma spectrum chart.
 * @module region-stats-tool
 */

import { invoke } from '@tauri-apps/api/core';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { Feature, Polygon } from 'geojson';
import {
  copyText,
  displayedBands,
  drawLineChart,
  escapeHtml,
  fileStem,
  findAnalysisTarget,
  formatNumber,
  saveCsv,
  toBackendCoords,
  toCsv,
  type AnalysisLayerManager,
  type AnalysisMapManager,
  type AnalysisTarget,
} from './analysis-common';
import { showError, showToast } from './notifications';

/** Statistics of one band (from `get_region_statistics`) */
export interface RegionBandStats {
  band: number;
  count: number;
  nodata_count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  median: number | null;
  sigma: number | null;
  p2: number | null;
  p98: number | null;
  snr: number | null;
}

/** Result of `get_region_statistics` */
export interface RegionStatistics {
  x: number;
  y: number;
  width: number;
  height: number;
  step: number;
  bands: RegionBandStats[];
}

const SOURCE_ID = 'region-stats-rect';
const COLUMNS: Array<[keyof RegionBandStats, string]> = [
  ['mean', 'Mean'],
  ['median', 'Median'],
  ['sigma', 'σ'],
  ['snr', 'SNR'],
  ['min', 'Min'],
  ['max', 'Max'],
  ['p2', 'P2'],
  ['p98', 'P98'],
  ['count', 'Valid'],
];

/** CSV of the region statistics, one row per band */
export function regionStatsCsv(stats: RegionStatistics): string {
  return toCsv(
    ['band', 'mean', 'median', 'sigma', 'snr', 'min', 'max', 'p2', 'p98', 'valid', 'nodata'],
    stats.bands.map(b => [
      b.band,
      b.mean,
      b.median,
      b.sigma,
      b.snr,
      b.min,
      b.max,
      b.p2,
      b.p98,
      b.count,
      b.nodata_count,
    ])
  );
}

export class RegionStatsTool {
  private mapManager: AnalysisMapManager;
  private layerManager: AnalysisLayerManager;
  private map: MapLibreMap;
  private active = false;
  private start: { x: number; y: number } | null = null;
  private box: HTMLDivElement | null = null;
  /** Bumped per request so a slow answer can't overwrite a newer region */
  private request = 0;

  constructor(mapManager: AnalysisMapManager, layerManager: AnalysisLayerManager) {
    this.mapManager = mapManager;
    this.layerManager = layerManager;
    this.map = mapManager.map;
    this.handleMouseDown = this.handleMouseDown.bind(this);
    this.handleMouseMove = this.handleMouseMove.bind(this);
    this.handleMouseUp = this.handleMouseUp.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
  }

  activate(): void {
    if (this.active) return;
    this.active = true;
    this.map.getCanvas().style.cursor = 'crosshair';
    this.map.dragPan.disable();
    this.map.getCanvas().addEventListener('mousedown', this.handleMouseDown);
    document.addEventListener('keydown', this.handleKeyDown);
    this.setInstruction(
      'Drag a box for band statistics, click a pixel for its spectrum (Esc to exit)'
    );
  }

  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.map.getCanvas().style.cursor = '';
    this.map.dragPan.enable();
    this.map.getCanvas().removeEventListener('mousedown', this.handleMouseDown);
    document.removeEventListener('mousemove', this.handleMouseMove);
    document.removeEventListener('mouseup', this.handleMouseUp);
    document.removeEventListener('keydown', this.handleKeyDown);
    this.removeBox();
    this.setInstruction(null);
    this.clearRegion();
    document.getElementById('region-stats-panel')?.remove();
    document.getElementById('region-stats-btn')?.classList.remove('active');
  }

  toggle(): boolean {
    if (this.active) this.deactivate();
    else this.activate();
    return this.active;
  }

  isActive(): boolean {
    return this.active;
  }

  private setInstruction(text: string | null): void {
    let el = document.getElementById('region-stats-instruction');
    if (!text) {
      if (el) el.style.display = 'none';
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.id = 'region-stats-instruction';
      el.className = 'tool-instruction';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.display = 'block';
  }

  private canvasPoint(e: MouseEvent): { x: number; y: number } {
    const rect = this.map.getCanvas().getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private handleMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    this.start = this.canvasPoint(e);
    this.removeBox();
    this.box = document.createElement('div');
    this.box.className = 'region-stats-box';
    this.map.getContainer().appendChild(this.box);
    document.addEventListener('mousemove', this.handleMouseMove);
    document.addEventListener('mouseup', this.handleMouseUp);
    e.preventDefault();
  }

  private handleMouseMove(e: MouseEvent): void {
    if (!this.start || !this.box) return;
    const p = this.canvasPoint(e);
    this.box.style.left = `${Math.min(this.start.x, p.x)}px`;
    this.box.style.top = `${Math.min(this.start.y, p.y)}px`;
    this.box.style.width = `${Math.abs(p.x - this.start.x)}px`;
    this.box.style.height = `${Math.abs(p.y - this.start.y)}px`;
  }

  private handleMouseUp(e: MouseEvent): void {
    document.removeEventListener('mousemove', this.handleMouseMove);
    document.removeEventListener('mouseup', this.handleMouseUp);
    this.removeBox();
    const start = this.start;
    this.start = null;
    if (!start) return;
    const end = this.canvasPoint(e);
    // A click (tiny drag) reads the single pixel under it
    const isClick = Math.abs(end.x - start.x) < 3 && Math.abs(end.y - start.y) < 3;
    const [x0, y0, x1, y1] = isClick
      ? [end.x, end.y, end.x, end.y]
      : [start.x, start.y, end.x, end.y];

    // Screen corners → map; the box may be rotated on the ground
    const corners = [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ].map(([x, y]) => {
      const ll = this.map.unproject([x, y]);
      return [ll.lng, ll.lat] as [number, number];
    });
    this.drawRegion(corners);
    void this.computeStatistics(corners);
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') this.deactivate();
  }

  private removeBox(): void {
    this.box?.remove();
    this.box = null;
  }

  private drawRegion(corners: Array<[number, number]>): void {
    if (corners.every(c => c[0] === corners[0][0] && c[1] === corners[0][1])) {
      this.clearRegion();
      return;
    }
    const feature: Feature<Polygon> = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [[...corners, corners[0]]] },
    };
    const source = this.map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    if (source) {
      source.setData(feature);
      return;
    }
    this.map.addSource(SOURCE_ID, { type: 'geojson', data: feature });
    this.map.addLayer({
      id: `${SOURCE_ID}-fill`,
      type: 'fill',
      source: SOURCE_ID,
      paint: { 'fill-color': '#f0883e', 'fill-opacity': 0.12 },
    });
    this.map.addLayer({
      id: `${SOURCE_ID}-line`,
      type: 'line',
      source: SOURCE_ID,
      paint: { 'line-color': '#f0883e', 'line-width': 2, 'line-dasharray': [2, 1] },
    });
  }

  private clearRegion(): void {
    for (const id of [`${SOURCE_ID}-line`, `${SOURCE_ID}-fill`]) {
      if (this.map.getLayer(id)) this.map.removeLayer(id);
    }
    if (this.map.getSource(SOURCE_ID)) this.map.removeSource(SOURCE_ID);
  }

  private async computeStatistics(corners: Array<[number, number]>): Promise<void> {
    const lngs = corners.map(c => c[0]);
    const lats = corners.map(c => c[1]);
    const center = {
      lng: (Math.min(...lngs) + Math.max(...lngs)) / 2,
      lat: (Math.min(...lats) + Math.max(...lats)) / 2,
    };
    const target =
      findAnalysisTarget(this.layerManager, center) ?? findAnalysisTarget(this.layerManager);
    if (!target) {
      showToast('No raster layer under the region', 'info', 2500);
      return;
    }
    const request = ++this.request;
    const { coords, pixel } = toBackendCoords(this.mapManager, corners);
    this.renderPanel(target, null);
    try {
      const stats = await invoke<RegionStatistics>('get_region_statistics', {
        id: target.datasetId,
        coords,
        pixel,
      });
      if (request === this.request && this.active) this.renderPanel(target, stats);
    } catch (error) {
      if (request !== this.request) return;
      document.getElementById('region-stats-panel')?.remove();
      showError('Region statistics failed', error instanceof Error ? error : String(error));
    }
  }

  private renderPanel(target: AnalysisTarget, stats: RegionStatistics | null): void {
    let panel = document.getElementById('region-stats-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'region-stats-panel';
      panel.className = 'floating-panel';
      document.body.appendChild(panel);
    }
    const highlighted = new Set(displayedBands(target.layer, target.bandCount));
    const info = stats
      ? (stats.width * stats.height === 1
          ? `Pixel (${stats.x}, ${stats.y})`
          : `${stats.width.toLocaleString()} × ${stats.height.toLocaleString()} px at (${stats.x}, ${stats.y})`) +
        (stats.step > 1 ? ` · sampled 1 px in ${stats.step}×${stats.step}` : '')
      : 'Reading pixels…';
    const rows = stats
      ? stats.bands
          .map(
            b =>
              `<tr class="${highlighted.has(b.band) ? 'highlighted' : ''}"><td>B${b.band}</td>${COLUMNS.map(
                ([key]) => `<td>${formatNumber(b[key] as number | null)}</td>`
              ).join('')}</tr>`
          )
          .join('')
      : '';
    panel.innerHTML = `
      <div class="floating-panel-header">
        <h4>Region Statistics — ${escapeHtml(target.name)}</h4>
        <div class="region-stats-actions">
          <button class="profile-chip-btn" data-action="copy" ${stats ? '' : 'disabled'}>Copy</button>
          <button class="profile-chip-btn" data-action="csv" ${stats ? '' : 'disabled'}>CSV</button>
          <button class="floating-panel-close" data-action="close">&times;</button>
        </div>
      </div>
      <div id="region-stats-content">
        <div class="region-stats-info">${info}</div>
        ${
          stats
            ? `<table class="region-stats-table"><thead><tr><th>Band</th>${COLUMNS.map(
                ([, label]) => `<th>${label}</th>`
              ).join('')}</tr></thead><tbody>${rows}</tbody></table>`
            : ''
        }
        ${
          stats && stats.bands.length >= 3
            ? `<div class="region-stats-spectrum">
                <div class="image-stats-chart-header"><span>Spectrum (mean ± σ)</span><span class="image-stats-readout"></span></div>
                <canvas></canvas>
              </div>`
            : ''
        }
      </div>`;
    if (stats && stats.bands.length >= 3) this.attachSpectrum(panel, stats);

    panel
      .querySelector('[data-action="close"]')
      ?.addEventListener('click', () => this.deactivate());
    if (stats) {
      const csv = regionStatsCsv(stats);
      panel
        .querySelector('[data-action="copy"]')
        ?.addEventListener('click', () => void copyText(csv, 'Statistics'));
      panel
        .querySelector('[data-action="csv"]')
        ?.addEventListener(
          'click',
          () => void saveCsv(`${fileStem(target.name)}_region_stats.csv`, csv)
        );
    }
  }

  /** Mean ± sigma per band, with a hover readout */
  private attachSpectrum(panel: HTMLElement, stats: RegionStatistics): void {
    const canvas = panel.querySelector('.region-stats-spectrum canvas') as HTMLCanvasElement | null;
    const readout = panel.querySelector('.region-stats-spectrum .image-stats-readout');
    if (!canvas || !readout) return;
    const mean = stats.bands.map(b => b.mean);
    const spread = (sign: number) =>
      stats.bands.map(b => (b.mean != null && b.sigma != null ? b.mean + sign * b.sigma : null));
    const single = stats.width * stats.height === 1;
    const draw = (cursor: number | null) =>
      drawLineChart(
        canvas,
        [
          ...(single
            ? []
            : [
                { color: 'rgba(240, 136, 62, 0.35)', values: spread(1) },
                { color: 'rgba(240, 136, 62, 0.35)', values: spread(-1) },
              ]),
          { color: '#f0883e', values: mean },
        ],
        {
          x: stats.bands.map(b => b.band),
          formatX: v => `B${v}`,
          dots: stats.bands.length <= 32,
          cursor,
        }
      );
    let layout = draw(null);
    canvas.addEventListener('mousemove', e => {
      const index = layout.indexAt(e.clientX - canvas.getBoundingClientRect().left);
      layout = draw(index);
      const b = index == null ? null : stats.bands[index];
      readout.textContent = b
        ? `B${b.band}: ${formatNumber(b.mean)}${single ? '' : ` ± ${formatNumber(b.sigma)}`}`
        : '';
    });
    canvas.addEventListener('mouseleave', () => {
      layout = draw(null);
      readout.textContent = '';
    });
  }
}
