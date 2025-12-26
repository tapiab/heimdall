# Changelog

All notable changes to Heimdall will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- SECURITY.md with vulnerability reporting policy
- NOTICE file for third-party attributions (Apache 2.0 compliance)
- GitHub issue templates (bug reports, feature requests)
- GitHub pull request template with contribution checklist
- Structured logging with `tracing` crate

### Changed
- Pinned GDAL dependency to specific commit for reproducible builds
- Improved documentation for unsafe Send/Sync implementations
- Replaced debug print statements with proper tracing macros

### Security
- Enabled Content Security Policy (CSP) in Tauri configuration
- Added security contact and vulnerability reporting process

## [0.2.0] - 2025

### Added
- STAC (SpatioTemporal Asset Catalog) API browser
- Connect to STAC APIs (Earth Search, Planetary Computer, custom)
- Search imagery by collection, date range, cloud cover, and bounding box
- Load Cloud Optimized GeoTIFFs (COGs) directly from STAC assets
- Draw bounding box for spatial search filtering
- Display search result footprints on map

### Changed
- Improved linting and test infrastructure

## [0.1.0] - 2025

### Added
- Initial release
- Map visualization with MapLibre GL
- Layer management (raster and vector)
- Measurement tools
- Inspect tool for feature attributes
- Export functionality
- Elevation profile tool
- Annotation support
- Project save/load
