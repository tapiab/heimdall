# Quick Start for Claude Code

## What We're Building
A Tauri desktop app for viewing geospatial rasters (GeoTIFF files) 
with WebGL-accelerated rendering.

## Immediate Tasks
1. Create Tauri project: `npm create tauri-app@latest geo-viewer`
2. Add Rust dependencies:
   - gdal = "0.17"
   - image = "0.25"
3. Implement Rust command:
```rust
   #[tauri::command]
   async fn get_tile(
       path: String,
       x: i32, 
       y: i32, 
       zoom: u8
   ) -> Result<Vec<u8>, String>
```
4. Frontend: MapLibre GL with custom tile source
5. Test with sample GeoTIFF

## Architecture Decision
- Rust backend extracts 256x256 tiles using GDAL RasterIO
- Frontend displays in WebGL via MapLibre
- IPC via Tauri invoke/command system

## Key Files to Create
- `src-tauri/src/tile_server.rs` - Tile extraction
- `src-tauri/src/gdal_utils.rs` - GDAL helpers  
- `src/lib/maplibre-setup.js` - Map initialization
- `src/lib/raster-layer.js` - Custom WebGL layer
