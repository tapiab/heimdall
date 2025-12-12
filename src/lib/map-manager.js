import maplibregl from 'maplibre-gl';

export class MapManager {
  constructor(containerId) {
    this.containerId = containerId;
    this.map = null;
    this.basemapVisible = true;
    this.currentBasemap = 'osm'; // 'osm', 'satellite', 'pixel', or 'none'
    this.previousBasemap = 'osm'; // Store previous basemap when switching to pixel mode
    this.pixelCoordMode = false; // true when viewing non-georeferenced images
    this.pixelExtent = null; // { width, height } of current non-geo image
    this.terrainEnabled = false;
    this.terrainExaggeration = 1.5;
    this.pixelGridCanvas = null;
  }

  async init() {
    this.map = new maplibregl.Map({
      container: this.containerId,
      style: {
        version: 8,
        sources: {
          osm: {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '&copy; OpenStreetMap contributors',
          },
          satellite: {
            type: 'raster',
            tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
            tileSize: 256,
            attribution: '&copy; Esri',
          },
        },
        layers: [
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
        ],
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
    this.map.addControl(new maplibregl.NavigationControl({
      showCompass: true,
      showZoom: true,
      visualizePitch: false,
    }), 'top-right');

    // Wait for map to load
    return new Promise((resolve) => {
      this.map.on('load', () => {
        this.setupEventListeners();
        resolve();
      });
    });
  }

  setupEventListeners() {
    // Update coordinates on mouse move
    this.map.on('mousemove', (e) => {
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

  updateZoomDisplay() {
    const zoomEl = document.getElementById('zoom-level');
    if (zoomEl) {
      zoomEl.textContent = `Zoom: ${this.map.getZoom().toFixed(2)}`;
    }
  }

  updateBearingDisplay() {
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

  resetNorth() {
    this.map.easeTo({ bearing: 0, pitch: 0 });
  }

  getBearing() {
    return this.map.getBearing();
  }

  fitBounds(bounds, options = {}) {
    this.map.fitBounds(bounds, {
      padding: 50,
      ...options,
    });
  }

  addSource(id, source) {
    if (!this.map.getSource(id)) {
      this.map.addSource(id, source);
    }
  }

  removeSource(id) {
    if (this.map.getSource(id)) {
      this.map.removeSource(id);
    }
  }

  addLayer(layer, beforeId) {
    if (!this.map.getLayer(layer.id)) {
      this.map.addLayer(layer, beforeId);
    }
  }

  removeLayer(id) {
    if (this.map.getLayer(id)) {
      this.map.removeLayer(id);
    }
  }

  moveLayer(id, beforeId) {
    if (this.map.getLayer(id)) {
      this.map.moveLayer(id, beforeId);
    }
  }

  setLayerVisibility(id, visible) {
    if (this.map.getLayer(id)) {
      this.map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
  }

  setLayerOpacity(id, opacity) {
    if (this.map.getLayer(id)) {
      this.map.setPaintProperty(id, 'raster-opacity', opacity);
    }
  }

  toggleBasemap() {
    this.basemapVisible = !this.basemapVisible;
    if (this.basemapVisible) {
      this.setBasemap(this.currentBasemap);
    } else {
      this.setLayerVisibility('osm-tiles', false);
      this.setLayerVisibility('satellite-tiles', false);
    }
    return this.basemapVisible;
  }

  setBasemap(type) {
    // type: 'osm', 'satellite', 'pixel', or 'none'
    this.currentBasemap = type;

    if (type === 'none') {
      this.basemapVisible = false;
      this.setLayerVisibility('osm-tiles', false);
      this.setLayerVisibility('satellite-tiles', false);
      this.setLayerVisibility('pixel-grid', false);
    } else if (type === 'pixel') {
      this.basemapVisible = true;
      this.setLayerVisibility('osm-tiles', false);
      this.setLayerVisibility('satellite-tiles', false);
      this.setLayerVisibility('pixel-grid', true);
    } else {
      this.basemapVisible = true;
      this.setLayerVisibility('osm-tiles', type === 'osm');
      this.setLayerVisibility('satellite-tiles', type === 'satellite');
      this.setLayerVisibility('pixel-grid', false);
    }
  }

  getBasemap() {
    return this.basemapVisible ? this.currentBasemap : 'none';
  }

  isBasemapVisible() {
    return this.basemapVisible;
  }

  setPixelCoordMode(enabled, extent = null) {
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
        const basemapSelect = document.getElementById('basemap-select');
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
        const basemapSelect = document.getElementById('basemap-select');
        if (basemapSelect) {
          basemapSelect.value = this.previousBasemap;
        }
      }
    }
  }

  /**
   * Create a pixel grid basemap for non-georeferenced images
   */
  createPixelGridBasemap(extent) {
    const { width, height, scale, offsetX, offsetY } = extent;

    // Remove existing pixel grid if any
    this.removePixelGridBasemap();

    // Calculate bounds in pseudo-geographic coordinates
    const bounds = [
      [-offsetX, -offsetY],           // SW corner
      [offsetX, -offsetY],            // SE corner
      [offsetX, offsetY],             // NE corner
      [-offsetX, offsetY],            // NW corner
    ];

    // Create canvas for pixel grid
    const canvas = document.createElement('canvas');
    const gridResolution = 1024; // Canvas resolution
    canvas.width = gridResolution;
    canvas.height = gridResolution;
    const ctx = canvas.getContext('2d');

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
  calculateGridSpacing(width, height) {
    const maxDim = Math.max(width, height);
    // Target roughly 10 major grid lines
    const targetLines = 10;
    const rawSpacing = maxDim / targetLines;

    // Round to a nice number (1, 2, 5, 10, 20, 50, 100, 200, 500, etc.)
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawSpacing)));
    const normalized = rawSpacing / magnitude;

    let niceSpacing;
    if (normalized <= 1) niceSpacing = magnitude;
    else if (normalized <= 2) niceSpacing = 2 * magnitude;
    else if (normalized <= 5) niceSpacing = 5 * magnitude;
    else niceSpacing = 10 * magnitude;

    return niceSpacing;
  }

  /**
   * Remove the pixel grid basemap
   */
  removePixelGridBasemap() {
    if (this.map.getLayer('pixel-grid')) {
      this.map.removeLayer('pixel-grid');
    }
    if (this.map.getSource('pixel-grid-source')) {
      this.map.removeSource('pixel-grid-source');
    }
    this.pixelGridCanvas = null;
  }

  isPixelCoordMode() {
    return this.pixelCoordMode;
  }

  // Terrain methods
  initTerrain() {
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
      console.error('Failed to initialize terrain source:', error);
      return false;
    }
  }

  handleTerrainError(e) {
    // Check if error is related to terrain tiles
    try {
      if (e.sourceId === 'terrain-dem' || (e.source && e.source.id === 'terrain-dem')) {
        console.warn('Terrain tile loading failed:', e.error?.message || 'Unknown error');
        // Don't disable terrain entirely - some tiles may still load
        // Just log the error for debugging
      }
    } catch (err) {
      // Ignore errors in error handler to prevent cascading issues
      console.warn('Error in terrain error handler:', err);
    }
  }

  enableTerrain(exaggeration = null) {
    if (this.pixelCoordMode) {
      // Terrain not available for non-georeferenced images
      return { success: false, error: 'Terrain not available for non-georeferenced images' };
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
      console.error('Failed to enable terrain:', error);
      return { success: false, error: error.message };
    }
  }

  disableTerrain() {
    this.map.setTerrain(null);
    this.terrainEnabled = false;
    this.removeSkyLayer();
  }

  toggleTerrain() {
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

  setTerrainExaggeration(value) {
    this.terrainExaggeration = value;
    if (this.terrainEnabled) {
      this.map.setTerrain({
        source: 'terrain-dem',
        exaggeration: value,
      });
    }
  }

  getTerrainExaggeration() {
    return this.terrainExaggeration;
  }

  isTerrainEnabled() {
    return this.terrainEnabled;
  }

  addSkyLayer() {
    if (this.map.getLayer('sky')) {
      return;
    }
    this.map.addLayer({
      id: 'sky',
      type: 'sky',
      paint: {
        'sky-type': 'atmosphere',
        'sky-atmosphere-sun': [0.0, 90.0],
        'sky-atmosphere-sun-intensity': 15,
      },
    });
  }

  removeSkyLayer() {
    if (this.map.getLayer('sky')) {
      this.map.removeLayer('sky');
    }
  }

  updatePitchDisplay() {
    const pitch = this.map.getPitch();
    const pitchEl = document.getElementById('pitch-display');
    if (pitchEl) {
      pitchEl.textContent = `Pitch: ${pitch.toFixed(0)}°`;
    }
  }

  getPitch() {
    return this.map.getPitch();
  }

  setPitch(pitch) {
    this.map.easeTo({ pitch });
  }

  resetView() {
    this.map.easeTo({
      bearing: 0,
      pitch: 0,
    });
  }
}
