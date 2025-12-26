/**
 * Histogram rendering and interaction for raster layers
 * @module layer-manager/histogram
 */

import { invoke } from '@tauri-apps/api/core';
import { logger } from '../logger';
import type { LayerManagerInterface, RasterLayer, HistogramData } from './types';

const log = logger.child('LayerManager:Histogram');

/**
 * Show histogram panel for a raster layer
 * @param manager - The LayerManager instance
 * @param layerId - Layer ID
 * @param band - Band number
 */
export async function showHistogram(
  manager: LayerManagerInterface,
  layerId: string,
  band: number
): Promise<void> {
  const layer = manager.layers.get(layerId);
  if (!layer || layer.type !== 'raster') return;

  const panel = document.getElementById('histogram-panel');
  const title = document.getElementById('histogram-panel-title');
  const canvas = document.getElementById('histogram-canvas') as HTMLCanvasElement | null;
  const minSpan = document.getElementById('histogram-min');
  const maxSpan = document.getElementById('histogram-max');
  const closeBtn = document.getElementById('histogram-panel-close');
  const bandSelect = document.getElementById('histogram-band') as HTMLSelectElement | null;
  const logScaleCheckbox = document.getElementById(
    'histogram-log-scale'
  ) as HTMLInputElement | null;
  const tooltip = document.getElementById('histogram-tooltip');

  if (!panel || !canvas) return;

  // Set title
  const layerName = layer.path.split('/').pop()?.split('\\').pop() || 'Unknown';
  if (title) title.textContent = `Histogram - ${layerName}`;

  const rasterLayer = layer as RasterLayer;

  // Populate band selector
  if (bandSelect) {
    bandSelect.innerHTML = Array.from(
      { length: rasterLayer.bands },
      (_, i) =>
        `<option value="${i + 1}" ${band === i + 1 ? 'selected' : ''}>Band ${i + 1}</option>`
    ).join('');

    // Store current layer ID for band change handler
    bandSelect.dataset.layerId = layerId;

    // Setup band change handler (remove old listener first)
    bandSelect.onchange = async (e: Event) => {
      const target = e.target as HTMLSelectElement;
      const newBand = parseInt(target.value, 10);
      await showHistogram(manager, layerId, newBand);
    };
  }

  // Show panel with loading state
  panel.classList.add('visible');
  if (minSpan) minSpan.textContent = 'Loading...';
  if (maxSpan) maxSpan.textContent = '';

  // Setup close button
  if (closeBtn) {
    closeBtn.onclick = () => {
      panel.classList.remove('visible');
      if (tooltip) tooltip.classList.remove('visible');
    };
  }

  try {
    // Fetch histogram data from backend
    const histogram = await invoke<HistogramData>('get_histogram', {
      id: layerId,
      band,
      numBins: 256,
    });

    // Store histogram data for redraw
    manager.currentHistogram = histogram;
    (manager as unknown as { currentHistogramLayerId: string }).currentHistogramLayerId = layerId;

    // Update stats
    if (minSpan) minSpan.textContent = `Min: ${histogram.min.toFixed(2)}`;
    if (maxSpan) maxSpan.textContent = `Max: ${histogram.max.toFixed(2)}`;

    // Auto-enable log scale for high dynamic range
    const maxCount = Math.max(...histogram.counts);
    if (logScaleCheckbox && maxCount > 1000) {
      logScaleCheckbox.checked = true;
    }

    // Draw histogram on canvas
    const useLogScale = logScaleCheckbox ? logScaleCheckbox.checked : false;
    drawHistogram(canvas, histogram, rasterLayer, useLogScale);

    // Setup mouse hover for tooltip
    setupHistogramHover(manager, canvas, tooltip, histogram, useLogScale);

    // Setup log scale toggle handler
    if (logScaleCheckbox) {
      logScaleCheckbox.onchange = () => {
        const currentLayerId = (manager as unknown as { currentHistogramLayerId: string })
          .currentHistogramLayerId;
        const currentLayer = manager.layers.get(currentLayerId);
        const currentCanvas = document.getElementById(
          'histogram-canvas'
        ) as HTMLCanvasElement | null;
        const currentTooltip = document.getElementById('histogram-tooltip');
        if (manager.currentHistogram && currentCanvas && currentLayer?.type === 'raster') {
          drawHistogram(
            currentCanvas,
            manager.currentHistogram,
            currentLayer as RasterLayer,
            logScaleCheckbox.checked
          );
          setupHistogramHover(
            manager,
            currentCanvas,
            currentTooltip,
            manager.currentHistogram,
            logScaleCheckbox.checked
          );
        }
      };
    }
  } catch (error) {
    log.error('Failed to load histogram', { error: String(error) });
    if (minSpan) minSpan.textContent = 'Error loading histogram';
    if (maxSpan) maxSpan.textContent = '';
  }
}

/**
 * Setup hover interaction for histogram
 * @param manager - The LayerManager instance
 * @param canvas - Canvas element
 * @param tooltip - Tooltip element
 * @param histogram - Histogram data
 * @param useLogScale - Whether to use log scale
 */
export function setupHistogramHover(
  manager: LayerManagerInterface,
  canvas: HTMLCanvasElement,
  tooltip: HTMLElement | null,
  histogram: HistogramData,
  useLogScale: boolean
): void {
  if (!tooltip) return;

  const padding = { top: 10, right: 10, bottom: 30, left: 50 };
  const chartWidth = canvas.width - padding.left - padding.right;

  // Remove old listeners by replacing with cloned node
  const newCanvas = canvas.cloneNode(true) as HTMLCanvasElement;
  canvas.parentNode?.replaceChild(newCanvas, canvas);

  newCanvas.addEventListener('mousemove', (e: MouseEvent) => {
    const rect = newCanvas.getBoundingClientRect();
    const scaleX = newCanvas.width / rect.width;
    const x = (e.clientX - rect.left) * scaleX;

    // Check if within chart area
    if (x < padding.left || x > newCanvas.width - padding.right) {
      tooltip.classList.remove('visible');
      return;
    }

    // Calculate which bin we're over
    const chartX = x - padding.left;
    const binIndex = Math.floor((chartX / chartWidth) * histogram.counts.length);

    if (binIndex >= 0 && binIndex < histogram.counts.length) {
      const count = histogram.counts[binIndex];
      const binWidth = (histogram.max - histogram.min) / histogram.counts.length;
      const valueStart = histogram.min + binIndex * binWidth;
      const valueEnd = valueStart + binWidth;

      // Format the tooltip content
      tooltip.innerHTML = `
        <div>Value: ${valueStart.toFixed(2)} - ${valueEnd.toFixed(2)}</div>
        <div>Count: ${count.toLocaleString()}</div>
      `;

      // Position tooltip near cursor but keep within bounds
      const tooltipX = Math.min(e.clientX - rect.left + 10, rect.width - 120);
      const tooltipY = Math.max(e.clientY - rect.top - 50, 5);
      tooltip.style.left = `${tooltipX}px`;
      tooltip.style.top = `${tooltipY}px`;
      tooltip.classList.add('visible');
    } else {
      tooltip.classList.remove('visible');
    }
  });

  newCanvas.addEventListener('mouseleave', () => {
    tooltip.classList.remove('visible');
  });

  // Redraw the histogram on the new canvas
  const selectedLayer = manager.layers.get(manager.selectedLayerId || '');
  if (selectedLayer?.type === 'raster') {
    drawHistogram(newCanvas, histogram, selectedLayer as RasterLayer, useLogScale);
  }
}

/**
 * Draw histogram on canvas
 * @param canvas - Canvas element
 * @param histogram - Histogram data
 * @param layer - Layer data
 * @param useLogScale - Whether to use log scale
 */
export function drawHistogram(
  canvas: HTMLCanvasElement,
  histogram: HistogramData,
  layer: RasterLayer | null,
  useLogScale: boolean = false
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const { width, height } = canvas;
  const padding = { top: 10, right: 10, bottom: 30, left: 50 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  // Clear canvas
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, width, height);

  // Find max count for scaling
  const maxCount = Math.max(...histogram.counts);
  if (maxCount === 0) return;

  const getScaledValue = (count: number): number => {
    if (useLogScale) {
      return count > 0 ? Math.log10(count + 1) / Math.log10(maxCount + 1) : 0;
    }
    return count / maxCount;
  };

  // Draw grid lines
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padding.top + (chartHeight * i) / 4;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
  }

  // Draw histogram bars
  const barWidth = chartWidth / histogram.counts.length;
  ctx.fillStyle = '#4a9eff';

  histogram.counts.forEach((count, i) => {
    const barHeight = getScaledValue(count) * chartHeight;
    const x = padding.left + i * barWidth;
    const y = padding.top + chartHeight - barHeight;
    ctx.fillRect(x, y, Math.max(barWidth - 0.5, 1), barHeight);
  });

  // Draw stretch markers (current min/max)
  if (layer?.stretch) {
    const stretchMin = layer.stretch.min;
    const stretchMax = layer.stretch.max;
    const range = histogram.max - histogram.min;

    if (range > 0) {
      // Min marker
      const minX = padding.left + ((stretchMin - histogram.min) / range) * chartWidth;
      ctx.strokeStyle = '#ff6b6b';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(minX, padding.top);
      ctx.lineTo(minX, height - padding.bottom);
      ctx.stroke();

      // Max marker
      const maxX = padding.left + ((stretchMax - histogram.min) / range) * chartWidth;
      ctx.strokeStyle = '#51cf66';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(maxX, padding.top);
      ctx.lineTo(maxX, height - padding.bottom);
      ctx.stroke();
    }
  }

  // Draw axes
  ctx.strokeStyle = '#666';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, height - padding.bottom);
  ctx.lineTo(width - padding.right, height - padding.bottom);
  ctx.stroke();

  // Draw labels
  ctx.fillStyle = '#888';
  ctx.font = '10px monospace';
  ctx.textAlign = 'center';

  // X-axis labels (min and max values)
  ctx.fillText(histogram.min.toFixed(1), padding.left, height - 8);
  ctx.fillText(histogram.max.toFixed(1), width - padding.right, height - 8);

  // Y-axis label
  ctx.save();
  ctx.translate(12, height / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(useLogScale ? 'Count (log)' : 'Count', 0, 0);
  ctx.restore();
}
