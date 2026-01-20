/**
 * STAC Browser - Browse and load data from STAC APIs
 * @module stac-browser
 *
 * Provides a UI for connecting to SpatioTemporal Asset Catalogs (STAC),
 * searching for imagery, and loading assets as map layers.
 */

import { invoke } from '@tauri-apps/api/core';
import maplibregl from 'maplibre-gl';
import { showToast, showError, showLoading, hideLoading } from './notifications';
import { logger } from './logger';
import type { LayerManager } from './layer-manager/index';
import type { MapManager } from './map-manager';
import type {
  RasterLayer,
  BandStats,
  StretchSettings,
  RgbStretchSettings,
} from './layer-manager/types';

const log = logger.child('StacBrowser');

/** Catalog type - API with search or static with links */
type StacCatalogType = 'Api' | 'Static';

/** STAC Link */
interface StacLink {
  href: string;
  rel: string;
  type?: string;
  title?: string;
}

/** STAC Catalog metadata */
interface StacCatalog {
  id: string;
  title?: string;
  description?: string;
  links?: StacLink[];
}

/** Extended catalog info from backend */
interface StacCatalogInfo {
  id: string;
  title?: string;
  description: string;
  catalog_type: StacCatalogType;
  base_url: string;
  links?: StacLink[];
}

/** Child entry from static catalog */
interface StacChildEntry {
  href: string;
  title?: string;
  entry_type?: string;
}

/** STAC Collection metadata */
interface StacCollection {
  id: string;
  title?: string;
  description?: string;
  extent?: {
    spatial?: { bbox?: number[][] };
    temporal?: { interval?: Array<[string | null, string | null]> };
  };
  links?: StacLink[];
}

/** Extended collection info for static catalogs (includes URL) */
interface StaticCollectionEntry {
  id: string;
  title?: string;
  description?: string;
  url: string;
  /** True if this is a sub-catalog (not a collection) */
  isCatalog?: boolean;
}

/** STAC Item */
interface StacItem {
  id: string;
  collection?: string;
  geometry?: GeoJSON.Geometry;
  bbox?: number[];
  properties?: {
    datetime?: string;
    cloud_cover?: number;
    [key: string]: unknown;
  };
  assets?: Record<string, StacAsset>;
}

/** STAC Asset */
interface StacAsset {
  href: string;
  title?: string;
  description?: string;
  media_type?: string;
  roles?: string[];
}

/** Search parameters */
interface StacSearchParams {
  collections: string[];
  limit: number;
  bbox?: number[];
  datetime?: string;
}

/** Search result */
interface StacSearchResult {
  features: StacItem[];
  number_matched?: number;
  context?: { matched?: number };
}

/** Raster metadata from backend */
interface RasterMetadata {
  id: string;
  path: string;
  width: number;
  height: number;
  bands: number;
  bounds: [number, number, number, number];
  native_bounds?: [number, number, number, number];
  projection?: string;
  pixel_size?: [number, number];
  nodata?: number | null;
  band_stats: Array<BandStats & { band?: number }>;
  is_georeferenced: boolean;
}

/** STAC layer data extending RasterLayer */
interface StacLayerData extends RasterLayer {
  stacInfo?: {
    itemId: string;
    collection?: string;
    assetKey: string;
    assetTitle: string;
  };
}

/**
 * STAC Browser - Browse and load data from STAC APIs.
 *
 * Provides functionality for:
 * - Connecting to STAC API catalogs
 * - Browsing collections
 * - Searching for items with spatial/temporal filters
 * - Loading COG/GeoTIFF assets as map layers
 */
export class StacBrowser {
  private layerManager: LayerManager;
  private mapManager: MapManager;

  // State
  private currentCatalogUrl: string | null = null;
  private currentCatalog: StacCatalog | null = null;
  private catalogType: StacCatalogType = 'Api';
  private collections: StacCollection[] = [];
  private staticCollections: StaticCollectionEntry[] = []; // For static catalogs
  private catalogNavHistory: Array<{ url: string; title: string }> = []; // Breadcrumb navigation
  private selectedCollection: StacCollection | null = null;
  private selectedStaticCollection: StaticCollectionEntry | null = null;
  private searchResults: StacItem[] = [];
  private selectedItem: StacItem | null = null;
  private searchBbox: number[] | null = null;

  // Map layer IDs for footprints
  private footprintSourceId = 'stac-footprints';
  private footprintFillLayerId = 'stac-footprints-fill';
  private footprintLineLayerId = 'stac-footprints-line';

  // Drawing state
  private isDrawing = false;
  private drawStart: maplibregl.LngLat | null = null;
  private _onMouseDown: ((e: maplibregl.MapMouseEvent) => void) | null = null;
  private _onMouseMove: ((e: maplibregl.MapMouseEvent) => void) | null = null;
  private _onMouseUp: ((e: maplibregl.MapMouseEvent) => void) | null = null;

  // DOM elements
  private panel: HTMLElement | null;
  private apiSelect: HTMLSelectElement | null;
  private customUrlRow: HTMLElement | null;
  private urlInput: HTMLInputElement | null;
  private connectBtn: HTMLButtonElement | null;
  private catalogInfo: HTMLElement | null;
  private collectionsSection: HTMLElement | null;
  private collectionSelect: HTMLSelectElement | null;
  private collectionInfo: HTMLElement | null;
  private searchSection: HTMLElement | null;
  private useViewBtn: HTMLElement | null;
  private bboxDisplay: HTMLElement | null;
  private dateStart: HTMLInputElement | null;
  private dateEnd: HTMLInputElement | null;
  private cloudCover: HTMLInputElement | null;
  private cloudValue: HTMLElement | null;
  private limitSelect: HTMLSelectElement | null;
  private searchBtn: HTMLButtonElement | null;
  private resultsSection: HTMLElement | null;
  private resultsCount: HTMLElement | null;
  private resultsList: HTMLElement | null;
  private clearResultsBtn: HTMLElement | null;
  private toggleFootprintsBtn: HTMLButtonElement | null;
  private footprintsVisible = true;
  private showAllCheckbox: HTMLInputElement | null;
  private itemDetailSection: HTMLElement | null;
  private itemTitle: HTMLElement | null;
  private itemProperties: HTMLElement | null;
  private assetList: HTMLElement | null;
  private itemBackBtn: HTMLElement | null;

  /**
   * Create a new StacBrowser instance.
   * @param layerManager - LayerManager for adding loaded assets
   * @param mapManager - MapManager for map operations
   */
  constructor(layerManager: LayerManager, mapManager: MapManager) {
    this.layerManager = layerManager;
    this.mapManager = mapManager;

    // DOM elements
    this.panel = document.getElementById('stac-panel');
    this.apiSelect = document.getElementById('stac-api-select') as HTMLSelectElement | null;
    this.customUrlRow = document.getElementById('stac-custom-url-row');
    this.urlInput = document.getElementById('stac-url') as HTMLInputElement | null;
    this.connectBtn = document.getElementById('stac-connect-btn') as HTMLButtonElement | null;
    this.catalogInfo = document.getElementById('stac-catalog-info');
    this.collectionsSection = document.getElementById('stac-collections');
    this.collectionSelect = document.getElementById(
      'stac-collection-select'
    ) as HTMLSelectElement | null;
    this.collectionInfo = document.getElementById('stac-collection-info');
    this.searchSection = document.getElementById('stac-search');
    this.useViewBtn = document.getElementById('stac-use-view');
    this.bboxDisplay = document.getElementById('stac-bbox-display');
    this.dateStart = document.getElementById('stac-date-start') as HTMLInputElement | null;
    this.dateEnd = document.getElementById('stac-date-end') as HTMLInputElement | null;
    this.cloudCover = document.getElementById('stac-cloud-cover') as HTMLInputElement | null;
    this.cloudValue = document.getElementById('stac-cloud-value');
    this.limitSelect = document.getElementById('stac-limit') as HTMLSelectElement | null;
    this.searchBtn = document.getElementById('stac-search-btn') as HTMLButtonElement | null;
    this.resultsSection = document.getElementById('stac-results');
    this.resultsCount = document.getElementById('stac-results-count');
    this.resultsList = document.getElementById('stac-results-list');
    this.clearResultsBtn = document.getElementById('stac-clear-results');
    this.toggleFootprintsBtn = document.getElementById(
      'stac-toggle-footprints'
    ) as HTMLButtonElement | null;
    this.showAllCheckbox = document.getElementById('stac-show-all') as HTMLInputElement | null;
    this.itemDetailSection = document.getElementById('stac-item-detail');
    this.itemTitle = document.getElementById('stac-item-title');
    this.itemProperties = document.getElementById('stac-item-properties');
    this.assetList = document.getElementById('stac-asset-list');
    this.itemBackBtn = document.getElementById('stac-item-back');

    this.setupEventListeners();
    this.setDefaultDates();
  }

  /**
   * Setup all event listeners for the STAC browser UI.
   */
  private setupEventListeners(): void {
    // Close button
    const closeBtn = document.getElementById('stac-panel-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.hide());
    }

    // API select dropdown - show/hide custom URL input and reset state
    if (this.apiSelect) {
      this.apiSelect.addEventListener('change', () => {
        const isCustom = this.apiSelect?.value === 'custom';
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
        if (this.cloudValue && this.cloudCover) {
          this.cloudValue.textContent = `${this.cloudCover.value}%`;
        }
      });
    }

    // Show all checkbox - toggle filter controls visibility
    if (this.showAllCheckbox) {
      this.showAllCheckbox.addEventListener('change', () => this.onShowAllChange());
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

  /**
   * Handle "Show all" checkbox change - toggle filter controls.
   */
  private onShowAllChange(): void {
    const showAll = this.showAllCheckbox?.checked ?? true;

    // Toggle visibility/state of filter controls
    const cloudCoverRow = this.cloudCover?.closest('.stac-filter-row');

    if (cloudCoverRow) {
      (cloudCoverRow as HTMLElement).style.opacity = showAll ? '0.5' : '1';
    }
  }

  /**
   * Set default date range (last 30 days).
   */
  private setDefaultDates(): void {
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

  /**
   * Show the STAC browser panel.
   */
  show(): void {
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

  /**
   * Hide the STAC browser panel.
   */
  hide(): void {
    if (this.panel) {
      this.panel.classList.remove('visible');
      const stacBtn = document.getElementById('stac-btn');
      if (stacBtn) stacBtn.classList.remove('active');
    }
    // Hide footprints when panel is closed
    this.setFootprintsVisibility(false);
  }

  /**
   * Toggle the STAC browser panel visibility.
   */
  toggle(): void {
    if (this.panel && this.panel.classList.contains('visible')) {
      this.hide();
    } else {
      this.show();
    }
  }

  /**
   * Check if the STAC browser panel is visible.
   */
  isVisible(): boolean {
    return this.panel ? this.panel.classList.contains('visible') : false;
  }

  // ============================================
  // API Connection
  // ============================================

  /**
   * Connect to a STAC API or static catalog.
   */
  async connect(): Promise<void> {
    // Get URL from dropdown or custom input
    let url: string | undefined;
    if (this.apiSelect?.value === 'custom') {
      url = this.urlInput?.value?.trim();
      if (!url) {
        showError('Invalid URL', 'Please enter a STAC catalog URL');
        return;
      }
    } else {
      url = this.apiSelect?.value;
    }

    if (!url) {
      showError('Invalid URL', 'Please select a STAC catalog');
      return;
    }

    if (this.connectBtn) {
      this.connectBtn.disabled = true;
      this.connectBtn.textContent = 'Connecting...';
    }

    try {
      log.info('Connecting to STAC catalog', { url });

      // Connect to catalog - returns extended info with type detection
      const catalogInfo = await invoke<StacCatalogInfo>('connect_stac_api', { url });
      this.currentCatalogUrl = catalogInfo.base_url;
      this.currentCatalog = {
        id: catalogInfo.id,
        title: catalogInfo.title,
        description: catalogInfo.description,
        links: catalogInfo.links,
      };
      this.catalogType = catalogInfo.catalog_type;

      // Show catalog info with type indicator
      this.showCatalogInfo(this.currentCatalog, catalogInfo.catalog_type);

      if (catalogInfo.catalog_type === 'Api') {
        // STAC API - fetch collections from /collections endpoint
        const collections = await invoke<StacCollection[]>('list_stac_collections', {
          url: this.currentCatalogUrl,
        });
        this.collections = collections;
        this.staticCollections = [];
        this.populateCollections(collections);
      } else {
        // Static catalog - extract collections from child links
        await this.loadStaticCatalogChildren(url);
      }

      // Show collections section
      this.collectionsSection?.classList.remove('hidden');

      const typeLabel = catalogInfo.catalog_type === 'Api' ? 'API' : 'Static';
      showToast(
        `Connected to ${this.currentCatalog.title || this.currentCatalog.id} (${typeLabel})`,
        'success'
      );
      log.info('Connected to STAC catalog', {
        catalog: this.currentCatalog.id,
        type: catalogInfo.catalog_type,
        collections: this.collections.length + this.staticCollections.length,
      });
    } catch (error) {
      log.error(
        'Failed to connect to STAC catalog',
        error instanceof Error ? error : { error: String(error) }
      );
      showError('Connection failed', error instanceof Error ? error : String(error));
    } finally {
      if (this.connectBtn) {
        this.connectBtn.disabled = false;
        this.connectBtn.textContent = 'Connect';
      }
    }
  }

  /**
   * Load children from a static STAC catalog.
   * Identifies sub-catalogs vs collections based on URL patterns.
   */
  private async loadStaticCatalogChildren(
    catalogUrl: string,
    _catalogTitle?: string
  ): Promise<void> {
    try {
      const children = await invoke<StacChildEntry[]>('get_static_catalog_children', {
        catalogUrl,
      });

      this.staticCollections = [];
      this.collections = [];

      for (const child of children) {
        // Check if it's a collection (ends with collection.json)
        // Sub-catalogs typically end with catalog.json
        const isCollection = child.href.includes('collection.json');
        const isCatalog = child.href.includes('catalog.json') && !isCollection;

        this.staticCollections.push({
          id: child.title || this.extractIdFromUrl(child.href),
          title: child.title,
          description: isCatalog ? '📁 Sub-catalog (click to explore)' : undefined,
          url: child.href,
          isCatalog,
        });
      }

      // Populate the dropdown with static collection entries
      this.populateStaticCollections(this.staticCollections);

      // Update breadcrumb display
      this.updateBreadcrumbDisplay();
    } catch (error) {
      log.error('Failed to load static catalog children', { error: String(error) });
      throw error;
    }
  }

  /**
   * Navigate into a sub-catalog.
   */
  private async navigateToSubCatalog(entry: StaticCollectionEntry): Promise<void> {
    if (!entry.isCatalog) return;

    // Add current location to navigation history
    if (this.currentCatalogUrl && this.currentCatalog) {
      this.catalogNavHistory.push({
        url: this.currentCatalogUrl,
        title: this.currentCatalog.title || this.currentCatalog.id,
      });
    }

    // Update current catalog URL
    this.currentCatalogUrl = entry.url;

    // Load the sub-catalog's children
    try {
      log.info('Navigating to sub-catalog', { url: entry.url });
      await this.loadStaticCatalogChildren(entry.url, entry.title);

      // Update catalog info display
      if (this.catalogInfo) {
        const breadcrumb = this.catalogNavHistory.map(h => h.title).join(' > ');
        const currentTitle = entry.title || this.extractIdFromUrl(entry.url);
        this.catalogInfo.innerHTML = `
          <div class="stac-info-title">${currentTitle} (Static Catalog)</div>
          ${breadcrumb ? `<div class="stac-breadcrumb">📂 ${breadcrumb} > <strong>${currentTitle}</strong></div>` : ''}
          <button id="stac-nav-back" class="stac-nav-back-btn" ${this.catalogNavHistory.length === 0 ? 'disabled' : ''}>← Back</button>
        `;

        // Attach back button handler
        const backBtn = document.getElementById('stac-nav-back');
        if (backBtn) {
          backBtn.addEventListener('click', () => this.navigateBack());
        }
      }

      // Hide search section when navigating (no collection selected yet)
      this.searchSection?.classList.add('hidden');
      this.selectedStaticCollection = null;

      showToast(`Opened ${entry.title || 'sub-catalog'}`, 'success');
    } catch (error) {
      log.error('Failed to navigate to sub-catalog', { error: String(error) });
      showError('Navigation failed', error instanceof Error ? error : String(error));
    }
  }

  /**
   * Navigate back to the parent catalog.
   */
  private async navigateBack(): Promise<void> {
    if (this.catalogNavHistory.length === 0) return;

    const parent = this.catalogNavHistory.pop()!;
    this.currentCatalogUrl = parent.url;

    try {
      await this.loadStaticCatalogChildren(parent.url, parent.title);

      // Update catalog info display
      if (this.catalogInfo) {
        const breadcrumb = this.catalogNavHistory.map(h => h.title).join(' > ');
        this.catalogInfo.innerHTML = `
          <div class="stac-info-title">${parent.title} (Static Catalog)</div>
          ${breadcrumb ? `<div class="stac-breadcrumb">📂 ${breadcrumb} > <strong>${parent.title}</strong></div>` : ''}
          <button id="stac-nav-back" class="stac-nav-back-btn" ${this.catalogNavHistory.length === 0 ? 'disabled' : ''}>← Back</button>
        `;

        // Attach back button handler
        const backBtn = document.getElementById('stac-nav-back');
        if (backBtn) {
          backBtn.addEventListener('click', () => this.navigateBack());
        }
      }

      // Hide search section
      this.searchSection?.classList.add('hidden');
      this.selectedStaticCollection = null;
    } catch (error) {
      log.error('Failed to navigate back', { error: String(error) });
      showError('Navigation failed', error instanceof Error ? error : String(error));
    }
  }

  /**
   * Update the breadcrumb display in catalog info.
   */
  private updateBreadcrumbDisplay(): void {
    if (!this.catalogInfo || this.catalogNavHistory.length === 0) return;

    // Find or create breadcrumb element
    let breadcrumbEl = this.catalogInfo.querySelector('.stac-breadcrumb');
    if (!breadcrumbEl) {
      breadcrumbEl = document.createElement('div');
      breadcrumbEl.className = 'stac-breadcrumb';
      this.catalogInfo.appendChild(breadcrumbEl);
    }

    const breadcrumb = this.catalogNavHistory.map(h => h.title).join(' > ');
    breadcrumbEl.innerHTML = breadcrumb ? `📂 ${breadcrumb}` : '';
  }

  /**
   * Extract an ID from a URL (last path segment without extension).
   */
  private extractIdFromUrl(url: string): string {
    const parts = url.split('/');
    const lastPart = parts[parts.length - 1] || parts[parts.length - 2];
    return lastPart.replace(/\.(json|geojson)$/i, '');
  }

  /**
   * Populate dropdown with static collection entries.
   */
  private populateStaticCollections(entries: StaticCollectionEntry[]): void {
    if (!this.collectionSelect) return;

    this.collectionSelect.innerHTML = '<option value="">Select a collection...</option>';

    entries.forEach(entry => {
      const option = document.createElement('option');
      option.value = entry.url; // Use URL as value for static collections
      option.textContent = entry.title || entry.id;
      if (entry.description) {
        option.title = entry.description;
      }
      this.collectionSelect!.appendChild(option);
    });
  }

  /**
   * Display catalog information.
   */
  private showCatalogInfo(catalog: StacCatalog, catalogType?: StacCatalogType): void {
    if (!this.catalogInfo) return;

    const typeLabel = catalogType === 'Static' ? ' (Static Catalog)' : '';

    this.catalogInfo.innerHTML = `
      <div class="stac-info-title">${catalog.title || catalog.id}${typeLabel}</div>
      <div class="stac-info-desc">${catalog.description || ''}</div>
    `;
    this.catalogInfo.classList.remove('hidden');
  }

  /**
   * Populate the collections dropdown.
   */
  private populateCollections(collections: StacCollection[]): void {
    if (!this.collectionSelect) return;

    // Clear existing options
    this.collectionSelect.innerHTML = '<option value="">Select a collection...</option>';

    // Add collection options
    collections.forEach(col => {
      const option = document.createElement('option');
      option.value = col.id;
      option.textContent = col.title || col.id;
      this.collectionSelect!.appendChild(option);
    });
  }

  /**
   * Handle collection selection change.
   */
  private onCollectionChange(): void {
    const selectedValue = this.collectionSelect?.value;
    console.log('[STAC] onCollectionChange:', selectedValue);
    console.log('[STAC] catalogType:', this.catalogType);
    console.log('[STAC] staticCollections:', this.staticCollections);

    if (!selectedValue) {
      this.selectedCollection = null;
      this.selectedStaticCollection = null;
      this.searchSection?.classList.add('hidden');
      if (this.collectionInfo) this.collectionInfo.innerHTML = '';
      return;
    }

    if (this.catalogType === 'Static') {
      // For static catalogs, the value is a URL
      const selectedEntry = this.staticCollections.find(c => c.url === selectedValue);
      console.log('[STAC] selectedEntry:', selectedEntry);

      if (selectedEntry?.isCatalog) {
        // This is a sub-catalog - navigate into it
        this.navigateToSubCatalog(selectedEntry);
        // Reset the dropdown selection since we're navigating
        if (this.collectionSelect) {
          this.collectionSelect.value = '';
        }
        return;
      }

      this.selectedStaticCollection = selectedEntry || null;
      this.selectedCollection = null;

      // Show collection info for static collection
      if (this.selectedStaticCollection && this.collectionInfo) {
        this.collectionInfo.innerHTML = `
          <div class="stac-info-desc">${this.selectedStaticCollection.description || 'Static collection'}</div>
        `;
      }
    } else {
      // For API catalogs, the value is a collection ID
      this.selectedCollection = this.collections.find(c => c.id === selectedValue) || null;
      this.selectedStaticCollection = null;

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
    }

    // Show search section
    this.searchSection?.classList.remove('hidden');
  }

  // ============================================
  // Bounding Box
  // ============================================

  /**
   * Use the current map view as the search bounding box.
   */
  private useCurrentViewBbox(): void {
    const map = this.mapManager?.map;
    if (!map) return;

    const bounds = map.getBounds();
    this.setBbox([bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]);

    log.info('Set search bbox from current view', { bbox: this.searchBbox });
  }

  /**
   * Set the search bounding box.
   */
  private setBbox(bbox: number[]): void {
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

  /**
   * Clear the search bounding box.
   */
  private clearBbox(): void {
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

  /**
   * Draw a bounding box rectangle on the map.
   */
  private drawBboxRectangle(bbox: number[]): void {
    const map = this.mapManager?.map;
    if (!map) return;

    // Remove existing
    this.removeBboxRectangle();

    // Create GeoJSON for the bbox
    const geojson: GeoJSON.Feature = {
      type: 'Feature',
      properties: {},
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

  /**
   * Remove the bounding box rectangle from the map.
   */
  private removeBboxRectangle(): void {
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

  /**
   * Start drawing a bounding box.
   */
  private startDrawing(): void {
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
    this._onMouseDown = (e: maplibregl.MapMouseEvent) => this.onDrawMouseDown(e);
    this._onMouseMove = (e: maplibregl.MapMouseEvent) => this.onDrawMouseMove(e);
    this._onMouseUp = (e: maplibregl.MapMouseEvent) => this.onDrawMouseUp(e);

    map.on('mousedown', this._onMouseDown);
    map.on('mousemove', this._onMouseMove);
    map.on('mouseup', this._onMouseUp);
  }

  /**
   * Stop drawing a bounding box.
   */
  private stopDrawing(): void {
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
    }
    if (this._onMouseMove) {
      map.off('mousemove', this._onMouseMove);
    }
    if (this._onMouseUp) {
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

  /**
   * Handle mouse down during bbox drawing.
   */
  private onDrawMouseDown(e: maplibregl.MapMouseEvent): void {
    if (!this.isDrawing) return;

    this.drawStart = e.lngLat;

    // Prevent map panning
    e.preventDefault();
  }

  /**
   * Handle mouse move during bbox drawing.
   */
  private onDrawMouseMove(e: maplibregl.MapMouseEvent): void {
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
    const geojson: GeoJSON.Feature = {
      type: 'Feature',
      properties: {},
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

    const source = map.getSource('stac-bbox-drawing') as maplibregl.GeoJSONSource | undefined;
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

  /**
   * Handle mouse up during bbox drawing.
   */
  private onDrawMouseUp(e: maplibregl.MapMouseEvent): void {
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
      log.info('Drew search bbox', { bbox });
    }

    this.stopDrawing();
  }

  /**
   * Toggle bounding box drawing mode.
   */
  private toggleDrawing(): void {
    if (this.isDrawing) {
      this.stopDrawing();
      // Restore previous bbox display if we had one
      if (this.searchBbox && this.bboxDisplay) {
        this.bboxDisplay.textContent = this.searchBbox.map(v => v.toFixed(4)).join(', ');
      } else if (this.bboxDisplay) {
        this.bboxDisplay.textContent = '';
      }
    } else {
      this.startDrawing();
    }
  }

  // ============================================
  // Search
  // ============================================

  /**
   * Search for STAC items (or browse for static catalogs).
   */
  async search(): Promise<void> {
    console.log('[STAC] search() called');
    console.log('[STAC] currentCatalogUrl:', this.currentCatalogUrl);
    console.log('[STAC] catalogType:', this.catalogType);
    console.log('[STAC] selectedStaticCollection:', this.selectedStaticCollection);
    console.log('[STAC] selectedCollection:', this.selectedCollection);

    if (!this.currentCatalogUrl) {
      showError('Not connected', 'Please connect to a STAC catalog first');
      return;
    }

    // Check if we have a valid collection selected
    const hasApiCollection = this.catalogType === 'Api' && this.selectedCollection;
    const hasStaticCollection = this.catalogType === 'Static' && this.selectedStaticCollection;

    if (!hasApiCollection && !hasStaticCollection) {
      showError('No collection selected', 'Please select a collection to browse');
      return;
    }

    if (this.searchBtn) {
      this.searchBtn.disabled = true;
      this.searchBtn.textContent = this.catalogType === 'Static' ? 'Browsing...' : 'Searching...';
    }

    // Show loading state in results area
    if (this.resultsList) {
      this.resultsList.innerHTML =
        '<div class="stac-empty-state">Loading items from catalog...</div>';
    }
    this.resultsSection?.classList.remove('hidden');

    try {
      let result: StacSearchResult;

      if (this.catalogType === 'Static' && this.selectedStaticCollection) {
        // Static catalog - browse collection by following links
        const collectionUrl = this.selectedStaticCollection.url;
        const limit = parseInt(this.limitSelect?.value || '20', 10);
        log.info('Browsing static collection', { url: collectionUrl, limit });
        console.log('[STAC] Browsing static collection:', collectionUrl, 'limit:', limit);

        result = await invoke<StacSearchResult>('browse_static_collection', {
          collectionUrl,
          limit,
        });
        console.log('[STAC] Browse result:', JSON.stringify(result, null, 2));
      } else if (this.selectedCollection) {
        // STAC API - use search endpoint
        const params: StacSearchParams = {
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
          params.datetime = `${startDate}T00:00:00Z/${endDate}T23:59:59Z`;
        } else if (startDate) {
          params.datetime = `${startDate}T00:00:00Z/..`;
        } else if (endDate) {
          params.datetime = `../${endDate}T23:59:59Z`;
        }

        log.info('Searching STAC items', { params });
        console.log('STAC search params:', JSON.stringify(params, null, 2));

        result = await invoke<StacSearchResult>('search_stac_items', {
          url: this.currentCatalogUrl,
          params,
        });
      } else {
        throw new Error('No collection selected');
      }

      const rawResults = result.features || [];
      const totalBeforeFilter = rawResults.length;

      // Apply client-side filters (if not "show all")
      this.searchResults = this.applyClientSideFilters(rawResults);

      const filtered = totalBeforeFilter - this.searchResults.length;
      log.info('Search completed', {
        total: totalBeforeFilter,
        filtered,
        showing: this.searchResults.length,
      });

      // Show results (show total matched if available, otherwise total fetched)
      const totalMatched = result.number_matched || result.context?.matched || totalBeforeFilter;
      this.renderResults(this.searchResults, totalMatched, filtered);

      // Display footprints on map
      this.displayFootprints(this.searchResults);
    } catch (error) {
      log.error('Search failed', error instanceof Error ? error : { error: String(error) });
      console.error('STAC search error details:', error);
      showError('Search failed', String(error));
    } finally {
      if (this.searchBtn) {
        this.searchBtn.disabled = false;
        this.searchBtn.textContent = 'Search';
      }
    }
  }

  /**
   * Apply client-side filters (cloud cover, date) to search results.
   * Skipped if "Show all" is checked.
   */
  private applyClientSideFilters(items: StacItem[]): StacItem[] {
    const showAll = this.showAllCheckbox?.checked ?? true;

    if (showAll) {
      return items;
    }

    const maxCloudCover = parseInt(this.cloudCover?.value || '100', 10);
    const startDate = this.dateStart?.value ? new Date(this.dateStart.value) : null;
    const endDate = this.dateEnd?.value ? new Date(this.dateEnd.value + 'T23:59:59') : null;

    return items.filter(item => {
      // Cloud cover filter
      const cloudCover = item.properties?.cloud_cover;
      if (cloudCover !== undefined && cloudCover > maxCloudCover) {
        return false;
      }

      // Date filter (for static catalogs that don't support server-side filtering)
      if (this.catalogType === 'Static') {
        const datetime = item.properties?.datetime;
        if (datetime) {
          const itemDate = new Date(datetime);
          if (startDate && itemDate < startDate) {
            return false;
          }
          if (endDate && itemDate > endDate) {
            return false;
          }
        }
      }

      return true;
    });
  }

  /**
   * Render search results.
   */
  private renderResults(items: StacItem[], totalMatched?: number, filteredCount?: number): void {
    if (!this.resultsList) return;

    // Show results section
    this.resultsSection?.classList.remove('hidden');
    this.itemDetailSection?.classList.add('hidden');

    // Update count
    if (this.resultsCount) {
      let countText = `(${items.length})`;
      if (totalMatched && totalMatched !== items.length) {
        countText = `(${items.length} of ${totalMatched})`;
      }
      if (filteredCount && filteredCount > 0) {
        countText += ` - ${filteredCount} filtered`;
      }
      this.resultsCount.textContent = countText;
    }

    // Render items
    if (items.length === 0) {
      const showAll = this.showAllCheckbox?.checked ?? true;
      const hint = showAll
        ? 'Try increasing the results limit or check if the collection has items.'
        : 'Try checking "Show all" to see unfiltered results.';
      this.resultsList.innerHTML = `<div class="stac-empty-state">No items found<br><small style="color:#666">${hint}</small></div>`;
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
        const itemId = (el as HTMLElement).dataset.itemId;
        if (itemId) this.selectItem(itemId);
      });
    });
  }

  /**
   * Select an item from search results.
   */
  private selectItem(itemId: string): void {
    // Find item
    const item = this.searchResults.find(i => i.id === itemId);
    if (!item) return;

    this.selectedItem = item;

    // Highlight in list
    this.resultsList?.querySelectorAll('.stac-result-item').forEach(el => {
      el.classList.toggle('selected', (el as HTMLElement).dataset.itemId === itemId);
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

  /**
   * Show item detail view.
   */
  private showItemDetail(item: StacItem): void {
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
        props.cloud_cover !== undefined ? `${(props.cloud_cover as number).toFixed(1)}%` : 'N/A';

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

  /**
   * Render item assets.
   */
  private renderAssets(item: StacItem): void {
    if (!this.assetList) return;

    const assets = item.assets || {};
    const assetKeys = Object.keys(assets);

    if (assetKeys.length === 0) {
      this.assetList.innerHTML = '<div class="stac-empty-state">No assets available</div>';
      return;
    }

    // Helper to check if asset is a loadable raster (COG/GeoTIFF/JP2)
    const isLoadableRaster = (asset: StacAsset, key: string): boolean => {
      const type = (asset.media_type || '').toLowerCase();
      const href = (asset.href || '').toLowerCase();
      const roles = asset.roles || [];

      if (type.includes('geotiff') || type.includes('cloud-optimized')) {
        return true;
      }

      if (type.includes('tiff') && !roles.includes('thumbnail')) {
        return true;
      }

      if (type.includes('jp2') || href.endsWith('.jp2')) {
        return true;
      }

      if (href.includes('.tif')) {
        return true;
      }

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
        const assetKey = (btn as HTMLElement).dataset.assetKey;
        if (assetKey) this.loadAsset(item, assetKey);
      });
    });
  }

  /**
   * Show the results list view.
   */
  private showResultsList(): void {
    this.itemDetailSection?.classList.add('hidden');
    this.resultsSection?.classList.remove('hidden');
  }

  /**
   * Clear search results.
   */
  private clearResults(): void {
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
   * Reset all state when changing STAC catalog.
   */
  private resetState(): void {
    // Clear catalog state
    this.currentCatalogUrl = null;
    this.currentCatalog = null;
    this.catalogType = 'Api';
    this.collections = [];
    this.staticCollections = [];
    this.catalogNavHistory = [];
    this.selectedCollection = null;
    this.selectedStaticCollection = null;

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

  /**
   * Display item footprints on the map.
   */
  private displayFootprints(items: StacItem[]): void {
    const map = this.mapManager?.map;
    if (!map) return;

    // Reset visibility state when displaying new footprints
    this.footprintsVisible = true;
    if (this.toggleFootprintsBtn) {
      this.toggleFootprintsBtn.textContent = 'Hide';
    }

    // Create GeoJSON feature collection
    const geojson: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: items.map(item => ({
        type: 'Feature' as const,
        id: item.id,
        geometry: item.geometry as GeoJSON.Geometry,
        properties: {
          id: item.id,
          datetime: item.properties?.datetime,
          cloud_cover: item.properties?.cloud_cover,
        },
      })),
    };

    // Check if source exists
    const source = map.getSource(this.footprintSourceId) as maplibregl.GeoJSONSource | undefined;

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
      map.on(
        'click',
        this.footprintFillLayerId,
        (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
          if (e.features && e.features.length > 0) {
            const itemId = e.features[0].properties?.id;
            if (itemId) this.selectItem(itemId);
          }
        }
      );

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

  /**
   * Highlight a footprint on the map.
   */
  private highlightFootprint(itemId: string): void {
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

  /**
   * Clear footprints from the map.
   */
  private clearFootprints(): void {
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

  /**
   * Toggle footprints visibility.
   */
  private toggleFootprints(): void {
    this.footprintsVisible = !this.footprintsVisible;
    this.setFootprintsVisibility(this.footprintsVisible);

    // Update button text
    if (this.toggleFootprintsBtn) {
      this.toggleFootprintsBtn.textContent = this.footprintsVisible ? 'Hide' : 'Show';
    }
  }

  /**
   * Set footprints visibility.
   */
  private setFootprintsVisibility(visible: boolean): void {
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

  /**
   * Load a STAC asset as a map layer.
   */
  async loadAsset(item: StacItem, assetKey: string): Promise<void> {
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
      const metadata = await invoke<RasterMetadata>('open_stac_asset', { assetHref });

      console.log('[STAC] Got metadata:', JSON.stringify(metadata, null, 2));
      console.log('[STAC] Bounds:', metadata.bounds);
      console.log('[STAC] is_georeferenced:', metadata.is_georeferenced);

      // Add to layer manager using existing infrastructure
      await this.addAssetToMap(metadata, item, assetKey, assetTitle);

      showToast(`Loaded ${assetTitle}`, 'success');
      log.info('Asset loaded successfully', { id: metadata.id });
    } catch (error) {
      console.error('[STAC] Raw error loading asset:', error);
      log.error(
        'Failed to load STAC asset',
        error instanceof Error ? error : { error: String(error) }
      );
      showError('Failed to load asset', error instanceof Error ? error : String(error));
    } finally {
      hideLoading();
    }
  }

  /**
   * Add a loaded asset to the map.
   */
  private async addAssetToMap(
    metadata: RasterMetadata,
    item: StacItem,
    assetKey: string,
    assetTitle: string
  ): Promise<void> {
    // Create layer name from item ID and asset key
    const layerName = `${item.id}/${assetTitle}`;

    // Create layer data structure compatible with LayerManager
    // Smart stretch detection handles different data types automatically
    const layerData: StacLayerData = {
      id: metadata.id,
      path: metadata.path,
      type: 'raster',
      displayName: layerName,
      visible: true,
      opacity: 1.0,
      width: metadata.width,
      height: metadata.height,
      bands: metadata.bands,
      bounds: metadata.bounds,
      band_stats: metadata.band_stats,
      is_georeferenced: metadata.is_georeferenced,
      displayMode: metadata.bands >= 3 ? 'rgb' : 'grayscale',
      band: 1,
      stretch: this.getDefaultStretch(metadata.band_stats, 1),
      rgbBands: { r: 1, g: 2, b: 3 },
      rgbStretch: this.getDefaultRgbStretch(metadata.band_stats),
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
    if (!map) {
      throw new Error('Map not initialized');
    }

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

  /**
   * Determine appropriate stretch range based on statistics and asset type.
   *
   * For satellite imagery:
   * - 8-bit data (max ~255): use full range 0-255
   * - 16-bit reflectance (max ~10000): use display-friendly range like 0-3000
   * - If stats look like defaults, use sensible visual defaults
   */
  private getSmartStretchRange(
    bandStats: Array<BandStats & { band?: number }>,
    bandNum: number
  ): { min: number; max: number } {
    const stats = bandStats?.find(s => s.band === bandNum) || bandStats?.[bandNum - 1];

    if (!stats) {
      // No stats available - use common reflectance default
      return { min: 0, max: 3000 };
    }

    const { min, max } = stats;

    // 8-bit data (0-255 range)
    if (max <= 255) {
      return { min: 0, max: 255 };
    }

    // 16-bit but looks like scaled 8-bit (max around 255-300)
    if (max <= 300) {
      return { min: 0, max: Math.ceil(max) };
    }

    // Float data normalized to 0-1
    if (max <= 1.0) {
      return { min: 0, max: 1 };
    }

    // 16-bit reflectance data (typically 0-10000 scale)
    // Use a display-friendly range - most land surfaces are 0-3000
    // This provides good contrast for typical scenes
    if (max >= 10000) {
      return { min: 0, max: 3500 };
    }

    // For other ranges, use ~30% of max for good contrast
    // (similar to 2-98% percentile stretch)
    if (max > 1000) {
      return { min: 0, max: Math.round(max * 0.35) };
    }

    // Default: use actual range
    return { min, max };
  }

  /**
   * Get default stretch settings for a band.
   * Uses smart detection of data range for optimal display.
   */
  private getDefaultStretch(
    bandStats: Array<BandStats & { band?: number }>,
    bandNum: number
  ): StretchSettings {
    const range = this.getSmartStretchRange(bandStats, bandNum);
    return {
      min: range.min,
      max: range.max,
      gamma: 1.0,
    };
  }

  /**
   * Get default RGB stretch settings.
   */
  private getDefaultRgbStretch(
    bandStats: Array<BandStats & { band?: number }>
  ): RgbStretchSettings {
    return {
      r: this.getDefaultStretch(bandStats, 1),
      g: this.getDefaultStretch(bandStats, 2),
      b: this.getDefaultStretch(bandStats, 3),
    };
  }
}
