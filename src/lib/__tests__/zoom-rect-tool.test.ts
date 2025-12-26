/**
 * Tests for ZoomRectTool
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ZoomRectTool } from '../zoom-rect-tool.js';

// Create mock map
function createMockMap() {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width: 800px; height: 600px;';
  canvas.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: 800,
    bottom: 600,
    width: 800,
    height: 600,
  });

  const container = document.createElement('div');
  container.id = 'map';
  container.appendChild(canvas);
  document.body.appendChild(container);

  return {
    getCanvas: () => canvas,
    getContainer: () => container,
    dragPan: {
      enable: vi.fn(),
      disable: vi.fn(),
    },
    unproject: vi.fn(([x, y]) => ({
      lng: x / 10 - 40, // Simple conversion for testing
      lat: 30 - y / 10,
    })),
    fitBounds: vi.fn(),
  };
}

function createMockMapManager(map) {
  return {
    map,
  };
}

describe('ZoomRectTool', () => {
  let mockMap;
  let mockMapManager;
  let zoomRectTool;

  beforeEach(() => {
    mockMap = createMockMap();
    mockMapManager = createMockMapManager(mockMap);
    zoomRectTool = new ZoomRectTool(mockMapManager);
  });

  afterEach(() => {
    zoomRectTool.deactivate();
    const container = document.getElementById('map');
    if (container) container.remove();
    const instruction = document.getElementById('zoom-rect-instruction');
    if (instruction) instruction.remove();
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with inactive state', () => {
      expect(zoomRectTool.active).toBe(false);
      expect(zoomRectTool.startPoint).toBeNull();
      expect(zoomRectTool.box).toBeNull();
    });

    it('should store map reference', () => {
      expect(zoomRectTool.map).toBe(mockMap);
      expect(zoomRectTool.mapManager).toBe(mockMapManager);
    });
  });

  describe('activate', () => {
    it('should set active to true', () => {
      zoomRectTool.activate();
      expect(zoomRectTool.active).toBe(true);
    });

    it('should change cursor to crosshair', () => {
      zoomRectTool.activate();
      expect(mockMap.getCanvas().style.cursor).toBe('crosshair');
    });

    it('should disable map drag pan', () => {
      zoomRectTool.activate();
      expect(mockMap.dragPan.disable).toHaveBeenCalled();
    });

    it('should show instruction', () => {
      zoomRectTool.activate();
      const instruction = document.getElementById('zoom-rect-instruction');
      expect(instruction).not.toBeNull();
      expect(instruction.style.display).toBe('block');
    });

    it('should not activate twice', () => {
      zoomRectTool.activate();
      mockMap.dragPan.disable.mockClear();
      zoomRectTool.activate();
      expect(mockMap.dragPan.disable).not.toHaveBeenCalled();
    });
  });

  describe('deactivate', () => {
    beforeEach(() => {
      zoomRectTool.activate();
    });

    it('should set active to false', () => {
      zoomRectTool.deactivate();
      expect(zoomRectTool.active).toBe(false);
    });

    it('should reset cursor', () => {
      zoomRectTool.deactivate();
      expect(mockMap.getCanvas().style.cursor).toBe('');
    });

    it('should re-enable map drag pan', () => {
      zoomRectTool.deactivate();
      expect(mockMap.dragPan.enable).toHaveBeenCalled();
    });

    it('should hide instruction', () => {
      zoomRectTool.deactivate();
      const instruction = document.getElementById('zoom-rect-instruction');
      expect(instruction.style.display).toBe('none');
    });

    it('should not deactivate if not active', () => {
      zoomRectTool.deactivate();
      mockMap.dragPan.enable.mockClear();
      zoomRectTool.deactivate();
      expect(mockMap.dragPan.enable).not.toHaveBeenCalled();
    });

    it('should remove selection box if present', () => {
      zoomRectTool.createBox();
      expect(zoomRectTool.box).not.toBeNull();
      zoomRectTool.deactivate();
      expect(zoomRectTool.box).toBeNull();
    });
  });

  describe('toggle', () => {
    it('should activate when inactive', () => {
      const result = zoomRectTool.toggle();
      expect(result).toBe(true);
      expect(zoomRectTool.active).toBe(true);
    });

    it('should deactivate when active', () => {
      zoomRectTool.activate();
      const result = zoomRectTool.toggle();
      expect(result).toBe(false);
      expect(zoomRectTool.active).toBe(false);
    });
  });

  describe('isActive', () => {
    it('should return false initially', () => {
      expect(zoomRectTool.isActive()).toBe(false);
    });

    it('should return true when activated', () => {
      zoomRectTool.activate();
      expect(zoomRectTool.isActive()).toBe(true);
    });
  });

  describe('instruction display', () => {
    it('should create instruction element if not exists', () => {
      zoomRectTool.showInstruction();
      const instruction = document.getElementById('zoom-rect-instruction');
      expect(instruction).not.toBeNull();
      expect(instruction.textContent).toContain('Click and drag');
    });

    it('should reuse existing instruction element', () => {
      zoomRectTool.showInstruction();
      const first = document.getElementById('zoom-rect-instruction');
      zoomRectTool.showInstruction();
      const second = document.getElementById('zoom-rect-instruction');
      expect(first).toBe(second);
    });

    it('should hide instruction', () => {
      zoomRectTool.showInstruction();
      zoomRectTool.hideInstruction();
      const instruction = document.getElementById('zoom-rect-instruction');
      expect(instruction.style.display).toBe('none');
    });
  });

  describe('selection box', () => {
    it('should create box element', () => {
      zoomRectTool.createBox();
      expect(zoomRectTool.box).not.toBeNull();
      expect(zoomRectTool.box.id).toBe('zoom-rect-box');
    });

    it('should add box to map container', () => {
      zoomRectTool.createBox();
      const box = mockMap.getContainer().querySelector('#zoom-rect-box');
      expect(box).not.toBeNull();
    });

    it('should remove existing box before creating new one', () => {
      zoomRectTool.createBox();
      const firstBox = zoomRectTool.box;
      zoomRectTool.createBox();
      expect(zoomRectTool.box).not.toBe(firstBox);
    });

    it('should remove box', () => {
      zoomRectTool.createBox();
      zoomRectTool.removeBox();
      expect(zoomRectTool.box).toBeNull();
    });

    it('should handle remove when no box exists', () => {
      expect(() => zoomRectTool.removeBox()).not.toThrow();
    });
  });

  describe('mouse interactions', () => {
    beforeEach(() => {
      zoomRectTool.activate();
    });

    it('should set start point on mousedown', () => {
      const event = new MouseEvent('mousedown', {
        button: 0,
        clientX: 100,
        clientY: 100,
      });
      zoomRectTool.handleMouseDown(event);
      expect(zoomRectTool.startPoint).toEqual({ x: 100, y: 100 });
    });

    it('should ignore non-left button clicks', () => {
      const event = new MouseEvent('mousedown', {
        button: 2, // right click
        clientX: 100,
        clientY: 100,
      });
      zoomRectTool.handleMouseDown(event);
      expect(zoomRectTool.startPoint).toBeNull();
    });

    it('should create box on mousedown', () => {
      const event = new MouseEvent('mousedown', {
        button: 0,
        clientX: 100,
        clientY: 100,
      });
      zoomRectTool.handleMouseDown(event);
      expect(zoomRectTool.box).not.toBeNull();
    });

    it('should update box size on mousemove', () => {
      // Start the selection
      zoomRectTool.handleMouseDown(
        new MouseEvent('mousedown', { button: 0, clientX: 100, clientY: 100 })
      );

      // Move the mouse
      zoomRectTool.handleMouseMove(new MouseEvent('mousemove', { clientX: 300, clientY: 250 }));

      expect(zoomRectTool.box.style.left).toBe('100px');
      expect(zoomRectTool.box.style.top).toBe('100px');
      expect(zoomRectTool.box.style.width).toBe('200px');
      expect(zoomRectTool.box.style.height).toBe('150px');
    });

    it('should not update box if no start point', () => {
      zoomRectTool.handleMouseMove(new MouseEvent('mousemove', { clientX: 300, clientY: 250 }));
      expect(zoomRectTool.box).toBeNull();
    });

    it('should call fitBounds on mouseup with valid selection', () => {
      // Start selection at 100,100
      zoomRectTool.handleMouseDown(
        new MouseEvent('mousedown', { button: 0, clientX: 100, clientY: 100 })
      );

      // End at 300,250 (200x150 box, larger than 10px threshold)
      zoomRectTool.handleMouseUp(new MouseEvent('mouseup', { clientX: 300, clientY: 250 }));

      expect(mockMap.fitBounds).toHaveBeenCalled();
    });

    it('should not call fitBounds for small selection', () => {
      // Start selection
      zoomRectTool.handleMouseDown(
        new MouseEvent('mousedown', { button: 0, clientX: 100, clientY: 100 })
      );

      // End with small movement (less than 10px)
      zoomRectTool.handleMouseUp(new MouseEvent('mouseup', { clientX: 105, clientY: 105 }));

      expect(mockMap.fitBounds).not.toHaveBeenCalled();
    });

    it('should deactivate after zoom', () => {
      zoomRectTool.handleMouseDown(
        new MouseEvent('mousedown', { button: 0, clientX: 100, clientY: 100 })
      );
      zoomRectTool.handleMouseUp(new MouseEvent('mouseup', { clientX: 300, clientY: 250 }));

      expect(zoomRectTool.active).toBe(false);
    });

    it('should clean up box after mouseup', () => {
      zoomRectTool.handleMouseDown(
        new MouseEvent('mousedown', { button: 0, clientX: 100, clientY: 100 })
      );
      zoomRectTool.handleMouseUp(new MouseEvent('mouseup', { clientX: 300, clientY: 250 }));

      expect(zoomRectTool.box).toBeNull();
      expect(zoomRectTool.startPoint).toBeNull();
    });
  });

  describe('keyboard interactions', () => {
    beforeEach(() => {
      zoomRectTool.activate();
    });

    it('should deactivate on Escape key', () => {
      zoomRectTool.handleKeyDown(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(zoomRectTool.active).toBe(false);
    });

    it('should ignore other keys', () => {
      zoomRectTool.handleKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }));
      expect(zoomRectTool.active).toBe(true);
    });
  });

  describe('coordinate conversion', () => {
    beforeEach(() => {
      zoomRectTool.activate();
    });

    it('should convert screen coordinates to map bounds', () => {
      zoomRectTool.handleMouseDown(
        new MouseEvent('mousedown', { button: 0, clientX: 100, clientY: 100 })
      );
      zoomRectTool.handleMouseUp(new MouseEvent('mouseup', { clientX: 300, clientY: 250 }));

      // unproject should be called twice (sw and ne corners)
      expect(mockMap.unproject).toHaveBeenCalledTimes(2);
      // First call: bottom-left [minX, maxY] = [100, 250]
      expect(mockMap.unproject).toHaveBeenCalledWith([100, 250]);
      // Second call: top-right [maxX, minY] = [300, 100]
      expect(mockMap.unproject).toHaveBeenCalledWith([300, 100]);
    });
  });
});
