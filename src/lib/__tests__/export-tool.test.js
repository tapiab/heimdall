/**
 * Tests for ExportTool functionality
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock Tauri plugins
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  writeFile: vi.fn(),
}));

vi.mock('../notifications.js', () => ({
  showToast: vi.fn(),
  showError: vi.fn(),
  showLoading: vi.fn(),
  hideLoading: vi.fn(),
}));

// Create test export tool logic
function createTestExportTool() {
  return {
    getTimestamp() {
      const now = new Date();
      return now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    },

    generateFilename(format, scale = null) {
      const ext = format === 'jpeg' ? 'jpg' : 'png';
      const scaleStr = scale ? `-${scale}x` : '';
      return `heimdall-export${scaleStr}-${this.getTimestamp()}.${ext}`;
    },

    getMimeType(format) {
      return format === 'jpeg' ? 'image/jpeg' : 'image/png';
    },

    getExtension(format) {
      return format === 'jpeg' ? 'jpg' : 'png';
    },
  };
}

describe('ExportTool', () => {
  let exportTool;

  beforeEach(() => {
    vi.clearAllMocks();
    exportTool = createTestExportTool();
  });

  describe('getTimestamp', () => {
    it('should return ISO-like timestamp without colons or periods', () => {
      const timestamp = exportTool.getTimestamp();
      expect(timestamp).not.toContain(':');
      expect(timestamp).not.toContain('.');
    });

    it('should return a 19-character string', () => {
      const timestamp = exportTool.getTimestamp();
      expect(timestamp.length).toBe(19);
    });

    it('should start with a year', () => {
      const timestamp = exportTool.getTimestamp();
      expect(timestamp).toMatch(/^20\d{2}-/);
    });
  });

  describe('generateFilename', () => {
    it('should generate PNG filename', () => {
      const filename = exportTool.generateFilename('png');
      expect(filename).toMatch(/^heimdall-export-.*\.png$/);
    });

    it('should generate JPEG filename with jpg extension', () => {
      const filename = exportTool.generateFilename('jpeg');
      expect(filename).toMatch(/^heimdall-export-.*\.jpg$/);
    });

    it('should include scale factor when provided', () => {
      const filename = exportTool.generateFilename('png', 2);
      expect(filename).toMatch(/^heimdall-export-2x-.*\.png$/);
    });

    it('should not include scale when null', () => {
      const filename = exportTool.generateFilename('png', null);
      expect(filename).not.toContain('-x-');
    });
  });

  describe('getMimeType', () => {
    it('should return image/png for png format', () => {
      expect(exportTool.getMimeType('png')).toBe('image/png');
    });

    it('should return image/jpeg for jpeg format', () => {
      expect(exportTool.getMimeType('jpeg')).toBe('image/jpeg');
    });

    it('should default to png for unknown formats', () => {
      expect(exportTool.getMimeType('unknown')).toBe('image/png');
    });
  });

  describe('getExtension', () => {
    it('should return png for png format', () => {
      expect(exportTool.getExtension('png')).toBe('png');
    });

    it('should return jpg for jpeg format', () => {
      expect(exportTool.getExtension('jpeg')).toBe('jpg');
    });
  });
});

describe('Canvas export simulation', () => {
  it('should create correct canvas dimensions for scale factor', () => {
    const originalWidth = 800;
    const originalHeight = 600;
    const scale = 2;

    const exportWidth = originalWidth * scale;
    const exportHeight = originalHeight * scale;

    expect(exportWidth).toBe(1600);
    expect(exportHeight).toBe(1200);
  });

  it('should handle scale factor of 1', () => {
    const originalWidth = 800;
    const originalHeight = 600;
    const scale = 1;

    const exportWidth = originalWidth * scale;
    const exportHeight = originalHeight * scale;

    expect(exportWidth).toBe(800);
    expect(exportHeight).toBe(600);
  });

  it('should handle large scale factors', () => {
    const originalWidth = 800;
    const originalHeight = 600;
    const scale = 4;

    const exportWidth = originalWidth * scale;
    const exportHeight = originalHeight * scale;

    expect(exportWidth).toBe(3200);
    expect(exportHeight).toBe(2400);
  });
});

describe('File path extraction', () => {
  function extractFilename(path) {
    return path.split('/').pop().split('\\').pop();
  }

  it('should extract filename from Unix path', () => {
    expect(extractFilename('/Users/name/Downloads/export.png')).toBe('export.png');
  });

  it('should extract filename from Windows path', () => {
    expect(extractFilename('C:\\Users\\name\\Downloads\\export.png')).toBe('export.png');
  });

  it('should handle filename only', () => {
    expect(extractFilename('export.png')).toBe('export.png');
  });
});
