/**
 * Zoom Rectangle Tool - Draw a rectangle to zoom into that area
 */

import type { Map as MapLibreMap, LngLatBoundsLike } from 'maplibre-gl';

// Interface for MapManager (will be properly typed when MapManager is migrated)
interface MapManager {
  map: MapLibreMap;
}

interface Point {
  x: number;
  y: number;
}

export class ZoomRectTool {
  private mapManager: MapManager;
  private map: MapLibreMap;
  private active: boolean;
  private startPoint: Point | null;
  private box: HTMLDivElement | null;

  constructor(mapManager: MapManager) {
    this.mapManager = mapManager;
    this.map = mapManager.map;
    this.active = false;
    this.startPoint = null;
    this.box = null;

    this.handleMouseDown = this.handleMouseDown.bind(this);
    this.handleMouseMove = this.handleMouseMove.bind(this);
    this.handleMouseUp = this.handleMouseUp.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
  }

  activate(): void {
    if (this.active) return;
    this.active = true;
    this.map.getCanvas().style.cursor = 'crosshair';

    // Disable map drag during rectangle selection
    this.map.dragPan.disable();

    this.map.getCanvas().addEventListener('mousedown', this.handleMouseDown);
    document.addEventListener('keydown', this.handleKeyDown);

    this.showInstruction();
  }

  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.map.getCanvas().style.cursor = '';

    // Re-enable map drag
    this.map.dragPan.enable();

    this.map.getCanvas().removeEventListener('mousedown', this.handleMouseDown);
    document.removeEventListener('mousemove', this.handleMouseMove);
    document.removeEventListener('mouseup', this.handleMouseUp);
    document.removeEventListener('keydown', this.handleKeyDown);

    this.removeBox();
    this.hideInstruction();
    this.startPoint = null;
  }

  toggle(): boolean {
    if (this.active) {
      this.deactivate();
    } else {
      this.activate();
    }
    return this.active;
  }

  isActive(): boolean {
    return this.active;
  }

  private showInstruction(): void {
    let instruction = document.getElementById('zoom-rect-instruction') as HTMLDivElement | null;
    if (!instruction) {
      instruction = document.createElement('div');
      instruction.id = 'zoom-rect-instruction';
      instruction.className = 'tool-instruction';
      document.body.appendChild(instruction);
    }
    instruction.textContent = 'Click and drag to select area to zoom';
    instruction.style.display = 'block';
  }

  private hideInstruction(): void {
    const instruction = document.getElementById('zoom-rect-instruction');
    if (instruction) {
      instruction.style.display = 'none';
    }
  }

  private handleMouseDown(e: MouseEvent): void {
    // Only respond to left mouse button
    if (e.button !== 0) return;

    // Get the starting point in screen coordinates
    const rect = this.map.getCanvas().getBoundingClientRect();
    this.startPoint = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };

    // Create the selection box
    this.createBox();

    // Add move and up listeners to document for capturing outside canvas
    document.addEventListener('mousemove', this.handleMouseMove);
    document.addEventListener('mouseup', this.handleMouseUp);

    e.preventDefault();
  }

  private handleMouseMove(e: MouseEvent): void {
    if (!this.startPoint || !this.box) return;

    const rect = this.map.getCanvas().getBoundingClientRect();
    const currentPoint = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };

    // Calculate box dimensions
    const minX = Math.min(this.startPoint.x, currentPoint.x);
    const minY = Math.min(this.startPoint.y, currentPoint.y);
    const maxX = Math.max(this.startPoint.x, currentPoint.x);
    const maxY = Math.max(this.startPoint.y, currentPoint.y);

    // Update box position and size
    this.box.style.left = `${minX}px`;
    this.box.style.top = `${minY}px`;
    this.box.style.width = `${maxX - minX}px`;
    this.box.style.height = `${maxY - minY}px`;
  }

  private handleMouseUp(e: MouseEvent): void {
    if (!this.startPoint) return;

    const rect = this.map.getCanvas().getBoundingClientRect();
    const endPoint = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };

    // Calculate the bounds
    const minX = Math.min(this.startPoint.x, endPoint.x);
    const minY = Math.min(this.startPoint.y, endPoint.y);
    const maxX = Math.max(this.startPoint.x, endPoint.x);
    const maxY = Math.max(this.startPoint.y, endPoint.y);

    // Only zoom if the box has some size (at least 10px)
    if (maxX - minX > 10 && maxY - minY > 10) {
      // Convert screen coordinates to map coordinates
      const sw = this.map.unproject([minX, maxY]); // bottom-left
      const ne = this.map.unproject([maxX, minY]); // top-right

      // Fit the map to these bounds
      const bounds: LngLatBoundsLike = [
        [sw.lng, sw.lat],
        [ne.lng, ne.lat],
      ];
      this.map.fitBounds(bounds, {
        padding: 0,
        animate: true,
        duration: 300,
      });
    }

    // Clean up
    this.removeBox();
    document.removeEventListener('mousemove', this.handleMouseMove);
    document.removeEventListener('mouseup', this.handleMouseUp);
    this.startPoint = null;

    // Deactivate after zooming
    this.deactivate();

    // Update button state
    const btn = document.getElementById('zoom-rect-btn');
    if (btn) {
      btn.classList.remove('active');
    }
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      this.deactivate();
      const btn = document.getElementById('zoom-rect-btn');
      if (btn) {
        btn.classList.remove('active');
      }
    }
  }

  private createBox(): void {
    this.removeBox();

    this.box = document.createElement('div');
    this.box.id = 'zoom-rect-box';
    this.box.style.cssText = `
      position: absolute;
      border: 2px dashed #4a9eff;
      background: rgba(74, 158, 255, 0.1);
      pointer-events: none;
      z-index: 1000;
    `;

    // Add to map container
    this.map.getContainer().appendChild(this.box);
  }

  private removeBox(): void {
    if (this.box) {
      this.box.remove();
      this.box = null;
    }
  }
}
