import maplibregl from 'maplibre-gl';

/**
 * Distance measurement tool for measuring distances on the map.
 * Supports both geodesic (geographic) and pixel-based (non-georeferenced) measurements.
 */
export class MeasureTool {
  constructor(mapManager) {
    this.mapManager = mapManager;
    this.map = mapManager.map;
    this.active = false;
    this.points = [];
    this.markers = [];
    this.popup = null;
    this.handleClick = this.handleClick.bind(this);
    this.handleMouseMove = this.handleMouseMove.bind(this);
  }

  /**
   * Activate measurement mode
   */
  activate() {
    if (this.active) return;

    this.active = true;
    this.points = [];
    this.clearMeasurement();
    this.map.getCanvas().style.cursor = 'crosshair';
    this.map.on('click', this.handleClick);
    this.map.on('mousemove', this.handleMouseMove);

    // Show instruction tooltip
    this.showInstruction('Click to place first point');
  }

  /**
   * Deactivate measurement mode
   */
  deactivate() {
    if (!this.active) return;

    this.active = false;
    this.clearMeasurement();
    this.map.getCanvas().style.cursor = '';
    this.map.off('click', this.handleClick);
    this.map.off('mousemove', this.handleMouseMove);
    this.hideInstruction();
  }

  /**
   * Toggle measurement mode
   */
  toggle() {
    if (this.active) {
      this.deactivate();
      return false;
    } else {
      this.activate();
      return true;
    }
  }

  /**
   * Check if measurement mode is active
   */
  isActive() {
    return this.active;
  }

  /**
   * Handle map click events
   */
  handleClick(e) {
    const { lng, lat } = e.lngLat;

    if (this.points.length === 0) {
      // First point
      this.points.push([lng, lat]);
      this.addMarker(lng, lat, 1);
      this.showInstruction('Click to place second point');
    } else if (this.points.length === 1) {
      // Second point - complete measurement
      this.points.push([lng, lat]);
      this.addMarker(lng, lat, 2);
      this.drawLine();
      this.showDistance();
      this.hideInstruction();
    } else {
      // Reset and start new measurement
      this.clearMeasurement();
      this.points = [[lng, lat]];
      this.addMarker(lng, lat, 1);
      this.showInstruction('Click to place second point');
    }
  }

  /**
   * Handle mouse move for preview line
   */
  handleMouseMove(e) {
    if (this.points.length !== 1) return;

    const { lng, lat } = e.lngLat;
    this.drawPreviewLine(lng, lat);
    this.showPreviewDistance(lng, lat);
  }

  /**
   * Add a marker at the specified location
   */
  addMarker(lng, lat, pointNumber) {
    const el = document.createElement('div');
    el.className = 'measure-marker';
    el.innerHTML = pointNumber;

    const marker = new maplibregl.Marker({ element: el })
      .setLngLat([lng, lat])
      .addTo(this.map);

    this.markers.push(marker);
  }

  /**
   * Draw line between measurement points
   */
  drawLine() {
    const geojson = {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: this.points,
      },
    };

    if (this.map.getSource('measure-line')) {
      this.map.getSource('measure-line').setData(geojson);
    } else {
      this.map.addSource('measure-line', { type: 'geojson', data: geojson });
      this.map.addLayer({
        id: 'measure-line',
        type: 'line',
        source: 'measure-line',
        paint: {
          'line-color': '#ff6600',
          'line-width': 3,
          'line-dasharray': [2, 2],
        },
      });
    }

    // Remove preview line
    this.removePreviewLine();
  }

  /**
   * Draw preview line from first point to cursor
   */
  drawPreviewLine(lng, lat) {
    const geojson = {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [this.points[0], [lng, lat]],
      },
    };

    if (this.map.getSource('measure-preview-line')) {
      this.map.getSource('measure-preview-line').setData(geojson);
    } else {
      this.map.addSource('measure-preview-line', { type: 'geojson', data: geojson });
      this.map.addLayer({
        id: 'measure-preview-line',
        type: 'line',
        source: 'measure-preview-line',
        paint: {
          'line-color': '#ff6600',
          'line-width': 2,
          'line-opacity': 0.5,
          'line-dasharray': [2, 2],
        },
      });
    }
  }

  /**
   * Remove preview line
   */
  removePreviewLine() {
    if (this.map.getLayer('measure-preview-line')) {
      this.map.removeLayer('measure-preview-line');
    }
    if (this.map.getSource('measure-preview-line')) {
      this.map.removeSource('measure-preview-line');
    }
  }

  /**
   * Show the measured distance
   */
  showDistance() {
    if (this.points.length < 2) return;

    const distance = this.calculateDistance(this.points[0], this.points[1]);
    const formattedDistance = this.formatDistance(distance);

    // Calculate midpoint for popup
    const midLng = (this.points[0][0] + this.points[1][0]) / 2;
    const midLat = (this.points[0][1] + this.points[1][1]) / 2;

    // Remove existing popup
    if (this.popup) {
      this.popup.remove();
    }

    // Create popup at midpoint
    this.popup = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: false,
      className: 'measure-popup',
    })
      .setLngLat([midLng, midLat])
      .setHTML(`<div class="measure-result">${formattedDistance}</div>`)
      .addTo(this.map);
  }

  /**
   * Show preview distance while moving mouse
   */
  showPreviewDistance(lng, lat) {
    if (this.points.length !== 1) return;

    const distance = this.calculateDistance(this.points[0], [lng, lat]);
    const formattedDistance = this.formatDistance(distance);

    this.showInstruction(`Distance: ${formattedDistance}`);
  }

  /**
   * Calculate distance between two points
   * Uses Haversine formula for geographic data, Euclidean for pixel coordinates
   */
  calculateDistance(point1, point2) {
    if (this.mapManager.isPixelCoordMode() && this.mapManager.pixelExtent) {
      // Calculate pixel distance
      return this.calculatePixelDistance(point1, point2);
    } else {
      // Calculate geodesic distance using Haversine formula
      return this.calculateGeodesicDistance(point1, point2);
    }
  }

  /**
   * Calculate geodesic distance using Haversine formula
   * @returns {Object} { value: number, unit: 'meters' }
   */
  calculateGeodesicDistance(point1, point2) {
    const R = 6371000; // Earth's radius in meters
    const lat1 = point1[1] * Math.PI / 180;
    const lat2 = point2[1] * Math.PI / 180;
    const deltaLat = (point2[1] - point1[1]) * Math.PI / 180;
    const deltaLng = (point2[0] - point1[0]) * Math.PI / 180;

    const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
              Math.cos(lat1) * Math.cos(lat2) *
              Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return { value: R * c, unit: 'meters' };
  }

  /**
   * Calculate pixel distance for non-georeferenced images
   * @returns {Object} { value: number, unit: 'pixels' }
   */
  calculatePixelDistance(point1, point2) {
    const extent = this.mapManager.pixelExtent;
    const scale = extent.scale || 0.01;
    const offsetX = extent.offsetX || 0;
    const offsetY = extent.offsetY || 0;

    // Convert map coords back to pixel coords
    const x1 = (point1[0] + offsetX) / scale;
    const y1 = (offsetY - point1[1]) / scale;
    const x2 = (point2[0] + offsetX) / scale;
    const y2 = (offsetY - point2[1]) / scale;

    // Euclidean distance
    const dx = x2 - x1;
    const dy = y2 - y1;
    const distance = Math.sqrt(dx * dx + dy * dy);

    return { value: distance, unit: 'pixels' };
  }

  /**
   * Format distance for display
   */
  formatDistance(distance) {
    const { value, unit } = distance;

    if (unit === 'pixels') {
      return `${value.toFixed(1)} px`;
    }

    // Format meters/kilometers
    if (value < 1000) {
      return `${value.toFixed(1)} m`;
    } else {
      return `${(value / 1000).toFixed(2)} km`;
    }
  }

  /**
   * Show instruction tooltip
   */
  showInstruction(text) {
    let instructionEl = document.getElementById('measure-instruction');
    if (!instructionEl) {
      instructionEl = document.createElement('div');
      instructionEl.id = 'measure-instruction';
      document.body.appendChild(instructionEl);
    }
    instructionEl.textContent = text;
    instructionEl.style.display = 'block';
  }

  /**
   * Hide instruction tooltip
   */
  hideInstruction() {
    const instructionEl = document.getElementById('measure-instruction');
    if (instructionEl) {
      instructionEl.style.display = 'none';
    }
  }

  /**
   * Clear all measurement elements
   */
  clearMeasurement() {
    // Remove markers
    this.markers.forEach(marker => marker.remove());
    this.markers = [];

    // Remove line
    if (this.map.getLayer('measure-line')) {
      this.map.removeLayer('measure-line');
    }
    if (this.map.getSource('measure-line')) {
      this.map.removeSource('measure-line');
    }

    // Remove preview line
    this.removePreviewLine();

    // Remove popup
    if (this.popup) {
      this.popup.remove();
      this.popup = null;
    }

    // Reset points
    this.points = [];
  }
}
