# Geo Viewer

A lightweight, fast geospatial raster viewer built with Tauri, Rust, and MapLibre GL. Designed as a modern replacement for OpenEV.

## Features

- **Fast raster viewing** - GDAL-powered tile extraction with automatic reprojection
- **Multi-layer support** - Load multiple rasters, drag to reorder
- **Dynamic adjustment** - Real-time min/max/gamma controls per band
- **RGB compositing** - Combine bands from single or multiple files
- **Basemaps** - OpenStreetMap, Satellite imagery, or none
- **Non-georeferenced images** - View regular images with pixel coordinates
- **Keyboard-driven** - Full keyboard shortcuts for power users

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+O` | Open file(s) |
| `F` | Fit to extent |
| `R` | Reset rotation |
| `B` | Cycle basemap (OSM → Satellite → None) |
| `L` | Toggle layer panel |
| `V` | Toggle selected layer visibility |
| `Del` | Remove selected layer |
| `?` | Show keyboard shortcuts |
| `Ctrl+Drag` | Rotate map |
| `Scroll` | Zoom in/out |

## Supported Formats

Any raster format supported by GDAL, including:
- GeoTIFF (.tif, .tiff)
- JPEG2000 (.jp2, .j2k)
- PNG, JPEG, GIF, BMP
- ERDAS Imagine (.img)
- ENVI (.hdr, .bil, .bsq)
- NetCDF (.nc)
- HDF5 (.h5, .hdf)
- VRT (.vrt)
- And many more...

## Installation

### Prerequisites

- **Rust** (1.70+): https://rustup.rs/
- **Node.js** (18+): https://nodejs.org/
- **GDAL** (3.0+):
  - macOS: `brew install gdal`
  - Ubuntu: `sudo apt install libgdal-dev`
  - Windows: OSGeo4W or GISInternals

### Build from Source

```bash
# Clone the repository
git clone https://github.com/yourusername/geo-viewer.git
cd geo-viewer

# Install dependencies
npm install

# Run in development mode
npm run tauri dev

# Build for production
npm run tauri build
```

## Usage

1. **Open files**: Click "Open" or press `Ctrl+O`
2. **Navigate**: Pan with mouse drag, zoom with scroll wheel
3. **Adjust display**: Use the controls panel to adjust min/max/gamma
4. **RGB composite**: Select "RGB Composite" or "Cross-Layer RGB" mode
5. **Layer management**: Toggle visibility, adjust opacity, reorder by dragging

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for technical details.

## Tech Stack

- **Frontend**: Vanilla JavaScript + MapLibre GL JS
- **Backend**: Rust + GDAL
- **Framework**: Tauri 2.0
- **Rendering**: WebGL via MapLibre

## License

MIT

## Acknowledgments

Inspired by OpenEV, the lightweight geospatial viewer that set the standard for fast raster viewing.
