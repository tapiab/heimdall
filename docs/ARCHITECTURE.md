# Architecture

## Overview

Geo Viewer is a desktop application built with Tauri, combining a Rust backend for high-performance geospatial operations with a JavaScript frontend for the user interface.

```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend (JavaScript)                     │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              MapLibre GL JS (WebGL)                    │ │
│  │  ┌──────────────────────────────────────────────────┐  │ │
│  │  │  Basemap Layer (OSM/Satellite)                   │  │ │
│  │  ├──────────────────────────────────────────────────┤  │ │
│  │  │  Raster Layers (Custom tile protocol)            │  │ │
│  │  │  - Grayscale with stretch                        │  │ │
│  │  │  - RGB composite                                 │  │ │
│  │  │  - Cross-layer RGB                               │  │ │
│  │  └──────────────────────────────────────────────────┘  │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ LayerManager│  │ MapManager  │  │    UI Components    │  │
│  │ - layers    │  │ - map       │  │ - Layer panel       │  │
│  │ - protocols │  │ - basemap   │  │ - Dynamic controls  │  │
│  │ - tiles     │  │ - coords    │  │ - Keyboard handler  │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                        ↕ IPC (Tauri Commands)
┌─────────────────────────────────────────────────────────────┐
│                      Backend (Rust)                          │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                   Tauri Commands                        │ │
│  │  open_raster, get_tile, get_tile_stretched,            │ │
│  │  get_rgb_tile, get_cross_layer_rgb_tile,               │ │
│  │  get_cross_layer_pixel_rgb_tile, get_pixel_tile,       │ │
│  │  get_raster_stats, close_dataset                       │ │
│  └────────────────────────────────────────────────────────┘ │
│                            ↓                                 │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                    GDAL Module                          │ │
│  │  ┌──────────────────┐  ┌─────────────────────────────┐ │ │
│  │  │  DatasetCache    │  │     TileExtractor           │ │ │
│  │  │  - LRU cache     │  │  - extract_tile             │ │ │
│  │  │  - path storage  │  │  - extract_rgb_tile         │ │ │
│  │  │  - thread-safe   │  │  - extract_pixel_tile       │ │ │
│  │  └──────────────────┘  │  - coordinate transforms    │ │ │
│  │                        │  - PNG encoding             │ │ │
│  │                        └─────────────────────────────┘ │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
geo-viewer/
├── src/                          # Frontend code
│   ├── main.js                   # App entry point
│   ├── lib/
│   │   ├── map-manager.js        # MapLibre initialization & controls
│   │   ├── layer-manager.js      # Layer state, tile protocols, UI
│   │   └── ui.js                 # Keyboard shortcuts, file dialog
│   └── styles/
│       └── main.css              # Application styles
│
├── src-tauri/                    # Backend code (Rust)
│   ├── Cargo.toml                # Rust dependencies
│   ├── tauri.conf.json           # Tauri configuration
│   └── src/
│       ├── main.rs               # Tauri app setup, command registration
│       ├── commands/
│       │   ├── mod.rs            # Module exports
│       │   └── raster.rs         # Raster commands (open, tile, stats)
│       └── gdal/
│           ├── mod.rs            # Module exports
│           ├── dataset_cache.rs  # LRU cache for dataset paths
│           └── tile_extractor.rs # Core tile extraction logic
│
├── docs/                         # Documentation
│   └── ARCHITECTURE.md           # This file
│
├── index.html                    # HTML entry point
├── package.json                  # Node.js dependencies
└── README.md                     # Project overview
```

## Data Flow

### Opening a Raster

```
User clicks Open → File Dialog → Selected path(s)
                                       ↓
                              invoke('open_raster', path)
                                       ↓
                              Rust: GDAL opens dataset
                                       ↓
                              Extract metadata:
                              - dimensions, bands, bounds
                              - projection, pixel size
                              - band statistics
                              - is_georeferenced flag
                                       ↓
                              Store path in DatasetCache
                                       ↓
                              Return RasterMetadata to frontend
                                       ↓
                              LayerManager creates layer
                              - Setup tile protocol
                              - Add MapLibre source/layer
                              - Update UI
```

### Tile Loading

```
MapLibre requests tile (z/x/y)
           ↓
Custom protocol handler (raster-{id}://)
           ↓
Check layer display mode:
├─ grayscale → get_tile_stretched / get_pixel_tile
├─ rgb → get_rgb_tile
└─ crossLayerRgb → get_cross_layer_rgb_tile / get_cross_layer_pixel_rgb_tile
           ↓
Rust backend:
1. Open dataset from cached path
2. Calculate tile bounds (Web Mercator → Geographic)
3. Check if tile intersects dataset
4. For georeferenced: GDAL reproject to tile
   For non-geo: Convert synthetic coords to pixels
5. Apply stretch (min/max/gamma)
6. Encode as PNG
           ↓
Return PNG bytes to frontend
           ↓
MapLibre renders tile
```

## Key Components

### Frontend

#### MapManager (`map-manager.js`)
- Initializes MapLibre GL JS map
- Manages basemap layers (OSM, Satellite)
- Handles coordinate display (geographic or pixel)
- Provides layer/source management helpers

#### LayerManager (`layer-manager.js`)
- Maintains layer state (visibility, opacity, stretch params)
- Registers custom tile protocols with MapLibre
- Handles display modes (grayscale, RGB, cross-layer RGB)
- Manages layer panel UI and dynamic controls
- Coordinates tile requests to backend

#### UI (`ui.js`)
- File open dialog integration
- Keyboard shortcut handling
- Help overlay

### Backend

#### DatasetCache (`dataset_cache.rs`)
- LRU cache storing dataset file paths
- Thread-safe access via Mutex
- Datasets opened fresh per request (GDAL thread safety)

#### TileExtractor (`tile_extractor.rs`)
- `tile_to_web_mercator_bounds()` - Convert z/x/y to EPSG:3857
- `tile_to_geo_bounds()` - Convert z/x/y to EPSG:4326
- `extract_raw_tile()` - GDAL reproject for georeferenced data
- `extract_raw_pixel_tile()` - Direct pixel read for non-geo
- `apply_stretch()` - Min/max/gamma transformation
- `encode_png()` - Image encoding

#### Raster Commands (`raster.rs`)
- `open_raster` - Open dataset, return metadata
- `get_tile` - Auto-stretched grayscale tile
- `get_tile_stretched` - Custom stretch grayscale
- `get_rgb_tile` - RGB composite from single dataset
- `get_cross_layer_rgb_tile` - RGB from multiple datasets
- `get_pixel_tile` - Non-georeferenced grayscale
- `get_cross_layer_pixel_rgb_tile` - Non-geo cross-layer RGB
- `get_raster_stats` - Band statistics
- `close_dataset` - Remove from cache

## Coordinate Systems

### Georeferenced Images
- Stored in native CRS (e.g., UTM, geographic)
- Transformed to EPSG:4326 for bounds
- Tiles extracted in EPSG:3857 (Web Mercator) via GDAL warp

### Non-Georeferenced Images
- Use synthetic geographic coordinates
- Scale: 0.01° per pixel
- Centered at (0, 0)
- Height clamped to ±85° (Web Mercator limits)
- All non-geo images share same coordinate space (stack at center)

## Performance Considerations

1. **Dataset Caching** - Paths cached, datasets opened per-request
2. **Tile Caching** - MapLibre handles tile caching automatically
3. **Overview Selection** - GDAL automatically uses overviews when available
4. **Decimation Reading** - RasterIO resamples to tile size
5. **PNG Encoding** - Efficient image crate encoding

## Future Enhancements

- Vector layer support (OGR → GeoJSON → MapLibre)
- Histogram display
- Band math (NDVI, etc.)
- Measurement tools
- Export/screenshot
- Tile caching in backend
