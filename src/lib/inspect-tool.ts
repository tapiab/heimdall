/**
 * Inspect Tool - Click to query pixel values from raster layers
 *
 * This tool allows users to click on raster layers and view the underlying
 * pixel values for all bands at that location. Supports both georeferenced
 * and non-georeferenced (pixel coordinate) images.
 *
 * @module inspect-tool
 */

import { invoke } from '@tauri-apps/api/core';
import maplibregl, {
  type Map as MapLibreMap,
  type MapMouseEvent,
  type Popup,
  type LngLat,
} from 'maplibre-gl';

/**
 * Pixel extent information for non-georeferenced images
 */
interface PixelExtent {
  /** Scale factor from pixels to map units */
  scale?: number;
  /** X offset for coordinate transformation */
  offsetX?: number;
  /** Y offset for coordinate transformation */
  offsetY?: number;
}

/**
 * MapManager interface for map operations
 */
interface MapManager {
  /** The underlying MapLibre GL map instance */
  map: MapLibreMap;
  /** Check if currently in pixel coordinate mode */
  isPixelCoordMode: () => boolean;
  /** Current pixel extent configuration */
  pixelExtent: PixelExtent | null;
}

/**
 * Raster layer data structure
 */
interface RasterLayer {
  /** Unique layer identifier */
  id: string;
  /** Layer type discriminator */
  type: 'raster';
  /** Whether layer is currently visible */
  visible: boolean;
  /** Geographic bounds [minX, minY, maxX, maxY] */
  bounds: [number, number, number, number] | null;
  /** File path to the raster source */
  path: string;
  /** Optional display name override */
  displayName?: string;
}

/**
 * LayerManager interface for layer operations
 */
interface LayerManager {
  /** Ordered list of layer IDs (bottom to top) */
  layerOrder: string[];
  /** Map of layer ID to layer data */
  layers: Map<string, RasterLayer>;
}

/**
 * Single band value from pixel query
 */
interface BandValue {
  /** Band number (1-indexed) */
  band: number;
  /** Pixel value at the queried location */
  value: number;
  /** Whether this is a NoData value */
  is_nodata: boolean;
}

/**
 * Result from querying a pixel location
 */
interface PixelQueryResult {
  /** Pixel X coordinate */
  x: number;
  /** Pixel Y coordinate */
  y: number;
  /** Whether the query returned valid data */
  is_valid: boolean;
  /** Values for each band at this location */
  values: BandValue[];
}

/**
 * InspectTool allows users to query pixel values from raster layers by clicking.
 *
 * Features:
 * - Click on any visible raster layer to see band values
 * - Supports georeferenced images (lat/lng click) and non-georeferenced (pixel coordinates)
 * - Shows NoData values and handles out-of-bounds clicks
 * - Queries the topmost visible raster layer at click location
 *
 * @example
 * ```typescript
 * const inspectTool = new InspectTool(mapManager, layerManager);
 * inspectTool.activate();
 * // User clicks on map...
 * inspectTool.deactivate();
 * ```
 */
export class InspectTool {
  private mapManager: MapManager;
  private layerManager: LayerManager;
  private map: MapLibreMap;
  private active: boolean;
  private popup: Popup | null;

  /**
   * Create a new InspectTool instance
   * @param mapManager - The MapManager instance for map access
   * @param layerManager - The LayerManager instance for layer queries
   */
  constructor(mapManager: MapManager, layerManager: LayerManager) {
    this.mapManager = mapManager;
    this.layerManager = layerManager;
    this.map = mapManager.map;
    this.active = false;
    this.popup = null;
    this.handleClick = this.handleClick.bind(this);
    this.handleMouseMove = this.handleMouseMove.bind(this);
  }

  /**
   * Activate the inspect tool
   * Sets up click handlers and changes cursor to crosshair
   */
  activate(): void {
    if (this.active) return;
    this.active = true;
    this.map.getCanvas().style.cursor = 'crosshair';
    this.map.on('click', this.handleClick);
    this.map.on('mousemove', this.handleMouseMove);
    this.showInstruction();
  }

  /**
   * Deactivate the inspect tool
   * Removes click handlers, resets cursor, and clears any open popup
   */
  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.map.getCanvas().style.cursor = '';
    this.map.off('click', this.handleClick);
    this.map.off('mousemove', this.handleMouseMove);
    this.hideInstruction();
    this.clearPopup();
  }

  /**
   * Toggle the inspect tool on/off
   * @returns True if tool is now active, false if deactivated
   */
  toggle(): boolean {
    if (this.active) {
      this.deactivate();
    } else {
      this.activate();
    }
    return this.active;
  }

  /**
   * Check if the inspect tool is currently active
   * @returns True if tool is active
   */
  isActive(): boolean {
    return this.active;
  }

  private showInstruction(): void {
    let instruction = document.getElementById('inspect-instruction') as HTMLDivElement | null;
    if (!instruction) {
      instruction = document.createElement('div');
      instruction.id = 'inspect-instruction';
      instruction.textContent = 'Click on a raster layer to inspect pixel values';
      document.body.appendChild(instruction);
    }
    instruction.style.display = 'block';
  }

  private hideInstruction(): void {
    const instruction = document.getElementById('inspect-instruction');
    if (instruction) {
      instruction.style.display = 'none';
    }
  }

  private handleMouseMove(_e: MapMouseEvent): void {
    // Update cursor position display if needed
  }

  private async handleClick(e: MapMouseEvent): Promise<void> {
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

  private getRasterLayersAtPoint(lng: number, lat: number): RasterLayer[] {
    const layers: RasterLayer[] = [];

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

  private isPointInBounds(
    lng: number,
    lat: number,
    bounds: [number, number, number, number] | null
  ): boolean {
    if (!bounds || bounds.length !== 4) return false;
    const [minX, minY, maxX, maxY] = bounds;
    return lng >= minX && lng <= maxX && lat >= minY && lat <= maxY;
  }

  private async queryAndShowPixelValues(
    layer: RasterLayer,
    lng: number,
    lat: number,
    lngLat: LngLat
  ): Promise<void> {
    try {
      let result: PixelQueryResult;

      if (this.mapManager.isPixelCoordMode() && this.mapManager.pixelExtent) {
        // Convert map coordinates to pixel coordinates
        const extent = this.mapManager.pixelExtent;
        const scale = extent.scale || 0.01;
        const offsetX = extent.offsetX || 0;
        const offsetY = extent.offsetY || 0;

        const pixelX = Math.floor((lng + offsetX) / scale);
        const pixelY = Math.floor((offsetY - lat) / scale);

        result = await invoke<PixelQueryResult>('query_pixel_value_at_pixel', {
          id: layer.id,
          pixel_x: pixelX,
          pixel_y: pixelY,
        });
      } else {
        result = await invoke<PixelQueryResult>('query_pixel_value', {
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

  private showPixelValuePopup(result: PixelQueryResult, layer: RasterLayer, lngLat: LngLat): void {
    this.clearPopup();

    const fileName =
      layer.displayName || layer.path.split('/').pop()?.split('\\').pop() || 'Unknown';

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

  private showNoDataPopup(lngLat: LngLat): void {
    this.clearPopup();

    this.popup = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: false,
      className: 'inspect-popup-container',
    })
      .setLngLat(lngLat)
      .setHTML(
        '<div class="inspect-popup"><div class="inspect-nodata">No raster layer at this location</div></div>'
      )
      .addTo(this.map);
  }

  private showErrorPopup(error: unknown, lngLat: LngLat): void {
    this.clearPopup();

    const errorMessage = error instanceof Error ? error.message : String(error);

    this.popup = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: false,
      className: 'inspect-popup-container',
    })
      .setLngLat(lngLat)
      .setHTML(`<div class="inspect-popup"><div class="inspect-error">Error: ${errorMessage}</div></div>`)
      .addTo(this.map);
  }

  private clearPopup(): void {
    if (this.popup) {
      this.popup.remove();
      this.popup = null;
    }
  }

  private formatValue(value: number): string {
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
