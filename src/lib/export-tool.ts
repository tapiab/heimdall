/**
 * Export Tool - Export current map view as image
 */

import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { showToast, showError, showLoading, hideLoading } from './notifications';
import type { Map as MapLibreMap } from 'maplibre-gl';

// Interface for MapManager (will be properly typed when MapManager is migrated)
interface MapManager {
  map: MapLibreMap;
}

type ImageFormat = 'png' | 'jpeg';

export class ExportTool {
  private mapManager: MapManager;
  private map: MapLibreMap;

  constructor(mapManager: MapManager) {
    this.mapManager = mapManager;
    this.map = mapManager.map;
  }

  /**
   * Export current map view to an image file
   */
  async exportView(format: ImageFormat = 'png', quality: number = 0.92): Promise<void> {
    showLoading('Preparing export...');

    try {
      // Get the map canvas
      const canvas = this.map.getCanvas();

      // Create a copy canvas to include any overlays
      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = canvas.width;
      exportCanvas.height = canvas.height;
      const ctx = exportCanvas.getContext('2d');

      if (!ctx) {
        throw new Error('Failed to get canvas context');
      }

      // Draw the map canvas
      ctx.drawImage(canvas, 0, 0);

      // Convert to blob
      const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
      const blob = await new Promise<Blob | null>(resolve => {
        exportCanvas.toBlob(resolve, mimeType, quality);
      });

      if (!blob) {
        throw new Error('Failed to create image');
      }

      // Get file extension
      const ext = format === 'jpeg' ? 'jpg' : 'png';
      const defaultName = `heimdall-export-${this.getTimestamp()}.${ext}`;

      // Show save dialog
      const filePath = await save({
        defaultPath: defaultName,
        filters: [
          {
            name: format === 'jpeg' ? 'JPEG Image' : 'PNG Image',
            extensions: [ext],
          },
        ],
      });

      if (!filePath) {
        hideLoading();
        return; // User cancelled
      }

      // Convert blob to array buffer
      const arrayBuffer = await blob.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);

      // Write to file
      await writeFile(filePath, uint8Array);

      showToast(`Exported to ${filePath.split('/').pop()}`, 'success');
    } catch (error) {
      console.error('Export failed:', error);
      showError('Export failed', error instanceof Error ? error : String(error));
    } finally {
      hideLoading();
    }
  }

  /**
   * Export with scale factor for higher resolution
   */
  async exportHighRes(scale: number = 2, format: ImageFormat = 'png'): Promise<void> {
    showLoading('Rendering high-resolution export...');

    try {
      const canvas = this.map.getCanvas();
      const originalWidth = canvas.width;
      const originalHeight = canvas.height;

      // Create high-res canvas
      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = originalWidth * scale;
      exportCanvas.height = originalHeight * scale;
      const ctx = exportCanvas.getContext('2d');

      if (!ctx) {
        throw new Error('Failed to get canvas context');
      }

      // Scale and draw
      ctx.scale(scale, scale);
      ctx.drawImage(canvas, 0, 0);

      // Convert to blob
      const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
      const blob = await new Promise<Blob | null>(resolve => {
        exportCanvas.toBlob(resolve, mimeType, 0.92);
      });

      if (!blob) {
        throw new Error('Failed to create image');
      }

      const ext = format === 'jpeg' ? 'jpg' : 'png';
      const defaultName = `heimdall-export-${scale}x-${this.getTimestamp()}.${ext}`;

      const filePath = await save({
        defaultPath: defaultName,
        filters: [
          {
            name: format === 'jpeg' ? 'JPEG Image' : 'PNG Image',
            extensions: [ext],
          },
        ],
      });

      if (!filePath) {
        hideLoading();
        return;
      }

      const arrayBuffer = await blob.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      await writeFile(filePath, uint8Array);

      showToast(`Exported ${scale}x image to ${filePath.split('/').pop()}`, 'success');
    } catch (error) {
      console.error('High-res export failed:', error);
      showError('Export failed', error instanceof Error ? error : String(error));
    } finally {
      hideLoading();
    }
  }

  /**
   * Copy current view to clipboard
   */
  async copyToClipboard(): Promise<void> {
    try {
      const canvas = this.map.getCanvas();

      const blob = await new Promise<Blob | null>(resolve => {
        canvas.toBlob(resolve, 'image/png');
      });

      if (!blob) {
        throw new Error('Failed to create image');
      }

      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);

      showToast('Copied to clipboard', 'success', 2000);
    } catch (error) {
      console.error('Copy to clipboard failed:', error);
      showError('Copy failed', error instanceof Error ? error : String(error));
    }
  }

  private getTimestamp(): string {
    const now = new Date();
    return now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  }
}
