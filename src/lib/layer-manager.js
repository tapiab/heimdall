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
    this.popup = null; // Feature info popup
    this.setupFeatureInteraction();
  }

  setupFeatureInteraction() {
    const map = this.mapManager.map;

    // Change cursor to pointer when hovering over vector features
    map.on('mouseenter', (e) => {
      const features = map.queryRenderedFeatures(e.point);
      const vectorFeature = features.find(f =>
        f.layer.id.startsWith('vector-fill-') ||
        f.layer.id.startsWith('vector-line-') ||
        f.layer.id.startsWith('vector-circle-')
      );
      if (vectorFeature) {
        map.getCanvas().style.cursor = 'pointer';
      }
    });

    map.on('mouseleave', () => {
      map.getCanvas().style.cursor = '';
    });

    map.on('mousemove', (e) => {
      const features = map.queryRenderedFeatures(e.point);
      const vectorFeature = features.find(f =>
        f.layer.id.startsWith('vector-fill-') ||
        f.layer.id.startsWith('vector-line-') ||
        f.layer.id.startsWith('vector-circle-')
      );
      map.getCanvas().style.cursor = vectorFeature ? 'pointer' : '';
    });

    // Show popup on click
    map.on('click', (e) => {
      const features = map.queryRenderedFeatures(e.point);
      const vectorFeature = features.find(f =>
        f.layer.id.startsWith('vector-fill-') ||
        f.layer.id.startsWith('vector-line-') ||
        f.layer.id.startsWith('vector-circle-')
      );

      if (vectorFeature) {
        this.showFeaturePopup(vectorFeature, e.lngLat);
      } else if (this.popup) {
        this.popup.remove();
        this.popup = null;
      }
    });
  }

  showFeaturePopup(feature, lngLat) {
    // Remove existing popup
    if (this.popup) {
      this.popup.remove();
    }

    const properties = feature.properties || {};
    const layerId = feature.layer.id.replace(/^vector-(fill|line|circle)-/, '');
    const layer = this.layers.get(layerId);
    const layerName = layer ? layer.path.split('/').pop().split('\\').pop() : 'Feature';

    // Build popup HTML
    let html = `<div class="feature-popup">`;
    html += `<div class="feature-popup-header">${layerName}</div>`;
    html += `<div class="feature-popup-content">`;

    const keys = Object.keys(properties);
    if (keys.length === 0) {
      html += `<div class="feature-popup-empty">No attributes</div>`;
    } else {
      for (const key of keys) {
        const value = properties[key];
        const displayValue = value === null || value === undefined ? '<em>null</em>' :
          typeof value === 'object' ? JSON.stringify(value) : String(value);
        html += `<div class="feature-popup-row">`;
        html += `<span class="feature-popup-key">${key}</span>`;
        html += `<span class="feature-popup-value">${displayValue}</span>`;
        html += `</div>`;
      }
    }

    html += `</div></div>`;

    this.popup = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: false,
      maxWidth: '320px',
    })
      .setLngLat(lngLat)
      .setHTML(html)
      .addTo(this.mapManager.map);
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

  async addVectorLayer(filePath) {
    try {
      // Open the vector in the backend
      const data = await invoke('open_vector', { path: filePath });
      const metadata = data.metadata;
      const geojson = data.geojson;

      console.log('Opened vector:', metadata);
      console.log('GeoJSON:', JSON.stringify(geojson, null, 2));

      // Store layer info
      const layerData = {
        ...metadata,
        visible: true,
        opacity: 1.0,
        type: 'vector',
        geojson: geojson,
        // Styling
        style: {
          fillColor: '#ff0000',
          fillOpacity: 0.5,
          strokeColor: '#ff0000',
          strokeWidth: 3,
          pointRadius: 8,
        },
      };

      this.layers.set(metadata.id, layerData);
      this.layerOrder.push(metadata.id);

      // Add to map as GeoJSON source
      const sourceId = `vector-source-${metadata.id}`;

      this.mapManager.addSource(sourceId, {
        type: 'geojson',
        data: geojson,
      });

      // Determine what layer types to add based on geometry
      const geomType = metadata.geometry_type.toLowerCase();

      // For unknown/mixed geometry types, add all layer types
      if (geomType.includes('unknown') || geomType === '') {
        // Add fill layer for polygons
        this.mapManager.addLayer({
          id: `vector-fill-${metadata.id}`,
          type: 'fill',
          source: sourceId,
          filter: ['==', '$type', 'Polygon'],
          paint: {
            'fill-color': layerData.style.fillColor,
            'fill-opacity': layerData.style.fillOpacity,
          },
        });
        // Add line layer for lines and polygon outlines
        this.mapManager.addLayer({
          id: `vector-line-${metadata.id}`,
          type: 'line',
          source: sourceId,
          filter: ['any', ['==', '$type', 'LineString'], ['==', '$type', 'Polygon']],
          paint: {
            'line-color': layerData.style.strokeColor,
            'line-width': layerData.style.strokeWidth,
          },
        });
        // Add circle layer for points
        this.mapManager.addLayer({
          id: `vector-circle-${metadata.id}`,
          type: 'circle',
          source: sourceId,
          filter: ['==', '$type', 'Point'],
          paint: {
            'circle-color': layerData.style.fillColor,
            'circle-radius': layerData.style.pointRadius,
            'circle-stroke-color': layerData.style.strokeColor,
            'circle-stroke-width': 1,
          },
        });
      } else if (geomType.includes('polygon') || geomType.includes('multipolygon')) {
        // Add fill layer
        this.mapManager.addLayer({
          id: `vector-fill-${metadata.id}`,
          type: 'fill',
          source: sourceId,
          paint: {
            'fill-color': layerData.style.fillColor,
            'fill-opacity': layerData.style.fillOpacity,
          },
        });
        // Add outline
        this.mapManager.addLayer({
          id: `vector-line-${metadata.id}`,
          type: 'line',
          source: sourceId,
          paint: {
            'line-color': layerData.style.strokeColor,
            'line-width': layerData.style.strokeWidth,
          },
        });
      } else if (geomType.includes('line') || geomType.includes('multiline')) {
        this.mapManager.addLayer({
          id: `vector-line-${metadata.id}`,
          type: 'line',
          source: sourceId,
          paint: {
            'line-color': layerData.style.strokeColor,
            'line-width': layerData.style.strokeWidth,
          },
        });
      } else if (geomType.includes('point') || geomType.includes('multipoint')) {
        this.mapManager.addLayer({
          id: `vector-circle-${metadata.id}`,
          type: 'circle',
          source: sourceId,
          paint: {
            'circle-color': layerData.style.fillColor,
            'circle-radius': layerData.style.pointRadius,
            'circle-stroke-color': layerData.style.strokeColor,
            'circle-stroke-width': 1,
          },
        });
      } else {
        // Unknown geometry - add both fill and line as fallback
        this.mapManager.addLayer({
          id: `vector-fill-${metadata.id}`,
          type: 'fill',
          source: sourceId,
          paint: {
            'fill-color': layerData.style.fillColor,
            'fill-opacity': layerData.style.fillOpacity,
          },
        });
        this.mapManager.addLayer({
          id: `vector-line-${metadata.id}`,
          type: 'line',
          source: sourceId,
          paint: {
            'line-color': layerData.style.strokeColor,
            'line-width': layerData.style.strokeWidth,
          },
        });
        this.mapManager.addLayer({
          id: `vector-circle-${metadata.id}`,
          type: 'circle',
          source: sourceId,
          paint: {
            'circle-color': layerData.style.fillColor,
            'circle-radius': layerData.style.pointRadius,
            'circle-stroke-color': layerData.style.strokeColor,
            'circle-stroke-width': 1,
          },
        });
      }

      // Select this layer for controls
      this.selectedLayerId = metadata.id;

      // Update UI
      this.updateLayerPanel();
      this.updateDynamicControls();

      // Fit to layer bounds
      this.mapManager.fitBounds([
        [metadata.bounds[0], metadata.bounds[1]],
        [metadata.bounds[2], metadata.bounds[3]],
      ]);

      return metadata;
    } catch (error) {
      console.error('Failed to add vector layer:', error);
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

    if (layer.type === 'vector') {
      // Remove vector layers
      const sourceId = `vector-source-${id}`;
      const possibleLayerIds = [
        `vector-fill-${id}`,
        `vector-line-${id}`,
        `vector-circle-${id}`,
      ];
      for (const layerId of possibleLayerIds) {
        try {
          this.mapManager.removeLayer(layerId);
        } catch (e) {
          // Layer might not exist
        }
      }
      this.mapManager.removeSource(sourceId);
    } else {
      // Remove raster layer
      const sourceId = `raster-source-${id}`;
      const layerId = `raster-layer-${id}`;
      const protocolName = `raster-${id}`;

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

    if (layer.type === 'vector') {
      const layerIds = [
        `vector-fill-${id}`,
        `vector-line-${id}`,
        `vector-circle-${id}`,
      ];
      for (const layerId of layerIds) {
        try {
          this.mapManager.setLayerVisibility(layerId, layer.visible);
        } catch (e) {
          // Layer might not exist
        }
      }
    } else {
      const layerId = `raster-layer-${id}`;
      this.mapManager.setLayerVisibility(layerId, layer.visible);
    }
    this.updateLayerPanel();
  }

  setLayerOpacity(id, opacity) {
    const layer = this.layers.get(id);
    if (!layer) return;

    layer.opacity = opacity;

    if (layer.type === 'vector') {
      // For vector layers, adjust fill and line opacity
      try {
        this.mapManager.map.setPaintProperty(`vector-fill-${id}`, 'fill-opacity', layer.style.fillOpacity * opacity);
      } catch (e) {}
      try {
        this.mapManager.map.setPaintProperty(`vector-line-${id}`, 'line-opacity', opacity);
      } catch (e) {}
      try {
        this.mapManager.map.setPaintProperty(`vector-circle-${id}`, 'circle-opacity', opacity);
      } catch (e) {}
    } else {
      const layerId = `raster-layer-${id}`;
      this.mapManager.setLayerOpacity(layerId, opacity);
    }
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

  setVectorStyle(id, property, value) {
    const layer = this.layers.get(id);
    if (!layer || layer.type !== 'vector') return;

    layer.style[property] = value;

    // Apply style changes to map
    try {
      if (property === 'fillColor') {
        this.mapManager.map.setPaintProperty(`vector-fill-${id}`, 'fill-color', value);
        this.mapManager.map.setPaintProperty(`vector-circle-${id}`, 'circle-color', value);
      } else if (property === 'fillOpacity') {
        this.mapManager.map.setPaintProperty(`vector-fill-${id}`, 'fill-opacity', value * layer.opacity);
      } else if (property === 'strokeColor') {
        this.mapManager.map.setPaintProperty(`vector-line-${id}`, 'line-color', value);
        this.mapManager.map.setPaintProperty(`vector-circle-${id}`, 'circle-stroke-color', value);
      } else if (property === 'strokeWidth') {
        this.mapManager.map.setPaintProperty(`vector-line-${id}`, 'line-width', value);
      } else if (property === 'pointRadius') {
        this.mapManager.map.setPaintProperty(`vector-circle-${id}`, 'circle-radius', value);
      }
    } catch (e) {
      // Layer might not exist for this geometry type
    }
  }

  setColorByField(id, fieldName) {
    const layer = this.layers.get(id);
    if (!layer || layer.type !== 'vector') return;

    layer.style.colorByField = fieldName || null;

    if (!fieldName) {
      // Reset to solid color
      const fillColor = layer.style.fillColor;
      try {
        this.mapManager.map.setPaintProperty(`vector-fill-${id}`, 'fill-color', fillColor);
        this.mapManager.map.setPaintProperty(`vector-circle-${id}`, 'circle-color', fillColor);
      } catch (e) {}
      return;
    }

    // Get unique values for the field
    const features = layer.geojson?.features || [];
    const values = [...new Set(features.map(f => f.properties?.[fieldName]).filter(v => v !== null && v !== undefined))];

    if (values.length === 0) return;

    // Check if numeric or categorical
    const isNumeric = values.every(v => typeof v === 'number');

    let colorExpression;

    if (isNumeric && values.length > 2) {
      // Graduated color scheme for numeric values
      const sortedValues = values.sort((a, b) => a - b);
      const min = sortedValues[0];
      const max = sortedValues[sortedValues.length - 1];

      // Use interpolate for smooth color ramp (blue -> yellow -> red)
      colorExpression = [
        'interpolate',
        ['linear'],
        ['get', fieldName],
        min, '#2166ac',  // Blue
        (min + max) / 2, '#f7f7f7',  // White
        max, '#b2182b'   // Red
      ];
    } else {
      // Categorical color scheme
      const colors = [
        '#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00',
        '#ffff33', '#a65628', '#f781bf', '#999999', '#66c2a5'
      ];

      // Build match expression
      const matchExpr = ['match', ['get', fieldName]];
      values.forEach((val, idx) => {
        matchExpr.push(val);
        matchExpr.push(colors[idx % colors.length]);
      });
      matchExpr.push('#888888'); // Default color

      colorExpression = matchExpr;
    }

    // Apply to layers
    try {
      this.mapManager.map.setPaintProperty(`vector-fill-${id}`, 'fill-color', colorExpression);
    } catch (e) {}
    try {
      this.mapManager.map.setPaintProperty(`vector-circle-${id}`, 'circle-color', colorExpression);
    } catch (e) {}
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
      if (layer.type === 'vector') {
        name.title = `${layer.path}\n${layer.feature_count} features, ${layer.geometry_type}`;
      } else {
        name.title = `${layer.path}\n${layer.width}x${layer.height}, ${layer.bands} band(s)`;
      }

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

    // Vector layer controls
    if (layer.type === 'vector') {
      // Build field options for styling
      const fields = layer.fields || [];
      const fieldOptions = fields.map(f =>
        `<option value="${f.name}" ${layer.style.colorByField === f.name ? 'selected' : ''}>${f.name}</option>`
      ).join('');

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

      // Attach vector styling event listeners
      const fillColorInput = document.getElementById('vector-fill-color');
      const fillOpacityInput = document.getElementById('vector-fill-opacity');
      const strokeColorInput = document.getElementById('vector-stroke-color');
      const strokeWidthInput = document.getElementById('vector-stroke-width');
      const pointRadiusInput = document.getElementById('vector-point-radius');
      const showAttributesBtn = document.getElementById('show-attributes');
      const colorByFieldSelect = document.getElementById('color-by-field');

      if (showAttributesBtn) {
        showAttributesBtn.addEventListener('click', () => {
          this.showAttributeTable(this.selectedLayerId);
        });
      }
      if (colorByFieldSelect) {
        colorByFieldSelect.addEventListener('change', (e) => {
          this.setColorByField(this.selectedLayerId, e.target.value);
        });
      }
      if (fillColorInput) {
        fillColorInput.addEventListener('change', (e) => {
          this.setVectorStyle(this.selectedLayerId, 'fillColor', e.target.value);
          // Reset color-by-field when manually setting color
          layer.style.colorByField = null;
          if (colorByFieldSelect) colorByFieldSelect.value = '';
        });
      }
      if (fillOpacityInput) {
        fillOpacityInput.addEventListener('input', (e) => {
          const opacity = parseInt(e.target.value) / 100;
          e.target.previousElementSibling.querySelector('.value-display').textContent = `${e.target.value}%`;
          this.setVectorStyle(this.selectedLayerId, 'fillOpacity', opacity);
        });
      }
      if (strokeColorInput) {
        strokeColorInput.addEventListener('change', (e) => {
          this.setVectorStyle(this.selectedLayerId, 'strokeColor', e.target.value);
        });
      }
      if (strokeWidthInput) {
        strokeWidthInput.addEventListener('input', (e) => {
          const width = parseFloat(e.target.value);
          e.target.previousElementSibling.querySelector('.value-display').textContent = `${width}px`;
          this.setVectorStyle(this.selectedLayerId, 'strokeWidth', width);
        });
      }
      if (pointRadiusInput) {
        pointRadiusInput.addEventListener('input', (e) => {
          const radius = parseInt(e.target.value);
          e.target.previousElementSibling.querySelector('.value-display').textContent = `${radius}px`;
          this.setVectorStyle(this.selectedLayerId, 'pointRadius', radius);
        });
      }

      return;
    }

    // Raster layer controls
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
        <button id="show-histogram" class="control-btn">Show Histogram</button>
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

      // Check if stretch controls should be shown (default hidden)
      const showStretch = layer.showRgbStretch || false;

      controlsHtml += `
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

      const showHistogramBtn = document.getElementById('show-histogram');
      if (showHistogramBtn) {
        showHistogramBtn.addEventListener('click', () => {
          this.showHistogram(this.selectedLayerId, layer.band);
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

      // Toggle stretch controls visibility
      const showStretchCheckbox = document.getElementById('show-rgb-stretch');
      if (showStretchCheckbox) {
        showStretchCheckbox.addEventListener('change', (e) => {
          layer.showRgbStretch = e.target.checked;
          const stretchControls = document.querySelectorAll('.rgb-stretch-controls');
          stretchControls.forEach(ctrl => {
            ctrl.classList.toggle('hidden', !e.target.checked);
          });
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

  showAttributeTable(layerId) {
    const layer = this.layers.get(layerId);
    if (!layer || layer.type !== 'vector') return;

    const panel = document.getElementById('attribute-panel');
    const title = document.getElementById('attribute-panel-title');
    const thead = document.querySelector('#attribute-table thead');
    const tbody = document.querySelector('#attribute-table tbody');
    const closeBtn = document.getElementById('attribute-panel-close');

    if (!panel || !thead || !tbody) return;

    // Set title
    const layerName = layer.path.split('/').pop().split('\\').pop();
    title.textContent = `${layerName} (${layer.feature_count} features)`;

    // Get field names from layer metadata
    const fields = layer.fields || [];
    const fieldNames = fields.map(f => f.name);

    // Build header row
    thead.innerHTML = '<tr>' + fieldNames.map(name =>
      `<th>${name}</th>`
    ).join('') + '</tr>';

    // Build body rows from geojson features
    const features = layer.geojson?.features || [];
    tbody.innerHTML = features.map((feature, idx) => {
      const props = feature.properties || {};
      return '<tr data-feature-idx="' + idx + '">' + fieldNames.map(name => {
        const value = props[name];
        const displayValue = value === null || value === undefined ? '' :
          typeof value === 'object' ? JSON.stringify(value) : String(value);
        return `<td title="${displayValue}">${displayValue}</td>`;
      }).join('') + '</tr>';
    }).join('');

    // Add click handler for row selection and zoom
    tbody.querySelectorAll('tr').forEach((row, idx) => {
      row.addEventListener('click', () => {
        // Highlight row
        tbody.querySelectorAll('tr').forEach(r => r.classList.remove('selected'));
        row.classList.add('selected');

        // Zoom to feature
        const feature = features[idx];
        if (feature?.geometry) {
          const bounds = this.getFeatureBounds(feature.geometry);
          if (bounds) {
            this.mapManager.fitBounds(bounds, { padding: 100, maxZoom: 18 });
          }
        }
      });
    });

    // Setup close button
    closeBtn.onclick = () => {
      panel.classList.remove('visible');
    };

    // Show panel
    panel.classList.add('visible');
  }

  getFeatureBounds(geometry) {
    if (!geometry || !geometry.coordinates) return null;

    let coords = [];
    const extractCoords = (c) => {
      if (typeof c[0] === 'number') {
        coords.push(c);
      } else {
        c.forEach(extractCoords);
      }
    };
    extractCoords(geometry.coordinates);

    if (coords.length === 0) return null;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of coords) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }

    // Add small buffer for points
    if (minX === maxX && minY === maxY) {
      const buffer = 0.001;
      minX -= buffer;
      minY -= buffer;
      maxX += buffer;
      maxY += buffer;
    }

    return [[minX, minY], [maxX, maxY]];
  }

  async showHistogram(layerId, band) {
    const layer = this.layers.get(layerId);
    if (!layer || layer.type !== 'raster') return;

    const panel = document.getElementById('histogram-panel');
    const title = document.getElementById('histogram-panel-title');
    const canvas = document.getElementById('histogram-canvas');
    const minSpan = document.getElementById('histogram-min');
    const maxSpan = document.getElementById('histogram-max');
    const closeBtn = document.getElementById('histogram-panel-close');
    const bandSelect = document.getElementById('histogram-band');
    const logScaleCheckbox = document.getElementById('histogram-log-scale');
    const tooltip = document.getElementById('histogram-tooltip');

    if (!panel || !canvas) return;

    // Set title
    const layerName = layer.path.split('/').pop().split('\\').pop();
    title.textContent = `Histogram - ${layerName}`;

    // Populate band selector
    if (bandSelect) {
      bandSelect.innerHTML = Array.from({ length: layer.bands }, (_, i) =>
        `<option value="${i + 1}" ${band === i + 1 ? 'selected' : ''}>Band ${i + 1}</option>`
      ).join('');

      // Store current layer ID for band change handler
      bandSelect.dataset.layerId = layerId;

      // Setup band change handler (remove old listener first)
      bandSelect.onchange = async (e) => {
        const newBand = parseInt(e.target.value);
        await this.showHistogram(layerId, newBand);
      };
    }

    // Show panel with loading state
    panel.classList.add('visible');
    minSpan.textContent = 'Loading...';
    maxSpan.textContent = '';

    // Setup close button
    closeBtn.onclick = () => {
      panel.classList.remove('visible');
      if (tooltip) tooltip.classList.remove('visible');
    };

    try {
      // Fetch histogram data from backend
      const histogram = await invoke('get_histogram', {
        id: layerId,
        band: band,
        numBins: 256,
      });

      // Store histogram data for redraw
      this.currentHistogram = histogram;
      this.currentHistogramLayerId = layerId;

      // Update stats
      minSpan.textContent = `Min: ${histogram.min.toFixed(2)}`;
      maxSpan.textContent = `Max: ${histogram.max.toFixed(2)}`;

      // Auto-enable log scale for high dynamic range
      const maxCount = Math.max(...histogram.counts);
      if (logScaleCheckbox && maxCount > 1000) {
        logScaleCheckbox.checked = true;
      }

      // Draw histogram on canvas
      const useLogScale = logScaleCheckbox ? logScaleCheckbox.checked : false;
      this.drawHistogram(canvas, histogram, layer, useLogScale);

      // Setup mouse hover for tooltip
      this.setupHistogramHover(canvas, tooltip, histogram, useLogScale);

      // Setup log scale toggle handler
      if (logScaleCheckbox) {
        logScaleCheckbox.onchange = () => {
          const currentLayer = this.layers.get(this.currentHistogramLayerId);
          const currentCanvas = document.getElementById('histogram-canvas');
          const currentTooltip = document.getElementById('histogram-tooltip');
          if (this.currentHistogram && currentCanvas) {
            this.drawHistogram(currentCanvas, this.currentHistogram, currentLayer, logScaleCheckbox.checked);
            this.setupHistogramHover(currentCanvas, currentTooltip, this.currentHistogram, logScaleCheckbox.checked);
          }
        };
      }
    } catch (error) {
      console.error('Failed to load histogram:', error);
      minSpan.textContent = 'Error loading histogram';
      maxSpan.textContent = '';
    }
  }

  setupHistogramHover(canvas, tooltip, histogram, useLogScale) {
    if (!tooltip) return;

    const padding = { top: 10, right: 10, bottom: 30, left: 50 };
    const chartWidth = canvas.width - padding.left - padding.right;

    // Remove old listeners by replacing with cloned node
    const newCanvas = canvas.cloneNode(true);
    canvas.parentNode.replaceChild(newCanvas, canvas);

    newCanvas.addEventListener('mousemove', (e) => {
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
    this.drawHistogram(newCanvas, histogram, this.layers.get(this.selectedLayerId), useLogScale);
  }

  drawHistogram(canvas, histogram, layer, useLogScale = false) {
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    const padding = { top: 10, right: 10, bottom: 30, left: 50 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    // Clear canvas
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, width, height);

    // Find max count for scaling
    const maxCount = Math.max(...histogram.counts);
    if (maxCount === 0) return;

    const getScaledValue = (count) => {
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
    if (layer && layer.stretch) {
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
}
