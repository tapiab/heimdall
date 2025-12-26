/**
 * MapManager handles the MapLibre GL map instance and basemap management.
 * Provides methods for map initialization, basemap switching, terrain control,
 * and layer management operations.
 */

import maplibregl, {
  type Map as MapLibreMap,
  type LngLatBoundsLike,
  type SourceSpecification,
  type LayerSpecification,
  type FitBoundsOptions,
} from 'maplibre-gl';

// MapLibre error event type (not exported from the package)
interface MapErrorEvent {
  error: Error;
}
import { logger } from './logger';
import type { BasemapConfig } from '../types/config';

const log = logger.child('MapManager');

// Default satellite basemap (open source friendly - CC BY 4.0)
const DEFAULT_SATELLITE: BasemapConfig = {
  url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg',
  attribution: 'Sentinel-2 cloudless by EOX - CC BY 4.0',
  name: 'Sentinel-2 Cloudless',
};

type BasemapType = 'osm' | 'satellite' | 'custom' | 'pixel' | 'none';

interface PixelExtent {
  width: number;
  height: number;
  scale: number;
  offsetX: number;
  offsetY: number;
}

interface TerrainResult {
  success: boolean;
  enabled?: boolean;
  error?: string;
}

interface ConfigManager {
  getSatelliteConfig: () => BasemapConfig | null;
  getCustomConfig: () => BasemapConfig | null;
}

export class MapManager {
  private containerId: string;
  private configManager: ConfigManager | null;
  map: MapLibreMap | null;
  private basemapVisible: boolean;
  private currentBasemap: BasemapType;
  private previousBasemap: BasemapType;
  pixelCoordMode: boolean;
  pixelExtent: PixelExtent | null;
  terrainEnabled: boolean;
  terrainExaggeration: number;
  private pixelGridCanvas: HTMLCanvasElement | null;
  private _terrainErrorHandlerBound: boolean;
  private _boundTerrainErrorHandler: ((e: MapErrorEvent) => void) | null;

  /**
   * Create a new MapManager instance
   * @param containerId - DOM element ID for the map container
   * @param configManager - Optional config manager for custom basemaps
   */
  constructor(containerId: string, configManager: ConfigManager | null = null) {
    this.containerId = containerId;
    this.configManager = configManager;
    this.map = null;
    this.basemapVisible = true;
    this.currentBasemap = 'osm';
    this.previousBasemap = 'osm';
    this.pixelCoordMode = false;
    this.pixelExtent = null;
    this.terrainEnabled = false;
    this.terrainExaggeration = 1.5;
    this.pixelGridCanvas = null;
    this._terrainErrorHandlerBound = false;
    this._boundTerrainErrorHandler = null;
  }

  /**
   * Initialize the map with default settings and basemaps
   * @returns Resolves when map is loaded and ready
   */
  async init(): Promise<void> {
    // Get satellite config from config manager or use defaults
    const satelliteConfig = this.configManager?.getSatelliteConfig() || DEFAULT_SATELLITE;
    const customConfig = this.configManager?.getCustomConfig();

    const sources: Record<string, SourceSpecification> = {
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        attribution: '&copy; OpenStreetMap contributors',
      },
      satellite: {
        type: 'raster',
        tiles: [satelliteConfig.url],
        tileSize: 256,
        attribution: satelliteConfig.attribution,
      },
    };

    // Add custom basemap source if configured
    if (customConfig?.url) {
      sources.custom = {
        type: 'raster',
        tiles: [customConfig.url],
        tileSize: 256,
        attribution: customConfig.attribution || '',
      };
    }

    const layers: LayerSpecification[] = [
      {
        id: 'osm-tiles',
        type: 'raster',
        source: 'osm',
        minzoom: 0,
        maxzoom: 19,
      },
      {
        id: 'satellite-tiles',
        type: 'raster',
        source: 'satellite',
        minzoom: 0,
        maxzoom: 19,
        layout: { visibility: 'none' },
      },
    ];

    // Add custom basemap layer if configured
    if (customConfig?.url) {
      layers.push({
        id: 'custom-tiles',
        type: 'raster',
        source: 'custom',
        minzoom: 0,
        maxzoom: 19,
        layout: { visibility: 'none' },
      });
    }

    this.map = new maplibregl.Map({
      container: this.containerId,
      style: {
        version: 8,
        sources,
        layers,
      },
      center: [0, 0],
      zoom: 2,
      maxZoom: 22,
      maxPitch: 85,
      dragRotate: true,
      touchZoomRotate: true,
      pitchWithRotate: true,
    });

    // Add navigation controls
    this.map.addControl(
      new maplibregl.NavigationControl({
        showCompass: true,
        showZoom: true,
        visualizePitch: false,
      }),
      'top-right'
    );

    // Wait for map to load
    return new Promise(resolve => {
      this.map!.on('load', () => {
        this.setupEventListeners();
        resolve();
      });
    });
  }

  private setupEventListeners(): void {
    if (!this.map) return;

    // Update coordinates on mouse move
    this.map.on('mousemove', e => {
      const coordsEl = document.getElementById('coordinates');
      if (coordsEl) {
        if (this.pixelCoordMode && this.pixelExtent) {
          // Convert map coords back to pixel coords using the scale
          const { lng, lat } = e.lngLat;
          const scale = this.pixelExtent.scale || 0.01;
          const offsetX = this.pixelExtent.offsetX || 0;
          const offsetY = this.pixelExtent.offsetY || 0;
          // Map coords to pixels: x = (lng + offset) / scale, y = (offset - lat) / scale (inverted)
          const x = Math.round((lng + offsetX) / scale);
          const y = Math.round((offsetY - lat) / scale);
          coordsEl.textContent = `Pixel: ${x}, ${y}`;
        } else {
          const { lng, lat } = e.lngLat;
          coordsEl.textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
        }
      }
    });

    // Update zoom level
    this.map.on('zoom', () => {
      this.updateZoomDisplay();
    });

    // Update bearing display
    this.map.on('rotate', () => {
      this.updateBearingDisplay();
    });

    // Update pitch display
    this.map.on('pitch', () => {
      this.updatePitchDisplay();
    });

    // Initial displays
    this.updateZoomDisplay();
    this.updateBearingDisplay();
    this.updatePitchDisplay();
  }

  private updateZoomDisplay(): void {
    const zoomEl = document.getElementById('zoom-level');
    if (zoomEl && this.map) {
      zoomEl.textContent = `Zoom: ${this.map.getZoom().toFixed(2)}`;
    }
  }

  private updateBearingDisplay(): void {
    if (!this.map) return;

    const bearing = this.map.getBearing();
    const bearingEl = document.getElementById('bearing');
    if (bearingEl) {
      bearingEl.textContent = `${bearing.toFixed(1)}°`;
    }

    // Update compass indicator rotation
    const compassEl = document.getElementById('compass-arrow');
    if (compassEl) {
      compassEl.style.transform = `rotate(${-bearing}deg)`;
    }
  }

  resetNorth(): void {
    this.map?.easeTo({ bearing: 0, pitch: 0 });
  }

  getBearing(): number {
    return this.map?.getBearing() ?? 0;
  }

  fitBounds(bounds: LngLatBoundsLike, options: FitBoundsOptions = {}): void {
    this.map?.fitBounds(bounds, {
      padding: 50,
      ...options,
    });
  }

  addSource(id: string, source: SourceSpecification): void {
    if (this.map && !this.map.getSource(id)) {
      this.map.addSource(id, source);
    }
  }

  removeSource(id: string): void {
    if (this.map?.getSource(id)) {
      this.map.removeSource(id);
    }
  }

  addLayer(layer: LayerSpecification, beforeId?: string): void {
    if (this.map && !this.map.getLayer(layer.id)) {
      this.map.addLayer(layer, beforeId);
    }
  }

  removeLayer(id: string): void {
    if (this.map?.getLayer(id)) {
      this.map.removeLayer(id);
    }
  }

  moveLayer(id: string, beforeId?: string): void {
    if (this.map?.getLayer(id)) {
      this.map.moveLayer(id, beforeId);
    }
  }

  setLayerVisibility(id: string, visible: boolean): void {
    if (this.map?.getLayer(id)) {
      this.map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
  }

  setLayerOpacity(id: string, opacity: number): void {
    if (this.map?.getLayer(id)) {
      this.map.setPaintProperty(id, 'raster-opacity', opacity);
    }
  }

  toggleBasemap(): boolean {
    this.basemapVisible = !this.basemapVisible;
    if (this.basemapVisible) {
      this.setBasemap(this.currentBasemap);
    } else {
      this.setLayerVisibility('osm-tiles', false);
      this.setLayerVisibility('satellite-tiles', false);
      this.setLayerVisibility('custom-tiles', false);
    }
    return this.basemapVisible;
  }

  setBasemap(type: BasemapType): void {
    this.currentBasemap = type;

    if (type === 'none') {
      this.basemapVisible = false;
      this.setLayerVisibility('osm-tiles', false);
      this.setLayerVisibility('satellite-tiles', false);
      this.setLayerVisibility('custom-tiles', false);
      this.setLayerVisibility('pixel-grid', false);
    } else if (type === 'pixel') {
      this.basemapVisible = true;
      this.setLayerVisibility('osm-tiles', false);
      this.setLayerVisibility('satellite-tiles', false);
      this.setLayerVisibility('custom-tiles', false);
      this.setLayerVisibility('pixel-grid', true);
    } else {
      this.basemapVisible = true;
      this.setLayerVisibility('osm-tiles', type === 'osm');
      this.setLayerVisibility('satellite-tiles', type === 'satellite');
      this.setLayerVisibility('custom-tiles', type === 'custom');
      this.setLayerVisibility('pixel-grid', false);
    }
  }

  /**
   * Check if a custom basemap is available
   */
  hasCustomBasemap(): boolean {
    return !!this.map?.getSource('custom');
  }

  /**
   * Update or add a custom basemap source
   */
  setCustomBasemapSource(url: string, attribution: string = ''): void {
    if (!url || !this.map) return;

    // Remove existing custom source and layer if they exist
    if (this.map.getLayer('custom-tiles')) {
      this.map.removeLayer('custom-tiles');
    }
    if (this.map.getSource('custom')) {
      this.map.removeSource('custom');
    }

    // Add new custom source
    this.map.addSource('custom', {
      type: 'raster',
      tiles: [url],
      tileSize: 256,
      attribution,
    });

    // Add custom layer
    this.map.addLayer({
      id: 'custom-tiles',
      type: 'raster',
      source: 'custom',
      minzoom: 0,
      maxzoom: 19,
      layout: { visibility: 'none' },
    });

    log.info('Custom basemap source updated', { url });
  }

  getBasemap(): string {
    return this.basemapVisible ? this.currentBasemap : 'none';
  }

  isBasemapVisible(): boolean {
    return this.basemapVisible;
  }

  setPixelCoordMode(enabled: boolean, extent: PixelExtent | null = null): void {
    this.pixelCoordMode = enabled;
    this.pixelExtent = extent;

    if (enabled) {
      // Disable terrain when in pixel coordinate mode
      if (this.terrainEnabled) {
        this.disableTerrain();
      }
      // Store the previous basemap and switch to pixel grid
      if (this.currentBasemap !== 'pixel' && this.currentBasemap !== 'none') {
        this.previousBasemap = this.currentBasemap;
      }
      // Create and show pixel grid basemap
      if (extent) {
        this.createPixelGridBasemap(extent);
        this.setBasemap('pixel');
        // Update basemap selector UI
        const basemapSelect = document.getElementById('basemap-select') as HTMLSelectElement | null;
        if (basemapSelect) {
          basemapSelect.value = 'pixel';
        }
      }
    } else {
      // Remove pixel grid and restore previous basemap
      this.removePixelGridBasemap();
      if (this.previousBasemap && this.previousBasemap !== 'pixel') {
        this.setBasemap(this.previousBasemap);
        // Update basemap selector UI
        const basemapSelect = document.getElementById('basemap-select') as HTMLSelectElement | null;
        if (basemapSelect) {
          basemapSelect.value = this.previousBasemap;
        }
      }
    }
  }

  /**
   * Create a pixel grid basemap for non-georeferenced images
   */
  private createPixelGridBasemap(extent: PixelExtent): void {
    if (!this.map) return;

    const { width, height, offsetX, offsetY } = extent;

    // Remove existing pixel grid if any
    this.removePixelGridBasemap();

    // Calculate bounds in pseudo-geographic coordinates
    const bounds: [[number, number], [number, number], [number, number], [number, number]] = [
      [-offsetX, -offsetY], // SW corner
      [offsetX, -offsetY], // SE corner
      [offsetX, offsetY], // NE corner
      [-offsetX, offsetY], // NW corner
    ];

    // Create canvas for pixel grid
    const canvas = document.createElement('canvas');
    const gridResolution = 1024; // Canvas resolution
    canvas.width = gridResolution;
    canvas.height = gridResolution;
    const ctx = canvas.getContext('2d');

    if (!ctx) return;

    // Transparent background - grid lines only
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Calculate grid spacing in pixels (image pixels)
    // We want major gridlines at nice intervals
    const imagePixelsPerCanvasPixel = width / gridResolution;
    const majorGridSpacing = this.calculateGridSpacing(width, height);
    const minorGridSpacing = majorGridSpacing / 5;

    // Convert image pixel spacing to canvas pixels
    const majorSpacingCanvas = majorGridSpacing / imagePixelsPerCanvasPixel;
    const minorSpacingCanvas = minorGridSpacing / imagePixelsPerCanvasPixel;

    // Draw minor grid lines (semi-transparent white)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= gridResolution; x += minorSpacingCanvas) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, gridResolution);
      ctx.stroke();
    }
    for (let y = 0; y <= gridResolution; y += minorSpacingCanvas) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(gridResolution, y);
      ctx.stroke();
    }

    // Draw major grid lines (more visible white)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 2;
    for (let x = 0; x <= gridResolution; x += majorSpacingCanvas) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, gridResolution);
      ctx.stroke();
    }
    for (let y = 0; y <= gridResolution; y += majorSpacingCanvas) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(gridResolution, y);
      ctx.stroke();
    }

    // Draw center crosshairs (origin) - bright cyan for visibility
    const centerX = gridResolution / 2;
    const centerY = gridResolution / 2;
    ctx.strokeStyle = 'rgba(74, 158, 255, 0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(centerX, 0);
    ctx.lineTo(centerX, gridResolution);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(gridResolution, centerY);
    ctx.stroke();

    // Draw coordinate labels at major intervals
    ctx.font = 'bold 14px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    // X-axis labels (at top)
    for (let i = 0; i <= width; i += majorGridSpacing) {
      const canvasX = (i / width) * gridResolution;
      // Add background for readability
      const text = i.toString();
      const metrics = ctx.measureText(text);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
      ctx.fillRect(canvasX - metrics.width / 2 - 3, 2, metrics.width + 6, 18);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, canvasX, 5);
    }

    // Y-axis labels (at left)
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= height; i += majorGridSpacing) {
      const canvasY = (i / height) * gridResolution;
      const text = i.toString();
      const metrics = ctx.measureText(text);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
      ctx.fillRect(2, canvasY - 9, metrics.width + 6, 18);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, 5, canvasY);
    }

    // Store canvas reference
    this.pixelGridCanvas = canvas;

    // Add to map as image source
    this.map.addSource('pixel-grid-source', {
      type: 'image',
      url: canvas.toDataURL(),
      coordinates: bounds,
    });

    // Add layer on top of all other layers (as overlay)
    this.map.addLayer({
      id: 'pixel-grid',
      type: 'raster',
      source: 'pixel-grid-source',
      paint: {
        'raster-opacity': 1,
        'raster-fade-duration': 0,
      },
    }); // No beforeId = add on top
  }

  /**
   * Calculate appropriate grid spacing based on image dimensions
   */
  private calculateGridSpacing(width: number, height: number): number {
    const maxDim = Math.max(width, height);
    // Target roughly 10 major grid lines
    const targetLines = 10;
    const rawSpacing = maxDim / targetLines;

    // Round to a nice number (1, 2, 5, 10, 20, 50, 100, 200, 500, etc.)
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawSpacing)));
    const normalized = rawSpacing / magnitude;

    let niceSpacing: number;
    if (normalized <= 1) niceSpacing = magnitude;
    else if (normalized <= 2) niceSpacing = 2 * magnitude;
    else if (normalized <= 5) niceSpacing = 5 * magnitude;
    else niceSpacing = 10 * magnitude;

    return niceSpacing;
  }

  /**
   * Remove the pixel grid basemap
   */
  private removePixelGridBasemap(): void {
    if (!this.map) return;

    if (this.map.getLayer('pixel-grid')) {
      this.map.removeLayer('pixel-grid');
    }
    if (this.map.getSource('pixel-grid-source')) {
      this.map.removeSource('pixel-grid-source');
    }
    this.pixelGridCanvas = null;
  }

  isPixelCoordMode(): boolean {
    return this.pixelCoordMode;
  }

  // Terrain methods
  private initTerrain(): boolean {
    if (!this.map) return false;

    if (this.map.getSource('terrain-dem')) {
      return true;
    }

    try {
      // AWS Terrain Tiles - free, no API key required
      this.map.addSource('terrain-dem', {
        type: 'raster-dem',
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 15,
      });

      // Listen for source errors (only bind once)
      if (!this._terrainErrorHandlerBound) {
        this._boundTerrainErrorHandler = this.handleTerrainError.bind(this);
        this.map.on('error', this._boundTerrainErrorHandler);
        this._terrainErrorHandlerBound = true;
      }

      return true;
    } catch (error) {
      log.error('Failed to initialize terrain source', { error: String(error) });
      return false;
    }
  }

  private handleTerrainError(e: MapErrorEvent): void {
    // Check if error is related to terrain tiles
    try {
      const sourceId = (e as unknown as { sourceId?: string }).sourceId;
      const source = (e as unknown as { source?: { id?: string } }).source;

      if (sourceId === 'terrain-dem' || source?.id === 'terrain-dem') {
        log.warn('Terrain tile loading failed', {
          error: e.error?.message || 'Unknown error',
        });
        // Don't disable terrain entirely - some tiles may still load
        // Just log the error for debugging
      }
    } catch (err) {
      // Ignore errors in error handler to prevent cascading issues
      log.warn('Error in terrain error handler', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  enableTerrain(exaggeration: number | null = null): TerrainResult {
    if (this.pixelCoordMode) {
      // Terrain not available for non-georeferenced images
      return { success: false, error: 'Terrain not available for non-georeferenced images' };
    }

    if (!this.map) {
      return { success: false, error: 'Map not initialized' };
    }

    if (!this.map.getSource('terrain-dem')) {
      const initialized = this.initTerrain();
      if (!initialized) {
        return { success: false, error: 'Failed to initialize terrain source' };
      }
    }

    try {
      const exag = exaggeration !== null ? exaggeration : this.terrainExaggeration;

      this.map.setTerrain({
        source: 'terrain-dem',
        exaggeration: exag,
      });
      this.terrainEnabled = true;
      this.terrainExaggeration = exag;

      // Add sky layer for better 3D visualization
      this.addSkyLayer();

      // Force a map resize to ensure proper rendering
      this.map.resize();

      return { success: true };
    } catch (error) {
      log.error('Failed to enable terrain', { error: String(error) });
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  disableTerrain(): void {
    this.map?.setTerrain(null);
    this.terrainEnabled = false;
    this.removeSkyLayer();
  }

  toggleTerrain(): TerrainResult {
    if (this.terrainEnabled) {
      this.disableTerrain();
      return { success: true, enabled: false };
    } else {
      const result = this.enableTerrain();
      if (result.success) {
        return { success: true, enabled: true };
      }
      return result; // Return the error
    }
  }

  setTerrainExaggeration(value: number): void {
    this.terrainExaggeration = value;
    if (this.terrainEnabled && this.map) {
      this.map.setTerrain({
        source: 'terrain-dem',
        exaggeration: value,
      });
    }
  }

  getTerrainExaggeration(): number {
    return this.terrainExaggeration;
  }

  isTerrainEnabled(): boolean {
    return this.terrainEnabled;
  }

  private addSkyLayer(): void {
    if (!this.map || this.map.getLayer('sky')) {
      return;
    }
    // Sky layer is a MapLibre-specific layer type not in the base LayerSpecification
    this.map.addLayer({
      id: 'sky',
      type: 'sky',
      paint: {
        'sky-type': 'atmosphere',
        'sky-atmosphere-sun': [0.0, 90.0],
        'sky-atmosphere-sun-intensity': 15,
      },
    } as unknown as LayerSpecification);
  }

  private removeSkyLayer(): void {
    if (this.map?.getLayer('sky')) {
      this.map.removeLayer('sky');
    }
  }

  private updatePitchDisplay(): void {
    if (!this.map) return;

    const pitch = this.map.getPitch();
    const pitchEl = document.getElementById('pitch-display');
    if (pitchEl) {
      pitchEl.textContent = `Pitch: ${pitch.toFixed(0)}°`;
    }
  }

  getPitch(): number {
    return this.map?.getPitch() ?? 0;
  }

  setPitch(pitch: number): void {
    this.map?.easeTo({ pitch });
  }

  resetView(): void {
    this.map?.easeTo({
      bearing: 0,
      pitch: 0,
    });
  }
}
