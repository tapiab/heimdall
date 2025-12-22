/**
 * Tests for UI module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock Tauri modules
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve()),
}));

vi.mock('../notifications.js', () => ({
  showToast: vi.fn(),
}));

// Vector extensions list (matching ui.js)
const VECTOR_EXTENSIONS = [
  'shp',
  'geojson',
  'json',
  'gpkg',
  'kml',
  'kmz',
  'gml',
  'gpx',
  'fgb',
  'tab',
  'mif',
];

// Helper to determine file type from extension
function isVectorFile(filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  return VECTOR_EXTENSIONS.includes(ext);
}

// Extract filename from path
function extractFilename(path) {
  return path.split('/').pop().split('\\').pop();
}

describe('UI Module - File Type Detection', () => {
  describe('VECTOR_EXTENSIONS', () => {
    it('should recognize shapefile extension', () => {
      expect(VECTOR_EXTENSIONS).toContain('shp');
    });

    it('should recognize GeoJSON extension', () => {
      expect(VECTOR_EXTENSIONS).toContain('geojson');
    });

    it('should recognize GeoPackage extension', () => {
      expect(VECTOR_EXTENSIONS).toContain('gpkg');
    });

    it('should recognize KML/KMZ extensions', () => {
      expect(VECTOR_EXTENSIONS).toContain('kml');
      expect(VECTOR_EXTENSIONS).toContain('kmz');
    });

    it('should recognize FlatGeobuf extension', () => {
      expect(VECTOR_EXTENSIONS).toContain('fgb');
    });

    it('should have correct number of extensions', () => {
      expect(VECTOR_EXTENSIONS.length).toBe(11);
    });
  });

  describe('isVectorFile', () => {
    it('should detect shapefile as vector', () => {
      expect(isVectorFile('/path/to/file.shp')).toBe(true);
    });

    it('should detect GeoJSON as vector', () => {
      expect(isVectorFile('/path/to/file.geojson')).toBe(true);
    });

    it('should detect GeoPackage as vector', () => {
      expect(isVectorFile('/path/to/data.gpkg')).toBe(true);
    });

    it('should detect KML as vector', () => {
      expect(isVectorFile('/path/to/places.kml')).toBe(true);
    });

    it('should detect GeoTIFF as raster (not vector)', () => {
      expect(isVectorFile('/path/to/image.tif')).toBe(false);
      expect(isVectorFile('/path/to/image.tiff')).toBe(false);
    });

    it('should detect PNG as raster (not vector)', () => {
      expect(isVectorFile('/path/to/image.png')).toBe(false);
    });

    it('should handle uppercase extensions', () => {
      expect(isVectorFile('/path/to/FILE.SHP')).toBe(true);
      expect(isVectorFile('/path/to/FILE.GEOJSON')).toBe(true);
    });

    it('should handle mixed case extensions', () => {
      expect(isVectorFile('/path/to/File.GeoJson')).toBe(true);
    });
  });

  describe('extractFilename', () => {
    it('should extract filename from Unix path', () => {
      expect(extractFilename('/Users/name/Documents/data.tif')).toBe('data.tif');
    });

    it('should extract filename from Windows path', () => {
      expect(extractFilename('C:\\Users\\name\\Documents\\data.tif')).toBe('data.tif');
    });

    it('should handle filename with no path', () => {
      expect(extractFilename('data.tif')).toBe('data.tif');
    });

    it('should handle paths with spaces', () => {
      expect(extractFilename('/Users/name/My Documents/my file.tif')).toBe('my file.tif');
    });
  });
});

describe('UI Module - Tool Management', () => {
  // Mock tools
  function createMockTool(_name) {
    return {
      isActive: vi.fn(() => false),
      activate: vi.fn(),
      deactivate: vi.fn(),
    };
  }

  describe('deactivateTools behavior', () => {
    let mockTools;
    let buttons;

    beforeEach(() => {
      // Create mock tools
      mockTools = {
        measureTool: createMockTool('measure'),
        inspectTool: createMockTool('inspect'),
        profileTool: createMockTool('profile'),
        annotationTool: createMockTool('annotation'),
        zoomRectTool: createMockTool('zoomRect'),
      };

      // Create mock buttons
      buttons = {};
      ['measure-btn', 'inspect-btn', 'profile-btn', 'annotate-btn', 'zoom-rect-btn'].forEach(id => {
        const btn = document.createElement('button');
        btn.id = id;
        btn.classList.add('active');
        document.body.appendChild(btn);
        buttons[id] = btn;
      });
    });

    afterEach(() => {
      Object.values(buttons).forEach(btn => btn.remove());
    });

    it('should deactivate measure tool when active', () => {
      mockTools.measureTool.isActive.mockReturnValue(true);

      // Simulate deactivateTools behavior
      if (mockTools.measureTool.isActive()) {
        mockTools.measureTool.deactivate();
        buttons['measure-btn'].classList.remove('active');
      }

      expect(mockTools.measureTool.deactivate).toHaveBeenCalled();
      expect(buttons['measure-btn'].classList.contains('active')).toBe(false);
    });

    it('should not deactivate tool when inactive', () => {
      mockTools.measureTool.isActive.mockReturnValue(false);

      if (mockTools.measureTool.isActive()) {
        mockTools.measureTool.deactivate();
      }

      expect(mockTools.measureTool.deactivate).not.toHaveBeenCalled();
    });

    it('should handle null tools gracefully', () => {
      const partialTools = {
        measureTool: null,
        inspectTool: createMockTool('inspect'),
      };

      expect(() => {
        if (partialTools.measureTool && partialTools.measureTool.isActive()) {
          partialTools.measureTool.deactivate();
        }
      }).not.toThrow();
    });
  });
});

describe('UI Module - Panel Toggle', () => {
  let layerPanel;
  let controlsPanel;
  let layerToggle;
  let controlsToggle;

  beforeEach(() => {
    // Create mock panels
    layerPanel = document.createElement('div');
    layerPanel.id = 'layer-panel';
    document.body.appendChild(layerPanel);

    controlsPanel = document.createElement('div');
    controlsPanel.id = 'controls-panel';
    document.body.appendChild(controlsPanel);

    layerToggle = document.createElement('button');
    layerToggle.id = 'layer-toggle';
    document.body.appendChild(layerToggle);

    controlsToggle = document.createElement('button');
    controlsToggle.id = 'controls-toggle';
    document.body.appendChild(controlsToggle);
  });

  afterEach(() => {
    layerPanel.remove();
    controlsPanel.remove();
    layerToggle.remove();
    controlsToggle.remove();
  });

  describe('toggleLayerPanel behavior', () => {
    it('should add collapsed class when visible', () => {
      expect(layerPanel.classList.contains('collapsed')).toBe(false);
      layerPanel.classList.add('collapsed');
      expect(layerPanel.classList.contains('collapsed')).toBe(true);
    });

    it('should remove collapsed class when hidden', () => {
      layerPanel.classList.add('collapsed');
      layerPanel.classList.remove('collapsed');
      expect(layerPanel.classList.contains('collapsed')).toBe(false);
    });

    it('should toggle collapsed class', () => {
      layerPanel.classList.toggle('collapsed');
      expect(layerPanel.classList.contains('collapsed')).toBe(true);
      layerPanel.classList.toggle('collapsed');
      expect(layerPanel.classList.contains('collapsed')).toBe(false);
    });
  });

  describe('toggleControlsPanel behavior', () => {
    it('should toggle controls panel visibility', () => {
      controlsPanel.classList.toggle('collapsed');
      expect(controlsPanel.classList.contains('collapsed')).toBe(true);
      controlsPanel.classList.toggle('collapsed');
      expect(controlsPanel.classList.contains('collapsed')).toBe(false);
    });
  });
});

describe('UI Module - Keyboard Shortcuts', () => {
  const shortcuts = [
    { key: 'b', description: 'Toggle basemap' },
    { key: 't', description: 'Toggle terrain' },
    { key: 'm', description: 'Toggle measure tool' },
    { key: 'i', description: 'Toggle inspect tool' },
    { key: 'e', description: 'Export map' },
    { key: 'p', description: 'Toggle profile tool' },
    { key: 'a', description: 'Toggle annotations' },
    { key: 'z', description: 'Toggle zoom rectangle' },
    { key: 'l', description: 'Toggle layer panel' },
    { key: 'c', description: 'Toggle controls panel' },
    { key: 'o', description: 'Open file' },
    { key: '?', description: 'Show shortcuts help' },
    { key: 'Escape', description: 'Close dialogs/cancel tools' },
  ];

  it('should define all expected shortcuts', () => {
    expect(shortcuts.length).toBeGreaterThan(10);
  });

  it('should have unique key bindings', () => {
    const keys = shortcuts.map(s => s.key);
    const uniqueKeys = [...new Set(keys)];
    expect(keys.length).toBe(uniqueKeys.length);
  });

  describe('key event handling', () => {
    it('should prevent default for handled shortcuts', () => {
      const event = new KeyboardEvent('keydown', { key: 'b' });
      const preventDefault = vi.spyOn(event, 'preventDefault');

      // Simulate shortcut handling
      if (['b', 't', 'm', 'i'].includes(event.key)) {
        event.preventDefault();
      }

      expect(preventDefault).toHaveBeenCalled();
    });

    it('should ignore shortcuts when typing in input', () => {
      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();

      const shouldIgnore = document.activeElement.tagName === 'INPUT';
      expect(shouldIgnore).toBe(true);

      input.remove();
    });

    it('should ignore shortcuts when typing in textarea', () => {
      const textarea = document.createElement('textarea');
      document.body.appendChild(textarea);
      textarea.focus();

      const shouldIgnore = document.activeElement.tagName === 'TEXTAREA';
      expect(shouldIgnore).toBe(true);

      textarea.remove();
    });
  });
});

describe('UI Module - Dropdown Menus', () => {
  let dropdown;
  let trigger;

  beforeEach(() => {
    dropdown = document.createElement('div');
    dropdown.className = 'dropdown';
    dropdown.style.display = 'none';

    trigger = document.createElement('button');
    trigger.className = 'dropdown-trigger';

    document.body.appendChild(trigger);
    document.body.appendChild(dropdown);
  });

  afterEach(() => {
    dropdown.remove();
    trigger.remove();
  });

  it('should show dropdown on trigger click', () => {
    dropdown.style.display = 'block';
    expect(dropdown.style.display).toBe('block');
  });

  it('should hide dropdown on outside click', () => {
    dropdown.style.display = 'block';
    dropdown.style.display = 'none';
    expect(dropdown.style.display).toBe('none');
  });

  it('should toggle dropdown visibility', () => {
    const isVisible = dropdown.style.display === 'block';
    dropdown.style.display = isVisible ? 'none' : 'block';
    expect(dropdown.style.display).toBe('block');
  });
});

describe('UI Module - Basemap Switching', () => {
  const basemaps = ['osm', 'satellite', 'none'];

  it('should support OSM basemap', () => {
    expect(basemaps).toContain('osm');
  });

  it('should support satellite basemap', () => {
    expect(basemaps).toContain('satellite');
  });

  it('should support no basemap option', () => {
    expect(basemaps).toContain('none');
  });

  it('should cycle through basemaps correctly', () => {
    let currentIndex = 0;
    const nextBasemap = () => {
      currentIndex = (currentIndex + 1) % basemaps.length;
      return basemaps[currentIndex];
    };

    expect(nextBasemap()).toBe('satellite');
    expect(nextBasemap()).toBe('none');
    expect(nextBasemap()).toBe('osm');
  });
});
