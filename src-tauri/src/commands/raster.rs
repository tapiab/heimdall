#![allow(clippy::too_many_arguments)]

use crate::gdal::analysis::{self, RegionStatistics};
use crate::gdal::dataset_cache::DatasetCache;
use crate::gdal::georef::{self, GeorefMethod};
use crate::gdal::image_stats::{self, ImageStatistics, Percentiles};
use crate::gdal::tile_extractor::{extract_raw_pixel_tile, extract_raw_tile, TileRequest};
use crate::gdal::{online_dem, overview};
use gdal::spatial_ref::{CoordTransform, SpatialRef};
use gdal::Dataset;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, State};

static FIRST_TILE_LOGGED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Serialize, Deserialize)]
pub struct RasterMetadata {
    pub id: String,
    pub path: String,
    pub width: usize,
    pub height: usize,
    pub bands: usize,
    pub bounds: [f64; 4], // [minx, miny, maxx, maxy] in EPSG:4326 or pixel coords
    pub native_bounds: [f64; 4], // bounds in native CRS
    pub projection: String,
    pub pixel_size: [f64; 2],
    pub nodata: Option<f64>,
    pub band_stats: Vec<BandStats>, // Stats for each band
    pub is_georeferenced: bool,     // true if image has valid geotransform/projection or RPC
    #[serde(default)]
    pub georef_method: GeorefMethod, // how pixels are placed on the map
    #[serde(default)]
    pub rpc_default_height: Option<f64>, // RPC HEIGHT_OFF, used when no DEM/override is set
    #[serde(default)]
    pub suggest_overviews: bool, // large local raster without overviews: offer to build them
}

#[derive(Clone, Serialize, Deserialize)]
pub struct BandStats {
    pub band: usize,
    pub min: f64,
    pub max: f64,
    pub mean: f64,
    pub std_dev: f64,
    /// Bits used by unsigned integer samples (NBITS metadata, else the data
    /// type size); `None` for signed and floating-point bands.
    #[serde(default)]
    pub significant_bits: Option<u32>,
}

/// Bits used by an unsigned integer band, from NBITS (e.g. 12 or 14-bit data
/// in 16-bit containers) or the data type size.
pub(crate) fn significant_bits(band: &gdal::raster::RasterBand) -> Option<u32> {
    use gdal::Metadata;
    let band_type = band.band_type();
    if !band_type.is_integer() || band_type.is_signed() {
        return None;
    }
    let type_bits = u32::from(band_type.bits());
    let nbits = band
        .metadata_item("NBITS", "IMAGE_STRUCTURE")
        .and_then(|v| v.trim().parse::<u32>().ok())
        .filter(|&n| n > 0 && n <= type_bits);
    Some(nbits.unwrap_or(type_bits))
}

#[derive(Clone, Serialize, Deserialize)]
pub struct HistogramData {
    pub band: usize,
    pub min: f64,
    pub max: f64,
    pub bin_count: usize,
    pub counts: Vec<u64>,
    pub bin_edges: Vec<f64>,
    /// Percentiles of the same sample, for stretch presets
    pub percentiles: Option<Percentiles>,
}

/// Compute histogram bins from raw pixel values
/// Returns (counts, bin_edges)
pub fn compute_histogram_bins(
    values: &[f64],
    min: f64,
    max: f64,
    bin_count: usize,
    nodata: Option<f64>,
) -> (Vec<u64>, Vec<f64>) {
    let mut counts = vec![0u64; bin_count];
    let range = max - min;

    if range > 0.0 {
        for &value in values {
            // Skip nodata values
            if let Some(nd) = nodata {
                if (value - nd).abs() < 1e-10 {
                    continue;
                }
            }

            if value >= min && value <= max {
                let bin_idx = ((value - min) / range * (bin_count - 1) as f64).floor() as usize;
                let bin_idx = bin_idx.min(bin_count - 1);
                counts[bin_idx] += 1;
            }
        }
    } else {
        // All values are the same - count non-nodata values
        let valid_count = if let Some(nd) = nodata {
            values.iter().filter(|&&v| (v - nd).abs() >= 1e-10).count()
        } else {
            values.len()
        };
        counts[0] = valid_count as u64;
    }

    // Compute bin edges
    let bin_width = range / bin_count as f64;
    let bin_edges: Vec<f64> = (0..=bin_count)
        .map(|i| min + i as f64 * bin_width)
        .collect();

    (counts, bin_edges)
}

/// Calculate bounds in native CRS.
///
/// Uses the full affine geotransform including shear terms (gt[2], gt[4]) so
/// that rotated rasters yield a bbox covering all four actual corners. Earlier
/// versions used only gt[0]/gt[1]/gt[3]/gt[5], which clipped a triangle off
/// rotated UTM orthos.
fn calculate_native_bounds(dataset: &Dataset) -> Result<[f64; 4], String> {
    let gt = dataset
        .geo_transform()
        .map_err(|e| format!("Failed to get geotransform: {}", e))?;

    let (width, height) = dataset.raster_size();
    let (w, h) = (width as f64, height as f64);

    // World coordinates of the four pixel corners.
    let corners = [
        (gt[0], gt[3]),
        (gt[0] + w * gt[1], gt[3] + w * gt[4]),
        (gt[0] + h * gt[2], gt[3] + h * gt[5]),
        (gt[0] + w * gt[1] + h * gt[2], gt[3] + w * gt[4] + h * gt[5]),
    ];

    let mut min_x = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for (x, y) in corners {
        if x < min_x {
            min_x = x;
        }
        if x > max_x {
            max_x = x;
        }
        if y < min_y {
            min_y = y;
        }
        if y > max_y {
            max_y = y;
        }
    }

    Ok([min_x, min_y, max_x, max_y])
}

/// Transform bounds from native CRS to EPSG:4326
fn transform_bounds_to_4326(
    dataset: &Dataset,
    native_bounds: [f64; 4],
) -> Result<[f64; 4], String> {
    let projection = dataset.projection();

    // If no projection or already in geographic CRS, assume it's lat/lon
    if projection.is_empty() {
        return Ok(native_bounds);
    }

    let source_srs = SpatialRef::from_wkt(&projection)
        .map_err(|e| format!("Failed to parse source SRS: {}", e))?;

    // Check if already geographic (lat/lon)
    if source_srs.is_geographic() {
        return Ok(native_bounds);
    }

    let mut target_srs = SpatialRef::from_epsg(4326)
        .map_err(|e| format!("Failed to create EPSG:4326 SRS: {}", e))?;

    // Force traditional GIS axis order (lon, lat) instead of authority-compliant (lat, lon)
    target_srs
        .set_axis_mapping_strategy(gdal::spatial_ref::AxisMappingStrategy::TraditionalGisOrder);

    let transform = CoordTransform::new(&source_srs, &target_srs)
        .map_err(|e| format!("Failed to create coordinate transform: {}", e))?;

    // Transform corners (x=easting, y=northing in UTM)
    let mut xs = vec![
        native_bounds[0],
        native_bounds[2],
        native_bounds[0],
        native_bounds[2],
    ];
    let mut ys = vec![
        native_bounds[1],
        native_bounds[1],
        native_bounds[3],
        native_bounds[3],
    ];

    transform
        .transform_coords(&mut xs, &mut ys, &mut [])
        .map_err(|e| format!("Failed to transform coordinates: {}", e))?;

    // After transform with TraditionalGisOrder: xs = longitudes, ys = latitudes
    let min_lon = xs.iter().cloned().fold(f64::INFINITY, f64::min);
    let max_lon = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let min_lat = ys.iter().cloned().fold(f64::INFINITY, f64::min);
    let max_lat = ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max);

    // Return as [minLon, minLat, maxLon, maxLat] for MapLibre
    Ok([min_lon, min_lat, max_lon, max_lat])
}

/// Compute statistics for all bands
fn compute_band_stats(dataset: &Dataset) -> Vec<BandStats> {
    let band_count = dataset.raster_count();
    let mut stats = Vec::new();

    for i in 1..=band_count {
        if let Ok(band) = dataset.rasterband(i) {
            if let Ok(min_max) = band.compute_raster_min_max(true) {
                let mean = (min_max.min + min_max.max) / 2.0;
                let std_dev = (min_max.max - min_max.min) / 4.0;
                stats.push(BandStats {
                    band: i,
                    min: min_max.min,
                    max: min_max.max,
                    mean,
                    std_dev,
                    significant_bits: significant_bits(&band),
                });
            }
        }
    }

    stats
}

/// Open a raster file and return metadata
#[tauri::command]
pub async fn open_raster(
    path: String,
    state: State<'_, DatasetCache>,
) -> Result<RasterMetadata, String> {
    let dataset = Dataset::open(&path).map_err(|e| format!("Failed to open raster: {}", e))?;

    let (width, height) = dataset.raster_size();
    let bands = dataset.raster_count();
    let method = georef::georef_method(&dataset);
    let georeferenced = method != GeorefMethod::None;

    let (bounds, native_bounds, pixel_size) = if method == GeorefMethod::Rpc {
        // RPC footprint is already lon/lat; pixel size is an approximate GSD in degrees.
        let bounds = georef::rpc_geo_bounds(&dataset)?;
        let pixel_size = [
            (bounds[2] - bounds[0]) / width as f64,
            (bounds[3] - bounds[1]) / height as f64,
        ];
        (bounds, bounds, pixel_size)
    } else if georeferenced {
        let native_bounds = calculate_native_bounds(&dataset)?;
        let bounds = transform_bounds_to_4326(&dataset, native_bounds)?;
        let gt = dataset
            .geo_transform()
            .map_err(|e| format!("Failed to get geotransform: {}", e))?;
        (bounds, native_bounds, [gt[1].abs(), gt[5].abs()])
    } else {
        // Non-georeferenced: use pixel coordinates
        let pixel_bounds = [0.0, 0.0, width as f64, height as f64];
        (pixel_bounds, pixel_bounds, [1.0, 1.0])
    };

    let projection = dataset.projection();

    let nodata = dataset.rasterband(1).ok().and_then(|b| b.no_data_value());

    // Compute stats for all bands
    let band_stats = compute_band_stats(&dataset);

    let id = uuid::Uuid::new_v4().to_string();

    let metadata = RasterMetadata {
        id: id.clone(),
        path: path.clone(),
        width,
        height,
        bands,
        bounds,
        native_bounds,
        projection,
        pixel_size,
        nodata,
        band_stats,
        is_georeferenced: georeferenced,
        georef_method: method,
        rpc_default_height: georef::rpc_default_height(&dataset),
        suggest_overviews: overview::should_suggest_overviews(&dataset, &path),
    };

    state.add(id, path, dataset);

    Ok(metadata)
}

/// Set the terrain used to project an RPC raster: a DEM file, a constant
/// height override, or neither (back to the model's HEIGHT_OFF). Returns the
/// recomputed EPSG:4326 footprint, which moves with the terrain.
#[tauri::command]
pub async fn set_rpc_elevation(
    id: String,
    dem_path: Option<String>,
    height: Option<f64>,
    dem_height_offset: Option<f64>,
    state: State<'_, DatasetCache>,
) -> Result<[f64; 4], String> {
    let pool = state.get_pool(&id).ok_or("Dataset not found")?;
    tokio::task::spawn_blocking(move || {
        if height
            .into_iter()
            .chain(dem_height_offset)
            .any(|h| !h.is_finite())
        {
            return Err("Heights must be finite numbers".to_string());
        }
        let dem_path = dem_path.filter(|p| !p.trim().is_empty());
        if let Some(dem) = &dem_path {
            let dem_ds = Dataset::open(dem).map_err(|e| format!("Failed to open DEM: {}", e))?;
            if !georef::has_geotransform(&dem_ds) {
                return Err("DEM has no georeferencing".to_string());
            }
        }

        let guard = pool.checkout();
        if georef::georef_method(&guard.0) != GeorefMethod::Rpc {
            return Err("Layer is not projected with RPC".to_string());
        }

        let path = pool.path().to_string();
        let previous = georef::get_rpc_elevation(&path);
        georef::set_rpc_elevation(
            &path,
            georef::RpcElevation {
                dem_path,
                height,
                dem_height_offset,
            },
        );
        georef::rpc_geo_bounds(&guard.0).inspect_err(|_| {
            georef::set_rpc_elevation(&path, previous);
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Online DEM applied to an RPC layer.
#[derive(Clone, Serialize)]
pub struct OnlineDem {
    /// Local VRT mosaicking the remote tiles; pass back as `dem_path`.
    pub dem_path: String,
    /// Geoid undulation added to DEM heights; `None` if it couldn't be looked
    /// up (offline PROJ grid), leaving heights ~tens of meters low/high.
    pub dem_height_offset: Option<f64>,
    /// EPSG:4326 footprint with the DEM applied.
    pub bounds: [f64; 4],
}

/// Project an RPC layer against Copernicus GLO-30, fetched on demand. Keeps the
/// layer's constant height (if any) as the fill outside DEM coverage.
#[tauri::command]
pub async fn use_online_dem(
    id: String,
    height: Option<f64>,
    state: State<'_, DatasetCache>,
) -> Result<OnlineDem, String> {
    let pool = state.get_pool(&id).ok_or("Dataset not found")?;
    tokio::task::spawn_blocking(move || {
        let path = pool.path().to_string();
        let guard = pool.checkout();
        if georef::georef_method(&guard.0) != GeorefMethod::Rpc {
            return Err("Layer is not projected with RPC".to_string());
        }

        // Footprint at the model's mean height: good enough to pick DEM tiles.
        let previous = georef::get_rpc_elevation(&path);
        georef::set_rpc_elevation(&path, georef::RpcElevation::default());
        let flat = georef::rpc_geo_bounds(&guard.0);
        georef::set_rpc_elevation(&path, previous.clone());
        let flat = flat?;

        let dem_path = online_dem::copernicus_vrt_for(flat)?;
        let center = ((flat[0] + flat[2]) / 2.0, (flat[1] + flat[3]) / 2.0);
        let dem_height_offset = online_dem::egm2008_undulation(center.0, center.1)
            .inspect_err(|e| eprintln!("[RPC] {}; DEM heights left geoid-relative", e))
            .ok();

        georef::set_rpc_elevation(
            &path,
            georef::RpcElevation {
                dem_path: Some(dem_path.clone()),
                height,
                dem_height_offset,
            },
        );
        match georef::rpc_geo_bounds(&guard.0) {
            Ok(bounds) => Ok(OnlineDem {
                dem_path,
                dem_height_offset,
                bounds,
            }),
            Err(e) => {
                georef::set_rpc_elevation(&path, previous);
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Clone, Serialize)]
struct OverviewProgress {
    id: String,
    progress: f64,
}

/// Build external overviews (`.ovr` next to the file) for a raster layer, then
/// reopen its handles so tiles start reading them. Emits `overview-progress`.
#[tauri::command]
pub async fn build_overviews(
    id: String,
    app: AppHandle,
    state: State<'_, DatasetCache>,
) -> Result<(), String> {
    let path = state.get_path(&id).ok_or("Dataset not found")?;
    let event_id = id.clone();
    tokio::task::spawn_blocking(move || {
        let mut last = -1.0;
        overview::build_external_overviews(&path, |progress| {
            // GDAL reports per block; ~100 events is plenty for a progress bar.
            if progress - last >= 0.01 || progress >= 1.0 {
                last = progress;
                let _ = app.emit(
                    "overview-progress",
                    OverviewProgress {
                        id: event_id.clone(),
                        progress,
                    },
                );
            }
        })
    })
    .await
    .map_err(|e| e.to_string())??;
    state.reopen(&id)
}

/// Get raw samples for one tile, for the frontend to stretch and colorize.
///
/// The body is little-endian `f32`, band-sequential, 256×256 per band, with
/// `NaN` for nodata and pixels outside the raster. An empty body means the
/// tile misses the raster. `pixel` selects the synthetic pixel coordinates used
/// for non-georeferenced images.
#[tauri::command]
pub async fn get_raw_tile(
    id: String,
    x: i32,
    y: i32,
    z: u8,
    bands: Vec<i32>,
    pixel: bool,
    state: State<'_, DatasetCache>,
) -> Result<Response, String> {
    if bands.is_empty() {
        return Err("No bands requested".to_string());
    }
    if !FIRST_TILE_LOGGED.swap(true, Ordering::Relaxed) {
        let path = state.get_path(&id).unwrap_or_default();
        println!(
            "[TILE] First tile request: z={} x={} y={} bands={:?} path={}",
            z, x, y, bands, path
        );
    }
    let pool = state.get_pool(&id).ok_or("Dataset not found")?;
    let bytes = tokio::task::spawn_blocking(move || {
        let guard = pool.checkout();
        let request = TileRequest {
            x,
            y,
            z,
            tile_size: 256,
        };
        let samples = if pixel {
            extract_raw_pixel_tile(&guard.0, &request, &bands)?
        } else {
            extract_raw_tile(&guard.0, &request, &bands)?
        };
        Ok::<_, String>(
            samples
                .map(|s| s.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>())
                .unwrap_or_default(),
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(Response::new(bytes))
}

/// Get statistics for a band
#[tauri::command]
pub async fn get_raster_stats(
    id: String,
    band: i32,
    state: State<'_, DatasetCache>,
) -> Result<BandStats, String> {
    let ds_pool = state.get_pool(&id).ok_or("Dataset not found")?;
    let ds_guard = ds_pool.checkout();
    let dataset = &ds_guard.0;

    let rasterband = dataset
        .rasterband(band as usize)
        .map_err(|e| format!("Failed to get band {}: {}", band, e))?;

    // Try to get pre-computed statistics, otherwise compute them
    let stats = rasterband
        .compute_raster_min_max(true)
        .map_err(|e| format!("Failed to compute statistics: {}", e))?;

    let min = stats.min;
    let max = stats.max;
    // Estimate mean and std_dev from min/max
    let mean = (min + max) / 2.0;
    let std_dev = (max - min) / 4.0;

    Ok(BandStats {
        band: band as usize,
        min,
        max,
        mean,
        std_dev,
        significant_bits: significant_bits(&rasterband),
    })
}

/// Get histogram for a band
#[tauri::command]
pub async fn get_histogram(
    id: String,
    band: i32,
    num_bins: Option<usize>,
    state: State<'_, DatasetCache>,
) -> Result<HistogramData, String> {
    use gdal::raster::ResampleAlg;

    let ds_pool = state.get_pool(&id).ok_or("Dataset not found")?;
    // Blocking GDAL read: keep it off the async runtime (runs on every layer open)
    tokio::task::spawn_blocking(move || {
        let ds_guard = ds_pool.checkout();
        let dataset = &ds_guard.0;

        let rasterband = dataset
            .rasterband(band as usize)
            .map_err(|e| format!("Failed to get band {}: {}", band, e))?;

        // Get band statistics for range
        let stats = rasterband
            .compute_raster_min_max(true)
            .map_err(|e| format!("Failed to compute statistics: {}", e))?;

        let min = stats.min;
        let max = stats.max;
        let bin_count = num_bins.unwrap_or(256);

        // For large rasters, use decimation to sample
        let (width, height) = dataset.raster_size();
        let max_sample_size = 1024;

        let (read_width, read_height) = if width > max_sample_size || height > max_sample_size {
            let scale = (max_sample_size as f64 / width.max(height) as f64).min(1.0);
            (
                (width as f64 * scale) as usize,
                (height as f64 * scale) as usize,
            )
        } else {
            (width, height)
        };

        // Read band data with resampling if needed
        let nodata = rasterband.no_data_value();

        let buffer = rasterband
            .read_as::<f64>(
                (0, 0),
                (width, height),
                (read_width, read_height),
                Some(ResampleAlg::NearestNeighbour),
            )
            .map_err(|e| format!("Failed to read band data: {}", e))?;

        // Compute histogram bins using extracted function
        let (counts, bin_edges) =
            compute_histogram_bins(buffer.data(), min, max, bin_count, nodata);
        let percentiles = image_stats::percentiles(buffer.data(), nodata);

        Ok(HistogramData {
            band: band as usize,
            min,
            max,
            bin_count,
            counts,
            bin_edges,
            percentiles,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Whole-band statistics at full resolution: summary plus per-column and
/// per-line median, mean and sigma. Reads the entire band, so it takes about
/// a second per 100 Mpx; run on demand only.
#[tauri::command]
pub async fn get_image_statistics(
    id: String,
    band: i32,
    state: State<'_, DatasetCache>,
) -> Result<ImageStatistics, String> {
    let pool = state.get_pool(&id).ok_or("Dataset not found")?;
    tokio::task::spawn_blocking(move || {
        let guard = pool.checkout();
        let rasterband = guard
            .0
            .rasterband(band as usize)
            .map_err(|e| format!("Failed to get band {}: {}", band, e))?;
        image_stats::compute_image_statistics(&rasterband, band as usize)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Close a dataset and remove from cache
#[tauri::command]
pub async fn close_dataset(id: String, state: State<'_, DatasetCache>) -> Result<(), String> {
    if let Some(path) = state.remove(&id) {
        // Elevation settings are keyed by path; drop them with the last layer
        // so reopening the file starts from the model's default height.
        if !state.has_path(&path) {
            georef::set_rpc_elevation(&path, georef::RpcElevation::default());
        }
    }
    Ok(())
}

/// Pixel value query result
#[derive(Clone, Serialize, Deserialize)]
pub struct PixelValueResult {
    pub x: i32,
    pub y: i32,
    pub values: Vec<PixelBandValue>,
    pub is_valid: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PixelBandValue {
    pub band: usize,
    pub value: f64,
    pub is_nodata: bool,
}

/// Map lon/lat points (EPSG:4326) to fractional pixel/line positions, through
/// the RPC model or the geotransform (reprojecting into the native CRS first).
fn lonlat_to_pixels(dataset: &Dataset, coords: &[[f64; 2]]) -> Result<Vec<(f64, f64)>, String> {
    let mut xs: Vec<f64> = coords.iter().map(|c| c[0]).collect();
    let mut ys: Vec<f64> = coords.iter().map(|c| c[1]).collect();

    if georef::georef_method(dataset) == GeorefMethod::Rpc {
        georef::rpc_lonlat_to_pixel(dataset, &mut xs, &mut ys)?;
        return Ok(xs.into_iter().zip(ys).collect());
    }

    let gt = dataset
        .geo_transform()
        .map_err(|e| format!("Failed to get geotransform: {}", e))?;

    let projection = dataset.projection();
    if !projection.is_empty() {
        let mut source_srs = SpatialRef::from_epsg(4326)
            .map_err(|e| format!("Failed to create EPSG:4326 SRS: {}", e))?;
        let mut target_srs = SpatialRef::from_wkt(&projection)
            .map_err(|e| format!("Failed to parse target SRS: {}", e))?;

        if !target_srs.is_geographic() {
            // Traditional GIS order (lng, lat), not (lat, lng)
            source_srs.set_axis_mapping_strategy(
                gdal::spatial_ref::AxisMappingStrategy::TraditionalGisOrder,
            );
            target_srs.set_axis_mapping_strategy(
                gdal::spatial_ref::AxisMappingStrategy::TraditionalGisOrder,
            );
            let transform = CoordTransform::new(&source_srs, &target_srs)
                .map_err(|e| format!("Failed to create coordinate transform: {}", e))?;
            transform
                .transform_coords(&mut xs, &mut ys, &mut [])
                .map_err(|e| format!("Failed to transform coordinates: {}", e))?;
        }
    }

    // Inverse geotransform, including rotation terms
    let det = gt[1] * gt[5] - gt[2] * gt[4];
    if det == 0.0 {
        return Err("Geotransform is not invertible".to_string());
    }
    Ok(xs
        .into_iter()
        .zip(ys)
        .map(|(x, y)| {
            let (dx, dy) = (x - gt[0], y - gt[3]);
            (
                (gt[5] * dx - gt[2] * dy) / det,
                (gt[1] * dy - gt[4] * dx) / det,
            )
        })
        .collect())
}

/// Map a lon/lat (EPSG:4326) point to integer pixel/line through the dataset's
/// geotransform, reprojecting into its native CRS first when needed.
fn geo_to_pixel(dataset: &Dataset, lng: f64, lat: f64) -> Result<(i32, i32), String> {
    let (x, y) = lonlat_to_pixels(dataset, &[[lng, lat]])?[0];
    Ok((x.floor() as i32, y.floor() as i32))
}

/// Values of every band along a polyline
#[derive(Serialize)]
pub struct BandProfile {
    /// "m" along georeferenced lines, "px" for pixel coordinates
    pub unit: &'static str,
    pub total_distance: f64,
    pub distance: Vec<f64>,
    /// Full-resolution pixel of each sample
    pub x: Vec<i64>,
    pub y: Vec<i64>,
    /// `values[band][sample]`, null outside the raster or for nodata
    pub values: Vec<Vec<Option<f64>>>,
}

/// Profile of every band along a polyline, about one sample per pixel (at
/// most `analysis::MAX_PROFILE_SAMPLES`). `coords` are lon/lat, or pixel/line
/// positions when `pixel` is set.
#[tauri::command]
pub async fn get_band_profile(
    id: String,
    coords: Vec<[f64; 2]>,
    pixel: bool,
    state: State<'_, DatasetCache>,
) -> Result<BandProfile, String> {
    let pool = state.get_pool(&id).ok_or("Dataset not found")?;
    tokio::task::spawn_blocking(move || {
        let guard = pool.checkout();
        let dataset = &guard.0;
        let vertices = if pixel {
            coords.iter().map(|c| (c[0], c[1])).collect()
        } else {
            lonlat_to_pixels(dataset, &coords)?
        };
        let samples = analysis::sample_polyline(&vertices, analysis::MAX_PROFILE_SAMPLES)?;

        // Ground distance per segment, spread linearly along each segment
        let (unit, distance, total_distance) = if pixel {
            let distance: Vec<f64> = samples.iter().map(|s| s.along).collect();
            let total = distance.last().copied().unwrap_or(0.0);
            ("px", distance, total)
        } else {
            let segment_m: Vec<f64> = coords
                .windows(2)
                .map(|w| haversine_distance(w[0][0], w[0][1], w[1][0], w[1][1]))
                .collect();
            let start_m: Vec<f64> = segment_m
                .iter()
                .scan(0.0, |acc, d| {
                    let start = *acc;
                    *acc += d;
                    Some(start)
                })
                .collect();
            let distance = samples
                .iter()
                .map(|s| start_m[s.segment] + segment_m[s.segment] * s.fraction)
                .collect();
            ("m", distance, segment_m.iter().sum())
        };

        let pixels: Vec<(i64, i64)> = samples
            .iter()
            .map(|s| (s.x.floor() as i64, s.y.floor() as i64))
            .collect();
        let values = analysis::read_band_values(dataset, &pixels)?;
        Ok(BandProfile {
            unit,
            total_distance,
            distance,
            x: pixels.iter().map(|p| p.0).collect(),
            y: pixels.iter().map(|p| p.1).collect(),
            values,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Per-band statistics over the pixel bounding box of `coords` (lon/lat, or
/// pixel/line positions when `pixel` is set). On rotated or RPC rasters the
/// box encloses the drawn shape rather than matching it.
#[tauri::command]
pub async fn get_region_statistics(
    id: String,
    coords: Vec<[f64; 2]>,
    pixel: bool,
    state: State<'_, DatasetCache>,
) -> Result<RegionStatistics, String> {
    let pool = state.get_pool(&id).ok_or("Dataset not found")?;
    tokio::task::spawn_blocking(move || {
        let guard = pool.checkout();
        let dataset = &guard.0;
        let corners = if pixel {
            coords.iter().map(|c| (c[0], c[1])).collect()
        } else {
            lonlat_to_pixels(dataset, &coords)?
        };
        if corners.len() < 2 {
            return Err("A region needs at least 2 corners".to_string());
        }
        let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for (x, y) in corners {
            (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x), y1.max(y));
        }
        analysis::region_statistics(dataset, x0, y0, x1, y1)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Query pixel values at a specific geographic coordinate
#[tauri::command]
pub async fn query_pixel_value(
    id: String,
    lng: f64,
    lat: f64,
    state: State<'_, DatasetCache>,
) -> Result<PixelValueResult, String> {
    let ds_pool = state.get_pool(&id).ok_or("Dataset not found")?;
    let ds_guard = ds_pool.checkout();
    let dataset = &ds_guard.0;

    let (width, height) = dataset.raster_size();

    let (pixel_x, pixel_y) = if georef::georef_method(dataset) == GeorefMethod::Rpc {
        let (mut xs, mut ys) = ([lng], [lat]);
        georef::rpc_lonlat_to_pixel(dataset, &mut xs, &mut ys)?;
        (xs[0].floor() as i32, ys[0].floor() as i32)
    } else {
        geo_to_pixel(dataset, lng, lat)?
    };

    // Check if pixel is within bounds
    if pixel_x < 0 || pixel_x >= width as i32 || pixel_y < 0 || pixel_y >= height as i32 {
        return Ok(PixelValueResult {
            x: pixel_x,
            y: pixel_y,
            values: vec![],
            is_valid: false,
        });
    }

    // Read values from all bands at this pixel
    let band_count = dataset.raster_count();
    let mut values = Vec::new();

    for band_idx in 1..=band_count {
        let band = dataset
            .rasterband(band_idx)
            .map_err(|e| format!("Failed to get band {}: {}", band_idx, e))?;

        let nodata = band.no_data_value();

        // Read single pixel
        let buffer = band
            .read_as::<f64>((pixel_x as isize, pixel_y as isize), (1, 1), (1, 1), None)
            .map_err(|e| format!("Failed to read pixel value: {}", e))?;

        let value = buffer.data()[0];
        let is_nodata = nodata.is_some_and(|nd| (value - nd).abs() < 1e-10);

        values.push(PixelBandValue {
            band: band_idx,
            value,
            is_nodata,
        });
    }

    Ok(PixelValueResult {
        x: pixel_x,
        y: pixel_y,
        values,
        is_valid: true,
    })
}

/// Haversine distance in meters
fn haversine_distance(lng1: f64, lat1: f64, lng2: f64, lat2: f64) -> f64 {
    let r = 6371000.0; // Earth radius in meters
    let lat1_rad = lat1.to_radians();
    let lat2_rad = lat2.to_radians();
    let delta_lat = (lat2 - lat1).to_radians();
    let delta_lng = (lng2 - lng1).to_radians();

    let a = (delta_lat / 2.0).sin().powi(2)
        + lat1_rad.cos() * lat2_rad.cos() * (delta_lng / 2.0).sin().powi(2);
    let c = 2.0 * a.sqrt().atan2((1.0 - a).sqrt());

    r * c
}

/// Query pixel values at pixel coordinates (for non-georeferenced images)
#[tauri::command]
pub async fn query_pixel_value_at_pixel(
    id: String,
    pixel_x: i32,
    pixel_y: i32,
    state: State<'_, DatasetCache>,
) -> Result<PixelValueResult, String> {
    let ds_pool = state.get_pool(&id).ok_or("Dataset not found")?;
    let ds_guard = ds_pool.checkout();
    let dataset = &ds_guard.0;

    let (width, height) = dataset.raster_size();

    // Check if pixel is within bounds
    if pixel_x < 0 || pixel_x >= width as i32 || pixel_y < 0 || pixel_y >= height as i32 {
        return Ok(PixelValueResult {
            x: pixel_x,
            y: pixel_y,
            values: vec![],
            is_valid: false,
        });
    }

    // Read values from all bands at this pixel
    let band_count = dataset.raster_count();
    let mut values = Vec::new();

    for band_idx in 1..=band_count {
        let band = dataset
            .rasterband(band_idx)
            .map_err(|e| format!("Failed to get band {}: {}", band_idx, e))?;

        let nodata = band.no_data_value();

        // Read single pixel
        let buffer = band
            .read_as::<f64>((pixel_x as isize, pixel_y as isize), (1, 1), (1, 1), None)
            .map_err(|e| format!("Failed to read pixel value: {}", e))?;

        let value = buffer.data()[0];
        let is_nodata = nodata.is_some_and(|nd| (value - nd).abs() < 1e-10);

        values.push(PixelBandValue {
            band: band_idx,
            value,
            is_nodata,
        });
    }

    Ok(PixelValueResult {
        x: pixel_x,
        y: pixel_y,
        values,
        is_valid: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_histogram_bins_uniform_distribution() {
        let values: Vec<f64> = (0..100).map(|i| i as f64).collect();
        let (counts, bin_edges) = compute_histogram_bins(&values, 0.0, 99.0, 10, None);

        assert_eq!(counts.len(), 10);
        assert_eq!(bin_edges.len(), 11);

        // Each bin should have roughly 10 values
        let total: u64 = counts.iter().sum();
        assert_eq!(total, 100);

        // First bin edge should be min, last should be max
        assert!((bin_edges[0] - 0.0).abs() < 1e-10);
        assert!((bin_edges[10] - 99.0).abs() < 1e-10);
    }

    #[test]
    fn test_histogram_bins_all_same_value() {
        let values = vec![42.0; 100];
        let (counts, bin_edges) = compute_histogram_bins(&values, 42.0, 42.0, 10, None);

        // When range is 0, all values go in first bin
        assert_eq!(counts[0], 100);
        for i in 1..10 {
            assert_eq!(counts[i], 0);
        }

        // Bin edges should all be the same value
        for edge in &bin_edges {
            assert!((edge - 42.0).abs() < 1e-10);
        }
    }

    #[test]
    fn test_histogram_bins_with_nodata() {
        let values = vec![1.0, 2.0, -9999.0, 3.0, -9999.0, 4.0, 5.0];
        let (counts, _) = compute_histogram_bins(&values, 1.0, 5.0, 5, Some(-9999.0));

        // Should only count 5 valid values (skip 2 nodata)
        let total: u64 = counts.iter().sum();
        assert_eq!(total, 5);
    }

    #[test]
    fn test_histogram_bins_values_outside_range() {
        let values = vec![-10.0, 0.0, 5.0, 10.0, 100.0];
        let (counts, _) = compute_histogram_bins(&values, 0.0, 10.0, 10, None);

        // Only values 0, 5, 10 are within range
        let total: u64 = counts.iter().sum();
        assert_eq!(total, 3);
    }

    #[test]
    fn test_histogram_bins_single_value() {
        let values = vec![5.0];
        let (counts, _bin_edges) = compute_histogram_bins(&values, 0.0, 10.0, 10, None);

        let total: u64 = counts.iter().sum();
        assert_eq!(total, 1);

        // 5.0 should be in the middle bin (bin 4 or 5 depending on rounding)
        let non_zero_bins: Vec<_> = counts.iter().enumerate().filter(|(_, &c)| c > 0).collect();
        assert_eq!(non_zero_bins.len(), 1);
    }

    #[test]
    fn test_histogram_bins_min_max_edge_values() {
        let values = vec![0.0, 10.0];
        let (counts, _) = compute_histogram_bins(&values, 0.0, 10.0, 10, None);

        // Min value should be in first bin
        assert!(counts[0] > 0);
        // Max value should be in last bin
        assert!(counts[9] > 0);

        let total: u64 = counts.iter().sum();
        assert_eq!(total, 2);
    }

    #[test]
    fn test_histogram_bin_edges_count() {
        let values = vec![0.0, 5.0, 10.0];
        let (counts, bin_edges) = compute_histogram_bins(&values, 0.0, 10.0, 256, None);

        // Should have bin_count bins and bin_count + 1 edges
        assert_eq!(counts.len(), 256);
        assert_eq!(bin_edges.len(), 257);
    }

    #[test]
    fn test_histogram_empty_values() {
        let values: Vec<f64> = vec![];
        let (counts, _) = compute_histogram_bins(&values, 0.0, 10.0, 10, None);

        let total: u64 = counts.iter().sum();
        assert_eq!(total, 0);
    }

    #[test]
    fn test_histogram_all_nodata() {
        let values = vec![-9999.0; 10];
        let (counts, _) = compute_histogram_bins(&values, 0.0, 10.0, 10, Some(-9999.0));

        let total: u64 = counts.iter().sum();
        assert_eq!(total, 0);
    }
}
