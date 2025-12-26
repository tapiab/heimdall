/**
 * Layer UI - Layer panel, dynamic controls, and drag/drop reordering
 * @module layer-manager/layer-ui
 */

import type { LayerManagerInterface, RasterLayer, VectorLayer, CrossLayerRgbConfig } from './types';

/** Extended LayerManager interface with UI-specific properties */
interface LayerManagerWithUI extends LayerManagerInterface {
  draggedItem: HTMLElement | null;
  selectLayer: (id: string) => void;
  toggleLayerVisibility: (id: string) => void;
  removeLayer: (id: string) => void;
  renameLayer: (id: string, newName: string) => void;
  setLayerOpacity: (id: string, opacity: number) => void;
  setLayerDisplayMode: (id: string, mode: string) => void;
  setLayerBand: (id: string, band: number) => void;
  setLayerStretch: (id: string, min: number, max: number, gamma: number) => void;
  setRgbBands: (id: string, r: number, g: number, b: number) => void;
  setRgbStretch: (id: string, channel: 'r' | 'g' | 'b', min: number, max: number, gamma: number) => void;
  setVectorStyle: (id: string, property: string, value: string | number) => void;
  setColorByField: (id: string, fieldName: string | null) => void;
  showAttributeTable: (layerId: string) => void;
  showHistogram: (layerId: string, band: number) => void;
  createRgbCompositionLayer: (sourceLayerId: string) => Promise<string | null>;
  createCrossLayerRgbCompositionLayer: (sourceLayerId: string) => Promise<string | null>;
  reorderLayers: (fromIndex: number, toIndex: number) => void;
}

/** Extended raster layer with UI state */
interface RasterLayerWithUI extends RasterLayer {
  showRgbStretch?: boolean;
}

/**
 * Update the layer panel UI with current layers.
 * Renders each layer as a draggable item with visibility toggle, opacity slider, and remove button.
 * @param manager - The LayerManager instance
 */
export function updateLayerPanel(manager: LayerManagerWithUI): void {
  const layerList = document.getElementById('layer-list');
  if (!layerList) return;

  layerList.innerHTML = '';

  const displayOrder = [...manager.layerOrder].reverse();

  displayOrder.forEach((id, displayIndex) => {
    const layer = manager.layers.get(id);
    if (!layer) return;

    const item = document.createElement('div');
    item.className = `layer-item${id === manager.selectedLayerId ? ' selected' : ''}`;
    item.draggable = true;
    item.dataset.layerId = id;
    item.dataset.index = String(manager.layerOrder.length - 1 - displayIndex);

    item.addEventListener('click', e => {
      const target = e.target as HTMLElement;
      if (target.tagName !== 'INPUT' && target.tagName !== 'BUTTON') {
        manager.selectLayer(id);
      }
    });
    item.addEventListener('dragstart', e => handleDragStart(manager, e, item));
    item.addEventListener('dragover', e => handleDragOver(manager, e, item));
    item.addEventListener('drop', e => handleDrop(manager, e, item));
    item.addEventListener('dragend', () => handleDragEnd(manager));

    const headerRow = document.createElement('div');
    headerRow.className = 'layer-header';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = layer.visible;
    checkbox.addEventListener('change', () => manager.toggleLayerVisibility(id));

    const name = document.createElement('span');
    name.className = 'layer-name';
    const fileName = layer.path.split('/').pop()?.split('\\').pop() || 'Unknown';
    const displayName = layer.displayName || fileName;
    name.textContent = displayName;

    if (layer.type === 'vector') {
      const vectorLayer = layer as VectorLayer;
      name.title = `${layer.path}\n${vectorLayer.feature_count} features, ${vectorLayer.geometry_type}\nDouble-click to rename`;
    } else if ((layer as RasterLayer).isComposition) {
      const rasterLayer = layer as RasterLayer;
      name.title = `RGB Composition\nR: Band ${rasterLayer.rgbBands.r}, G: Band ${rasterLayer.rgbBands.g}, B: Band ${rasterLayer.rgbBands.b}\n${rasterLayer.width}x${rasterLayer.height}\nDouble-click to rename`;
      name.style.fontStyle = 'italic';
    } else {
      const rasterLayer = layer as RasterLayer;
      name.title = `${layer.path}\n${rasterLayer.width}x${rasterLayer.height}, ${rasterLayer.bands} band(s)\nDouble-click to rename`;
    }

    // Double-click to rename
    name.addEventListener('dblclick', e => {
      e.stopPropagation();
      startRenameLayer(manager, id, name, displayName);
    });

    const removeBtn = document.createElement('button');
    removeBtn.className = 'layer-remove';
    removeBtn.textContent = '\u00d7';
    removeBtn.title = 'Remove layer';
    removeBtn.addEventListener('click', e => {
      e.stopPropagation();
      manager.removeLayer(id);
    });

    headerRow.appendChild(checkbox);
    headerRow.appendChild(name);
    headerRow.appendChild(removeBtn);

    const opacityRow = document.createElement('div');
    opacityRow.className = 'layer-opacity';

    const opacityLabel = document.createElement('span');
    opacityLabel.className = 'opacity-label';
    opacityLabel.textContent = 'Opacity';

    const opacitySlider = document.createElement('input');
    opacitySlider.type = 'range';
    opacitySlider.min = '0';
    opacitySlider.max = '100';
    opacitySlider.value = String(Math.round(layer.opacity * 100));
    opacitySlider.addEventListener('input', e => {
      const target = e.target as HTMLInputElement;
      manager.setLayerOpacity(id, parseInt(target.value, 10) / 100);
    });

    opacityRow.appendChild(opacityLabel);
    opacityRow.appendChild(opacitySlider);

    item.appendChild(headerRow);
    item.appendChild(opacityRow);

    // Add band selector for multi-band rasters
    if (layer.type === 'raster') {
      const rasterLayer = layer as RasterLayer;
      if (rasterLayer.bands > 1 && !rasterLayer.isComposition) {
        const bandRow = document.createElement('div');
        bandRow.className = 'layer-band-selector';

        const bandLabel = document.createElement('span');
        bandLabel.className = 'band-label';
        bandLabel.textContent = 'Band';

        const bandSelect = document.createElement('select');
        bandSelect.className = 'band-select';

        // Add grayscale band options
        for (let i = 1; i <= rasterLayer.bands; i++) {
          const option = document.createElement('option');
          option.value = `band-${i}`;
          option.textContent = `Band ${i}`;
          if (rasterLayer.displayMode === 'grayscale' && rasterLayer.band === i) {
            option.selected = true;
          }
          bandSelect.appendChild(option);
        }

        // Add RGB option if 3+ bands
        if (rasterLayer.bands >= 3) {
          const rgbOption = document.createElement('option');
          rgbOption.value = 'rgb';
          rgbOption.textContent = 'RGB';
          if (rasterLayer.displayMode === 'rgb') {
            rgbOption.selected = true;
          }
          bandSelect.appendChild(rgbOption);
        }

        bandSelect.addEventListener('change', e => {
          e.stopPropagation();
          const target = e.target as HTMLSelectElement;
          const { value } = target;
          if (value === 'rgb') {
            manager.setLayerDisplayMode(id, 'rgb');
          } else {
            const bandNum = parseInt(value.replace('band-', ''), 10);
            manager.setLayerDisplayMode(id, 'grayscale');
            manager.setLayerBand(id, bandNum);
          }
        });

        bandRow.appendChild(bandLabel);
        bandRow.appendChild(bandSelect);
        item.appendChild(bandRow);
      }
    }

    layerList.appendChild(item);
  });

  const fitBoundsBtn = document.getElementById('fit-bounds') as HTMLButtonElement | null;
  if (fitBoundsBtn) {
    fitBoundsBtn.disabled = manager.layers.size === 0;
  }
}

/**
 * Start inline rename editing for a layer
 */
function startRenameLayer(
  manager: LayerManagerWithUI,
  id: string,
  nameElement: HTMLElement,
  currentName: string
): void {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'layer-name-input';
  input.value = currentName;

  const commitRename = (): void => {
    const newName = input.value.trim();
    if (newName && newName !== currentName) {
      manager.renameLayer(id, newName);
    } else {
      manager.updateLayerPanel(); // Restore original
    }
  };

  input.addEventListener('blur', commitRename);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      manager.updateLayerPanel(); // Cancel
    }
  });

  nameElement.replaceWith(input);
  input.focus();
  input.select();
}

/**
 * Update dynamic controls panel based on selected layer.
 * Shows vector styling controls or raster band/stretch controls.
 * @param manager - The LayerManager instance
 */
export function updateDynamicControls(manager: LayerManagerWithUI): void {
  const controlsPanel = document.getElementById('dynamic-controls');
  if (!controlsPanel) return;

  const layer = manager.selectedLayerId ? manager.layers.get(manager.selectedLayerId) : null;

  if (!layer) {
    controlsPanel.innerHTML = '<div class="no-layer-selected">Select a layer to adjust</div>';
    return;
  }

  // Vector layer controls
  if (layer.type === 'vector') {
    renderVectorControls(manager, controlsPanel, layer as VectorLayer);
    return;
  }

  // Raster layer controls
  renderRasterControls(manager, controlsPanel, layer as RasterLayerWithUI);
}

/**
 * Render vector layer style controls
 */
function renderVectorControls(
  manager: LayerManagerWithUI,
  controlsPanel: HTMLElement,
  layer: VectorLayer
): void {
  const fields = layer.fields || [];
  const fieldOptions = fields
    .map(
      f =>
        `<option value="${f.name}" ${layer.style.colorByField === f.name ? 'selected' : ''}>${f.name}</option>`
    )
    .join('');

  controlsPanel.innerHTML = `
    <div class="control-section">
      <label>Layer Type</label>
      <span style="color: #888; font-size: 12px;">Vector (${layer.geometry_type})</span>
    </div>
    <div class="control-section">
      <label>Features</label>
      <span style="color: #888; font-size: 12px;">${layer.feature_count} features</span>
    </div>
    <button id="show-attributes" class="control-btn">Open Attribute Table</button>
    <div class="control-section" style="margin-top: 12px;">
      <label>Color By Field</label>
      <select id="color-by-field">
        <option value="">-- Solid Color --</option>
        ${fieldOptions}
      </select>
    </div>
    <div class="control-section">
      <label>Fill Color</label>
      <input type="color" id="vector-fill-color" value="${layer.style.fillColor}">
    </div>
    <div class="control-section">
      <label>Fill Opacity <span class="value-display">${(layer.style.fillOpacity * 100).toFixed(0)}%</span></label>
      <input type="range" id="vector-fill-opacity" min="0" max="100" value="${layer.style.fillOpacity * 100}">
    </div>
    <div class="control-section">
      <label>Stroke Color</label>
      <input type="color" id="vector-stroke-color" value="${layer.style.strokeColor}">
    </div>
    <div class="control-section">
      <label>Stroke Width <span class="value-display">${layer.style.strokeWidth}px</span></label>
      <input type="range" id="vector-stroke-width" min="0.5" max="10" value="${layer.style.strokeWidth}" step="0.5">
    </div>
    <div class="control-section">
      <label>Point Radius <span class="value-display">${layer.style.pointRadius}px</span></label>
      <input type="range" id="vector-point-radius" min="1" max="20" value="${layer.style.pointRadius}">
    </div>
  `;

  // Attach event listeners
  attachVectorEventListeners(manager, layer);
}

/**
 * Attach vector control event listeners
 */
function attachVectorEventListeners(manager: LayerManagerWithUI, layer: VectorLayer): void {
  const fillColorInput = document.getElementById('vector-fill-color') as HTMLInputElement | null;
  const fillOpacityInput = document.getElementById('vector-fill-opacity') as HTMLInputElement | null;
  const strokeColorInput = document.getElementById('vector-stroke-color') as HTMLInputElement | null;
  const strokeWidthInput = document.getElementById('vector-stroke-width') as HTMLInputElement | null;
  const pointRadiusInput = document.getElementById('vector-point-radius') as HTMLInputElement | null;
  const showAttributesBtn = document.getElementById('show-attributes');
  const colorByFieldSelect = document.getElementById('color-by-field') as HTMLSelectElement | null;

  if (showAttributesBtn) {
    showAttributesBtn.addEventListener('click', () => {
      if (manager.selectedLayerId) {
        manager.showAttributeTable(manager.selectedLayerId);
      }
    });
  }
  if (colorByFieldSelect) {
    colorByFieldSelect.addEventListener('change', e => {
      const target = e.target as HTMLSelectElement;
      if (manager.selectedLayerId) {
        manager.setColorByField(manager.selectedLayerId, target.value || null);
      }
    });
  }
  if (fillColorInput) {
    fillColorInput.addEventListener('change', e => {
      const target = e.target as HTMLInputElement;
      if (manager.selectedLayerId) {
        manager.setVectorStyle(manager.selectedLayerId, 'fillColor', target.value);
        layer.style.colorByField = null;
        if (colorByFieldSelect) colorByFieldSelect.value = '';
      }
    });
  }
  if (fillOpacityInput) {
    fillOpacityInput.addEventListener('input', e => {
      const target = e.target as HTMLInputElement;
      const opacity = parseInt(target.value, 10) / 100;
      const label = target.previousElementSibling as HTMLElement;
      const valueDisplay = label?.querySelector('.value-display');
      if (valueDisplay) valueDisplay.textContent = `${target.value}%`;
      if (manager.selectedLayerId) {
        manager.setVectorStyle(manager.selectedLayerId, 'fillOpacity', opacity);
      }
    });
  }
  if (strokeColorInput) {
    strokeColorInput.addEventListener('change', e => {
      const target = e.target as HTMLInputElement;
      if (manager.selectedLayerId) {
        manager.setVectorStyle(manager.selectedLayerId, 'strokeColor', target.value);
      }
    });
  }
  if (strokeWidthInput) {
    strokeWidthInput.addEventListener('input', e => {
      const target = e.target as HTMLInputElement;
      const width = parseFloat(target.value);
      const label = target.previousElementSibling as HTMLElement;
      const valueDisplay = label?.querySelector('.value-display');
      if (valueDisplay) valueDisplay.textContent = `${width}px`;
      if (manager.selectedLayerId) {
        manager.setVectorStyle(manager.selectedLayerId, 'strokeWidth', width);
      }
    });
  }
  if (pointRadiusInput) {
    pointRadiusInput.addEventListener('input', e => {
      const target = e.target as HTMLInputElement;
      const radius = parseInt(target.value, 10);
      const label = target.previousElementSibling as HTMLElement;
      const valueDisplay = label?.querySelector('.value-display');
      if (valueDisplay) valueDisplay.textContent = `${radius}px`;
      if (manager.selectedLayerId) {
        manager.setVectorStyle(manager.selectedLayerId, 'pointRadius', radius);
      }
    });
  }
}

/**
 * Render raster layer controls
 */
function renderRasterControls(
  manager: LayerManagerWithUI,
  controlsPanel: HTMLElement,
  layer: RasterLayerWithUI
): void {
  const bandOptions = Array.from(
    { length: layer.bands },
    (_, i) =>
      `<option value="${i + 1}" ${layer.band === i + 1 ? 'selected' : ''}>Band ${i + 1}</option>`
  ).join('');

  // Check if we have multiple single-band layers for cross-layer RGB
  const singleBandLayers = Array.from(manager.layers.values()).filter(
    l => l.type === 'raster' && (l as RasterLayer).bands === 1
  );
  const canCrossLayerRgb = singleBandLayers.length >= 3;

  const modeOptions = `
    <option value="grayscale" ${layer.displayMode === 'grayscale' ? 'selected' : ''}>Grayscale</option>
    ${layer.bands >= 3 ? `<option value="rgb" ${layer.displayMode === 'rgb' ? 'selected' : ''}>RGB Composite</option>` : ''}
    ${canCrossLayerRgb ? `<option value="crossLayerRgb" ${layer.displayMode === 'crossLayerRgb' ? 'selected' : ''}>Cross-Layer RGB</option>` : ''}
  `;

  let controlsHtml = `
    <div class="control-section">
      <label>Display Mode</label>
      <select id="display-mode">${modeOptions}</select>
    </div>
  `;

  if (layer.displayMode === 'grayscale') {
    controlsHtml += renderGrayscaleControls(layer, bandOptions);
  } else if (layer.displayMode === 'crossLayerRgb') {
    controlsHtml += renderCrossLayerRgbControls(manager, layer);
  } else {
    controlsHtml += renderRgbControls(layer);
  }

  controlsPanel.innerHTML = controlsHtml;

  // Attach event listeners
  attachRasterEventListeners(manager, layer);
}

/**
 * Render grayscale stretch controls
 */
function renderGrayscaleControls(layer: RasterLayer, bandOptions: string): string {
  const bandStats = layer.band_stats[layer.band - 1] || { min: 0, max: 255 };
  return `
    <div class="control-section">
      <label>Band</label>
      <select id="band-select">${bandOptions}</select>
    </div>
    <div class="control-section">
      <label>Min <span class="value-display">${layer.stretch.min.toFixed(1)}</span></label>
      <input type="range" id="stretch-min" min="${bandStats.min}" max="${bandStats.max}" value="${layer.stretch.min}" step="0.1">
    </div>
    <div class="control-section">
      <label>Max <span class="value-display">${layer.stretch.max.toFixed(1)}</span></label>
      <input type="range" id="stretch-max" min="${bandStats.min}" max="${bandStats.max}" value="${layer.stretch.max}" step="0.1">
    </div>
    <div class="control-section">
      <label>Gamma <span class="value-display">${layer.stretch.gamma.toFixed(2)}</span></label>
      <input type="range" id="stretch-gamma" min="0.1" max="3.0" value="${layer.stretch.gamma}" step="0.05">
    </div>
    <button id="auto-stretch" class="control-btn">Auto Stretch</button>
    <button id="show-histogram" class="control-btn">Show Histogram</button>
  `;
}

/**
 * Render cross-layer RGB controls
 */
function renderCrossLayerRgbControls(manager: LayerManagerWithUI, layer: RasterLayer): string {
  const layerOptions = (selectedId: string | undefined): string => {
    let opts = '<option value="">-- Select Layer --</option>';
    for (const [id, l] of manager.layers) {
      const name = l.path.split('/').pop()?.split('\\').pop() || 'Unknown';
      opts += `<option value="${id}" ${selectedId === id ? 'selected' : ''}>${name}</option>`;
    }
    return opts;
  };

  // Initialize crossLayerRgb settings if not present
  const crossConfig: CrossLayerRgbConfig = layer.crossLayerRgb || {
    rLayerId: '',
    rBand: 1,
    gLayerId: '',
    gBand: 1,
    bLayerId: '',
    bBand: 1,
  };

  const hasAllLayers = crossConfig.rLayerId && crossConfig.gLayerId && crossConfig.bLayerId;

  return `
    <div class="control-section">
      <p style="font-size: 11px; color: #888; margin-bottom: 8px;">Select layers for each RGB channel:</p>
      <div class="rgb-channel-group">
        <div class="rgb-row">
          <span class="rgb-label r">R</span>
          <select id="cross-r-layer">${layerOptions(crossConfig.rLayerId)}</select>
        </div>
      </div>
      <div class="rgb-channel-group">
        <div class="rgb-row">
          <span class="rgb-label g">G</span>
          <select id="cross-g-layer">${layerOptions(crossConfig.gLayerId)}</select>
        </div>
      </div>
      <div class="rgb-channel-group">
        <div class="rgb-row">
          <span class="rgb-label b">B</span>
          <select id="cross-b-layer">${layerOptions(crossConfig.bLayerId)}</select>
        </div>
      </div>
    </div>
    <button id="apply-cross-rgb" class="control-btn">Apply Cross-Layer RGB</button>
    ${!layer.isComposition && hasAllLayers ? '<button id="create-cross-rgb-layer" class="control-btn" style="margin-top: 8px;">Create Cross-Layer RGB Layer</button>' : ''}
  `;
}

/**
 * Render RGB band and stretch controls
 */
function renderRgbControls(layer: RasterLayerWithUI): string {
  const rgbBandOptions = (selected: number): string =>
    Array.from(
      { length: layer.bands },
      (_, i) =>
        `<option value="${i + 1}" ${selected === i + 1 ? 'selected' : ''}>Band ${i + 1}</option>`
    ).join('');

  const rStats = layer.band_stats[layer.rgbBands.r - 1] || { min: 0, max: 255 };
  const gStats = layer.band_stats[layer.rgbBands.g - 1] || { min: 0, max: 255 };
  const bStats = layer.band_stats[layer.rgbBands.b - 1] || { min: 0, max: 255 };
  const showStretch = layer.showRgbStretch || false;

  return `
    <div class="control-section rgb-bands">
      <div class="rgb-channel-group">
        <div class="rgb-row">
          <span class="rgb-label r">R</span>
          <select id="rgb-r">${rgbBandOptions(layer.rgbBands.r)}</select>
        </div>
        <div class="rgb-stretch-controls ${showStretch ? '' : 'hidden'}">
          <div class="mini-control">
            <span class="mini-label">Min</span>
            <input type="range" id="rgb-r-min" min="${rStats.min}" max="${rStats.max}" value="${layer.rgbStretch.r.min}" step="0.1">
            <span class="mini-value">${layer.rgbStretch.r.min.toFixed(0)}</span>
          </div>
          <div class="mini-control">
            <span class="mini-label">Max</span>
            <input type="range" id="rgb-r-max" min="${rStats.min}" max="${rStats.max}" value="${layer.rgbStretch.r.max}" step="0.1">
            <span class="mini-value">${layer.rgbStretch.r.max.toFixed(0)}</span>
          </div>
        </div>
      </div>
      <div class="rgb-channel-group">
        <div class="rgb-row">
          <span class="rgb-label g">G</span>
          <select id="rgb-g">${rgbBandOptions(layer.rgbBands.g)}</select>
        </div>
        <div class="rgb-stretch-controls ${showStretch ? '' : 'hidden'}">
          <div class="mini-control">
            <span class="mini-label">Min</span>
            <input type="range" id="rgb-g-min" min="${gStats.min}" max="${gStats.max}" value="${layer.rgbStretch.g.min}" step="0.1">
            <span class="mini-value">${layer.rgbStretch.g.min.toFixed(0)}</span>
          </div>
          <div class="mini-control">
            <span class="mini-label">Max</span>
            <input type="range" id="rgb-g-max" min="${gStats.min}" max="${gStats.max}" value="${layer.rgbStretch.g.max}" step="0.1">
            <span class="mini-value">${layer.rgbStretch.g.max.toFixed(0)}</span>
          </div>
        </div>
      </div>
      <div class="rgb-channel-group">
        <div class="rgb-row">
          <span class="rgb-label b">B</span>
          <select id="rgb-b">${rgbBandOptions(layer.rgbBands.b)}</select>
        </div>
        <div class="rgb-stretch-controls ${showStretch ? '' : 'hidden'}">
          <div class="mini-control">
            <span class="mini-label">Min</span>
            <input type="range" id="rgb-b-min" min="${bStats.min}" max="${bStats.max}" value="${layer.rgbStretch.b.min}" step="0.1">
            <span class="mini-value">${layer.rgbStretch.b.min.toFixed(0)}</span>
          </div>
          <div class="mini-control">
            <span class="mini-label">Max</span>
            <input type="range" id="rgb-b-max" min="${bStats.min}" max="${bStats.max}" value="${layer.rgbStretch.b.max}" step="0.1">
            <span class="mini-value">${layer.rgbStretch.b.max.toFixed(0)}</span>
          </div>
        </div>
      </div>
    </div>
    <div class="stretch-toggle-row">
      <label class="stretch-toggle-label">
        <input type="checkbox" id="show-rgb-stretch" ${showStretch ? 'checked' : ''}>
        Show Stretch Controls
      </label>
    </div>
    <button id="auto-stretch-rgb" class="control-btn">Auto Stretch All</button>
    ${!layer.isComposition ? '<button id="create-rgb-layer" class="control-btn" style="margin-top: 8px;">Create RGB Layer</button>' : ''}
  `;
}

/**
 * Attach raster control event listeners
 */
function attachRasterEventListeners(manager: LayerManagerWithUI, layer: RasterLayerWithUI): void {
  const displayModeSelect = document.getElementById('display-mode') as HTMLSelectElement | null;
  if (displayModeSelect) {
    displayModeSelect.addEventListener('change', e => {
      const target = e.target as HTMLSelectElement;
      if (manager.selectedLayerId) {
        manager.setLayerDisplayMode(manager.selectedLayerId, target.value);
      }
    });
  }

  if (layer.displayMode === 'grayscale') {
    attachGrayscaleListeners(manager, layer);
  } else if (layer.displayMode === 'crossLayerRgb') {
    attachCrossLayerRgbListeners(manager, layer);
  } else {
    attachRgbListeners(manager, layer);
  }
}

/**
 * Attach grayscale control listeners
 */
function attachGrayscaleListeners(manager: LayerManagerWithUI, layer: RasterLayer): void {
  const bandSelect = document.getElementById('band-select') as HTMLSelectElement | null;
  if (bandSelect) {
    bandSelect.addEventListener('change', e => {
      const target = e.target as HTMLSelectElement;
      if (manager.selectedLayerId) {
        manager.setLayerBand(manager.selectedLayerId, parseInt(target.value, 10));
      }
    });
  }

  const minSlider = document.getElementById('stretch-min') as HTMLInputElement | null;
  const maxSlider = document.getElementById('stretch-max') as HTMLInputElement | null;
  const gammaSlider = document.getElementById('stretch-gamma') as HTMLInputElement | null;

  if (minSlider) {
    minSlider.addEventListener('input', e => {
      const target = e.target as HTMLInputElement;
      const label = target.previousElementSibling as HTMLElement;
      const valueDisplay = label?.querySelector('.value-display');
      if (valueDisplay) valueDisplay.textContent = parseFloat(target.value).toFixed(1);
    });
    minSlider.addEventListener('change', e => {
      const target = e.target as HTMLInputElement;
      if (manager.selectedLayerId) {
        manager.setLayerStretch(
          manager.selectedLayerId,
          parseFloat(target.value),
          layer.stretch.max,
          layer.stretch.gamma
        );
      }
    });
  }

  if (maxSlider) {
    maxSlider.addEventListener('input', e => {
      const target = e.target as HTMLInputElement;
      const label = target.previousElementSibling as HTMLElement;
      const valueDisplay = label?.querySelector('.value-display');
      if (valueDisplay) valueDisplay.textContent = parseFloat(target.value).toFixed(1);
    });
    maxSlider.addEventListener('change', e => {
      const target = e.target as HTMLInputElement;
      if (manager.selectedLayerId) {
        manager.setLayerStretch(
          manager.selectedLayerId,
          layer.stretch.min,
          parseFloat(target.value),
          layer.stretch.gamma
        );
      }
    });
  }

  if (gammaSlider) {
    gammaSlider.addEventListener('input', e => {
      const target = e.target as HTMLInputElement;
      const label = target.previousElementSibling as HTMLElement;
      const valueDisplay = label?.querySelector('.value-display');
      if (valueDisplay) valueDisplay.textContent = parseFloat(target.value).toFixed(2);
    });
    gammaSlider.addEventListener('change', e => {
      const target = e.target as HTMLInputElement;
      if (manager.selectedLayerId) {
        manager.setLayerStretch(
          manager.selectedLayerId,
          layer.stretch.min,
          layer.stretch.max,
          parseFloat(target.value)
        );
      }
    });
  }

  const autoStretchBtn = document.getElementById('auto-stretch');
  if (autoStretchBtn) {
    autoStretchBtn.addEventListener('click', () => {
      const bandStats = layer.band_stats[layer.band - 1];
      if (bandStats && manager.selectedLayerId) {
        manager.setLayerStretch(manager.selectedLayerId, bandStats.min, bandStats.max, 1.0);
        manager.updateDynamicControls();
      }
    });
  }

  const showHistogramBtn = document.getElementById('show-histogram');
  if (showHistogramBtn) {
    showHistogramBtn.addEventListener('click', () => {
      if (manager.selectedLayerId) {
        manager.showHistogram(manager.selectedLayerId, layer.band);
      }
    });
  }
}

/**
 * Attach cross-layer RGB control listeners
 */
function attachCrossLayerRgbListeners(manager: LayerManagerWithUI, layer: RasterLayer): void {
  const applyBtn = document.getElementById('apply-cross-rgb');
  if (applyBtn) {
    applyBtn.addEventListener('click', () => {
      const rSelect = document.getElementById('cross-r-layer') as HTMLSelectElement | null;
      const gSelect = document.getElementById('cross-g-layer') as HTMLSelectElement | null;
      const bSelect = document.getElementById('cross-b-layer') as HTMLSelectElement | null;

      const rLayerId = rSelect?.value;
      const gLayerId = gSelect?.value;
      const bLayerId = bSelect?.value;

      if (rLayerId && gLayerId && bLayerId) {
        layer.crossLayerRgb = {
          rLayerId,
          rBand: 1,
          gLayerId,
          gBand: 1,
          bLayerId,
          bBand: 1,
        };
        if (manager.selectedLayerId) {
          manager.refreshLayerTiles(manager.selectedLayerId);
          manager.updateDynamicControls();
        }
      } else {
        alert('Please select a layer for each RGB channel');
      }
    });
  }

  const createCrossRgbLayerBtn = document.getElementById('create-cross-rgb-layer');
  if (createCrossRgbLayerBtn) {
    createCrossRgbLayerBtn.addEventListener('click', () => {
      if (manager.selectedLayerId) {
        manager.createCrossLayerRgbCompositionLayer(manager.selectedLayerId);
      }
    });
  }
}

/**
 * Attach RGB control listeners
 */
function attachRgbListeners(manager: LayerManagerWithUI, layer: RasterLayerWithUI): void {
  const rgbR = document.getElementById('rgb-r') as HTMLSelectElement | null;
  const rgbG = document.getElementById('rgb-g') as HTMLSelectElement | null;
  const rgbB = document.getElementById('rgb-b') as HTMLSelectElement | null;

  if (rgbR && rgbG && rgbB) {
    const updateRgbBands = (): void => {
      if (manager.selectedLayerId) {
        manager.setRgbBands(
          manager.selectedLayerId,
          parseInt(rgbR.value, 10),
          parseInt(rgbG.value, 10),
          parseInt(rgbB.value, 10)
        );
      }
    };
    rgbR.addEventListener('change', updateRgbBands);
    rgbG.addEventListener('change', updateRgbBands);
    rgbB.addEventListener('change', updateRgbBands);
  }

  // Per-channel stretch sliders
  const channels: Array<'r' | 'g' | 'b'> = ['r', 'g', 'b'];
  channels.forEach(ch => {
    const minSlider = document.getElementById(`rgb-${ch}-min`) as HTMLInputElement | null;
    const maxSlider = document.getElementById(`rgb-${ch}-max`) as HTMLInputElement | null;

    if (minSlider) {
      minSlider.addEventListener('input', e => {
        const target = e.target as HTMLInputElement;
        const valueSpan = target.nextElementSibling;
        if (valueSpan) valueSpan.textContent = parseFloat(target.value).toFixed(0);
      });
      minSlider.addEventListener('change', e => {
        const target = e.target as HTMLInputElement;
        if (manager.selectedLayerId) {
          manager.setRgbStretch(
            manager.selectedLayerId,
            ch,
            parseFloat(target.value),
            layer.rgbStretch[ch].max,
            layer.rgbStretch[ch].gamma
          );
        }
      });
    }

    if (maxSlider) {
      maxSlider.addEventListener('input', e => {
        const target = e.target as HTMLInputElement;
        const valueSpan = target.nextElementSibling;
        if (valueSpan) valueSpan.textContent = parseFloat(target.value).toFixed(0);
      });
      maxSlider.addEventListener('change', e => {
        const target = e.target as HTMLInputElement;
        if (manager.selectedLayerId) {
          manager.setRgbStretch(
            manager.selectedLayerId,
            ch,
            layer.rgbStretch[ch].min,
            parseFloat(target.value),
            layer.rgbStretch[ch].gamma
          );
        }
      });
    }
  });

  const autoStretchRgbBtn = document.getElementById('auto-stretch-rgb');
  if (autoStretchRgbBtn) {
    autoStretchRgbBtn.addEventListener('click', () => {
      const rStats = layer.band_stats[layer.rgbBands.r - 1];
      const gStats = layer.band_stats[layer.rgbBands.g - 1];
      const bStats = layer.band_stats[layer.rgbBands.b - 1];

      if (rStats) layer.rgbStretch.r = { min: rStats.min, max: rStats.max, gamma: 1.0 };
      if (gStats) layer.rgbStretch.g = { min: gStats.min, max: gStats.max, gamma: 1.0 };
      if (bStats) layer.rgbStretch.b = { min: bStats.min, max: bStats.max, gamma: 1.0 };

      if (manager.selectedLayerId) {
        manager.refreshLayerTiles(manager.selectedLayerId);
        manager.updateDynamicControls();
      }
    });
  }

  const showStretchCheckbox = document.getElementById('show-rgb-stretch') as HTMLInputElement | null;
  if (showStretchCheckbox) {
    showStretchCheckbox.addEventListener('change', e => {
      const target = e.target as HTMLInputElement;
      layer.showRgbStretch = target.checked;
      const stretchControls = document.querySelectorAll('.rgb-stretch-controls');
      stretchControls.forEach(ctrl => {
        ctrl.classList.toggle('hidden', !target.checked);
      });
    });
  }

  const createRgbLayerBtn = document.getElementById('create-rgb-layer');
  if (createRgbLayerBtn) {
    createRgbLayerBtn.addEventListener('click', () => {
      if (manager.selectedLayerId) {
        manager.createRgbCompositionLayer(manager.selectedLayerId);
      }
    });
  }
}

// ==================== Drag and Drop Handlers ====================

/**
 * Handle drag start for layer reordering
 */
function handleDragStart(manager: LayerManagerWithUI, e: DragEvent, item: HTMLElement): void {
  manager.draggedItem = item;
  item.classList.add('dragging');
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
  }
}

/**
 * Handle drag over for layer reordering
 */
function handleDragOver(manager: LayerManagerWithUI, e: DragEvent, item: HTMLElement): void {
  e.preventDefault();
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'move';
  }

  if (item !== manager.draggedItem) {
    const rect = item.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (e.clientY < midY) {
      item.classList.add('drag-over-top');
      item.classList.remove('drag-over-bottom');
    } else {
      item.classList.add('drag-over-bottom');
      item.classList.remove('drag-over-top');
    }
  }
}

/**
 * Handle drop for layer reordering
 */
function handleDrop(manager: LayerManagerWithUI, e: DragEvent, item: HTMLElement): void {
  e.preventDefault();
  if (!manager.draggedItem || item === manager.draggedItem) return;

  const fromIndex = parseInt(manager.draggedItem.dataset.index || '0', 10);
  let toIndex = parseInt(item.dataset.index || '0', 10);

  const rect = item.getBoundingClientRect();
  const midY = rect.top + rect.height / 2;
  if (e.clientY > midY && toIndex > fromIndex) {
    // No adjustment needed
  } else if (e.clientY < midY && toIndex < fromIndex) {
    // No adjustment needed
  } else if (e.clientY > midY) {
    toIndex = Math.max(0, toIndex - 1);
  } else {
    toIndex = Math.min(manager.layerOrder.length - 1, toIndex + 1);
  }

  manager.reorderLayers(fromIndex, toIndex);
  item.classList.remove('drag-over-top', 'drag-over-bottom');
}

/**
 * Handle drag end for layer reordering
 */
function handleDragEnd(manager: LayerManagerWithUI): void {
  if (manager.draggedItem) {
    manager.draggedItem.classList.remove('dragging');
    manager.draggedItem = null;
  }
  document.querySelectorAll('.layer-item').forEach(item => {
    item.classList.remove('drag-over-top', 'drag-over-bottom');
  });
}
