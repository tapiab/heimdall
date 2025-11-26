import { invoke } from '@tauri-apps/api/core';
import maplibregl from 'maplibre-gl';

// Track registered protocols
const registeredProtocols = new Set();

export class LayerManager {
  constructor(mapManager) {
    this.mapManager = mapManager;
    this.layers = new Map(); // id -> layer metadata
    this.layerOrder = []; // Array of layer IDs in display order (bottom to top)
    this.tileCache = new Map(); // tile key -> image data URL
    this.draggedItem = null;
    this.selectedLayerId = null; // Currently selected layer for controls
  }

  async addRasterLayer(filePath) {
    try {
      // Open the raster in the backend
      const metadata = await invoke('open_raster', { path: filePath });
      console.log('Opened raster:', metadata);

      // Get stats for first band (default)
      const defaultBandStats = metadata.band_stats[0] || { min: 0, max: 255 };

      // Store layer info with stretch parameters
      const layerData = {
        ...metadata,
        visible: true,
        opacity: 1.0,
        type: 'raster',
        // Display mode: 'grayscale', 'rgb', or 'crossLayerRgb'
        displayMode: metadata.bands >= 3 ? 'rgb' : 'grayscale',
        // Grayscale settings
        band: 1,
        stretch: {
          min: defaultBandStats.min,
          max: defaultBandStats.max,
          gamma: 1.0,
        },
        // RGB settings
        rgbBands: { r: 1, g: 2, b: 3 },
        rgbStretch: {
          r: { min: metadata.band_stats[0]?.min || 0, max: metadata.band_stats[0]?.max || 255, gamma: 1.0 },
          g: { min: metadata.band_stats[1]?.min || 0, max: metadata.band_stats[1]?.max || 255, gamma: 1.0 },
          b: { min: metadata.band_stats[2]?.min || 0, max: metadata.band_stats[2]?.max || 255, gamma: 1.0 },
        },
      };

      // Handle non-georeferenced images
      if (!metadata.is_georeferenced) {
        // Auto-disable basemap for non-georeferenced images
        this.mapManager.setBasemap('none');
        document.getElementById('basemap-select').value = 'none';
      }

      this.layers.set(metadata.id, layerData);

      // Add to layer order (on top)
      this.layerOrder.push(metadata.id);

      // Create a unique protocol for this layer's current settings
      const protocolName = `raster-${metadata.id}`;
      this.setupTileProtocol(protocolName, metadata.id, layerData);

      // Add to map
      const sourceId = `raster-source-${metadata.id}`;
      const layerId = `raster-layer-${metadata.id}`;

      // For non-georeferenced images, use pseudo-geographic bounds
      // Map pixel coords to a valid geographic range centered at 0,0
      let mapBounds = metadata.bounds;
      if (!metadata.is_georeferenced) {
        // Scale image to fit within valid lat/lon bounds
        // Use a consistent scale: 1 pixel = 0.01 degrees (approximately 1km at equator)
        // Center the image at 0,0
        const scale = 0.01;
        const halfWidth = (metadata.width * scale) / 2;
        const halfHeight = (metadata.height * scale) / 2;
        // Clamp to valid ranges
        const clampedHalfHeight = Math.min(halfHeight, 85); // Stay within Web Mercator limits
        mapBounds = [-halfWidth, -clampedHalfHeight, halfWidth, clampedHalfHeight];
        // Store the scale for coordinate display
        layerData.pixelScale = scale;
        layerData.pixelOffset = { x: halfWidth, y: clampedHalfHeight };
        // Set pixel coordinate mode with scale info
        this.mapManager.setPixelCoordMode(true, {
          width: metadata.width,
          height: metadata.height,
          scale: scale,
          offsetX: halfWidth,
          offsetY: clampedHalfHeight,
        });
      }

      this.mapManager.addSource(sourceId, {
        type: 'raster',
        tiles: [`${protocolName}://{z}/{x}/{y}`],
        tileSize: 256,
        bounds: mapBounds,
        minzoom: 0,
        maxzoom: 22,
      });

      this.mapManager.addLayer({
        id: layerId,
        type: 'raster',
        source: sourceId,
        paint: {
          'raster-opacity': 1,
        },
      });

      // Select this layer for controls
      this.selectedLayerId = metadata.id;

      // Update UI
      this.updateLayerPanel();
      this.updateDynamicControls();

      // Fit to layer bounds
      if (!metadata.is_georeferenced) {
        // For non-geo images, fit to the scaled pseudo-geo bounds
        this.mapManager.fitBounds([
          [mapBounds[0], mapBounds[1]],
          [mapBounds[2], mapBounds[3]],
        ]);
      } else {
        this.mapManager.fitBounds([
          [metadata.bounds[0], metadata.bounds[1]],
          [metadata.bounds[2], metadata.bounds[3]],
        ]);
      }

      return metadata;
    } catch (error) {
      console.error('Failed to add raster layer:', error);
      throw error;
    }
  }

  setupTileProtocol(protocolName, datasetId, layerData) {
    // Remove existing protocol if any
    if (registeredProtocols.has(protocolName)) {
      maplibregl.removeProtocol(protocolName);
    }

    const self = this;

    maplibregl.addProtocol(protocolName, async (params, abortController) => {
      const url = params.url;
      const match = url.match(/raster-[^:]+:\/\/(\d+)\/(\d+)\/(\d+)/);

      if (!match) {
        throw new Error('Invalid raster URL format');
      }

      const [, z, x, y] = match;
      const layer = self.layers.get(datasetId);

      if (!layer) {
        throw new Error('Layer not found');
      }

      try {
        let tileData;

        if (layer.displayMode === 'crossLayerRgb' && layer.crossLayerRgb) {
          // Cross-layer RGB: get bands from different datasets
          const cross = layer.crossLayerRgb;
          const rLayer = self.layers.get(cross.rLayerId);
          const gLayer = self.layers.get(cross.gLayerId);
          const bLayer = self.layers.get(cross.bLayerId);

          if (rLayer && gLayer && bLayer) {
            // Use pixel version for non-georeferenced images
            const usePixelVersion = !rLayer.is_georeferenced || !gLayer.is_georeferenced || !bLayer.is_georeferenced;
            const command = usePixelVersion ? 'get_cross_layer_pixel_rgb_tile' : 'get_cross_layer_rgb_tile';

            tileData = await invoke(command, {
              redId: cross.rLayerId,
              redBand: cross.rBand,
              greenId: cross.gLayerId,
              greenBand: cross.gBand,
              blueId: cross.bLayerId,
              blueBand: cross.bBand,
              x: parseInt(x),
              y: parseInt(y),
              z: parseInt(z),
              redMin: rLayer.band_stats[0]?.min || 0,
              redMax: rLayer.band_stats[0]?.max || 255,
              redGamma: 1.0,
              greenMin: gLayer.band_stats[0]?.min || 0,
              greenMax: gLayer.band_stats[0]?.max || 255,
              greenGamma: 1.0,
              blueMin: bLayer.band_stats[0]?.min || 0,
              blueMax: bLayer.band_stats[0]?.max || 255,
              blueGamma: 1.0,
            });
          } else {
            // Missing layer, return empty
            return { data: new Uint8Array(0) };
          }
        } else if (layer.displayMode === 'rgb' && layer.bands >= 3) {
          // RGB mode
          tileData = await invoke('get_rgb_tile', {
            id: datasetId,
            x: parseInt(x),
            y: parseInt(y),
            z: parseInt(z),
            redBand: layer.rgbBands.r,
            greenBand: layer.rgbBands.g,
            blueBand: layer.rgbBands.b,
            redMin: layer.rgbStretch.r.min,
            redMax: layer.rgbStretch.r.max,
            redGamma: layer.rgbStretch.r.gamma,
            greenMin: layer.rgbStretch.g.min,
            greenMax: layer.rgbStretch.g.max,
            greenGamma: layer.rgbStretch.g.gamma,
            blueMin: layer.rgbStretch.b.min,
            blueMax: layer.rgbStretch.b.max,
            blueGamma: layer.rgbStretch.b.gamma,
          });
        } else {
          // Grayscale mode with stretch
          // Use pixel tile for non-georeferenced images
          if (!layer.is_georeferenced) {
            tileData = await invoke('get_pixel_tile', {
              id: datasetId,
              x: parseInt(x),
              y: parseInt(y),
              z: parseInt(z),
              band: layer.band,
              min: layer.stretch.min,
              max: layer.stretch.max,
              gamma: layer.stretch.gamma,
            });
          } else {
            tileData = await invoke('get_tile_stretched', {
              id: datasetId,
              x: parseInt(x),
              y: parseInt(y),
              z: parseInt(z),
              band: layer.band,
              min: layer.stretch.min,
              max: layer.stretch.max,
              gamma: layer.stretch.gamma,
            });
          }
        }

        return { data: new Uint8Array(tileData) };
      } catch (error) {
        console.error('Failed to load tile:', error);
        throw error;
      }
    });

    registeredProtocols.add(protocolName);
  }

  refreshLayerTiles(id) {
    const layer = this.layers.get(id);
    if (!layer) return;

    const sourceId = `raster-source-${id}`;
    const layerId = `raster-layer-${id}`;
    const protocolName = `raster-${id}`;

    // Update the protocol with new settings
    this.setupTileProtocol(protocolName, id, layer);

    // Force map to reload tiles - update tiles URL with cache buster
    const source = this.mapManager.map.getSource(sourceId);
    if (source) {
      // Add timestamp to force cache invalidation
      const cacheBuster = Date.now();
      source.setTiles([`${protocolName}://{z}/{x}/{y}?v=${cacheBuster}`]);
    }
  }

  async removeLayer(id) {
    const layer = this.layers.get(id);
    if (!layer) return;

    const sourceId = `raster-source-${id}`;
    const layerId = `raster-layer-${id}`;
    const protocolName = `raster-${id}`;

    // Remove from map
    this.mapManager.removeLayer(layerId);
    this.mapManager.removeSource(sourceId);

    // Remove protocol
    if (registeredProtocols.has(protocolName)) {
      maplibregl.removeProtocol(protocolName);
      registeredProtocols.delete(protocolName);
    }

    // Close dataset in backend
    try {
      await invoke('close_dataset', { id });
    } catch (error) {
      console.error('Failed to close dataset:', error);
    }

    // Remove from local state
    this.layers.delete(id);
    this.layerOrder = this.layerOrder.filter(lid => lid !== id);

    // Update selection
    if (this.selectedLayerId === id) {
      this.selectedLayerId = this.layerOrder.length > 0 ? this.layerOrder[this.layerOrder.length - 1] : null;
    }

    this.updateLayerPanel();
    this.updateDynamicControls();
  }

  selectLayer(id) {
    this.selectedLayerId = id;
    this.updateLayerPanel();
    this.updateDynamicControls();
  }

  toggleLayerVisibility(id) {
    const layer = this.layers.get(id);
    if (!layer) return;

    layer.visible = !layer.visible;
    const layerId = `raster-layer-${id}`;
    this.mapManager.setLayerVisibility(layerId, layer.visible);
    this.updateLayerPanel();
  }

  setLayerOpacity(id, opacity) {
    const layer = this.layers.get(id);
    if (!layer) return;

    layer.opacity = opacity;
    const layerId = `raster-layer-${id}`;
    this.mapManager.setLayerOpacity(layerId, opacity);
  }

  setLayerStretch(id, min, max, gamma) {
    const layer = this.layers.get(id);
    if (!layer) return;

    layer.stretch = { min, max, gamma };
    this.refreshLayerTiles(id);
  }

  setLayerBand(id, band) {
    const layer = this.layers.get(id);
    if (!layer) return;

    layer.band = band;
    // Update stretch to match band stats
    const bandStats = layer.band_stats[band - 1];
    if (bandStats) {
      layer.stretch.min = bandStats.min;
      layer.stretch.max = bandStats.max;
    }
    this.refreshLayerTiles(id);
    this.updateDynamicControls();
  }

  setLayerDisplayMode(id, mode) {
    const layer = this.layers.get(id);
    if (!layer) return;

    layer.displayMode = mode;
    this.refreshLayerTiles(id);
    this.updateDynamicControls();
  }

  setRgbBands(id, r, g, b) {
    const layer = this.layers.get(id);
    if (!layer) return;

    layer.rgbBands = { r, g, b };

    // Update stretch values for new bands
    const rStats = layer.band_stats[r - 1];
    const gStats = layer.band_stats[g - 1];
    const bStats = layer.band_stats[b - 1];

    if (rStats) layer.rgbStretch.r = { min: rStats.min, max: rStats.max, gamma: 1.0 };
    if (gStats) layer.rgbStretch.g = { min: gStats.min, max: gStats.max, gamma: 1.0 };
    if (bStats) layer.rgbStretch.b = { min: bStats.min, max: bStats.max, gamma: 1.0 };

    this.refreshLayerTiles(id);
    this.updateDynamicControls();
  }

  setRgbStretch(id, channel, min, max, gamma) {
    const layer = this.layers.get(id);
    if (!layer) return;

    layer.rgbStretch[channel] = { min, max, gamma };
    this.refreshLayerTiles(id);
  }

  reorderLayers(fromIndex, toIndex) {
    if (fromIndex === toIndex) return;

    const [movedId] = this.layerOrder.splice(fromIndex, 1);
    this.layerOrder.splice(toIndex, 0, movedId);

    this.applyLayerOrder();
    this.updateLayerPanel();
  }

  applyLayerOrder() {
    for (let i = 1; i < this.layerOrder.length; i++) {
      const layerId = `raster-layer-${this.layerOrder[i]}`;
      const beforeLayerId = `raster-layer-${this.layerOrder[i - 1]}`;
      this.mapManager.moveLayer(layerId, beforeLayerId);
    }
  }

  updateLayerPanel() {
    const layerList = document.getElementById('layer-list');
    if (!layerList) return;

    layerList.innerHTML = '';

    const displayOrder = [...this.layerOrder].reverse();

    displayOrder.forEach((id, displayIndex) => {
      const layer = this.layers.get(id);
      if (!layer) return;

      const item = document.createElement('div');
      item.className = 'layer-item' + (id === this.selectedLayerId ? ' selected' : '');
      item.draggable = true;
      item.dataset.layerId = id;
      item.dataset.index = this.layerOrder.length - 1 - displayIndex;

      item.addEventListener('click', (e) => {
        if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'BUTTON') {
          this.selectLayer(id);
        }
      });
      item.addEventListener('dragstart', (e) => this.handleDragStart(e, item));
      item.addEventListener('dragover', (e) => this.handleDragOver(e, item));
      item.addEventListener('drop', (e) => this.handleDrop(e, item));
      item.addEventListener('dragend', () => this.handleDragEnd());

      const headerRow = document.createElement('div');
      headerRow.className = 'layer-header';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = layer.visible;
      checkbox.addEventListener('change', () => this.toggleLayerVisibility(id));

      const name = document.createElement('span');
      name.className = 'layer-name';
      const fileName = layer.path.split('/').pop().split('\\').pop();
      name.textContent = fileName;
      name.title = `${layer.path}\n${layer.width}x${layer.height}, ${layer.bands} band(s)`;

      const removeBtn = document.createElement('button');
      removeBtn.className = 'layer-remove';
      removeBtn.textContent = '\u00d7';
      removeBtn.title = 'Remove layer';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.removeLayer(id);
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
      opacitySlider.value = Math.round(layer.opacity * 100);
      opacitySlider.addEventListener('input', (e) => {
        this.setLayerOpacity(id, parseInt(e.target.value) / 100);
      });

      opacityRow.appendChild(opacityLabel);
      opacityRow.appendChild(opacitySlider);

      item.appendChild(headerRow);
      item.appendChild(opacityRow);
      layerList.appendChild(item);
    });

    const fitBoundsBtn = document.getElementById('fit-bounds');
    if (fitBoundsBtn) {
      fitBoundsBtn.disabled = this.layers.size === 0;
    }
  }

  updateDynamicControls() {
    const controlsPanel = document.getElementById('dynamic-controls');
    if (!controlsPanel) return;

    const layer = this.selectedLayerId ? this.layers.get(this.selectedLayerId) : null;

    if (!layer) {
      controlsPanel.innerHTML = '<div class="no-layer-selected">Select a layer to adjust</div>';
      return;
    }

    const bandOptions = Array.from({ length: layer.bands }, (_, i) =>
      `<option value="${i + 1}" ${layer.band === i + 1 ? 'selected' : ''}>Band ${i + 1}</option>`
    ).join('');

    // Check if we have multiple single-band layers for cross-layer RGB
    const singleBandLayers = Array.from(this.layers.values()).filter(l => l.bands === 1);
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
      const bandStats = layer.band_stats[layer.band - 1] || { min: 0, max: 255 };
      controlsHtml += `
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
      `;
    } else if (layer.displayMode === 'crossLayerRgb') {
      // Cross-layer RGB mode - select layers for each channel
      const layerOptions = (selectedId) => {
        let opts = '<option value="">-- Select Layer --</option>';
        for (const [id, l] of this.layers) {
          const name = l.path.split('/').pop().split('\\').pop();
          opts += `<option value="${id}" ${selectedId === id ? 'selected' : ''}>${name}</option>`;
        }
        return opts;
      };

      // Initialize crossLayerRgb settings if not present
      if (!layer.crossLayerRgb) {
        layer.crossLayerRgb = {
          rLayerId: null, rBand: 1,
          gLayerId: null, gBand: 1,
          bLayerId: null, bBand: 1,
        };
      }

      controlsHtml += `
        <div class="control-section">
          <p style="font-size: 11px; color: #888; margin-bottom: 8px;">Select layers for each RGB channel:</p>
          <div class="rgb-channel-group">
            <div class="rgb-row">
              <span class="rgb-label r">R</span>
              <select id="cross-r-layer">${layerOptions(layer.crossLayerRgb.rLayerId)}</select>
            </div>
          </div>
          <div class="rgb-channel-group">
            <div class="rgb-row">
              <span class="rgb-label g">G</span>
              <select id="cross-g-layer">${layerOptions(layer.crossLayerRgb.gLayerId)}</select>
            </div>
          </div>
          <div class="rgb-channel-group">
            <div class="rgb-row">
              <span class="rgb-label b">B</span>
              <select id="cross-b-layer">${layerOptions(layer.crossLayerRgb.bLayerId)}</select>
            </div>
          </div>
        </div>
        <button id="apply-cross-rgb" class="control-btn">Apply Cross-Layer RGB</button>
      `;
    } else {
      // RGB mode controls
      const rgbBandOptions = (selected) => Array.from({ length: layer.bands }, (_, i) =>
        `<option value="${i + 1}" ${selected === i + 1 ? 'selected' : ''}>Band ${i + 1}</option>`
      ).join('');

      // Get stats for current RGB bands
      const rStats = layer.band_stats[layer.rgbBands.r - 1] || { min: 0, max: 255 };
      const gStats = layer.band_stats[layer.rgbBands.g - 1] || { min: 0, max: 255 };
      const bStats = layer.band_stats[layer.rgbBands.b - 1] || { min: 0, max: 255 };

      controlsHtml += `
        <div class="control-section rgb-bands">
          <div class="rgb-channel-group">
            <div class="rgb-row">
              <span class="rgb-label r">R</span>
              <select id="rgb-r">${rgbBandOptions(layer.rgbBands.r)}</select>
            </div>
            <div class="rgb-stretch-controls">
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
            <div class="rgb-stretch-controls">
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
            <div class="rgb-stretch-controls">
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
        <button id="auto-stretch-rgb" class="control-btn">Auto Stretch All</button>
      `;
    }

    controlsPanel.innerHTML = controlsHtml;

    // Attach event listeners
    const displayModeSelect = document.getElementById('display-mode');
    if (displayModeSelect) {
      displayModeSelect.addEventListener('change', (e) => {
        this.setLayerDisplayMode(this.selectedLayerId, e.target.value);
      });
    }

    if (layer.displayMode === 'grayscale') {
      const bandSelect = document.getElementById('band-select');
      if (bandSelect) {
        bandSelect.addEventListener('change', (e) => {
          this.setLayerBand(this.selectedLayerId, parseInt(e.target.value));
        });
      }

      const minSlider = document.getElementById('stretch-min');
      const maxSlider = document.getElementById('stretch-max');
      const gammaSlider = document.getElementById('stretch-gamma');

      if (minSlider) {
        minSlider.addEventListener('input', (e) => {
          const min = parseFloat(e.target.value);
          e.target.previousElementSibling.querySelector('.value-display').textContent = min.toFixed(1);
        });
        minSlider.addEventListener('change', (e) => {
          const min = parseFloat(e.target.value);
          this.setLayerStretch(this.selectedLayerId, min, layer.stretch.max, layer.stretch.gamma);
        });
      }

      if (maxSlider) {
        maxSlider.addEventListener('input', (e) => {
          const max = parseFloat(e.target.value);
          e.target.previousElementSibling.querySelector('.value-display').textContent = max.toFixed(1);
        });
        maxSlider.addEventListener('change', (e) => {
          const max = parseFloat(e.target.value);
          this.setLayerStretch(this.selectedLayerId, layer.stretch.min, max, layer.stretch.gamma);
        });
      }

      if (gammaSlider) {
        gammaSlider.addEventListener('input', (e) => {
          const gamma = parseFloat(e.target.value);
          e.target.previousElementSibling.querySelector('.value-display').textContent = gamma.toFixed(2);
        });
        gammaSlider.addEventListener('change', (e) => {
          const gamma = parseFloat(e.target.value);
          this.setLayerStretch(this.selectedLayerId, layer.stretch.min, layer.stretch.max, gamma);
        });
      }

      const autoStretchBtn = document.getElementById('auto-stretch');
      if (autoStretchBtn) {
        autoStretchBtn.addEventListener('click', () => {
          const bandStats = layer.band_stats[layer.band - 1];
          if (bandStats) {
            this.setLayerStretch(this.selectedLayerId, bandStats.min, bandStats.max, 1.0);
            this.updateDynamicControls();
          }
        });
      }
    } else if (layer.displayMode === 'crossLayerRgb') {
      // Cross-layer RGB event listeners
      const applyBtn = document.getElementById('apply-cross-rgb');
      if (applyBtn) {
        applyBtn.addEventListener('click', () => {
          const rLayerId = document.getElementById('cross-r-layer').value;
          const gLayerId = document.getElementById('cross-g-layer').value;
          const bLayerId = document.getElementById('cross-b-layer').value;

          if (rLayerId && gLayerId && bLayerId) {
            layer.crossLayerRgb = {
              rLayerId, rBand: 1,
              gLayerId, gBand: 1,
              bLayerId, bBand: 1,
            };
            this.refreshLayerTiles(this.selectedLayerId);
          } else {
            alert('Please select a layer for each RGB channel');
          }
        });
      }
    } else {
      // RGB mode event listeners
      const rgbR = document.getElementById('rgb-r');
      const rgbG = document.getElementById('rgb-g');
      const rgbB = document.getElementById('rgb-b');

      if (rgbR && rgbG && rgbB) {
        const updateRgbBands = () => {
          this.setRgbBands(
            this.selectedLayerId,
            parseInt(rgbR.value),
            parseInt(rgbG.value),
            parseInt(rgbB.value)
          );
        };
        rgbR.addEventListener('change', updateRgbBands);
        rgbG.addEventListener('change', updateRgbBands);
        rgbB.addEventListener('change', updateRgbBands);
      }

      // Per-channel stretch sliders
      const channels = ['r', 'g', 'b'];
      channels.forEach(ch => {
        const minSlider = document.getElementById(`rgb-${ch}-min`);
        const maxSlider = document.getElementById(`rgb-${ch}-max`);

        if (minSlider) {
          minSlider.addEventListener('input', (e) => {
            e.target.nextElementSibling.textContent = parseFloat(e.target.value).toFixed(0);
          });
          minSlider.addEventListener('change', (e) => {
            this.setRgbStretch(this.selectedLayerId, ch, parseFloat(e.target.value), layer.rgbStretch[ch].max, layer.rgbStretch[ch].gamma);
          });
        }

        if (maxSlider) {
          maxSlider.addEventListener('input', (e) => {
            e.target.nextElementSibling.textContent = parseFloat(e.target.value).toFixed(0);
          });
          maxSlider.addEventListener('change', (e) => {
            this.setRgbStretch(this.selectedLayerId, ch, layer.rgbStretch[ch].min, parseFloat(e.target.value), layer.rgbStretch[ch].gamma);
          });
        }
      });

      const autoStretchRgbBtn = document.getElementById('auto-stretch-rgb');
      if (autoStretchRgbBtn) {
        autoStretchRgbBtn.addEventListener('click', () => {
          // Reset all RGB stretches to band stats
          const rStats = layer.band_stats[layer.rgbBands.r - 1];
          const gStats = layer.band_stats[layer.rgbBands.g - 1];
          const bStats = layer.band_stats[layer.rgbBands.b - 1];

          if (rStats) layer.rgbStretch.r = { min: rStats.min, max: rStats.max, gamma: 1.0 };
          if (gStats) layer.rgbStretch.g = { min: gStats.min, max: gStats.max, gamma: 1.0 };
          if (bStats) layer.rgbStretch.b = { min: bStats.min, max: bStats.max, gamma: 1.0 };

          this.refreshLayerTiles(this.selectedLayerId);
          this.updateDynamicControls();
        });
      }
    }
  }

  handleDragStart(e, item) {
    this.draggedItem = item;
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  }

  handleDragOver(e, item) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    if (item !== this.draggedItem) {
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

  handleDrop(e, item) {
    e.preventDefault();
    if (!this.draggedItem || item === this.draggedItem) return;

    const fromIndex = parseInt(this.draggedItem.dataset.index);
    let toIndex = parseInt(item.dataset.index);

    const rect = item.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (e.clientY > midY && toIndex > fromIndex) {
    } else if (e.clientY < midY && toIndex < fromIndex) {
    } else if (e.clientY > midY) {
      toIndex = Math.max(0, toIndex - 1);
    } else {
      toIndex = Math.min(this.layerOrder.length - 1, toIndex + 1);
    }

    this.reorderLayers(fromIndex, toIndex);
    item.classList.remove('drag-over-top', 'drag-over-bottom');
  }

  handleDragEnd() {
    if (this.draggedItem) {
      this.draggedItem.classList.remove('dragging');
      this.draggedItem = null;
    }
    document.querySelectorAll('.layer-item').forEach(item => {
      item.classList.remove('drag-over-top', 'drag-over-bottom');
    });
  }

  fitToAllLayers() {
    if (this.layers.size === 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (const layer of this.layers.values()) {
      minX = Math.min(minX, layer.bounds[0]);
      minY = Math.min(minY, layer.bounds[1]);
      maxX = Math.max(maxX, layer.bounds[2]);
      maxY = Math.max(maxY, layer.bounds[3]);
    }

    this.mapManager.fitBounds([
      [minX, minY],
      [maxX, maxY],
    ]);
  }
}
