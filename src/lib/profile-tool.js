/**
 * Profile Tool - Draw a line and show elevation profile along it
 */

import { invoke } from '@tauri-apps/api/core';
import maplibregl from 'maplibre-gl';
import { showToast, showError, showLoading, hideLoading } from './notifications.js';

export class ProfileTool {
  constructor(mapManager, layerManager) {
    this.mapManager = mapManager;
    this.layerManager = layerManager;
    this.map = mapManager.map;
    this.active = false;
    this.points = [];
    this.markers = [];
    this.clickHandler = this.handleClick.bind(this);
    this.moveHandler = this.handleMouseMove.bind(this);
    this.keyHandler = this.handleKeyDown.bind(this);
  }

  activate() {
    if (this.active) return;
    this.active = true;
    this.points = [];
    this.clearMarkers();
    this.map.getCanvas().style.cursor = 'crosshair';
    this.map.on('click', this.clickHandler);
    this.map.on('mousemove', this.moveHandler);
    document.addEventListener('keydown', this.keyHandler);
    this.showInstruction('Click to set profile start point');
  }

  deactivate() {
    if (!this.active) return;
    this.active = false;
    this.map.getCanvas().style.cursor = '';
    this.map.off('click', this.clickHandler);
    this.map.off('mousemove', this.moveHandler);
    document.removeEventListener('keydown', this.keyHandler);
    this.hideInstruction();
    this.clearMarkers();
    this.clearLine();
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

  showInstruction(text) {
    let instruction = document.getElementById('profile-instruction');
    if (!instruction) {
      instruction = document.createElement('div');
      instruction.id = 'profile-instruction';
      document.body.appendChild(instruction);
    }
    instruction.textContent = text;
    instruction.style.display = 'block';
  }

  hideInstruction() {
    const instruction = document.getElementById('profile-instruction');
    if (instruction) {
      instruction.style.display = 'none';
    }
  }

  handleClick(e) {
    const { lng, lat } = e.lngLat;
    this.points.push([lng, lat]);

    // Add marker
    const markerEl = document.createElement('div');
    markerEl.className = 'profile-marker';
    markerEl.textContent = this.points.length;

    const marker = new maplibregl.Marker({ element: markerEl })
      .setLngLat([lng, lat])
      .addTo(this.map);
    this.markers.push(marker);

    if (this.points.length === 1) {
      this.showInstruction(
        'Click to set profile end point (or keep clicking for multi-point profile)'
      );
    } else {
      this.drawLine();
      this.showInstruction('Click to add more points, or press Enter to generate profile');
    }
  }

  handleMouseMove(e) {
    if (this.points.length > 0) {
      this.drawPreviewLine(e.lngLat);
    }
  }

  handleKeyDown(e) {
    if (e.key === 'Enter' && this.points.length >= 2) {
      e.preventDefault();
      this.generateProfile();
    }
  }

  drawLine() {
    const geojson = {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: this.points,
      },
    };

    if (this.map.getSource('profile-line')) {
      this.map.getSource('profile-line').setData(geojson);
    } else {
      this.map.addSource('profile-line', { type: 'geojson', data: geojson });
      this.map.addLayer({
        id: 'profile-line-layer',
        type: 'line',
        source: 'profile-line',
        paint: {
          'line-color': '#27ae60',
          'line-width': 3,
          'line-dasharray': [2, 1],
        },
      });
    }
  }

  drawPreviewLine(currentLngLat) {
    if (this.points.length === 0) return;

    const coords = [...this.points, [currentLngLat.lng, currentLngLat.lat]];
    const geojson = {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: coords,
      },
    };

    if (this.map.getSource('profile-preview')) {
      this.map.getSource('profile-preview').setData(geojson);
    } else {
      this.map.addSource('profile-preview', { type: 'geojson', data: geojson });
      this.map.addLayer({
        id: 'profile-preview-layer',
        type: 'line',
        source: 'profile-preview',
        paint: {
          'line-color': '#27ae60',
          'line-width': 2,
          'line-opacity': 0.5,
          'line-dasharray': [2, 2],
        },
      });
    }
  }

  clearLine() {
    if (this.map.getLayer('profile-line-layer')) {
      this.map.removeLayer('profile-line-layer');
    }
    if (this.map.getSource('profile-line')) {
      this.map.removeSource('profile-line');
    }
    if (this.map.getLayer('profile-preview-layer')) {
      this.map.removeLayer('profile-preview-layer');
    }
    if (this.map.getSource('profile-preview')) {
      this.map.removeSource('profile-preview');
    }
  }

  clearMarkers() {
    this.markers.forEach(m => m.remove());
    this.markers = [];
    this.points = [];
  }

  async generateProfile() {
    if (this.points.length < 2) {
      showToast('Need at least 2 points for profile', 'error');
      return;
    }

    // Find a suitable raster layer for elevation
    const rasterLayer = this.findElevationLayer();
    if (!rasterLayer) {
      showToast('No raster layer found for elevation profile', 'error');
      return;
    }

    showLoading('Generating elevation profile...');

    try {
      let result;

      if (this.mapManager.isPixelCoordMode() && this.mapManager.pixelExtent) {
        // Convert pseudo-geographic coordinates to pixel coordinates
        const extent = this.mapManager.pixelExtent;
        const scale = extent.scale || 0.01;
        const offsetX = extent.offsetX || 0;
        const offsetY = extent.offsetY || 0;

        const pixelCoords = this.points.map(([lng, lat]) => [
          Math.floor((lng + offsetX) / scale),
          Math.floor((offsetY - lat) / scale),
        ]);

        result = await invoke('get_elevation_profile_pixels', {
          id: rasterLayer.id,
          pixel_coords: pixelCoords,
          num_samples: 200,
        });
      } else {
        result = await invoke('get_elevation_profile', {
          id: rasterLayer.id,
          coords: this.points,
          num_samples: 200,
        });
      }

      this.showProfilePanel(result, rasterLayer);
    } catch (error) {
      console.error('Profile generation failed:', error);
      showError('Profile failed', error);
    } finally {
      hideLoading();
    }
  }

  findElevationLayer() {
    // Find the topmost visible raster layer (including non-georeferenced)
    const layerOrder = [...this.layerManager.layerOrder].reverse();
    for (const id of layerOrder) {
      const layer = this.layerManager.layers.get(id);
      if (layer && layer.type === 'raster' && layer.visible) {
        return layer;
      }
    }
    return null;
  }

  showProfilePanel(result, _layer) {
    // Remove existing panel
    const existing = document.getElementById('profile-panel');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = 'profile-panel';
    panel.innerHTML = `
      <div id="profile-panel-header">
        <h4>Elevation Profile</h4>
        <div class="profile-stats">
          <span>Distance: ${this.formatDistance(result.total_distance)}</span>
          <span>↑ ${result.elevation_gain.toFixed(1)}m</span>
          <span>↓ ${result.elevation_loss.toFixed(1)}m</span>
        </div>
        <button id="profile-panel-close">&times;</button>
      </div>
      <div id="profile-content">
        <canvas id="profile-canvas" width="600" height="200"></canvas>
        <div id="profile-hover-info"></div>
      </div>
      <div id="profile-range">
        <span>Min: ${result.min_elevation.toFixed(1)}m</span>
        <span>Max: ${result.max_elevation.toFixed(1)}m</span>
      </div>
    `;

    document.body.appendChild(panel);

    // Close button
    document.getElementById('profile-panel-close').addEventListener('click', () => {
      panel.remove();
      this.deactivate();
    });

    // Draw the chart
    this.drawProfileChart(result);

    // Add hover interaction
    this.setupChartHover(result);
  }

  drawProfileChart(result) {
    const canvas = document.getElementById('profile-canvas');
    const ctx = canvas.getContext('2d');
    const { width } = canvas;
    const { height } = canvas;
    const padding = { top: 20, right: 20, bottom: 30, left: 50 };

    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    // Clear
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, width, height);

    // Filter valid points
    const validPoints = result.points.filter(p => p.is_valid);
    if (validPoints.length < 2) {
      ctx.fillStyle = '#666';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No valid elevation data', width / 2, height / 2);
      return;
    }

    // Calculate scales
    const xScale = chartWidth / result.total_distance;
    const elevRange = result.max_elevation - result.min_elevation;
    const yScale = elevRange > 0 ? chartHeight / (elevRange * 1.1) : 1;
    const yOffset = result.min_elevation - elevRange * 0.05;

    // Draw grid
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
      const y = padding.top + (chartHeight * i) / 5;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();
    }

    // Draw axes
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, height - padding.bottom);
    ctx.lineTo(width - padding.right, height - padding.bottom);
    ctx.stroke();

    // Draw profile line
    ctx.beginPath();
    ctx.strokeStyle = '#27ae60';
    ctx.lineWidth = 2;

    let first = true;
    for (const point of result.points) {
      if (!point.is_valid) continue;

      const x = padding.left + point.distance * xScale;
      const y = height - padding.bottom - (point.elevation - yOffset) * yScale;

      if (first) {
        ctx.moveTo(x, y);
        first = false;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    // Fill under line
    ctx.lineTo(padding.left + result.total_distance * xScale, height - padding.bottom);
    ctx.lineTo(padding.left, height - padding.bottom);
    ctx.closePath();
    ctx.fillStyle = 'rgba(39, 174, 96, 0.2)';
    ctx.fill();

    // Draw labels
    ctx.fillStyle = '#888';
    ctx.font = '11px monospace';

    // Y axis labels
    ctx.textAlign = 'right';
    for (let i = 0; i <= 5; i++) {
      const elev = result.min_elevation + (elevRange * 1.1 * (5 - i)) / 5 - elevRange * 0.05;
      const y = padding.top + (chartHeight * i) / 5;
      ctx.fillText(`${elev.toFixed(0)}m`, padding.left - 5, y + 4);
    }

    // X axis labels
    ctx.textAlign = 'center';
    ctx.fillText('0', padding.left, height - 10);
    ctx.fillText(this.formatDistance(result.total_distance), width - padding.right, height - 10);
  }

  setupChartHover(result) {
    const canvas = document.getElementById('profile-canvas');
    const hoverInfo = document.getElementById('profile-hover-info');
    const padding = { left: 50, right: 20, top: 20, bottom: 30 };
    const chartWidth = canvas.width - padding.left - padding.right;

    canvas.addEventListener('mousemove', e => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const relX = x - padding.left;

      if (relX < 0 || relX > chartWidth) {
        hoverInfo.style.display = 'none';
        return;
      }

      const distance = (relX / chartWidth) * result.total_distance;

      // Find closest point
      let closest = result.points[0];
      let minDiff = Math.abs(closest.distance - distance);
      for (const point of result.points) {
        const diff = Math.abs(point.distance - distance);
        if (diff < minDiff) {
          minDiff = diff;
          closest = point;
        }
      }

      if (closest.is_valid) {
        hoverInfo.innerHTML = `
          <strong>${closest.elevation.toFixed(1)}m</strong> at ${this.formatDistance(closest.distance)}
        `;
        hoverInfo.style.display = 'block';
        hoverInfo.style.left = `${x}px`;
      } else {
        hoverInfo.style.display = 'none';
      }
    });

    canvas.addEventListener('mouseleave', () => {
      hoverInfo.style.display = 'none';
    });
  }

  formatDistance(meters) {
    if (meters < 1000) {
      return `${meters.toFixed(0)}m`;
    }
    return `${(meters / 1000).toFixed(2)}km`;
  }
}
