import { invoke } from '@tauri-apps/api/core';
import maplibregl from 'maplibre-gl';
import { showToast, showError, showLoading, hideLoading } from './notifications.js';
import { logger } from './logger.js';

const log = logger.child('StacBrowser');

/**
 * STAC Browser - Browse and load data from STAC APIs
 */
export class StacBrowser {
  constructor(layerManager, mapManager) {
    this.layerManager = layerManager;
    this.mapManager = mapManager;

    // State
    this.currentCatalogUrl = null;
    this.currentCatalog = null;
    this.collections = [];
    this.selectedCollection = null;
    this.searchResults = [];
    this.selectedItem = null;
    this.searchBbox = null;

    // Map layer IDs for footprints
    this.footprintSourceId = 'stac-footprints';
    this.footprintFillLayerId = 'stac-footprints-fill';
    this.footprintLineLayerId = 'stac-footprints-line';

    // Drawing state
    this.isDrawing = false;
    this.drawStart = null;

    // DOM elements
    this.panel = document.getElementById('stac-panel');
    this.apiSelect = document.getElementById('stac-api-select');
    this.customUrlRow = document.getElementById('stac-custom-url-row');
    this.urlInput = document.getElementById('stac-url');
    this.connectBtn = document.getElementById('stac-connect-btn');
    this.catalogInfo = document.getElementById('stac-catalog-info');
    this.collectionsSection = document.getElementById('stac-collections');
    this.collectionSelect = document.getElementById('stac-collection-select');
    this.collectionInfo = document.getElementById('stac-collection-info');
    this.searchSection = document.getElementById('stac-search');
    this.useViewBtn = document.getElementById('stac-use-view');
    this.bboxDisplay = document.getElementById('stac-bbox-display');
    this.dateStart = document.getElementById('stac-date-start');
    this.dateEnd = document.getElementById('stac-date-end');
    this.cloudCover = document.getElementById('stac-cloud-cover');
    this.cloudValue = document.getElementById('stac-cloud-value');
    this.limitSelect = document.getElementById('stac-limit');
    this.searchBtn = document.getElementById('stac-search-btn');
    this.resultsSection = document.getElementById('stac-results');
    this.resultsCount = document.getElementById('stac-results-count');
    this.resultsList = document.getElementById('stac-results-list');
    this.clearResultsBtn = document.getElementById('stac-clear-results');
    this.toggleFootprintsBtn = document.getElementById('stac-toggle-footprints');
    this.footprintsVisible = true;
    this.itemDetailSection = document.getElementById('stac-item-detail');
    this.itemTitle = document.getElementById('stac-item-title');
    this.itemProperties = document.getElementById('stac-item-properties');
    this.assetList = document.getElementById('stac-asset-list');
    this.itemBackBtn = document.getElementById('stac-item-back');

    this.setupEventListeners();
    this.setDefaultDates();
  }

  setupEventListeners() {
    // Close button
    const closeBtn = document.getElementById('stac-panel-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.hide());
    }

    // API select dropdown - show/hide custom URL input and reset state
    if (this.apiSelect) {
      this.apiSelect.addEventListener('change', () => {
        const isCustom = this.apiSelect.value === 'custom';
        if (this.customUrlRow) {
          this.customUrlRow.classList.toggle('hidden', !isCustom);
          if (isCustom && this.urlInput) {
            this.urlInput.focus();
          }
        }
        // Reset state when API changes
        this.resetState();
      });
    }

    // Connect button
    if (this.connectBtn) {
      this.connectBtn.addEventListener('click', () => this.connect());
    }

    // URL input - connect on Enter
    if (this.urlInput) {
      this.urlInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          this.connect();
        }
      });
    }

    // Collection select
    if (this.collectionSelect) {
      this.collectionSelect.addEventListener('change', () => this.onCollectionChange());
    }

    // Use current view button
    if (this.useViewBtn) {
      this.useViewBtn.addEventListener('click', () => this.useCurrentViewBbox());
    }

    // Draw bbox button
    const drawBboxBtn = document.getElementById('stac-draw-bbox');
    if (drawBboxBtn) {
      drawBboxBtn.addEventListener('click', () => this.toggleDrawing());
    }

    // Clear bbox button
    const clearBboxBtn = document.getElementById('stac-clear-bbox');
    if (clearBboxBtn) {
      clearBboxBtn.addEventListener('click', () => this.clearBbox());
    }

    // Cloud cover slider
    if (this.cloudCover) {
      this.cloudCover.addEventListener('input', () => {
        if (this.cloudValue) {
          this.cloudValue.textContent = `${this.cloudCover.value}%`;
        }
      });
    }

    // Search button
    if (this.searchBtn) {
      this.searchBtn.addEventListener('click', () => this.search());
    }

    // Clear results button
    if (this.clearResultsBtn) {
      this.clearResultsBtn.addEventListener('click', () => this.clearResults());
    }

    // Toggle footprints button
    if (this.toggleFootprintsBtn) {
      this.toggleFootprintsBtn.addEventListener('click', () => this.toggleFootprints());
    }

    // Back button in item detail
    if (this.itemBackBtn) {
      this.itemBackBtn.addEventListener('click', () => this.showResultsList());
    }
  }

  setDefaultDates() {
    // Default to last 30 days
    const today = new Date();
    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    if (this.dateEnd) {
      this.dateEnd.value = today.toISOString().split('T')[0];
    }
    if (this.dateStart) {
      this.dateStart.value = thirtyDaysAgo.toISOString().split('T')[0];
    }
  }

  // ============================================
  // Panel visibility
  // ============================================

  show() {
    if (this.panel) {
      this.panel.classList.add('visible');
      const stacBtn = document.getElementById('stac-btn');
      if (stacBtn) stacBtn.classList.add('active');
    }
    // Restore footprints visibility when panel is shown
    if (this.footprintsVisible) {
      this.setFootprintsVisibility(true);
    }
  }

  hide() {
    if (this.panel) {
      this.panel.classList.remove('visible');
      const stacBtn = document.getElementById('stac-btn');
      if (stacBtn) stacBtn.classList.remove('active');
    }
    // Hide footprints when panel is closed
    this.setFootprintsVisibility(false);
  }

  toggle() {
    if (this.panel && this.panel.classList.contains('visible')) {
      this.hide();
    } else {
      this.show();
    }
  }

  isVisible() {
    return this.panel && this.panel.classList.contains('visible');
  }

  // ============================================
  // API Connection
  // ============================================

  async connect() {
    // Get URL from dropdown or custom input
    let url;
    if (this.apiSelect?.value === 'custom') {
      url = this.urlInput?.value?.trim();
      if (!url) {
        showError('Invalid URL', 'Please enter a STAC API URL');
        return;
      }
    } else {
      url = this.apiSelect?.value;
    }

    if (!url) {
      showError('Invalid URL', 'Please select a STAC API');
      return;
    }

    this.connectBtn.disabled = true;
    this.connectBtn.textContent = 'Connecting...';

    try {
      log.info('Connecting to STAC API', url);

      // Connect to catalog
      const catalog = await invoke('connect_stac_api', { url });
      this.currentCatalogUrl = url;
      this.currentCatalog = catalog;

      // Show catalog info
      this.showCatalogInfo(catalog);

      // Fetch collections
      const collections = await invoke('list_stac_collections', { url });
      this.collections = collections;

      // Populate collection select
      this.populateCollections(collections);

      // Show collections section
      this.collectionsSection?.classList.remove('hidden');

      showToast(`Connected to ${catalog.title || catalog.id}`, 'success');
      log.info('Connected to STAC API', { catalog: catalog.id, collections: collections.length });
    } catch (error) {
      log.error('Failed to connect to STAC API', error);
      showError('Connection failed', error);
    } finally {
      this.connectBtn.disabled = false;
      this.connectBtn.textContent = 'Connect';
    }
  }

  showCatalogInfo(catalog) {
    if (!this.catalogInfo) return;

    this.catalogInfo.innerHTML = `
      <div class="stac-info-title">${catalog.title || catalog.id}</div>
      <div class="stac-info-desc">${catalog.description || ''}</div>
    `;
    this.catalogInfo.classList.remove('hidden');
  }

  populateCollections(collections) {
    if (!this.collectionSelect) return;

    // Clear existing options
    this.collectionSelect.innerHTML = '<option value="">Select a collection...</option>';

    // Add collection options
    collections.forEach(col => {
      const option = document.createElement('option');
      option.value = col.id;
      option.textContent = col.title || col.id;
      this.collectionSelect.appendChild(option);
    });
  }

  onCollectionChange() {
    const collectionId = this.collectionSelect?.value;
    if (!collectionId) {
      this.selectedCollection = null;
      this.searchSection?.classList.add('hidden');
      this.collectionInfo.innerHTML = '';
      return;
    }

    // Find collection
    this.selectedCollection = this.collections.find(c => c.id === collectionId);

    // Show collection info
    if (this.selectedCollection && this.collectionInfo) {
      const extent = this.selectedCollection.extent;
      let info = `<div class="stac-info-desc">${this.selectedCollection.description || ''}</div>`;

      if (extent?.temporal?.interval?.[0]) {
        const [start, end] = extent.temporal.interval[0];
        info += `<div style="margin-top: 6px; font-size: 11px; color: #666;">
          Temporal: ${start || 'ongoing'} - ${end || 'ongoing'}
        </div>`;
      }

      this.collectionInfo.innerHTML = info;
    }

    // Show search section
    this.searchSection?.classList.remove('hidden');
  }

  // ============================================
  // Bounding Box
  // ============================================

  useCurrentViewBbox() {
    const map = this.mapManager?.map;
    if (!map) return;

    const bounds = map.getBounds();
    this.setBbox([bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]);

    log.info('Set search bbox from current view', this.searchBbox);
  }

  setBbox(bbox) {
    this.searchBbox = bbox;

    // Display bbox
    if (this.bboxDisplay) {
      this.bboxDisplay.textContent = bbox.map(v => v.toFixed(4)).join(', ');
    }

    // Show clear button
    const clearBtn = document.getElementById('stac-clear-bbox');
    if (clearBtn) {
      clearBtn.style.display = 'inline-block';
    }

    // Draw bbox rectangle on map
    this.drawBboxRectangle(bbox);
  }

  clearBbox() {
    this.searchBbox = null;

    // Clear display
    if (this.bboxDisplay) {
      this.bboxDisplay.textContent = '';
    }

    // Hide clear button
    const clearBtn = document.getElementById('stac-clear-bbox');
    if (clearBtn) {
      clearBtn.style.display = 'none';
    }

    // Remove bbox rectangle from map
    this.removeBboxRectangle();

    // Stop drawing if active
    this.stopDrawing();
  }

  drawBboxRectangle(bbox) {
    const map = this.mapManager?.map;
    if (!map) return;

    // Remove existing
    this.removeBboxRectangle();

    // Create GeoJSON for the bbox
    const geojson = {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [bbox[0], bbox[1]],
            [bbox[2], bbox[1]],
            [bbox[2], bbox[3]],
            [bbox[0], bbox[3]],
            [bbox[0], bbox[1]],
          ],
        ],
      },
    };

    // Add source and layers
    map.addSource('stac-bbox', {
      type: 'geojson',
      data: geojson,
    });

    map.addLayer({
      id: 'stac-bbox-fill',
      type: 'fill',
      source: 'stac-bbox',
      paint: {
        'fill-color': '#ff9800',
        'fill-opacity': 0.1,
      },
    });

    map.addLayer({
      id: 'stac-bbox-line',
      type: 'line',
      source: 'stac-bbox',
      paint: {
        'line-color': '#ff9800',
        'line-width': 2,
        'line-dasharray': [2, 2],
      },
    });
  }

  removeBboxRectangle() {
    const map = this.mapManager?.map;
    if (!map) return;

    if (map.getLayer('stac-bbox-line')) {
      map.removeLayer('stac-bbox-line');
    }
    if (map.getLayer('stac-bbox-fill')) {
      map.removeLayer('stac-bbox-fill');
    }
    if (map.getSource('stac-bbox')) {
      map.removeSource('stac-bbox');
    }
  }

  startDrawing() {
    const map = this.mapManager?.map;
    if (!map) return;

    this.isDrawing = true;
    this.drawStart = null;

    // Change cursor
    map.getCanvas().style.cursor = 'crosshair';

    // Show instructions
    if (this.bboxDisplay) {
      this.bboxDisplay.textContent = 'Click and drag to draw area...';
    }

    // Update button state
    const drawBtn = document.getElementById('stac-draw-bbox');
    if (drawBtn) {
      drawBtn.textContent = 'Cancel';
      drawBtn.classList.add('active');
    }

    // Add event listeners
    this._onMouseDown = e => this.onDrawMouseDown(e);
    this._onMouseMove = e => this.onDrawMouseMove(e);
    this._onMouseUp = e => this.onDrawMouseUp(e);

    map.on('mousedown', this._onMouseDown);
    map.on('mousemove', this._onMouseMove);
    map.on('mouseup', this._onMouseUp);
  }

  stopDrawing() {
    const map = this.mapManager?.map;
    if (!map) return;

    this.isDrawing = false;
    this.drawStart = null;

    // Reset cursor
    map.getCanvas().style.cursor = '';

    // Update button state
    const drawBtn = document.getElementById('stac-draw-bbox');
    if (drawBtn) {
      drawBtn.textContent = 'Draw Area';
      drawBtn.classList.remove('active');
    }

    // Remove event listeners
    if (this._onMouseDown) {
      map.off('mousedown', this._onMouseDown);
      map.off('mousemove', this._onMouseMove);
      map.off('mouseup', this._onMouseUp);
    }

    // Remove temporary drawing layer
    if (map.getLayer('stac-bbox-drawing')) {
      map.removeLayer('stac-bbox-drawing');
    }
    if (map.getSource('stac-bbox-drawing')) {
      map.removeSource('stac-bbox-drawing');
    }
  }

  onDrawMouseDown(e) {
    if (!this.isDrawing) return;

    this.drawStart = e.lngLat;

    // Prevent map panning
    e.preventDefault();
  }

  onDrawMouseMove(e) {
    if (!this.isDrawing || !this.drawStart) return;

    const map = this.mapManager?.map;
    if (!map) return;

    const start = this.drawStart;
    const end = e.lngLat;

    // Create temporary bbox
    const bbox = [
      Math.min(start.lng, end.lng),
      Math.min(start.lat, end.lat),
      Math.max(start.lng, end.lng),
      Math.max(start.lat, end.lat),
    ];

    // Update temporary drawing
    const geojson = {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [bbox[0], bbox[1]],
            [bbox[2], bbox[1]],
            [bbox[2], bbox[3]],
            [bbox[0], bbox[3]],
            [bbox[0], bbox[1]],
          ],
        ],
      },
    };

    const source = map.getSource('stac-bbox-drawing');
    if (source) {
      source.setData(geojson);
    } else {
      map.addSource('stac-bbox-drawing', {
        type: 'geojson',
        data: geojson,
      });

      map.addLayer({
        id: 'stac-bbox-drawing',
        type: 'line',
        source: 'stac-bbox-drawing',
        paint: {
          'line-color': '#ff9800',
          'line-width': 2,
        },
      });
    }
  }

  onDrawMouseUp(e) {
    if (!this.isDrawing || !this.drawStart) return;

    const start = this.drawStart;
    const end = e.lngLat;

    // Calculate final bbox
    const bbox = [
      Math.min(start.lng, end.lng),
      Math.min(start.lat, end.lat),
      Math.max(start.lng, end.lng),
      Math.max(start.lat, end.lat),
    ];

    // Only set if it's a reasonable size (not just a click)
    const minSize = 0.001; // ~100m at equator
    if (Math.abs(bbox[2] - bbox[0]) > minSize && Math.abs(bbox[3] - bbox[1]) > minSize) {
      this.setBbox(bbox);
      log.info('Drew search bbox', bbox);
    }

    this.stopDrawing();
  }

  toggleDrawing() {
    if (this.isDrawing) {
      this.stopDrawing();
      // Restore previous bbox display if we had one
      if (this.searchBbox) {
        this.bboxDisplay.textContent = this.searchBbox.map(v => v.toFixed(4)).join(', ');
      } else {
        this.bboxDisplay.textContent = '';
      }
    } else {
      this.startDrawing();
    }
  }

  // ============================================
  // Search
  // ============================================

  async search() {
    if (!this.currentCatalogUrl) {
      showError('Not connected', 'Please connect to a STAC API first');
      return;
    }

    if (!this.selectedCollection) {
      showError('No collection selected', 'Please select a collection to search');
      return;
    }

    // Build search params
    const params = {
      collections: [this.selectedCollection.id],
      limit: parseInt(this.limitSelect?.value || '20', 10),
    };

    // Add bbox if set
    if (this.searchBbox) {
      params.bbox = this.searchBbox;
    }

    // Add datetime range - only if at least one date is set
    const startDate = this.dateStart?.value;
    const endDate = this.dateEnd?.value;
    if (startDate && endDate) {
      // Both dates set - use range format with T00:00:00Z timestamps
      params.datetime = `${startDate}T00:00:00Z/${endDate}T23:59:59Z`;
    } else if (startDate) {
      // Only start date - search from that date onwards
      params.datetime = `${startDate}T00:00:00Z/..`;
    } else if (endDate) {
      // Only end date - search up to that date
      params.datetime = `../${endDate}T23:59:59Z`;
    }
    // If neither date is set, don't include datetime param (search all time)

    // Note: Cloud cover filter removed - not all STAC APIs support CQL2 filter extension
    // If needed in the future, can add: params.filter = {...} with filter-lang: 'cql2-json'
    // For now, cloud cover filtering is done client-side after results are returned

    this.searchBtn.disabled = true;
    this.searchBtn.textContent = 'Searching...';

    try {
      log.info('Searching STAC items', params);
      console.log('STAC search params:', JSON.stringify(params, null, 2));

      const result = await invoke('search_stac_items', {
        url: this.currentCatalogUrl,
        params,
      });

      this.searchResults = result.features || [];

      // Show results
      this.renderResults(this.searchResults, result.number_matched || result.context?.matched);

      // Display footprints on map
      this.displayFootprints(this.searchResults);

      log.info('Search completed', { count: this.searchResults.length });
    } catch (error) {
      // Log full error details for debugging
      log.error('Search failed', error);
      console.error('STAC search error details:', error);
      showError('Search failed', String(error));
    } finally {
      this.searchBtn.disabled = false;
      this.searchBtn.textContent = 'Search';
    }
  }

  renderResults(items, totalMatched) {
    if (!this.resultsList) return;

    // Show results section
    this.resultsSection?.classList.remove('hidden');
    this.itemDetailSection?.classList.add('hidden');

    // Update count
    if (this.resultsCount) {
      const countText = totalMatched ? `(${items.length} of ${totalMatched})` : `(${items.length})`;
      this.resultsCount.textContent = countText;
    }

    // Render items
    if (items.length === 0) {
      this.resultsList.innerHTML = '<div class="stac-empty-state">No items found</div>';
      return;
    }

    this.resultsList.innerHTML = items
      .map(item => {
        const datetime = item.properties?.datetime
          ? new Date(item.properties.datetime).toLocaleDateString()
          : 'Unknown date';
        const cloudCover = item.properties?.cloud_cover;
        const cloudText = cloudCover !== undefined ? `${cloudCover.toFixed(1)}% cloud` : '';

        return `
        <div class="stac-result-item" data-item-id="${item.id}">
          <div class="stac-result-title">${item.id}</div>
          <div class="stac-result-meta">
            <span class="stac-result-date">${datetime}</span>
            ${cloudText ? `<span class="stac-result-cloud">${cloudText}</span>` : ''}
          </div>
        </div>
      `;
      })
      .join('');

    // Add click handlers
    this.resultsList.querySelectorAll('.stac-result-item').forEach(el => {
      el.addEventListener('click', () => {
        const itemId = el.dataset.itemId;
        this.selectItem(itemId);
      });
    });
  }

  selectItem(itemId) {
    // Find item
    const item = this.searchResults.find(i => i.id === itemId);
    if (!item) return;

    this.selectedItem = item;

    // Highlight in list
    this.resultsList?.querySelectorAll('.stac-result-item').forEach(el => {
      el.classList.toggle('selected', el.dataset.itemId === itemId);
    });

    // Highlight on map
    this.highlightFootprint(itemId);

    // Show item detail
    this.showItemDetail(item);

    // Zoom to item
    if (item.bbox && item.bbox.length >= 4) {
      this.mapManager?.map?.fitBounds(
        [
          [item.bbox[0], item.bbox[1]],
          [item.bbox[2], item.bbox[3]],
        ],
        { padding: 50, maxZoom: 12 }
      );
    }
  }

  showItemDetail(item) {
    // Hide results list, show detail
    this.resultsSection?.classList.add('hidden');
    this.itemDetailSection?.classList.remove('hidden');

    // Set title
    if (this.itemTitle) {
      this.itemTitle.textContent = item.id;
    }

    // Show properties
    if (this.itemProperties) {
      const props = item.properties || {};
      const datetime = props.datetime ? new Date(props.datetime).toLocaleString() : 'Unknown';
      const cloudCover =
        props.cloud_cover !== undefined ? `${props.cloud_cover.toFixed(1)}%` : 'N/A';

      this.itemProperties.innerHTML = `
        <div class="stac-property-row">
          <span class="stac-property-key">Date</span>
          <span class="stac-property-value">${datetime}</span>
        </div>
        <div class="stac-property-row">
          <span class="stac-property-key">Cloud Cover</span>
          <span class="stac-property-value">${cloudCover}</span>
        </div>
        <div class="stac-property-row">
          <span class="stac-property-key">Collection</span>
          <span class="stac-property-value">${item.collection || 'N/A'}</span>
        </div>
      `;
    }

    // Show assets
    this.renderAssets(item);
  }

  renderAssets(item) {
    if (!this.assetList) return;

    const assets = item.assets || {};
    const assetKeys = Object.keys(assets);

    if (assetKeys.length === 0) {
      this.assetList.innerHTML = '<div class="stac-empty-state">No assets available</div>';
      return;
    }

    // Helper to check if asset is a loadable raster (COG/GeoTIFF/JP2)
    const isLoadableRaster = (asset, key) => {
      const type = (asset.media_type || '').toLowerCase();
      const href = (asset.href || '').toLowerCase();
      const roles = asset.roles || [];

      // Check media type for GeoTIFF/COG
      if (type.includes('geotiff') || type.includes('cloud-optimized')) {
        return true;
      }

      // Check for TIFF files (but not thumbnails)
      if (type.includes('tiff') && !roles.includes('thumbnail')) {
        return true;
      }

      // Check for JPEG2000 (common in Sentinel data)
      if (type.includes('jp2') || href.endsWith('.jp2')) {
        return true;
      }

      // Check href extension for TIF files
      if (href.includes('.tif')) {
        return true;
      }

      // Known data asset keys (not thumbnails/overviews)
      const dataKeys = [
        'visual',
        'B01',
        'B02',
        'B03',
        'B04',
        'B05',
        'B06',
        'B07',
        'B08',
        'B8A',
        'B09',
        'B11',
        'B12',
        'red',
        'green',
        'blue',
        'nir',
      ];
      if (dataKeys.includes(key)) {
        return true;
      }

      return false;
    };

    // Filter to show loadable raster assets first, then others
    const rasterAssets = assetKeys.filter(key => isLoadableRaster(assets[key], key));
    const otherAssets = assetKeys.filter(key => !rasterAssets.includes(key));
    const sortedKeys = [...rasterAssets, ...otherAssets];

    this.assetList.innerHTML = sortedKeys
      .map(key => {
        const asset = assets[key];
        const title = asset.title || key;
        const type = asset.media_type || 'Unknown type';
        const canLoad = isLoadableRaster(asset, key);

        return `
        <div class="stac-asset-item" data-asset-key="${key}">
          <div class="stac-asset-info">
            <div class="stac-asset-name">${title}</div>
            <div class="stac-asset-type">${type}</div>
          </div>
          ${
            canLoad
              ? `<button class="stac-asset-load-btn" data-asset-key="${key}">Load</button>`
              : ''
          }
        </div>
      `;
      })
      .join('');

    // Add click handlers for load buttons
    this.assetList.querySelectorAll('.stac-asset-load-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const assetKey = btn.dataset.assetKey;
        this.loadAsset(item, assetKey);
      });
    });
  }

  showResultsList() {
    this.itemDetailSection?.classList.add('hidden');
    this.resultsSection?.classList.remove('hidden');
  }

  clearResults() {
    this.searchResults = [];
    this.selectedItem = null;

    // Clear results list
    if (this.resultsList) {
      this.resultsList.innerHTML = '';
    }

    // Hide sections
    this.resultsSection?.classList.add('hidden');
    this.itemDetailSection?.classList.add('hidden');

    // Clear footprints from map
    this.clearFootprints();
  }

  /**
   * Reset all state when changing STAC API
   */
  resetState() {
    // Clear catalog state
    this.currentCatalogUrl = null;
    this.currentCatalog = null;
    this.collections = [];
    this.selectedCollection = null;

    // Clear search results
    this.clearResults();

    // Clear bbox
    this.searchBbox = null;
    if (this.bboxDisplay) {
      this.bboxDisplay.textContent = '';
    }
    const clearBboxBtn = document.getElementById('stac-clear-bbox');
    if (clearBboxBtn) {
      clearBboxBtn.style.display = 'none';
    }

    // Hide catalog info
    if (this.catalogInfo) {
      this.catalogInfo.classList.add('hidden');
      this.catalogInfo.innerHTML = '';
    }

    // Hide and reset collections section
    if (this.collectionsSection) {
      this.collectionsSection.classList.add('hidden');
    }
    if (this.collectionSelect) {
      this.collectionSelect.innerHTML = '<option value="">Select a collection...</option>';
    }
    if (this.collectionInfo) {
      this.collectionInfo.innerHTML = '';
    }

    // Hide search section
    if (this.searchSection) {
      this.searchSection.classList.add('hidden');
    }
  }

  // ============================================
  // Footprints on Map
  // ============================================

  displayFootprints(items) {
    const map = this.mapManager?.map;
    if (!map) return;

    // Reset visibility state when displaying new footprints
    this.footprintsVisible = true;
    if (this.toggleFootprintsBtn) {
      this.toggleFootprintsBtn.textContent = 'Hide';
    }

    // Create GeoJSON feature collection
    const geojson = {
      type: 'FeatureCollection',
      features: items.map(item => ({
        type: 'Feature',
        id: item.id,
        geometry: item.geometry,
        properties: {
          id: item.id,
          datetime: item.properties?.datetime,
          cloud_cover: item.properties?.cloud_cover,
        },
      })),
    };

    // Check if source exists
    const source = map.getSource(this.footprintSourceId);

    if (source) {
      // Update existing source
      source.setData(geojson);
    } else {
      // Add new source
      map.addSource(this.footprintSourceId, {
        type: 'geojson',
        data: geojson,
      });

      // Add fill layer
      map.addLayer({
        id: this.footprintFillLayerId,
        type: 'fill',
        source: this.footprintSourceId,
        paint: {
          'fill-color': [
            'case',
            ['boolean', ['feature-state', 'selected'], false],
            '#ff6600',
            '#4a9eff',
          ],
          'fill-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0.4, 0.2],
        },
      });

      // Add line layer
      map.addLayer({
        id: this.footprintLineLayerId,
        type: 'line',
        source: this.footprintSourceId,
        paint: {
          'line-color': [
            'case',
            ['boolean', ['feature-state', 'selected'], false],
            '#ff6600',
            '#4a9eff',
          ],
          'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 3, 2],
        },
      });

      // Add click handler
      map.on('click', this.footprintFillLayerId, e => {
        if (e.features && e.features.length > 0) {
          const itemId = e.features[0].properties.id;
          this.selectItem(itemId);
        }
      });

      // Change cursor on hover
      map.on('mouseenter', this.footprintFillLayerId, () => {
        map.getCanvas().style.cursor = 'pointer';
      });

      map.on('mouseleave', this.footprintFillLayerId, () => {
        map.getCanvas().style.cursor = '';
      });
    }

    // Fit bounds to footprints
    if (items.length > 0) {
      const bounds = new maplibregl.LngLatBounds();
      items.forEach(item => {
        if (item.bbox && item.bbox.length >= 4) {
          bounds.extend([item.bbox[0], item.bbox[1]]);
          bounds.extend([item.bbox[2], item.bbox[3]]);
        }
      });

      if (!bounds.isEmpty()) {
        map.fitBounds(bounds, { padding: 50, maxZoom: 10 });
      }
    }
  }

  highlightFootprint(itemId) {
    const map = this.mapManager?.map;
    if (!map) return;

    // Clear previous selection
    this.searchResults.forEach(item => {
      map.setFeatureState({ source: this.footprintSourceId, id: item.id }, { selected: false });
    });

    // Set new selection
    if (itemId) {
      map.setFeatureState({ source: this.footprintSourceId, id: itemId }, { selected: true });
    }
  }

  clearFootprints() {
    const map = this.mapManager?.map;
    if (!map) return;

    // Remove layers
    if (map.getLayer(this.footprintLineLayerId)) {
      map.removeLayer(this.footprintLineLayerId);
    }
    if (map.getLayer(this.footprintFillLayerId)) {
      map.removeLayer(this.footprintFillLayerId);
    }

    // Remove source
    if (map.getSource(this.footprintSourceId)) {
      map.removeSource(this.footprintSourceId);
    }
  }

  toggleFootprints() {
    this.footprintsVisible = !this.footprintsVisible;
    this.setFootprintsVisibility(this.footprintsVisible);

    // Update button text
    if (this.toggleFootprintsBtn) {
      this.toggleFootprintsBtn.textContent = this.footprintsVisible ? 'Hide' : 'Show';
    }
  }

  setFootprintsVisibility(visible) {
    const map = this.mapManager?.map;
    if (!map) return;

    const visibility = visible ? 'visible' : 'none';

    if (map.getLayer(this.footprintFillLayerId)) {
      map.setLayoutProperty(this.footprintFillLayerId, 'visibility', visibility);
    }
    if (map.getLayer(this.footprintLineLayerId)) {
      map.setLayoutProperty(this.footprintLineLayerId, 'visibility', visibility);
    }
  }

  // ============================================
  // Asset Loading
  // ============================================

  async loadAsset(item, assetKey) {
    const asset = item.assets?.[assetKey];
    if (!asset) {
      showError('Asset not found', `Asset "${assetKey}" not found in item`);
      return;
    }

    const assetHref = asset.href;
    const assetTitle = asset.title || assetKey;

    showLoading(`Loading ${assetTitle}...`);

    try {
      console.log('[STAC] Loading asset:', assetHref);
      log.info('Loading STAC asset', { itemId: item.id, assetKey, href: assetHref });

      // Call backend to open via /vsicurl/
      const metadata = await invoke('open_stac_asset', { assetHref });

      // Add to layer manager using existing infrastructure
      await this.addAssetToMap(metadata, item, assetKey, assetTitle);

      showToast(`Loaded ${assetTitle}`, 'success');
      log.info('Asset loaded successfully', { id: metadata.id });
    } catch (error) {
      // Log raw error to console for debugging
      console.error('[STAC] Raw error loading asset:', error);
      log.error('Failed to load STAC asset', error);
      showError('Failed to load asset', error);
    } finally {
      hideLoading();
    }
  }

  async addAssetToMap(metadata, item, assetKey, assetTitle) {
    // Create layer name from item ID and asset key
    const layerName = `${item.id}/${assetTitle}`;

    // Create layer data structure compatible with LayerManager
    const layerData = {
      id: metadata.id,
      path: metadata.path,
      type: 'raster',
      name: layerName,
      visible: true,
      opacity: 1.0,
      width: metadata.width,
      height: metadata.height,
      bands: metadata.bands,
      bounds: metadata.bounds,
      native_bounds: metadata.native_bounds,
      projection: metadata.projection,
      pixel_size: metadata.pixel_size,
      nodata: metadata.nodata,
      band_stats: metadata.band_stats,
      is_georeferenced: metadata.is_georeferenced,
      displayMode: metadata.bands >= 3 ? 'rgb' : 'grayscale',
      band: 1,
      stretch: this.getDefaultStretch(metadata.band_stats, 1),
      rgbBands: { r: 1, g: 2, b: 3 },
      rgbStretch: this.getDefaultRgbStretch(metadata.band_stats),
      // STAC metadata
      stacInfo: {
        itemId: item.id,
        collection: item.collection,
        assetKey,
        assetTitle,
      },
    };

    // Store in layer manager
    this.layerManager.layers.set(metadata.id, layerData);
    this.layerManager.layerOrder.push(metadata.id);

    // Setup tile protocol for this layer
    const protocolName = `raster-${metadata.id}`;
    this.layerManager.setupTileProtocol(protocolName, metadata.id, layerData);

    // Add to map
    const map = this.mapManager.map;

    // Add source
    map.addSource(`raster-source-${metadata.id}`, {
      type: 'raster',
      tiles: [`${protocolName}://{z}/{x}/{y}`],
      tileSize: 256,
      bounds: metadata.bounds,
      minzoom: 0,
      maxzoom: 22,
    });

    // Add layer
    map.addLayer({
      id: `raster-layer-${metadata.id}`,
      type: 'raster',
      source: `raster-source-${metadata.id}`,
      paint: {
        'raster-opacity': 1,
      },
    });

    // Update layer panel
    this.layerManager.updateLayerPanel();

    // Select the new layer
    this.layerManager.selectLayer(metadata.id);

    // Fit to bounds
    if (metadata.bounds && metadata.is_georeferenced) {
      map.fitBounds(
        [
          [metadata.bounds[0], metadata.bounds[1]],
          [metadata.bounds[2], metadata.bounds[3]],
        ],
        { padding: 50 }
      );
    }
  }

  getDefaultStretch(bandStats, bandNum) {
    const stats = bandStats?.find(s => s.band === bandNum) || bandStats?.[0];
    if (stats) {
      return {
        min: stats.min,
        max: stats.max,
        gamma: 1.0,
      };
    }
    return { min: 0, max: 10000, gamma: 1.0 };
  }

  getDefaultRgbStretch(bandStats) {
    return {
      r: this.getDefaultStretch(bandStats, 1),
      g: this.getDefaultStretch(bandStats, 2),
      b: this.getDefaultStretch(bandStats, 3),
    };
  }
}
