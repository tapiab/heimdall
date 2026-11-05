/**
 * Value profile panel: every band of a raster along a drawn line, one sample
 * per pixel, with band toggles, per-band normalisation, hover readout and CSV
 * export.
 * @module band-profile-panel
 */

import {
  bandColor,
  displayedBands,
  drawLineChart,
  escapeHtml,
  fileStem,
  formatNumber,
  saveCsv,
  toCsv,
  type AnalysisTarget,
  type ChartLayout,
} from './analysis-common';

/** Result of `get_band_profile` */
export interface BandProfile {
  unit: 'm' | 'px';
  total_distance: number;
  distance: number[];
  x: number[];
  y: number[];
  /** values[band - 1][sample] */
  values: Array<Array<number | null>>;
}

export interface BandProfileSummary {
  min: number | null;
  max: number | null;
  mean: number | null;
  /** Sum of rises and of drops between consecutive valid samples */
  gain: number;
  loss: number;
}

/** Min, max, mean, total rise and drop of one band along the profile */
export function summarizeProfile(values: Array<number | null>): BandProfileSummary {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;
  let gain = 0;
  let loss = 0;
  let prev: number | null = null;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) continue;
    min = Math.min(min, v);
    max = Math.max(max, v);
    sum += v;
    count++;
    if (prev != null) {
      if (v > prev) gain += v - prev;
      else loss += prev - v;
    }
    prev = v;
  }
  return count
    ? { min, max, mean: sum / count, gain, loss }
    : { min: null, max: null, mean: null, gain: 0, loss: 0 };
}

/** Each value scaled to 0..1 over the band's own range (constant bands → 0.5) */
export function normalizeSeries(values: Array<number | null>): Array<number | null> {
  const { min, max } = summarizeProfile(values);
  if (min == null || max == null) return values.map(() => null);
  const span = max - min;
  return values.map(v => (v == null || !Number.isFinite(v) ? null : span ? (v - min) / span : 0.5));
}

/** CSV with distance, pixel position and every band */
export function profileCsv(profile: BandProfile): string {
  const header = [
    `distance_${profile.unit}`,
    'x',
    'y',
    ...profile.values.map((_, i) => `band_${i + 1}`),
  ];
  const rows = profile.distance.map((d, i) => [
    Number(d.toFixed(profile.unit === 'm' ? 3 : 2)),
    profile.x[i],
    profile.y[i],
    ...profile.values.map(band => band[i]),
  ]);
  return toCsv(header, rows);
}

function formatDistance(value: number, unit: 'm' | 'px'): string {
  if (unit === 'px') return `${value.toFixed(value < 100 ? 1 : 0)} px`;
  return value < 1000
    ? `${value.toFixed(value < 10 ? 2 : 0)} m`
    : `${(value / 1000).toFixed(2)} km`;
}

export interface BandProfilePanelOptions {
  /** Hovered sample index, or null when the pointer leaves the chart */
  onHover?: (index: number | null) => void;
  onClose?: () => void;
}

/** Open (or replace) the profile panel */
export function showBandProfilePanel(
  target: AnalysisTarget,
  profile: BandProfile,
  options: BandProfilePanelOptions = {}
): void {
  document.getElementById('profile-panel')?.remove();

  const bandCount = profile.values.length;
  const visible = new Set(displayedBands(target.layer, bandCount));
  let normalize = false;
  let cursor: number | null = null;
  let layout: ChartLayout | null = null;

  const panel = document.createElement('div');
  panel.id = 'profile-panel';
  const chips =
    bandCount > 1
      ? `<div class="profile-bands">${profile.values
          .map((_, i) => {
            const band = i + 1;
            return `<label class="profile-band-chip" style="--chip-color: ${bandColor(target.layer, band)}">
              <input type="checkbox" data-band="${band}" ${visible.has(band) ? 'checked' : ''}>B${band}</label>`;
          })
          .join('')}
          <button class="profile-chip-btn" data-action="all">All</button>
          <button class="profile-chip-btn" data-action="none">None</button>
          <label class="profile-band-chip profile-normalize" title="Scale each band to its own min–max">
            <input type="checkbox" data-action="normalize">Normalize</label>
        </div>`
      : '';
  panel.innerHTML = `
    <div id="profile-panel-header">
      <h4>Value Profile — ${escapeHtml(target.name)}</h4>
      <div class="profile-stats">
        <span>${formatDistance(profile.total_distance, profile.unit)}</span>
        <span>${profile.distance.length.toLocaleString()} samples</span>
      </div>
      <div class="profile-actions">
        <button id="profile-csv" class="profile-chip-btn" title="Save every band as CSV">CSV</button>
        <button id="profile-panel-close">&times;</button>
      </div>
    </div>
    ${chips}
    <div id="profile-content">
      <canvas id="profile-canvas"></canvas>
      <div id="profile-hover-info"></div>
    </div>
    <div id="profile-range"></div>
  `;
  document.body.appendChild(panel);

  const canvas = panel.querySelector('#profile-canvas') as HTMLCanvasElement;
  const hoverInfo = panel.querySelector('#profile-hover-info') as HTMLDivElement;
  const footer = panel.querySelector('#profile-range') as HTMLDivElement;

  const shownBands = () => [...visible].sort((a, b) => a - b);

  const renderFooter = () => {
    const bands = shownBands();
    if (bands.length === 1) {
      const s = summarizeProfile(profile.values[bands[0] - 1]);
      const slope =
        profile.unit === 'm' && bandCount === 1
          ? `<span>↑ ${formatNumber(s.gain, 1)}</span><span>↓ ${formatNumber(s.loss, 1)}</span>`
          : '';
      footer.innerHTML = `<span>B${bands[0]}</span><span>Min ${formatNumber(s.min)}</span>
        <span>Mean ${formatNumber(s.mean)}</span><span>Max ${formatNumber(s.max)}</span>${slope}`;
    } else {
      footer.innerHTML = bands.length
        ? `<span>${bands.length} bands shown</span>`
        : '<span>No band selected</span>';
    }
  };

  const draw = () => {
    const series = shownBands().map(band => ({
      color: bandColor(target.layer, band),
      values: normalize ? normalizeSeries(profile.values[band - 1]) : profile.values[band - 1],
    }));
    layout = drawLineChart(canvas, series, {
      x: profile.distance,
      formatX: v => formatDistance(v, profile.unit),
      formatY: normalize ? v => v.toFixed(2) : undefined,
      cursor,
    });
  };

  const showReadout = (index: number) => {
    const values = shownBands()
      .map(band => {
        const v = profile.values[band - 1][index];
        return `<span style="color: ${bandColor(target.layer, band)}">B${band} ${formatNumber(v)}</span>`;
      })
      .join(' ');
    hoverInfo.innerHTML = `${formatDistance(profile.distance[index], profile.unit)} · px (${profile.x[index]}, ${profile.y[index]})<br>${values}`;
    hoverInfo.style.display = 'block';
    const x = layout ? layout.xOf(index) : 0;
    hoverInfo.style.left = `${Math.min(Math.max(x, 120), canvas.clientWidth - 120) + canvas.offsetLeft}px`;
  };

  canvas.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    const index = layout?.indexAt(e.clientX - rect.left) ?? null;
    if (index === cursor) return;
    cursor = index;
    draw();
    if (index == null) hoverInfo.style.display = 'none';
    else showReadout(index);
    options.onHover?.(index);
  });
  canvas.addEventListener('mouseleave', () => {
    cursor = null;
    hoverInfo.style.display = 'none';
    draw();
    options.onHover?.(null);
  });

  panel.querySelectorAll<HTMLInputElement>('input[data-band]').forEach(input => {
    input.addEventListener('change', () => {
      const band = Number(input.dataset.band);
      if (input.checked) visible.add(band);
      else visible.delete(band);
      draw();
      renderFooter();
    });
  });
  panel.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach(button => {
    button.addEventListener('click', () => {
      const all = button.dataset.action === 'all';
      visible.clear();
      if (all) profile.values.forEach((_, i) => visible.add(i + 1));
      panel.querySelectorAll<HTMLInputElement>('input[data-band]').forEach(input => {
        input.checked = all;
      });
      draw();
      renderFooter();
    });
  });
  panel
    .querySelector<HTMLInputElement>('input[data-action="normalize"]')
    ?.addEventListener('change', e => {
      normalize = (e.target as HTMLInputElement).checked;
      draw();
    });
  panel.querySelector('#profile-csv')?.addEventListener('click', () => {
    void saveCsv(`${fileStem(target.name)}_profile.csv`, profileCsv(profile));
  });
  panel.querySelector('#profile-panel-close')?.addEventListener('click', () => {
    panel.remove();
    options.onClose?.();
  });

  const resize = new ResizeObserver(() => {
    if (!panel.isConnected) {
      resize.disconnect();
      return;
    }
    draw();
  });
  resize.observe(canvas);
  draw();
  renderFooter();
}
