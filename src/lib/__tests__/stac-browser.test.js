/**
 * Tests for StacBrowser
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock Tauri
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

// Mock maplibre-gl
vi.mock('maplibre-gl', () => {
  class MockLngLatBounds {
    constructor() {
      this._coords = [];
    }
    extend() {
      return this;
    }
    isEmpty() {
      return false;
    }
  }
  return {
    default: {
      LngLatBounds: MockLngLatBounds,
    },
  };
});

// Mock notifications
vi.mock('../notifications.js', () => ({
  showToast: vi.fn(),
  showError: vi.fn(),
  showLoading: vi.fn(),
  hideLoading: vi.fn(),
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

// Create mock map
function createMockMap() {
  return {
    getSource: vi.fn(),
    getLayer: vi.fn(),
    addSource: vi.fn(),
    addLayer: vi.fn(),
    removeSource: vi.fn(),
    removeLayer: vi.fn(),
    setFeatureState: vi.fn(),
    getBounds: vi.fn(() => ({
      getWest: () => -10,
      getSouth: () => -20,
      getEast: () => 10,
      getNorth: () => 20,
    })),
    fitBounds: vi.fn(),
    getCanvas: vi.fn(() => ({ style: {} })),
    on: vi.fn(),
  };
}

function createMockMapManager() {
  const map = createMockMap();
  return {
    map,
  };
}

function createMockLayerManager() {
  return {
    layers: new Map(),
    layerOrder: [],
    setupTileProtocol: vi.fn(),
    updateLayerPanel: vi.fn(),
    selectLayer: vi.fn(),
  };
}

// Setup DOM elements before importing
function setupDOM() {
  // Panel
  const panel = document.createElement('div');
  panel.id = 'stac-panel';
  document.body.appendChild(panel);

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.id = 'stac-panel-close';
  document.body.appendChild(closeBtn);

  // API select dropdown
  const apiSelect = document.createElement('select');
  apiSelect.id = 'stac-api-select';
  apiSelect.innerHTML = `
    <option value="https://earth-search.aws.element84.com/v1">Earth Search (AWS)</option>
    <option value="https://planetarycomputer.microsoft.com/api/stac/v1">Planetary Computer</option>
    <option value="custom">Custom URL...</option>
  `;
  document.body.appendChild(apiSelect);

  // Custom URL row
  const customUrlRow = document.createElement('div');
  customUrlRow.id = 'stac-custom-url-row';
  customUrlRow.classList.add('hidden');
  document.body.appendChild(customUrlRow);

  // URL input
  const urlInput = document.createElement('input');
  urlInput.id = 'stac-url';
  urlInput.value = 'https://earth-search.aws.element84.com/v1';
  customUrlRow.appendChild(urlInput);

  // Connect button
  const connectBtn = document.createElement('button');
  connectBtn.id = 'stac-connect-btn';
  document.body.appendChild(connectBtn);

  // Catalog info
  const catalogInfo = document.createElement('div');
  catalogInfo.id = 'stac-catalog-info';
  catalogInfo.classList.add('hidden');
  document.body.appendChild(catalogInfo);

  // Collections section
  const collectionsSection = document.createElement('div');
  collectionsSection.id = 'stac-collections';
  collectionsSection.classList.add('hidden');
  document.body.appendChild(collectionsSection);

  // Collection select
  const collectionSelect = document.createElement('select');
  collectionSelect.id = 'stac-collection-select';
  document.body.appendChild(collectionSelect);

  // Collection info
  const collectionInfo = document.createElement('div');
  collectionInfo.id = 'stac-collection-info';
  document.body.appendChild(collectionInfo);

  // Search section
  const searchSection = document.createElement('div');
  searchSection.id = 'stac-search';
  searchSection.classList.add('hidden');
  document.body.appendChild(searchSection);

  // Use view button
  const useViewBtn = document.createElement('button');
  useViewBtn.id = 'stac-use-view';
  document.body.appendChild(useViewBtn);

  // Bbox display
  const bboxDisplay = document.createElement('span');
  bboxDisplay.id = 'stac-bbox-display';
  document.body.appendChild(bboxDisplay);

  // Date inputs
  const dateStart = document.createElement('input');
  dateStart.id = 'stac-date-start';
  dateStart.type = 'date';
  document.body.appendChild(dateStart);

  const dateEnd = document.createElement('input');
  dateEnd.id = 'stac-date-end';
  dateEnd.type = 'date';
  document.body.appendChild(dateEnd);

  // Cloud cover slider
  const cloudCover = document.createElement('input');
  cloudCover.id = 'stac-cloud-cover';
  cloudCover.type = 'range';
  cloudCover.value = '20';
  document.body.appendChild(cloudCover);

  const cloudValue = document.createElement('span');
  cloudValue.id = 'stac-cloud-value';
  document.body.appendChild(cloudValue);

  // Limit select
  const limitSelect = document.createElement('select');
  limitSelect.id = 'stac-limit';
  limitSelect.innerHTML = '<option value="20">20</option>';
  document.body.appendChild(limitSelect);

  // Search button
  const searchBtn = document.createElement('button');
  searchBtn.id = 'stac-search-btn';
  document.body.appendChild(searchBtn);

  // Results section
  const resultsSection = document.createElement('div');
  resultsSection.id = 'stac-results';
  resultsSection.classList.add('hidden');
  document.body.appendChild(resultsSection);

  // Results count
  const resultsCount = document.createElement('span');
  resultsCount.id = 'stac-results-count';
  document.body.appendChild(resultsCount);

  // Results list
  const resultsList = document.createElement('div');
  resultsList.id = 'stac-results-list';
  document.body.appendChild(resultsList);

  // Clear results button
  const clearResultsBtn = document.createElement('button');
  clearResultsBtn.id = 'stac-clear-results';
  document.body.appendChild(clearResultsBtn);

  // Toggle footprints button
  const toggleFootprintsBtn = document.createElement('button');
  toggleFootprintsBtn.id = 'stac-toggle-footprints';
  document.body.appendChild(toggleFootprintsBtn);

  // Draw bbox button
  const drawBboxBtn = document.createElement('button');
  drawBboxBtn.id = 'stac-draw-bbox';
  document.body.appendChild(drawBboxBtn);

  // Clear bbox button
  const clearBboxBtn = document.createElement('button');
  clearBboxBtn.id = 'stac-clear-bbox';
  document.body.appendChild(clearBboxBtn);

  // Item detail section
  const itemDetailSection = document.createElement('div');
  itemDetailSection.id = 'stac-item-detail';
  itemDetailSection.classList.add('hidden');
  document.body.appendChild(itemDetailSection);

  // Item title
  const itemTitle = document.createElement('div');
  itemTitle.id = 'stac-item-title';
  document.body.appendChild(itemTitle);

  // Item properties
  const itemProperties = document.createElement('div');
  itemProperties.id = 'stac-item-properties';
  document.body.appendChild(itemProperties);

  // Asset list
  const assetList = document.createElement('div');
  assetList.id = 'stac-asset-list';
  document.body.appendChild(assetList);

  // Back button
  const itemBackBtn = document.createElement('button');
  itemBackBtn.id = 'stac-item-back';
  document.body.appendChild(itemBackBtn);

  // STAC button
  const stacBtn = document.createElement('button');
  stacBtn.id = 'stac-btn';
  document.body.appendChild(stacBtn);
}

function cleanupDOM() {
  const elements = [
    'stac-panel',
    'stac-panel-close',
    'stac-api-select',
    'stac-custom-url-row',
    'stac-url',
    'stac-connect-btn',
    'stac-catalog-info',
    'stac-collections',
    'stac-collection-select',
    'stac-collection-info',
    'stac-search',
    'stac-use-view',
    'stac-bbox-display',
    'stac-date-start',
    'stac-date-end',
    'stac-cloud-cover',
    'stac-cloud-value',
    'stac-limit',
    'stac-search-btn',
    'stac-results',
    'stac-results-count',
    'stac-results-list',
    'stac-clear-results',
    'stac-toggle-footprints',
    'stac-draw-bbox',
    'stac-clear-bbox',
    'stac-item-detail',
    'stac-item-title',
    'stac-item-properties',
    'stac-asset-list',
    'stac-item-back',
    'stac-btn',
  ];
  elements.forEach(id => document.getElementById(id)?.remove());
}

// Import after mocks are set up
import { StacBrowser } from '../stac-browser.js';
import { invoke } from '@tauri-apps/api/core';
import { showToast, showError, showLoading, hideLoading } from '../notifications.js';

describe('StacBrowser', () => {
  let mockMapManager;
  let mockLayerManager;
  let stacBrowser;

  beforeEach(() => {
    vi.clearAllMocks();
    setupDOM();
    mockMapManager = createMockMapManager();
    mockLayerManager = createMockLayerManager();
    stacBrowser = new StacBrowser(mockLayerManager, mockMapManager);
  });

  afterEach(() => {
    cleanupDOM();
  });

  describe('constructor', () => {
    it('should initialize with null catalog state', () => {
      expect(stacBrowser.currentCatalogUrl).toBeNull();
      expect(stacBrowser.currentCatalog).toBeNull();
    });

    it('should initialize with empty collections', () => {
      expect(stacBrowser.collections).toEqual([]);
    });

    it('should initialize with null selected collection', () => {
      expect(stacBrowser.selectedCollection).toBeNull();
    });

    it('should initialize with empty search results', () => {
      expect(stacBrowser.searchResults).toEqual([]);
    });

    it('should initialize with null selected item', () => {
      expect(stacBrowser.selectedItem).toBeNull();
    });

    it('should initialize with null search bbox', () => {
      expect(stacBrowser.searchBbox).toBeNull();
    });

    it('should store layer manager reference', () => {
      expect(stacBrowser.layerManager).toBe(mockLayerManager);
    });

    it('should store map manager reference', () => {
      expect(stacBrowser.mapManager).toBe(mockMapManager);
    });

    it('should set default dates', () => {
      const today = new Date();
      const dateEnd = document.getElementById('stac-date-end');
      expect(dateEnd.value).toBe(today.toISOString().split('T')[0]);
    });
  });

  describe('panel visibility', () => {
    it('should show panel when show() is called', () => {
      stacBrowser.show();
      expect(stacBrowser.panel.classList.contains('visible')).toBe(true);
    });

    it('should add active class to button when shown', () => {
      stacBrowser.show();
      const btn = document.getElementById('stac-btn');
      expect(btn.classList.contains('active')).toBe(true);
    });

    it('should hide panel when hide() is called', () => {
      stacBrowser.show();
      stacBrowser.hide();
      expect(stacBrowser.panel.classList.contains('visible')).toBe(false);
    });

    it('should remove active class from button when hidden', () => {
      stacBrowser.show();
      stacBrowser.hide();
      const btn = document.getElementById('stac-btn');
      expect(btn.classList.contains('active')).toBe(false);
    });

    it('should toggle panel visibility', () => {
      expect(stacBrowser.isVisible()).toBe(false);

      stacBrowser.toggle();
      expect(stacBrowser.isVisible()).toBe(true);

      stacBrowser.toggle();
      expect(stacBrowser.isVisible()).toBe(false);
    });

    it('should return correct visibility state', () => {
      expect(stacBrowser.isVisible()).toBe(false);
      stacBrowser.show();
      expect(stacBrowser.isVisible()).toBe(true);
    });
  });

  describe('connect', () => {
    const mockCatalog = {
      id: 'earth-search',
      title: 'Earth Search',
      description: 'A STAC catalog of public datasets',
    };

    const mockCollections = [
      { id: 'sentinel-2-l2a', title: 'Sentinel-2 L2A' },
      { id: 'landsat-c2-l2', title: 'Landsat C2 L2' },
    ];

    it('should show error when URL is empty', async () => {
      // Set dropdown to custom and clear the URL input
      stacBrowser.apiSelect.value = 'custom';
      stacBrowser.urlInput.value = '';
      await stacBrowser.connect();
      expect(showError).toHaveBeenCalledWith('Invalid URL', expect.any(String));
    });

    it('should call connect_stac_api with URL', async () => {
      invoke.mockResolvedValueOnce(mockCatalog).mockResolvedValueOnce(mockCollections);

      await stacBrowser.connect();

      expect(invoke).toHaveBeenCalledWith('connect_stac_api', {
        url: 'https://earth-search.aws.element84.com/v1',
      });
    });

    it('should store catalog URL on success', async () => {
      invoke.mockResolvedValueOnce(mockCatalog).mockResolvedValueOnce(mockCollections);

      await stacBrowser.connect();

      expect(stacBrowser.currentCatalogUrl).toBe('https://earth-search.aws.element84.com/v1');
    });

    it('should store catalog on success', async () => {
      invoke.mockResolvedValueOnce(mockCatalog).mockResolvedValueOnce(mockCollections);

      await stacBrowser.connect();

      expect(stacBrowser.currentCatalog).toEqual(mockCatalog);
    });

    it('should fetch and store collections', async () => {
      invoke.mockResolvedValueOnce(mockCatalog).mockResolvedValueOnce(mockCollections);

      await stacBrowser.connect();

      expect(stacBrowser.collections).toEqual(mockCollections);
    });

    it('should show collections section on success', async () => {
      invoke.mockResolvedValueOnce(mockCatalog).mockResolvedValueOnce(mockCollections);

      await stacBrowser.connect();

      expect(stacBrowser.collectionsSection.classList.contains('hidden')).toBe(false);
    });

    it('should show toast on success', async () => {
      invoke.mockResolvedValueOnce(mockCatalog).mockResolvedValueOnce(mockCollections);

      await stacBrowser.connect();

      expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Earth Search'), 'success');
    });

    it('should show error on failure', async () => {
      invoke.mockRejectedValueOnce('Connection failed');

      await stacBrowser.connect();

      expect(showError).toHaveBeenCalledWith('Connection failed', 'Connection failed');
    });

    it('should disable connect button during connection', async () => {
      invoke.mockImplementation(
        () =>
          new Promise(resolve => {
            expect(stacBrowser.connectBtn.disabled).toBe(true);
            resolve(mockCatalog);
          })
      );

      await stacBrowser.connect();
    });

    it('should re-enable connect button after connection', async () => {
      invoke.mockResolvedValueOnce(mockCatalog).mockResolvedValueOnce(mockCollections);

      await stacBrowser.connect();

      expect(stacBrowser.connectBtn.disabled).toBe(false);
    });
  });

  describe('populateCollections', () => {
    const collections = [
      { id: 'collection-1', title: 'Collection One' },
      { id: 'collection-2', title: 'Collection Two' },
      { id: 'collection-3' }, // No title
    ];

    it('should clear existing options', () => {
      stacBrowser.collectionSelect.innerHTML = '<option value="old">Old</option>';
      stacBrowser.populateCollections(collections);

      expect(stacBrowser.collectionSelect.querySelector('option[value="old"]')).toBeNull();
    });

    it('should add default option', () => {
      stacBrowser.populateCollections(collections);

      const defaultOption = stacBrowser.collectionSelect.querySelector('option[value=""]');
      expect(defaultOption).not.toBeNull();
      expect(defaultOption.textContent).toBe('Select a collection...');
    });

    it('should add collection options', () => {
      stacBrowser.populateCollections(collections);

      expect(stacBrowser.collectionSelect.querySelectorAll('option').length).toBe(4); // 3 + default
    });

    it('should use title when available', () => {
      stacBrowser.populateCollections(collections);

      const option = stacBrowser.collectionSelect.querySelector('option[value="collection-1"]');
      expect(option.textContent).toBe('Collection One');
    });

    it('should use id when title is not available', () => {
      stacBrowser.populateCollections(collections);

      const option = stacBrowser.collectionSelect.querySelector('option[value="collection-3"]');
      expect(option.textContent).toBe('collection-3');
    });
  });

  describe('useCurrentViewBbox', () => {
    it('should set bbox from map bounds', () => {
      stacBrowser.useCurrentViewBbox();

      expect(stacBrowser.searchBbox).toEqual([-10, -20, 10, 20]);
    });

    it('should display bbox in UI', () => {
      stacBrowser.useCurrentViewBbox();

      expect(stacBrowser.bboxDisplay.textContent).toBe('-10.0000, -20.0000, 10.0000, 20.0000');
    });

    it('should handle missing map gracefully', () => {
      stacBrowser.mapManager = null;

      expect(() => stacBrowser.useCurrentViewBbox()).not.toThrow();
    });
  });

  describe('search', () => {
    const mockSearchResult = {
      features: [
        {
          id: 'item-1',
          geometry: { type: 'Polygon', coordinates: [] },
          properties: { datetime: '2024-01-15T10:00:00Z', cloud_cover: 5.5 },
          bbox: [-10, -20, 10, 20],
        },
      ],
      number_matched: 100,
    };

    beforeEach(() => {
      stacBrowser.currentCatalogUrl = 'https://test.api';
      stacBrowser.selectedCollection = { id: 'sentinel-2-l2a' };
    });

    it('should show error when not connected', async () => {
      stacBrowser.currentCatalogUrl = null;

      await stacBrowser.search();

      expect(showError).toHaveBeenCalledWith('Not connected', expect.any(String));
    });

    it('should show error when no collection selected', async () => {
      stacBrowser.selectedCollection = null;

      await stacBrowser.search();

      expect(showError).toHaveBeenCalledWith('No collection selected', expect.any(String));
    });

    it('should call search_stac_items with params', async () => {
      invoke.mockResolvedValueOnce(mockSearchResult);

      await stacBrowser.search();

      expect(invoke).toHaveBeenCalledWith('search_stac_items', {
        url: 'https://test.api',
        params: expect.objectContaining({
          collections: ['sentinel-2-l2a'],
          limit: 20,
        }),
      });
    });

    it('should include bbox when set', async () => {
      stacBrowser.searchBbox = [-10, -20, 10, 20];
      invoke.mockResolvedValueOnce(mockSearchResult);

      await stacBrowser.search();

      expect(invoke).toHaveBeenCalledWith(
        'search_stac_items',
        expect.objectContaining({
          params: expect.objectContaining({
            bbox: [-10, -20, 10, 20],
          }),
        })
      );
    });

    it('should include datetime when dates are set', async () => {
      stacBrowser.dateStart.value = '2024-01-01';
      stacBrowser.dateEnd.value = '2024-01-31';
      invoke.mockResolvedValueOnce(mockSearchResult);

      await stacBrowser.search();

      expect(invoke).toHaveBeenCalledWith(
        'search_stac_items',
        expect.objectContaining({
          params: expect.objectContaining({
            datetime: '2024-01-01T00:00:00Z/2024-01-31T23:59:59Z',
          }),
        })
      );
    });

    it('should not include cloud cover filter (filtering done client-side)', async () => {
      stacBrowser.cloudCover.value = '20';
      invoke.mockResolvedValueOnce(mockSearchResult);

      await stacBrowser.search();

      // Cloud cover filtering is done client-side, not in the STAC query
      expect(invoke).toHaveBeenCalledWith(
        'search_stac_items',
        expect.objectContaining({
          params: expect.not.objectContaining({
            filter: expect.anything(),
          }),
        })
      );
    });

    it('should store search results', async () => {
      invoke.mockResolvedValueOnce(mockSearchResult);

      await stacBrowser.search();

      expect(stacBrowser.searchResults).toEqual(mockSearchResult.features);
    });

    it('should show results section', async () => {
      invoke.mockResolvedValueOnce(mockSearchResult);

      await stacBrowser.search();

      expect(stacBrowser.resultsSection.classList.contains('hidden')).toBe(false);
    });

    it('should disable search button during search', async () => {
      invoke.mockImplementation(
        () =>
          new Promise(resolve => {
            expect(stacBrowser.searchBtn.disabled).toBe(true);
            resolve(mockSearchResult);
          })
      );

      await stacBrowser.search();
    });

    it('should re-enable search button after search', async () => {
      invoke.mockResolvedValueOnce(mockSearchResult);

      await stacBrowser.search();

      expect(stacBrowser.searchBtn.disabled).toBe(false);
    });
  });

  describe('renderResults', () => {
    const items = [
      {
        id: 'item-1',
        properties: { datetime: '2024-01-15T10:00:00Z', cloud_cover: 5.5 },
      },
      {
        id: 'item-2',
        properties: { datetime: '2024-01-16T10:00:00Z', cloud_cover: 10.2 },
      },
    ];

    it('should show results section', () => {
      stacBrowser.renderResults(items, 100);
      expect(stacBrowser.resultsSection.classList.contains('hidden')).toBe(false);
    });

    it('should display result count', () => {
      stacBrowser.renderResults(items, 100);
      expect(stacBrowser.resultsCount.textContent).toBe('(2 of 100)');
    });

    it('should render result items', () => {
      stacBrowser.renderResults(items, 100);
      const resultItems = stacBrowser.resultsList.querySelectorAll('.stac-result-item');
      expect(resultItems.length).toBe(2);
    });

    it('should show empty state when no items', () => {
      stacBrowser.renderResults([], 0);
      expect(stacBrowser.resultsList.innerHTML).toContain('No items found');
    });
  });

  describe('clearResults', () => {
    beforeEach(() => {
      stacBrowser.searchResults = [{ id: 'test' }];
      stacBrowser.selectedItem = { id: 'test' };
      stacBrowser.resultsSection.classList.remove('hidden');
    });

    it('should clear search results', () => {
      stacBrowser.clearResults();
      expect(stacBrowser.searchResults).toEqual([]);
    });

    it('should clear selected item', () => {
      stacBrowser.clearResults();
      expect(stacBrowser.selectedItem).toBeNull();
    });

    it('should hide results section', () => {
      stacBrowser.clearResults();
      expect(stacBrowser.resultsSection.classList.contains('hidden')).toBe(true);
    });
  });

  describe('displayFootprints', () => {
    const items = [
      {
        id: 'item-1',
        geometry: { type: 'Polygon', coordinates: [] },
        properties: { datetime: '2024-01-15', cloud_cover: 5 },
        bbox: [-10, -20, 10, 20],
      },
    ];

    it('should add source when it does not exist', () => {
      mockMapManager.map.getSource.mockReturnValue(null);

      stacBrowser.displayFootprints(items);

      expect(mockMapManager.map.addSource).toHaveBeenCalledWith(
        'stac-footprints',
        expect.objectContaining({
          type: 'geojson',
        })
      );
    });

    it('should add fill layer when source does not exist', () => {
      mockMapManager.map.getSource.mockReturnValue(null);

      stacBrowser.displayFootprints(items);

      expect(mockMapManager.map.addLayer).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'stac-footprints-fill',
          type: 'fill',
        })
      );
    });

    it('should add line layer when source does not exist', () => {
      mockMapManager.map.getSource.mockReturnValue(null);

      stacBrowser.displayFootprints(items);

      expect(mockMapManager.map.addLayer).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'stac-footprints-line',
          type: 'line',
        })
      );
    });

    it('should update existing source data', () => {
      const mockSource = { setData: vi.fn() };
      mockMapManager.map.getSource.mockReturnValue(mockSource);

      stacBrowser.displayFootprints(items);

      expect(mockSource.setData).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'FeatureCollection',
        })
      );
    });

    it('should fit bounds to footprints', () => {
      mockMapManager.map.getSource.mockReturnValue(null);

      stacBrowser.displayFootprints(items);

      expect(mockMapManager.map.fitBounds).toHaveBeenCalled();
    });
  });

  describe('clearFootprints', () => {
    it('should remove line layer if it exists', () => {
      mockMapManager.map.getLayer.mockReturnValue(true);
      mockMapManager.map.getSource.mockReturnValue(true);

      stacBrowser.clearFootprints();

      expect(mockMapManager.map.removeLayer).toHaveBeenCalledWith('stac-footprints-line');
    });

    it('should remove fill layer if it exists', () => {
      mockMapManager.map.getLayer.mockReturnValue(true);
      mockMapManager.map.getSource.mockReturnValue(true);

      stacBrowser.clearFootprints();

      expect(mockMapManager.map.removeLayer).toHaveBeenCalledWith('stac-footprints-fill');
    });

    it('should remove source if it exists', () => {
      mockMapManager.map.getLayer.mockReturnValue(true);
      mockMapManager.map.getSource.mockReturnValue(true);

      stacBrowser.clearFootprints();

      expect(mockMapManager.map.removeSource).toHaveBeenCalledWith('stac-footprints');
    });

    it('should not remove layers if they do not exist', () => {
      mockMapManager.map.getLayer.mockReturnValue(null);
      mockMapManager.map.getSource.mockReturnValue(null);

      stacBrowser.clearFootprints();

      expect(mockMapManager.map.removeLayer).not.toHaveBeenCalled();
      expect(mockMapManager.map.removeSource).not.toHaveBeenCalled();
    });
  });

  describe('loadAsset', () => {
    const mockItem = {
      id: 'test-item',
      collection: 'sentinel-2-l2a',
      assets: {
        visual: {
          href: 'https://example.com/visual.tif',
          title: 'Visual',
          media_type: 'image/tiff; application=geotiff; profile=cloud-optimized',
        },
      },
    };

    const mockMetadata = {
      id: 'asset-123',
      path: '/vsicurl/https://example.com/visual.tif',
      width: 10980,
      height: 10980,
      bands: 3,
      bounds: [-10, -20, 10, 20],
      band_stats: [{ band: 1, min: 0, max: 10000 }],
      is_georeferenced: true,
    };

    it('should show error when asset not found', async () => {
      await stacBrowser.loadAsset(mockItem, 'nonexistent');

      expect(showError).toHaveBeenCalledWith('Asset not found', expect.any(String));
    });

    it('should show loading indicator', async () => {
      invoke.mockResolvedValueOnce(mockMetadata);

      await stacBrowser.loadAsset(mockItem, 'visual');

      expect(showLoading).toHaveBeenCalledWith('Loading Visual...');
    });

    it('should call open_stac_asset with asset href', async () => {
      invoke.mockResolvedValueOnce(mockMetadata);

      await stacBrowser.loadAsset(mockItem, 'visual');

      expect(invoke).toHaveBeenCalledWith('open_stac_asset', {
        assetHref: 'https://example.com/visual.tif',
      });
    });

    it('should show success toast on completion', async () => {
      invoke.mockResolvedValueOnce(mockMetadata);

      await stacBrowser.loadAsset(mockItem, 'visual');

      expect(showToast).toHaveBeenCalledWith('Loaded Visual', 'success');
    });

    it('should hide loading indicator on completion', async () => {
      invoke.mockResolvedValueOnce(mockMetadata);

      await stacBrowser.loadAsset(mockItem, 'visual');

      expect(hideLoading).toHaveBeenCalled();
    });

    it('should show error on failure', async () => {
      invoke.mockRejectedValueOnce('Failed to load');

      await stacBrowser.loadAsset(mockItem, 'visual');

      expect(showError).toHaveBeenCalledWith('Failed to load asset', 'Failed to load');
    });

    it('should hide loading indicator on failure', async () => {
      invoke.mockRejectedValueOnce('Failed to load');

      await stacBrowser.loadAsset(mockItem, 'visual');

      expect(hideLoading).toHaveBeenCalled();
    });
  });

  describe('getDefaultStretch', () => {
    it('should return stretch from matching band stats', () => {
      const bandStats = [
        { band: 1, min: 0, max: 10000 },
        { band: 2, min: 0, max: 8000 },
      ];

      const stretch = stacBrowser.getDefaultStretch(bandStats, 1);

      expect(stretch).toEqual({ min: 0, max: 10000, gamma: 1.0 });
    });

    it('should return first band stats if no match', () => {
      const bandStats = [{ band: 1, min: 0, max: 10000 }];

      const stretch = stacBrowser.getDefaultStretch(bandStats, 5);

      expect(stretch).toEqual({ min: 0, max: 10000, gamma: 1.0 });
    });

    it('should return default values when no stats', () => {
      const stretch = stacBrowser.getDefaultStretch(null, 1);

      expect(stretch).toEqual({ min: 0, max: 10000, gamma: 1.0 });
    });
  });

  describe('getDefaultRgbStretch', () => {
    it('should return stretch for RGB bands', () => {
      const bandStats = [
        { band: 1, min: 0, max: 10000 },
        { band: 2, min: 0, max: 8000 },
        { band: 3, min: 0, max: 9000 },
      ];

      const rgbStretch = stacBrowser.getDefaultRgbStretch(bandStats);

      expect(rgbStretch.r).toEqual({ min: 0, max: 10000, gamma: 1.0 });
      expect(rgbStretch.g).toEqual({ min: 0, max: 8000, gamma: 1.0 });
      expect(rgbStretch.b).toEqual({ min: 0, max: 9000, gamma: 1.0 });
    });
  });

  describe('showCatalogInfo', () => {
    it('should display catalog title', () => {
      stacBrowser.showCatalogInfo({ id: 'test', title: 'Test Catalog', description: 'A test' });

      expect(stacBrowser.catalogInfo.innerHTML).toContain('Test Catalog');
    });

    it('should display catalog description', () => {
      stacBrowser.showCatalogInfo({ id: 'test', title: 'Test Catalog', description: 'A test' });

      expect(stacBrowser.catalogInfo.innerHTML).toContain('A test');
    });

    it('should use id when title is not available', () => {
      stacBrowser.showCatalogInfo({ id: 'test-id' });

      expect(stacBrowser.catalogInfo.innerHTML).toContain('test-id');
    });

    it('should remove hidden class', () => {
      stacBrowser.showCatalogInfo({ id: 'test' });

      expect(stacBrowser.catalogInfo.classList.contains('hidden')).toBe(false);
    });
  });

  describe('onCollectionChange', () => {
    beforeEach(() => {
      stacBrowser.collections = [
        {
          id: 'sentinel-2-l2a',
          title: 'Sentinel-2 L2A',
          description: 'Sentinel-2 data',
          extent: { temporal: { interval: [['2015-01-01', null]] } },
        },
      ];
      // Add option to select so value can be set
      const option = document.createElement('option');
      option.value = 'sentinel-2-l2a';
      option.textContent = 'Sentinel-2 L2A';
      stacBrowser.collectionSelect.appendChild(option);
    });

    it('should set selected collection', () => {
      stacBrowser.collectionSelect.value = 'sentinel-2-l2a';

      stacBrowser.onCollectionChange();

      expect(stacBrowser.selectedCollection.id).toBe('sentinel-2-l2a');
    });

    it('should show search section when collection selected', () => {
      stacBrowser.collectionSelect.value = 'sentinel-2-l2a';

      stacBrowser.onCollectionChange();

      expect(stacBrowser.searchSection.classList.contains('hidden')).toBe(false);
    });

    it('should clear selection when empty value', () => {
      stacBrowser.selectedCollection = { id: 'previous' };
      stacBrowser.collectionSelect.value = '';

      stacBrowser.onCollectionChange();

      expect(stacBrowser.selectedCollection).toBeNull();
    });

    it('should hide search section when empty value', () => {
      stacBrowser.searchSection.classList.remove('hidden');
      stacBrowser.collectionSelect.value = '';

      stacBrowser.onCollectionChange();

      expect(stacBrowser.searchSection.classList.contains('hidden')).toBe(true);
    });
  });

  describe('selectItem', () => {
    beforeEach(() => {
      stacBrowser.searchResults = [
        {
          id: 'item-1',
          geometry: { type: 'Polygon', coordinates: [] },
          properties: { datetime: '2024-01-15T10:00:00Z', cloud_cover: 5.5 },
          bbox: [-10, -20, 10, 20],
          assets: {},
        },
      ];
    });

    it('should set selected item', () => {
      stacBrowser.selectItem('item-1');

      expect(stacBrowser.selectedItem.id).toBe('item-1');
    });

    it('should call highlightFootprint', () => {
      const highlightSpy = vi.spyOn(stacBrowser, 'highlightFootprint');

      stacBrowser.selectItem('item-1');

      expect(highlightSpy).toHaveBeenCalledWith('item-1');
    });

    it('should zoom to item bbox', () => {
      stacBrowser.selectItem('item-1');

      expect(mockMapManager.map.fitBounds).toHaveBeenCalled();
    });

    it('should do nothing for non-existent item', () => {
      stacBrowser.selectItem('non-existent');

      expect(stacBrowser.selectedItem).toBeNull();
    });
  });

  describe('showResultsList', () => {
    it('should hide item detail section', () => {
      stacBrowser.itemDetailSection.classList.remove('hidden');

      stacBrowser.showResultsList();

      expect(stacBrowser.itemDetailSection.classList.contains('hidden')).toBe(true);
    });

    it('should show results section', () => {
      stacBrowser.resultsSection.classList.add('hidden');

      stacBrowser.showResultsList();

      expect(stacBrowser.resultsSection.classList.contains('hidden')).toBe(false);
    });
  });
});
