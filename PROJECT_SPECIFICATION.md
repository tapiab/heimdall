# Geospatial Raster Viewer - Complete Development Plan

## Table of Contents
1. [Project Overview](#project-overview)
2. [Background & Context](#background--context)
3. [Technology Stack](#technology-stack)
4. [Feature Requirements](#feature-requirements)
5. [Architecture](#architecture)
6. [Development Phases](#development-phases)
7. [Technical Implementation Details](#technical-implementation-details)
8. [Timeline & Resources](#timeline--resources)
9. [Risk Assessment](#risk-assessment)
10. [Getting Started](#getting-started)

---

## Project Overview

### Goal
Build a lightweight, blazing-fast geospatial raster and vector viewer as a modern replacement for OpenEV - a deprecated Python/GTK application that provided excellent performance for viewing large geospatial imagery.

### Key Objectives
- **Performance**: Match or exceed OpenEV's speed for large raster files
- **Lightweight**: Binary size <5MB (vs QGIS's bloated multi-GB installation)
- **Modern**: Use contemporary web technologies with native performance
- **Cross-platform**: Single codebase for Windows, macOS, Linux
- **User-friendly**: Intuitive interface with familiar GIS workflows

### Success Criteria
- Open and smoothly navigate 5GB+ GeoTIFF files
- Support multiple simultaneous layers
- 60fps rendering performance
- Sub-second tile loading
- Executable size under 5MB

---

## Background & Context

### Why This Project?

**The Problem:**
- **OpenEV** (the gold standard for lightweight geospatial viewing) is deprecated
  - Built on Python 2 + GTK 1.2 + PyGTK (all dead technologies)
  - Used hardware-accelerated OpenGL for fast rendering
  - Excellent sparse reading and tiled display
  - Cannot be easily ported to modern Python 3

- **QGIS** (suggested replacement) has major issues:
  - Bloated: Multi-GB installation
  - Slow: Poor raster performance compared to OpenEV
  - Overkill: Too many features for simple viewing tasks
  - Bad sparse reading implementation

- **Monteverdi** (OTB's viewer) was discontinued:
  - Dropped in OTB 9.0 (March 2024)
  - Was the closest modern equivalent to OpenEV
  - Developers claimed "redundant with QGIS" (ignoring performance issues)

**The Solution:**
Build a focused, lightweight viewer using modern web technologies (Tauri + WebGL) with native performance (Rust + GDAL) for the best of both worlds.

---

## Technology Stack

### Frontend: Web Technologies
**Framework**: Tauri 2.0+
- Uses system WebView (not Chromium like Electron)
- Results in <600KB base binary size
- Native performance with web development experience

**Graphics**: MapLibre GL JS + WebGL
- Hardware-accelerated rendering
- Mature geospatial library
- Built-in rotation, zoom, pan
- Custom shader support for advanced rendering

**UI**: Vanilla JavaScript/TypeScript (or Svelte for lightweight reactivity)
- Keep it simple
- No React/Vue overhead needed
- Fast prototyping and hot-reload

### Backend: Native Performance
**Language**: Rust
- Memory safe
- Native speed
- Excellent GDAL bindings
- Cross-compilation support

**Geospatial Library**: GDAL/OGR
- Industry standard
- Handles all raster/vector formats
- Built-in overview support
- Efficient RasterIO for decimation reading

### Why Not Alternatives?

| Option | Why Not? |
|--------|----------|
| **Port OpenEV to Python 3** | 6-12 months fighting deprecated APIs (GTK1→GTK3, PyGTK→PyGObject). Custom C bindings need complete rewrite. |
| **Qt + Python/C++** | Heavier than needed. Qt OpenGL integration more complex than WebGL. Larger binaries. |
| **Electron** | Bundles entire Chromium (~100MB+ overhead). Overkill for this use case. |
| **Pure Web App** | No native file system access. Can't leverage GDAL's native performance. |

---

## Feature Requirements

### Core Features (MVP)

| Feature | Priority | Difficulty | Notes |
|---------|----------|------------|-------|
| **Fast raster reading** | P0 | Easy | GDAL RasterIO with overview selection |
| **Multi-layer support** | P0 | Trivial | Basic state management |
| **Layer toggle** | P0 | Trivial | Show/hide individual layers |
| **Basemap** | P0 | Trivial | OSM/MapLibre built-in tiles |
| **Pan/Zoom** | P0 | Trivial | Core MapLibre feature |
| **Rotation** | P0 | Easy | Ctrl+mouse, built into MapLibre |
| **Dynamic adjustment** | P0 | Easy | WebGL fragment shader for min/max/gamma |
| **RGB compositing** | P0 | Medium | Custom shader, 3-band merge |
| **Vector support** | P0 | Easy | OGR → GeoJSON → MapLibre |
| **Version display** | P0 | Easy | ✅ IMPLEMENTED - Git tag version via build.rs, displayed in status bar and help modal |
| **Pixel basemap** | P0 | Medium | Grid/checkerboard basemap for non-georeferenced data |
| **Distance measurement** | P1 | Medium | Measure distance between two points in meters |
| **3D terrain draping** | P1 | Medium | ✅ IMPLEMENTED - AWS terrain tiles with sky layer |

### Future Enhancements (Post-MVP)

- Histogram display
- Band math (NDVI, etc.)
- Profile/transect tools
- Area measurement tools
- Export/screenshot
- Annotation layers
- Time series animation
- Plugin system
- Local DEM support (load your own elevation data)

---

## Architecture

### High-Level Overview
```
┌─────────────────────────────────────────────────────┐
│                 Frontend (JavaScript)                │
│                                                       │
│  ┌────────────────────────────────────────────────┐ │
│  │         MapLibre GL JS (WebGL Engine)          │ │
│  │  ┌──────────────────────────────────────────┐ │ │
│  │  │  Basemap Layer (OSM/Mapbox tiles)        │ │ │
│  │  ├──────────────────────────────────────────┤ │ │
│  │  │  Custom Raster Layers (your GeoTIFFs)    │ │ │
│  │  │  - Tile-based rendering                  │ │ │
│  │  │  - Custom WebGL shaders                  │ │ │
│  │  │  - Dynamic adjustment                    │ │ │
│  │  │  - RGB compositing                       │ │ │
│  │  ├──────────────────────────────────────────┤ │ │
│  │  │  Vector Layers (GeoJSON from OGR)        │ │ │
│  │  └──────────────────────────────────────────┘ │ │
│  └────────────────────────────────────────────────┘ │
│                                                       │
│  UI Components:                                       │
│  ├─ Layer Panel (checkboxes, reorder)                │
│  ├─ Dynamic Controls (min/max/gamma sliders)         │
│  ├─ RGB Band Selector (R/G/B dropdowns)              │
│  ├─ File Picker (open GeoTIFF/vector)                │
│  ├─ Toolbar (zoom, rotate, pan tools)                │
│  └─ Status Bar (coordinates, zoom level)             │
└─────────────────────────────────────────────────────┘
                    ↕ IPC (Tauri Commands)
┌─────────────────────────────────────────────────────┐
│                   Backend (Rust)                     │
│                                                       │
│  ┌────────────────────────────────────────────────┐ │
│  │              GDAL Core Engine                  │ │
│  │  ┌──────────────────────────────────────────┐ │ │
│  │  │  Dataset Manager                         │ │ │
│  │  │  - LRU cache for open datasets           │ │ │
│  │  │  - Overview selection logic              │ │ │
│  │  │  - Thread-safe access                    │ │ │
│  │  ├──────────────────────────────────────────┤ │ │
│  │  │  Tile Extraction                         │ │ │
│  │  │  - RasterIO for decimation reading       │ │ │
│  │  │  - Geographic bounds → pixel coords      │ │ │
│  │  │  - Multi-band reading                    │ │ │
│  │  ├──────────────────────────────────────────┤ │ │
│  │  │  Vector Processing                       │ │ │
│  │  │  - OGR dataset reading                   │ │ │
│  │  │  - Conversion to GeoJSON                 │ │ │
│  │  ├──────────────────────────────────────────┤ │ │
│  │  │  Tile Encoding                           │ │ │
│  │  │  - PNG/WebP/JPEG encoding                │ │ │
│  │  │  - Raw buffer option for WebGL          │ │ │
│  │  └──────────────────────────────────────────┘ │ │
│  └────────────────────────────────────────────────┘ │
│                                                       │
│  Tauri Commands:                                      │
│  ├─ open_raster(path) → RasterMetadata               │
│  ├─ get_tile(id, x, y, z) → TileBytes                │
│  ├─ get_rgb_tile(ids[], bands[], x, y, z) → Bytes    │
│  ├─ open_vector(path) → GeoJSON                      │
│  ├─ get_raster_stats(id, band) → Stats               │
│  └─ close_dataset(id) → Result                       │
└─────────────────────────────────────────────────────┘
```

### Data Flow: Tile Loading
```
User pans/zooms map
        ↓
Frontend calculates visible tiles needed
        ↓
For each tile:
    ├─ Check local cache (JavaScript Map)
    ├─ If cached → render immediately
    └─ If not cached:
           ↓
      invoke('get_tile', {id, x, y, z})
           ↓
      Rust Backend:
        1. Open dataset (or retrieve from cache)
        2. Select appropriate overview for zoom level
        3. Calculate geographic bounds for tile
        4. Convert geo bounds → pixel coordinates
        5. Call GDAL RasterIO for decimation read
        6. Encode tile as PNG/WebP
        7. Return bytes to frontend
           ↓
      Frontend:
        1. Create WebGL texture from bytes
        2. Store in cache
        3. Render tile
```

### File Structure
```
geo-viewer/
├── src/                          # Frontend code
│   ├── main.js                   # App entry point
│   ├── lib/
│   │   ├── map-manager.js        # MapLibre initialization
│   │   ├── layer-manager.js      # Layer state management
│   │   ├── raster-layer.js       # Custom WebGL raster layer
│   │   ├── tile-cache.js         # LRU tile cache
│   │   └── shaders/
│   │       ├── dynamic.frag      # Dynamic adjustment shader
│   │       └── rgb-composite.frag # RGB compositing shader
│   ├── components/
│   │   ├── LayerPanel.js         # Layer list UI
│   │   ├── DynamicControls.js    # Min/max/gamma controls
│   │   └── RGBSelector.js        # Band selection UI
│   └── styles/
│       └── main.css
│
├── src-tauri/                    # Backend code
│   ├── Cargo.toml                # Rust dependencies
│   ├── src/
│   │   ├── main.rs               # Tauri app setup
│   │   ├── commands/
│   │   │   ├── mod.rs
│   │   │   ├── raster.rs         # Raster commands
│   │   │   └── vector.rs         # Vector commands
│   │   ├── gdal/
│   │   │   ├── mod.rs
│   │   │   ├── dataset_cache.rs  # LRU cache for datasets
│   │   │   ├── tile_extractor.rs # Core tile logic
│   │   │   ├── overview.rs       # Overview selection
│   │   │   └── projection.rs     # Coordinate transforms
│   │   └── utils/
│   │       ├── encoding.rs       # Image encoding
│   │       └── error.rs          # Error types
│   └── tauri.conf.json           # Tauri configuration
│
├── package.json
├── README.md
└── PROJECT_SPEC.md               # This document
```

---

## Development Phases

### Phase 1: Foundation (Week 1-2)
**Goal**: Basic single-raster viewer

#### Tasks

**1.1 Project Setup (2 days)**
- [ ] Create Tauri project: `npm create tauri-app@latest`
- [ ] Add Rust dependencies:
```toml
  [dependencies]
  gdal = "0.17"
  gdal-sys = "0.10"
  image = "0.25"
```
- [ ] Add frontend dependencies:
```bash
  npm install maplibre-gl
```
- [ ] Configure Tauri permissions (file system access)
- [ ] Setup development environment and test build

**1.2 GDAL Tile Server (3 days)**
- [ ] Implement `open_raster()` command
  - Open GDAL dataset
  - Extract metadata (size, bands, projection, bounds)
  - Store in dataset cache
  - Return metadata to frontend
- [ ] Implement `get_tile()` command
  - Accept tile coordinates (x, y, zoom)
  - Calculate geographic bounds for tile
  - Select appropriate overview
  - Read tile data with RasterIO
  - Encode as PNG
  - Return bytes
- [ ] Implement dataset caching (LRU)
  - Cache open datasets
  - Evict least recently used
  - Thread-safe access

**1.3 MapLibre Integration (2 days)**
- [ ] Initialize MapLibre map
- [ ] Create custom raster source
  - Override tile loading
  - Call Rust backend via IPC
- [ ] Implement custom WebGL layer
  - Render tiles as textures
  - Handle tile pyramid
- [ ] Implement tile caching (frontend)
  - Store loaded tiles
  - Avoid redundant requests

**1.4 File Picker (1 day)**
- [ ] Add Tauri dialog API
- [ ] File open dialog (filter: .tif, .tiff)
- [ ] Display file info after opening
- [ ] Error handling for invalid files

**Deliverable**: Application that opens a GeoTIFF and displays it with smooth pan/zoom

**Code Samples**:
```rust
// src-tauri/src/commands/raster.rs
use gdal::Dataset;
use std::sync::{Arc, Mutex};

#[derive(Clone, serde::Serialize)]
pub struct RasterMetadata {
    pub id: String,
    pub width: usize,
    pub height: usize,
    pub bands: usize,
    pub bounds: [f64; 4], // [minx, miny, maxx, maxy]
    pub projection: String,
}

#[tauri::command]
pub async fn open_raster(
    path: String,
    state: tauri::State<'_, DatasetCache>
) -> Result<RasterMetadata, String> {
    let dataset = Dataset::open(&path)
        .map_err(|e| format!("Failed to open: {}", e))?;
    
    let metadata = RasterMetadata {
        id: uuid::Uuid::new_v4().to_string(),
        width: dataset.raster_size().0,
        height: dataset.raster_size().1,
        bands: dataset.raster_count() as usize,
        bounds: calculate_bounds(&dataset)?,
        projection: dataset.projection(),
    };
    
    state.add(metadata.id.clone(), dataset);
    
    Ok(metadata)
}

#[tauri::command]
pub async fn get_tile(
    id: String,
    x: i32,
    y: i32,
    zoom: u8,
    state: tauri::State<'_, DatasetCache>
) -> Result<Vec<u8>, String> {
    let dataset = state.get(&id)
        .ok_or("Dataset not found")?;
    
    // Calculate tile bounds in geographic coordinates
    let bounds = tile_to_geo_bounds(x, y, zoom);
    
    // Select best overview for this zoom level
    let overview_idx = select_overview(&dataset, zoom);
    
    // Extract tile using GDAL RasterIO
    let tile_data = extract_tile(&dataset, bounds, overview_idx)?;
    
    // Encode as PNG
    let png_bytes = encode_png(&tile_data)?;
    
    Ok(png_bytes)
}
```
```javascript
// src/lib/raster-layer.js
export class RasterLayer {
    constructor(id, metadata) {
        this.id = id;
        this.metadata = metadata;
        this.tileCache = new Map();
    }
    
    async loadTile(x, y, z) {
        const key = `${x}-${y}-${z}`;
        
        if (this.tileCache.has(key)) {
            return this.tileCache.get(key);
        }
        
        const { invoke } = window.__TAURI__;
        const bytes = await invoke('get_tile', {
            id: this.id,
            x, y, zoom: z
        });
        
        // Create image from bytes
        const blob = new Blob([bytes], { type: 'image/png' });
        const url = URL.createObjectURL(blob);
        const img = await loadImage(url);
        
        this.tileCache.set(key, img);
        return img;
    }
}
```

---

### Phase 2: Core Features (Week 3-4)
**Goal**: Multi-layer support with basemap and rotation

#### Tasks

**2.1 Layer Management (2 days)**
- [ ] Implement layer state management
```javascript
  class LayerManager {
      layers = []
      
      addLayer(layer)
      removeLayer(id)
      toggleVisibility(id)
      reorderLayers(fromIndex, toIndex)
      getVisibleLayers()
  }
```
- [ ] Create layer panel UI
  - Checkbox for each layer
  - Drag-to-reorder
  - Delete button
  - Opacity slider
- [ ] Handle multiple datasets in backend
- [ ] Layer rendering order (bottom to top)

**2.2 Basemap Integration (1 day)**
- [ ] Add OpenStreetMap basemap
- [ ] Configure layer ordering
  - Basemap (bottom)
  - Raster layers (middle)
  - Vector layers (top)
- [ ] Toggle basemap on/off

**2.3 Rotation Support (1 day)**
- [ ] Enable MapLibre bearing property
- [ ] Implement Ctrl+drag rotation
- [ ] Add compass/north arrow UI
- [ ] Add reset rotation button
- [ ] Keyboard shortcuts (R = reset)

**2.4 Overview Optimization (2 days)**
- [ ] Implement smart overview selection
```rust
  fn select_overview(dataset: &Dataset, zoom: u8) -> Option<usize> {
      // Calculate target resolution based on zoom
      let target_res = calculate_resolution_for_zoom(zoom);
      
      // Find overview with closest resolution
      let overviews = dataset.rasterband(1)?.overviews()?;
      
      overviews.iter()
          .enumerate()
          .min_by_key(|(_, ov)| {
              let res = ov.resolution();
              ((res - target_res).abs() * 1000.0) as i32
          })
          .map(|(idx, _)| idx)
  }
```
- [ ] Pre-calculate overview table for datasets
- [ ] Test with various zoom levels
- [ ] Performance profiling

**Deliverable**: Multi-layer viewer with basemap, rotation, and optimized tile loading

---

### Phase 3: Advanced Rendering (Week 5-6)
**Goal**: Dynamic adjustment and RGB compositing

#### Tasks

**3.1 Dynamic Adjustment Shader (3 days)**
- [ ] Implement WebGL fragment shader
```glsl
  uniform sampler2D u_image;
  uniform float u_min;
  uniform float u_max;
  uniform float u_gamma;
  
  void main() {
      vec4 color = texture2D(u_image, v_texCoord);
      float value = color.r;
      
      // Linear stretch
      float stretched = (value - u_min) / (u_max - u_min);
      stretched = clamp(stretched, 0.0, 1.0);
      
      // Gamma correction
      float adjusted = pow(stretched, u_gamma);
      
      gl_FragColor = vec4(vec3(adjusted), 1.0);
  }
```
- [ ] Integrate shader into MapLibre custom layer
- [ ] Pass uniforms (min/max/gamma) from UI
- [ ] Real-time shader updates

**3.2 Dynamic Controls UI (2 days)**
- [ ] Create control panel
  - Min value slider
  - Max value slider
  - Gamma slider (0.1 - 3.0)
- [ ] Auto-calculate min/max from raster stats
- [ ] Add preset buttons (Auto, Linear, Histogram Equalize)
- [ ] Show current values numerically

**3.3 RGB Compositing (3 days)**
- [ ] Backend: Multi-band tile extraction
```rust
  #[tauri::command]
  async fn get_rgb_tile(
      datasets: Vec<String>,  // 3 dataset IDs
      bands: Vec<i32>,        // Band indices
      x: i32, y: i32, zoom: u8,
      stretches: Vec<(f64, f64)> // Min/max for each band
  ) -> Result<Vec<u8>, String> {
      // Read 3 tiles (one per band)
      let r_data = read_tile(&datasets[0], bands[0], x, y, zoom)?;
      let g_data = read_tile(&datasets[1], bands[1], x, y, zoom)?;
      let b_data = read_tile(&datasets[2], bands[2], x, y, zoom)?;
      
      // Apply stretches
      let r_stretched = apply_stretch(&r_data, stretches[0]);
      let g_stretched = apply_stretch(&g_data, stretches[1]);
      let b_stretched = apply_stretch(&b_data, stretches[2]);
      
      // Merge into RGB
      let rgb = merge_bands(r_stretched, g_stretched, b_stretched);
      
      // Encode and return
      encode_rgb_png(&rgb)
  }
```
- [ ] Frontend: RGB layer type
- [ ] UI: Band selector
  - Red: [Dataset] [Band]
  - Green: [Dataset] [Band]
  - Blue: [Dataset] [Band]
- [ ] Preset combinations (True Color, False Color, NDVI)

**Deliverable**: Full rendering pipeline with dynamic adjustment and RGB compositing

---

### Phase 4: Vector Support (Week 7)
**Goal**: Display and style vector layers

#### Tasks

**4.1 OGR Reading (2 days)**
- [ ] Implement vector loading command
```rust
  #[tauri::command]
  async fn open_vector(path: String) -> Result<String, String> {
      let dataset = Dataset::open(&path)?;
      let layer = dataset.layer(0)?;
      
      // Convert to GeoJSON
      let mut features = Vec::new();
      for feature in layer.features() {
          features.push(feature_to_geojson(&feature)?);
      }
      
      let geojson = serde_json::to_string(&features)?;
      Ok(geojson)
  }
```
- [ ] Handle multiple geometry types
  - Points
  - LineStrings
  - Polygons
- [ ] Preserve attributes

**4.2 Vector Rendering (2 days)**
- [ ] Add GeoJSON source to MapLibre
- [ ] Default styling
  - Points: circles
  - Lines: thin strokes
  - Polygons: fill + stroke
- [ ] Toggle vector layer visibility
- [ ] Z-order (above rasters)

**4.3 Vector Styling (1 day)**
- [ ] Style editor UI
  - Color picker
  - Line width slider
  - Fill opacity
- [ ] Apply styles to MapLibre layer
- [ ] Per-layer styling

**Deliverable**: Complete viewer with vector overlay support

---

### Phase 5: Polish & Performance (Week 8)
**Goal**: Production-ready application

#### Tasks

**5.1 Tile Caching (2 days)**
- [ ] Implement LRU cache in Rust
```rust
  struct TileCache {
      cache: Arc<Mutex<lru::LruCache<String, Vec<u8>>>>,
      max_size: usize,
  }
```
- [ ] Cache encoded tiles (not just datasets)
- [ ] Configurable cache size
- [ ] Cache statistics (hit rate)

**5.2 Performance Profiling (1 day)**
- [ ] Profile tile extraction time
- [ ] Identify bottlenecks
- [ ] Optimize hot paths
  - Overview selection
  - Coordinate transforms
  - Tile encoding

**5.3 Keyboard Shortcuts (1 day)**
- [ ] Implement shortcuts
  - `Space + Drag` = Pan
  - `Ctrl + Wheel` = Zoom
  - `Ctrl + Drag` = Rotate
  - `L` = Toggle layer panel
  - `D` = Toggle dynamic controls
  - `R` = Reset rotation
  - `F` = Fit to extent
  - `Ctrl+O` = Open file
- [ ] Show shortcut help (?)

**5.4 UI Polish (2 days)**
- [ ] Layer panel refinements
  - Drag-to-reorder animation
  - Layer thumbnails
  - Rename layers
- [ ] Progress indicators
  - Loading spinner for tiles
  - File opening progress
- [ ] Error handling
  - User-friendly error messages
  - Recovery options
- [ ] Settings panel
  - Tile cache size
  - Coordinate display format
  - Default stretches

**Deliverable**: Polished, production-ready MVP

---

### Phase 6: Version Management & Pixel Basemap (Week 9)
**Goal**: Unified version management and proper basemap for non-georeferenced images

#### Tasks

**6.1 Version Management (2 days)** ✅ IMPLEMENTED
- [x] Create single source of truth for version
  - Use git tags as the canonical version source
  - Generate version at build time from `git describe --tags`
- [x] Implement Rust build script for version injection
```rust
  // src-tauri/build.rs
  fn main() {
      // Get version from git tag
      let output = std::process::Command::new("git")
          .args(["describe", "--tags", "--always", "--dirty"])
          .output()
          .expect("Failed to execute git");

      let version = String::from_utf8_lossy(&output.stdout)
          .trim()
          .to_string();

      // Fall back to Cargo.toml version if no tags
      let version = if version.is_empty() || version.starts_with("fatal") {
          env!("CARGO_PKG_VERSION").to_string()
      } else {
          version
      };

      println!("cargo:rustc-env=HEIMDALL_VERSION={}", version);
      tauri_build::build();
  }
```
- [x] Add Tauri command to expose version
```rust
  // src-tauri/src/commands/app.rs
  #[tauri::command]
  pub fn get_version() -> String {
      env!("HEIMDALL_VERSION").to_string()
  }
```
- [x] Display version in UI
  - Show version in status bar (`#version-display`)
  - Show version in keyboard shortcuts help modal (? key)
- [x] Version synced at build time via `git describe --tags --always --dirty`

**6.2 Pixel Coordinate Basemap (3 days)**
- [ ] Create pixel grid basemap layer
  - Render a subtle grid pattern for non-georeferenced images
  - Show pixel coordinate axes
  - Checkerboard or graph paper style background
- [ ] Implement pixel basemap source
```javascript
  // src/lib/pixel-basemap.js
  export function createPixelBasemapSource(width, height) {
      // Generate a canvas-based tile source showing pixel grid
      return {
          type: 'canvas',
          canvas: generateGridCanvas(width, height),
          coordinates: calculatePixelBounds(width, height),
          animate: false,
      };
  }

  function generateGridCanvas(width, height, gridSize = 100) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');

      // Light background
      ctx.fillStyle = '#f5f5f5';
      ctx.fillRect(0, 0, width, height);

      // Draw grid lines
      ctx.strokeStyle = '#e0e0e0';
      ctx.lineWidth = 1;

      // Vertical lines
      for (let x = 0; x <= width; x += gridSize) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
          ctx.stroke();
      }

      // Horizontal lines
      for (let y = 0; y <= height; y += gridSize) {
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(width, y);
          ctx.stroke();
      }

      // Draw coordinate labels at major intervals
      ctx.fillStyle = '#999';
      ctx.font = '12px monospace';
      for (let x = 0; x <= width; x += gridSize * 5) {
          ctx.fillText(x.toString(), x + 2, 12);
      }
      for (let y = gridSize * 5; y <= height; y += gridSize * 5) {
          ctx.fillText(y.toString(), 2, y - 2);
      }

      return canvas;
  }
```
- [ ] Update MapManager to switch basemaps based on data type
```javascript
  // src/lib/map-manager.js
  setBasemap(type) {
      // type: 'osm', 'satellite', 'pixel', or 'none'
      this.currentBasemap = type;

      if (type === 'none') {
          this.basemapVisible = false;
          this.setLayerVisibility('osm-tiles', false);
          this.setLayerVisibility('satellite-tiles', false);
          this.setLayerVisibility('pixel-grid', false);
      } else if (type === 'pixel') {
          this.basemapVisible = true;
          this.setLayerVisibility('osm-tiles', false);
          this.setLayerVisibility('satellite-tiles', false);
          this.setLayerVisibility('pixel-grid', true);
      } else {
          this.basemapVisible = true;
          this.setLayerVisibility('osm-tiles', type === 'osm');
          this.setLayerVisibility('satellite-tiles', type === 'satellite');
          this.setLayerVisibility('pixel-grid', false);
      }
  }
```
- [ ] Auto-switch to pixel basemap when loading non-georeferenced data
  - Detect `pixelCoordMode` activation
  - Automatically change basemap to 'pixel' type
  - Remember previous basemap to restore when switching back to geo data
- [ ] Add UI controls for pixel basemap options
  - Grid spacing selector (10, 50, 100, 500 pixels)
  - Toggle grid labels
  - Grid line style (solid, dashed, dots)

**6.3 Distance Measurement Tool (2 days)**
- [ ] Implement measurement mode toggle
  - Add "Measure" button to toolbar or keyboard shortcut (M key)
  - Visual indicator when measurement mode is active
  - Cursor changes to crosshair in measurement mode
- [ ] Implement two-point click interaction
```javascript
  // src/lib/measure-tool.js
  export class MeasureTool {
      constructor(map) {
          this.map = map;
          this.active = false;
          this.points = [];
          this.markers = [];
          this.lineLayer = null;
      }

      activate() {
          this.active = true;
          this.points = [];
          this.clearMarkers();
          this.map.getCanvas().style.cursor = 'crosshair';
          this.map.on('click', this.handleClick);
      }

      deactivate() {
          this.active = false;
          this.clearMarkers();
          this.map.getCanvas().style.cursor = '';
          this.map.off('click', this.handleClick);
      }

      handleClick = (e) => {
          const { lng, lat } = e.lngLat;
          this.points.push([lng, lat]);
          this.addMarker(lng, lat);

          if (this.points.length === 2) {
              this.showDistance();
              this.drawLine();
          } else if (this.points.length > 2) {
              // Reset for new measurement
              this.points = [[lng, lat]];
              this.clearMarkers();
              this.addMarker(lng, lat);
          }
      }

      addMarker(lng, lat) {
          const el = document.createElement('div');
          el.className = 'measure-marker';
          const marker = new maplibregl.Marker(el)
              .setLngLat([lng, lat])
              .addTo(this.map);
          this.markers.push(marker);
      }

      clearMarkers() {
          this.markers.forEach(m => m.remove());
          this.markers = [];
          if (this.lineLayer && this.map.getLayer('measure-line')) {
              this.map.removeLayer('measure-line');
              this.map.removeSource('measure-line');
          }
      }
  }
```
- [ ] Implement geodesic distance calculation (Haversine formula)
```javascript
  // src/lib/geo-utils.js
  export function calculateDistance(point1, point2) {
      // Haversine formula for geodesic distance
      const R = 6371000; // Earth's radius in meters
      const lat1 = point1[1] * Math.PI / 180;
      const lat2 = point2[1] * Math.PI / 180;
      const deltaLat = (point2[1] - point1[1]) * Math.PI / 180;
      const deltaLng = (point2[0] - point1[0]) * Math.PI / 180;

      const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
                Math.cos(lat1) * Math.cos(lat2) *
                Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

      return R * c; // Distance in meters
  }

  export function formatDistance(meters) {
      if (meters < 1000) {
          return `${meters.toFixed(1)} m`;
      } else {
          return `${(meters / 1000).toFixed(2)} km`;
      }
  }
```
- [ ] Display measurement result
  - Show distance in popup or overlay near the line
  - Format: meters for <1km, kilometers for >=1km
  - Include both metric units
- [ ] Draw measurement line on map
```javascript
  drawLine() {
      const geojson = {
          type: 'Feature',
          geometry: {
              type: 'LineString',
              coordinates: this.points
          }
      };

      if (this.map.getSource('measure-line')) {
          this.map.getSource('measure-line').setData(geojson);
      } else {
          this.map.addSource('measure-line', { type: 'geojson', data: geojson });
          this.map.addLayer({
              id: 'measure-line',
              type: 'line',
              source: 'measure-line',
              paint: {
                  'line-color': '#ff6600',
                  'line-width': 2,
                  'line-dasharray': [2, 2]
              }
          });
      }
  }
```
- [ ] Support pixel distance for non-georeferenced images
  - When in pixel coordinate mode, calculate Euclidean distance in pixels
  - Display as "X pixels" instead of meters
- [ ] Add keyboard shortcut (M) to toggle measurement mode
- [ ] Add clear measurement button/shortcut (Esc to cancel)

**6.4 3D Terrain Draping (2 days)**
- [ ] Add terrain source using AWS free terrain tiles
```javascript
  // src/lib/map-manager.js
  initTerrain() {
      // AWS Terrain Tiles - free, no API key required
      this.map.addSource('terrain-dem', {
          type: 'raster-dem',
          tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
          encoding: 'terrarium',
          tileSize: 256,
          maxzoom: 15
      });
  }

  enableTerrain(exaggeration = 1.5) {
      if (!this.map.getSource('terrain-dem')) {
          this.initTerrain();
      }
      this.map.setTerrain({
          source: 'terrain-dem',
          exaggeration: exaggeration
      });
      this.terrainEnabled = true;
  }

  disableTerrain() {
      this.map.setTerrain(null);
      this.terrainEnabled = false;
  }

  setTerrainExaggeration(value) {
      if (this.terrainEnabled) {
          this.map.setTerrain({
              source: 'terrain-dem',
              exaggeration: value
          });
      }
  }
```
- [ ] Add sky layer for better 3D visualization
```javascript
  addSkyLayer() {
      if (!this.map.getLayer('sky')) {
          this.map.addLayer({
              id: 'sky',
              type: 'sky',
              paint: {
                  'sky-type': 'atmosphere',
                  'sky-atmosphere-sun': [0.0, 90.0],
                  'sky-atmosphere-sun-intensity': 15
              }
          });
      }
  }
```
- [ ] Enable pitch control for 3D viewing
```javascript
  // Update map initialization
  this.map = new maplibregl.Map({
      // ... existing config
      pitch: 0,
      maxPitch: 85,
      pitchWithRotate: true  // Already enabled
  });
```
- [ ] Add terrain controls to UI
  - Toggle button for 3D terrain (keyboard shortcut: T)
  - Exaggeration slider (0.5x to 5x)
  - Pitch angle display in status bar
```javascript
  // src/lib/ui.js - Add to controls panel
  function createTerrainControls(mapManager) {
      const container = document.createElement('div');
      container.className = 'terrain-controls';
      container.innerHTML = `
          <div class="control-group">
              <label>
                  <input type="checkbox" id="terrain-toggle"> 3D Terrain
              </label>
          </div>
          <div class="control-group" id="exaggeration-control" style="display:none">
              <label>Exaggeration: <span id="exaggeration-value">1.5</span>x</label>
              <input type="range" id="exaggeration-slider"
                     min="0.5" max="5" step="0.1" value="1.5">
          </div>
      `;

      const toggle = container.querySelector('#terrain-toggle');
      const slider = container.querySelector('#exaggeration-slider');
      const exaggerationControl = container.querySelector('#exaggeration-control');

      toggle.addEventListener('change', (e) => {
          if (e.target.checked) {
              mapManager.enableTerrain();
              exaggerationControl.style.display = 'block';
          } else {
              mapManager.disableTerrain();
              exaggerationControl.style.display = 'none';
          }
      });

      slider.addEventListener('input', (e) => {
          const value = parseFloat(e.target.value);
          container.querySelector('#exaggeration-value').textContent = value.toFixed(1);
          mapManager.setTerrainExaggeration(value);
      });

      return container;
  }
```
- [ ] Add keyboard shortcut (T) to toggle terrain
- [ ] Update pitch display in status bar
```javascript
  // Add to setupEventListeners in map-manager.js
  this.map.on('pitch', () => {
      this.updatePitchDisplay();
  });

  updatePitchDisplay() {
      const pitch = this.map.getPitch();
      const pitchEl = document.getElementById('pitch-display');
      if (pitchEl) {
          pitchEl.textContent = `Pitch: ${pitch.toFixed(0)}°`;
      }
  }
```
- [ ] Add reset view button (resets pitch, bearing, and zoom)
- [ ] Disable terrain for non-georeferenced images
  - Terrain only makes sense for geographic data
  - Hide terrain controls when in pixel coordinate mode

**Deliverable**: Unified version management from git tags, proper pixel-coordinate basemap for non-georeferenced imagery, distance measurement tool, and 3D terrain visualization

---

## Technical Implementation Details

### 1. Tile Extraction Algorithm

**Overview Selection Logic**:
```rust
fn select_best_overview(dataset: &Dataset, zoom_level: u8) -> Option<usize> {
    // Zoom level to resolution mapping (Web Mercator)
    // zoom 0  = 156543.03 meters/pixel
    // zoom 1  = 78271.52 meters/pixel
    // zoom n  = 156543.03 / (2^n) meters/pixel
    
    let target_resolution = 156543.03 / (2_f64.powi(zoom_level as i32));
    
    let band = dataset.rasterband(1).unwrap();
    let base_res = calculate_pixel_resolution(dataset);
    
    // If base resolution is already good enough, use it
    if base_res <= target_resolution * 1.5 {
        return None; // Use base dataset
    }
    
    // Find best matching overview
    let overview_count = band.overview_count();
    let mut best_overview = None;
    let mut best_diff = f64::MAX;
    
    for i in 0..overview_count {
        let overview = band.overview(i).unwrap();
        let ov_res = calculate_overview_resolution(&overview);
        let diff = (ov_res - target_resolution).abs();
        
        if diff < best_diff {
            best_diff = diff;
            best_overview = Some(i);
        }
    }
    
    best_overview
}
```

**Tile Bounds Calculation**:
```rust
fn tile_to_geo_bounds(x: i32, y: i32, zoom: u8) -> [f64; 4] {
    // Web Mercator tile bounds
    let n = 2_f64.powi(zoom as i32);
    let lon_min = (x as f64 / n) * 360.0 - 180.0;
    let lon_max = ((x + 1) as f64 / n) * 360.0 - 180.0;
    
    let lat_rad_min = ((1.0 - 2.0 * (y + 1) as f64 / n) * PI).sinh().atan();
    let lat_rad_max = ((1.0 - 2.0 * y as f64 / n) * PI).sinh().atan();
    
    let lat_min = lat_rad_min.to_degrees();
    let lat_max = lat_rad_max.to_degrees();
    
    [lon_min, lat_min, lon_max, lat_max]
}
```

**RasterIO Decimation Read**:
```rust
fn extract_tile_data(
    dataset: &Dataset,
    geo_bounds: [f64; 4],
    overview_idx: Option<usize>,
    tile_size: usize
) -> Result<Vec<u8>, GdalError> {
    let band = if let Some(idx) = overview_idx {
        dataset.rasterband(1)?.overview(idx)?
    } else {
        dataset.rasterband(1)?
    };
    
    // Convert geo bounds to pixel coordinates
    let (x_off, y_off, x_size, y_size) = geo_to_pixel_coords(
        dataset,
        geo_bounds,
        overview_idx
    )?;
    
    // Read with automatic decimation/resampling
    let buffer = band.read_as::<u8>(
        (x_off, y_off),        // Window offset
        (x_size, y_size),      // Window size
        (tile_size, tile_size), // Buffer size (causes decimation)
        Some(ResampleAlg::Average) // Resampling algorithm
    )?;
    
    Ok(buffer.data)
}
```

### 2. WebGL Custom Layer Implementation
```javascript
// src/lib/raster-layer.js
export function createRasterLayer(layerId, rasterSource) {
    return {
        id: layerId,
        type: 'custom',
        
        onAdd(map, gl) {
            this.map = map;
            this.gl = gl;
            
            // Create shader program
            this.program = createShaderProgram(gl, vertexShader, fragmentShader);
            
            // Setup vertex buffer (tile quad)
            this.vertexBuffer = createTileQuad(gl);
            
            // Texture cache
            this.textures = new Map();
        },
        
        render(gl, matrix) {
            const zoom = this.map.getZoom();
            const bounds = this.map.getBounds();
            
            // Calculate visible tiles
            const tiles = calculateVisibleTiles(bounds, zoom);
            
            gl.useProgram(this.program);
            
            for (const tile of tiles) {
                const key = `${tile.x}-${tile.y}-${tile.z}`;
                
                // Load tile if not cached
                if (!this.textures.has(key)) {
                    this.loadTile(tile).then(texture => {
                        this.textures.set(key, texture);
                        this.map.triggerRepaint();
                    });
                    continue;
                }
                
                // Render tile
                const texture = this.textures.get(key);
                const tileMatrix = calculateTileMatrix(tile, matrix);
                
                gl.uniformMatrix4fv(
                    this.program.u_matrix,
                    false,
                    tileMatrix
                );
                gl.bindTexture(gl.TEXTURE_2D, texture);
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            }
        },
        
        async loadTile(tile) {
            const { invoke } = window.__TAURI__;
            const bytes = await invoke('get_tile', {
                id: this.datasetId,
                x: tile.x,
                y: tile.y,
                zoom: tile.z
            });
            
            return createTextureFromBytes(this.gl, bytes);
        }
    };
}
```

### 3. Dynamic Adjustment Shader
```glsl
// dynamic-adjustment.frag
precision highp float;

uniform sampler2D u_image;
uniform float u_min;
uniform float u_max;
uniform float u_gamma;

varying vec2 v_texCoord;

void main() {
    // Sample texture
    vec4 texel = texture2D(u_image, v_texCoord);
    float value = texel.r;
    
    // Apply linear stretch
    float stretched = (value - u_min) / (u_max - u_min);
    stretched = clamp(stretched, 0.0, 1.0);
    
    // Apply gamma correction
    float adjusted = pow(stretched, 1.0 / u_gamma);
    
    // Output grayscale
    gl_FragColor = vec4(vec3(adjusted), texel.a);
}
```

### 4. RGB Compositing Shader
```glsl
// rgb-composite.frag
precision highp float;

uniform sampler2D u_red;
uniform sampler2D u_green;
uniform sampler2D u_blue;

uniform vec2 u_red_stretch;   // (min, max)
uniform vec2 u_green_stretch;
uniform vec2 u_blue_stretch;

varying vec2 v_texCoord;

float applyStretch(float value, vec2 stretch) {
    float stretched = (value - stretch.x) / (stretch.y - stretch.x);
    return clamp(stretched, 0.0, 1.0);
}

void main() {
    float r = texture2D(u_red, v_texCoord).r;
    float g = texture2D(u_green, v_texCoord).r;
    float b = texture2D(u_blue, v_texCoord).r;
    
    r = applyStretch(r, u_red_stretch);
    g = applyStretch(g, u_green_stretch);
    b = applyStretch(b, u_blue_stretch);
    
    gl_FragColor = vec4(r, g, b, 1.0);
}
```

### 5. LRU Cache Implementation
```rust
// src-tauri/src/gdal/dataset_cache.rs
use lru::LruCache;
use std::sync::{Arc, Mutex};
use gdal::Dataset;

pub struct DatasetCache {
    cache: Arc<Mutex<LruCache<String, Arc<Dataset>>>>,
}

impl DatasetCache {
    pub fn new(capacity: usize) -> Self {
        Self {
            cache: Arc::new(Mutex::new(LruCache::new(capacity))),
        }
    }
    
    pub fn get(&self, id: &str) -> Option<Arc<Dataset>> {
        let mut cache = self.cache.lock().unwrap();
        cache.get(id).cloned()
    }
    
    pub fn add(&self, id: String, dataset: Dataset) {
        let mut cache = self.cache.lock().unwrap();
        cache.put(id, Arc::new(dataset));
    }
    
    pub fn remove(&self, id: &str) {
        let mut cache = self.cache.lock().unwrap();
        cache.pop(id);
    }
}
```

---

## Timeline & Resources

### Time Estimates

**Full-time development (40hrs/week):**
- Phase 1: 2 weeks (80 hours)
- Phase 2: 2 weeks (80 hours)
- Phase 3: 2 weeks (80 hours)
- Phase 4: 1 week (40 hours)
- Phase 5: 1 week (40 hours)
- Phase 6: 2 weeks (80 hours)
- **Total: 10 weeks (400 hours)**

**Part-time development (10hrs/week):**
- Phase 1: 8 weeks
- Phase 2: 8 weeks
- Phase 3: 8 weeks
- Phase 4: 4 weeks
- Phase 5: 4 weeks
- Phase 6: 8 weeks
- **Total: 40 weeks (~10 months)**

### Resource Requirements

**Hardware:**
- Development machine with 16GB+ RAM
- GPU supporting OpenGL/WebGL 2.0
- Multi-platform testing: Windows, macOS, Linux VMs

**Software:**
- Rust toolchain (rustup)
- Node.js 18+
- GDAL system library (varies by platform)
- Code editor (VS Code recommended)

**Skills Required:**
- **Essential**: JavaScript, basic Rust, GDAL concepts
- **Helpful**: WebGL/GLSL, systems programming, geospatial fundamentals
- **Nice to have**: Tauri experience, MapLibre experience

**Learning Curve:**
- If you know JavaScript: ~1 week to get productive with Rust basics
- If you know Rust: ~1 day to understand Tauri patterns
- GDAL concepts: ~2-3 days of reading documentation
- WebGL shaders: ~1 week for basics (lots of examples available)

---

## Risk Assessment

### Technical Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| **GDAL Rust bindings incomplete** | Medium | High | Fallback to FFI with GDAL C API directly |
| **WebGL performance issues** | Low | Medium | Optimize tile size, use texture atlases, profile |
| **Coordinate system bugs** | Medium | Medium | Comprehensive testing, use GDAL's projection handling |
| **Memory leaks in tile cache** | Medium | Low | Implement proper cleanup, use weak references |
| **Cross-platform build issues** | Medium | Medium | Test early on all platforms, use CI/CD |
| **GDAL system dependency conflicts** | High | Low | Document installation clearly, consider static linking |

### Project Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| **Scope creep** | High | High | Stick to MVP features, maintain backlog for v2 |
| **Underestimated complexity** | Medium | Medium | Buffer time built into estimates, regular check-ins |
| **Loss of motivation** | Medium | High | Focus on quick wins, celebrate milestones |
| **Lack of testing** | Medium | Medium | Test with real-world data early and often |

### Showstoppers to Watch For

1. **GDAL binding limitations**: If Rust bindings can't handle your use cases, pivot to:
   - Direct C API via FFI
   - Python subprocess for GDAL operations (slower but works)

2. **WebGL context issues**: Different behavior across platforms
   - Solution: Extensive testing, fallback to simpler rendering

3. **Tauri WebView limitations**: Some WebGL features might not work
   - Solution: Test WebGL features early, document requirements

---

## Getting Started

### Prerequisites

**1. Install Rust**
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
```

**2. Install Node.js**
- Download from https://nodejs.org/ (LTS version)

**3. Install GDAL**

**macOS:**
```bash
brew install gdal
```

**Ubuntu/Debian:**
```bash
sudo apt-get update
sudo apt-get install libgdal-dev gdal-bin
```

**Windows:**
- Download from https://www.gisinternals.com/
- Or use OSGeo4W installer
- Add to PATH

**4. Verify installations**
```bash
rustc --version   # Should show 1.70+
node --version    # Should show 18+
gdalinfo --version # Should show 3.0+
```

### Quick Start

**Step 1: Create Project**
```bash
npm create tauri-app@latest
# Choose:
# - Project name: geo-viewer
# - Package manager: npm
# - UI recipe: Vanilla (or your preference)
# - Add @tauri-apps/api: Yes
# - Add @tauri-apps/cli: Yes

cd geo-viewer
```

**Step 2: Add Dependencies**

**Rust dependencies** (`src-tauri/Cargo.toml`):
```toml
[dependencies]
tauri = { version = "2", features = ["dialog-open"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
gdal = "0.17"
gdal-sys = "0.10"
image = "0.25"
lru = "0.12"
uuid = { version = "1", features = ["v4"] }
```

**Frontend dependencies**:
```bash
npm install maplibre-gl
npm install --save-dev @types/maplibre-gl  # If using TypeScript
```

**Step 3: Configure Tauri** (`src-tauri/tauri.conf.json`):
```json
{
  "build": {
    "beforeBuildCommand": "npm run build",
    "beforeDevCommand": "npm run dev",
    "devPath": "http://localhost:5173",
    "distDir": "../dist"
  },
  "bundle": {
    "identifier": "com.geo-viewer.app",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  },
  "security": {
    "csp": null
  },
  "app": {
    "windows": [{
      "title": "Geospatial Viewer",
      "width": 1200,
      "height": 800,
      "resizable": true,
      "fullscreen": false
    }]
  }
}
```

**Step 4: Test Build**
```bash
npm run tauri dev
```

Should open an empty Tauri window. Success!

### Next Steps

**Option A: Implement yourself**
- Follow Phase 1 tasks
- Start with `open_raster` command in Rust
- Add MapLibre to frontend
- Build incrementally

**Option B: Use Claude Code**
```bash
# Install Claude Code
npm install -g @anthropic-ai/claude-code

# Start in project directory
cd geo-viewer
claude-code

# In Claude Code:
"I'm building a geospatial viewer based on this spec:
[paste PROJECT_SPEC.md or share this chat URL]

Let's implement Phase 1, starting with the GDAL tile 
extraction in Rust. Please create the command structure 
and implement open_raster()."
```

**Option C: Incremental prototyping**
- Start with simplified version (single hardcoded file)
- Add one feature at a time
- Test thoroughly before moving on

---

## Success Metrics

### Performance Targets
- **Tile load time**: <100ms for 256x256 tile
- **Frame rate**: Consistent 60fps during pan/zoom
- **File open time**: <2s for 5GB GeoTIFF
- **Memory usage**: <500MB for 5 open layers
- **Binary size**: <5MB compiled

### Feature Completeness
- [ ] Opens GeoTIFF files (all common formats)
- [ ] Smooth pan/zoom/rotate
- [ ] Multi-layer support (5+ layers)
- [ ] Layer visibility toggle
- [ ] Dynamic adjustment (min/max/gamma)
- [ ] RGB compositing (3+ bands)
- [ ] Vector overlay (Shapefile, GeoJSON)
- [ ] Basemap integration (OSM, satellite)
- [ ] Pixel basemap for non-georeferenced data
- [x] Version display from git tag (status bar and help modal)
- [ ] Distance measurement tool (meters/pixels)
- [x] 3D terrain draping (AWS terrain tiles)
- [ ] Keyboard shortcuts

### Code Quality
- [ ] Comprehensive error handling
- [ ] No memory leaks (tested with valgrind/instruments)
- [ ] Documented code (inline comments)
- [ ] README with setup instructions
- [ ] Basic test coverage (unit tests for core logic)

---

## Appendix

### Useful Resources

**Tauri:**
- Official docs: https://v2.tauri.app/
- Examples: https://github.com/tauri-apps/tauri/tree/dev/examples
- Discord: https://discord.com/invite/tauri

**GDAL:**
- Rust bindings: https://docs.rs/gdal/latest/gdal/
- GDAL docs: https://gdal.org/
- Raster tutorial: https://gdal.org/tutorials/raster_api_tut.html

**MapLibre:**
- Docs: https://maplibre.org/maplibre-gl-js/docs/
- Examples: https://maplibre.org/maplibre-gl-js/docs/examples/
- Custom layers: https://maplibre.org/maplibre-gl-js/docs/examples/custom-style-layer/

**WebGL:**
- WebGL fundamentals: https://webglfundamentals.org/
- Shader examples: https://www.shadertoy.com/
- Texture mapping: https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/Tutorial/Using_textures_in_WebGL

### Sample Data for Testing

**Raster:**
- USGS Earth Explorer: https://earthexplorer.usgs.gov/
- Copernicus Open Access Hub: https://scihub.copernicus.eu/
- NASA Earthdata: https://earthdata.nasa.gov/

**Vector:**
- Natural Earth: https://www.naturalearthdata.com/
- OpenStreetMap extracts: https://download.geofabrik.de/

### Common GDAL Commands (for reference)
```bash
# Get raster info
gdalinfo input.tif

# Build overviews (pyramids)
gdaladdo -r average input.tif 2 4 8 16

# Convert to Cloud Optimized GeoTIFF
gdal_translate input.tif output_cog.tif \
  -co TILED=YES \
  -co COPY_SRC_OVERVIEWS=YES \
  -co COMPRESS=LZW

# Reproject raster
gdalwarp -t_srs EPSG:3857 input.tif output_webmercator.tif

# Convert vector to GeoJSON
ogr2ogr -f GeoJSON output.json input.shp
```

---

## Revision History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2024-11-25 | Initial comprehensive plan |
| 1.1 | 2025-11-27 | Added Phase 6: Version management (git tag sync) and pixel basemap for non-georeferenced data |
| 1.2 | 2025-11-27 | Added distance measurement tool (Phase 6.3) |
| 1.3 | 2025-11-28 | Added 3D terrain draping with AWS terrain tiles (Phase 6.4) |
| 1.4 | 2025-11-28 | **Implemented** 3D terrain draping (Phase 6.4) with error handling, tests, and map.resize() fix |
| 1.5 | 2025-11-28 | **Implemented** Version from git tag (Phase 6.1) - build.rs extracts version, displayed in status bar and help modal |

---

**Ready to build? Let's make this happen! 🚀**
