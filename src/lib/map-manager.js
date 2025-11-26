import maplibregl from 'maplibre-gl';

export class MapManager {
  constructor(containerId) {
    this.containerId = containerId;
    this.map = null;
    this.basemapVisible = true;
    this.currentBasemap = 'osm'; // 'osm', 'satellite', or 'none'
    this.pixelCoordMode = false; // true when viewing non-georeferenced images
    this.pixelExtent = null; // { width, height } of current non-geo image
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
      dragRotate: true,
      touchZoomRotate: true,
      pitchWithRotate: false,
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

    // Initial displays
    this.updateZoomDisplay();
    this.updateBearingDisplay();
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
    // type: 'osm', 'satellite', or 'none'
    this.currentBasemap = type;

    if (type === 'none') {
      this.basemapVisible = false;
      this.setLayerVisibility('osm-tiles', false);
      this.setLayerVisibility('satellite-tiles', false);
    } else {
      this.basemapVisible = true;
      this.setLayerVisibility('osm-tiles', type === 'osm');
      this.setLayerVisibility('satellite-tiles', type === 'satellite');
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
  }

  isPixelCoordMode() {
    return this.pixelCoordMode;
  }
}
