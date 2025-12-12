/**
 * Inspect Tool - Click to query pixel values from raster layers
 */

import { invoke } from '@tauri-apps/api/core';
import maplibregl from 'maplibre-gl';

export class InspectTool {
  constructor(mapManager, layerManager) {
    this.mapManager = mapManager;
    this.layerManager = layerManager;
    this.map = mapManager.map;
    this.active = false;
    this.popup = null;
    this.clickHandler = this.handleClick.bind(this);
    this.moveHandler = this.handleMouseMove.bind(this);
  }

  activate() {
    if (this.active) return;
    this.active = true;
    this.map.getCanvas().style.cursor = 'crosshair';
    this.map.on('click', this.clickHandler);
    this.map.on('mousemove', this.moveHandler);
    this.showInstruction();
  }

  deactivate() {
    if (!this.active) return;
    this.active = false;
    this.map.getCanvas().style.cursor = '';
    this.map.off('click', this.clickHandler);
    this.map.off('mousemove', this.moveHandler);
    this.hideInstruction();
    this.clearPopup();
  }

  toggle() {
    if (this.active) {
      this.deactivate();
    } else {
      this.activate();
    }
    return this.active;
  }

  isActive() {
    return this.active;
  }

  showInstruction() {
    let instruction = document.getElementById('inspect-instruction');
    if (!instruction) {
      instruction = document.createElement('div');
      instruction.id = 'inspect-instruction';
      instruction.textContent = 'Click on a raster layer to inspect pixel values';
      document.body.appendChild(instruction);
    }
    instruction.style.display = 'block';
  }

  hideInstruction() {
    const instruction = document.getElementById('inspect-instruction');
    if (instruction) {
      instruction.style.display = 'none';
    }
  }

  handleMouseMove(e) {
    // Update cursor position display if needed
  }

  async handleClick(e) {
    const { lng, lat } = e.lngLat;

    // Find raster layers at this location
    const rasterLayers = this.getRasterLayersAtPoint(lng, lat);

    if (rasterLayers.length === 0) {
      this.showNoDataPopup(e.lngLat);
      return;
    }

    // Query pixel values from the topmost visible raster layer
    const layer = rasterLayers[0];
    await this.queryAndShowPixelValues(layer, lng, lat, e.lngLat);
  }

  getRasterLayersAtPoint(lng, lat) {
    const layers = [];

    // Get all raster layers in render order (top to bottom)
    const layerOrder = [...this.layerManager.layerOrder].reverse();

    for (const id of layerOrder) {
      const layer = this.layerManager.layers.get(id);
      if (!layer || layer.type !== 'raster' || !layer.visible) continue;

      // Check if point is within layer bounds
      if (this.isPointInBounds(lng, lat, layer.bounds)) {
        layers.push(layer);
      }
    }

    return layers;
  }

  isPointInBounds(lng, lat, bounds) {
    if (!bounds || bounds.length !== 4) return false;
    const [minX, minY, maxX, maxY] = bounds;
    return lng >= minX && lng <= maxX && lat >= minY && lat <= maxY;
  }

  async queryAndShowPixelValues(layer, lng, lat, lngLat) {
    try {
      let result;

      if (this.mapManager.isPixelCoordMode() && this.mapManager.pixelExtent) {
        // Convert map coordinates to pixel coordinates
        const extent = this.mapManager.pixelExtent;
        const scale = extent.scale || 0.01;
        const offsetX = extent.offsetX || 0;
        const offsetY = extent.offsetY || 0;

        const pixelX = Math.floor((lng + offsetX) / scale);
        const pixelY = Math.floor((offsetY - lat) / scale);

        result = await invoke('query_pixel_value_at_pixel', {
          id: layer.id,
          pixel_x: pixelX,
          pixel_y: pixelY,
        });
      } else {
        result = await invoke('query_pixel_value', {
          id: layer.id,
          lng,
          lat,
        });
      }

      this.showPixelValuePopup(result, layer, lngLat);
    } catch (error) {
      console.error('Failed to query pixel value:', error);
      this.showErrorPopup(error, lngLat);
    }
  }

  showPixelValuePopup(result, layer, lngLat) {
    this.clearPopup();

    const fileName = layer.displayName || layer.path.split('/').pop().split('\\').pop();

    let html = `
      <div class="inspect-popup">
        <div class="inspect-header">${fileName}</div>
        <div class="inspect-coords">Pixel: (${result.x}, ${result.y})</div>
    `;

    if (!result.is_valid) {
      html += '<div class="inspect-nodata">Outside raster bounds</div>';
    } else if (result.values.length === 0) {
      html += '<div class="inspect-nodata">No data</div>';
    } else {
      html += '<div class="inspect-values">';
      for (const bandValue of result.values) {
        const valueStr = bandValue.is_nodata
          ? '<span class="nodata-value">NoData</span>'
          : this.formatValue(bandValue.value);
        html += `
          <div class="inspect-band">
            <span class="band-label">Band ${bandValue.band}:</span>
            <span class="band-value">${valueStr}</span>
          </div>
        `;
      }
      html += '</div>';
    }

    html += '</div>';

    this.popup = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: false,
      className: 'inspect-popup-container',
    })
      .setLngLat(lngLat)
      .setHTML(html)
      .addTo(this.map);
  }

  showNoDataPopup(lngLat) {
    this.clearPopup();

    this.popup = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: false,
      className: 'inspect-popup-container',
    })
      .setLngLat(lngLat)
      .setHTML('<div class="inspect-popup"><div class="inspect-nodata">No raster layer at this location</div></div>')
      .addTo(this.map);
  }

  showErrorPopup(error, lngLat) {
    this.clearPopup();

    this.popup = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: false,
      className: 'inspect-popup-container',
    })
      .setLngLat(lngLat)
      .setHTML(`<div class="inspect-popup"><div class="inspect-error">Error: ${error.message || error}</div></div>`)
      .addTo(this.map);
  }

  clearPopup() {
    if (this.popup) {
      this.popup.remove();
      this.popup = null;
    }
  }

  formatValue(value) {
    // Format number based on its magnitude
    if (Number.isInteger(value)) {
      return value.toString();
    }
    if (Math.abs(value) >= 1000 || Math.abs(value) < 0.01) {
      return value.toExponential(4);
    }
    return value.toFixed(4);
  }
}
