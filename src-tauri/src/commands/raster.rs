#![allow(clippy::too_many_arguments)]

use crate::gdal::dataset_cache::DatasetCache;
use crate::gdal::georef::{self, GeorefMethod};
use crate::gdal::tile_extractor::{
    extract_rgb_tile, extract_tile, extract_tile_with_stretch, StretchParams, TileRequest,
};
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
}

#[derive(Clone, Serialize, Deserialize)]
pub struct HistogramData {
    pub band: usize,
    pub min: f64,
    pub max: f64,
    pub bin_count: usize,
    pub counts: Vec<u64>,
    pub bin_edges: Vec<f64>,
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

/// Get a tile from a raster dataset with auto stretch
#[tauri::command]
pub async fn get_tile(
    id: String,
    x: i32,
    y: i32,
    z: u8,
    band: Option<i32>,
    state: State<'_, DatasetCache>,
) -> Result<Response, String> {
    let pool = state.get_pool(&id).ok_or("Dataset not found")?;
    let bytes = tokio::task::spawn_blocking(move || {
        let guard = pool.checkout();
        let request = TileRequest {
            x,
            y,
            z,
            band: band.unwrap_or(1),
            tile_size: 256,
        };
        extract_tile(&guard.0, &request)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(Response::new(bytes))
}

/// Get a tile with custom stretch parameters
#[tauri::command]
pub async fn get_tile_stretched(
    id: String,
    x: i32,
    y: i32,
    z: u8,
    band: Option<i32>,
    min: f64,
    max: f64,
    gamma: f64,
    state: State<'_, DatasetCache>,
) -> Result<Response, String> {
    if !FIRST_TILE_LOGGED.swap(true, Ordering::Relaxed) {
        let path = state.get_path(&id).unwrap_or_default();
        println!(
            "[TILE] First tile request: z={} x={} y={} path={}",
            z, x, y, path
        );
    }
    let pool = state.get_pool(&id).ok_or("Dataset not found")?;
    let bytes = tokio::task::spawn_blocking(move || {
        let guard = pool.checkout();
        let request = TileRequest {
            x,
            y,
            z,
            band: band.unwrap_or(1),
            tile_size: 256,
        };
        extract_tile_with_stretch(&guard.0, &request, &StretchParams { min, max, gamma })
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(Response::new(bytes))
}

/// Get an RGB composite tile
#[tauri::command]
pub async fn get_rgb_tile(
    id: String,
    x: i32,
    y: i32,
    z: u8,
    red_band: i32,
    green_band: i32,
    blue_band: i32,
    red_min: f64,
    red_max: f64,
    red_gamma: f64,
    green_min: f64,
    green_max: f64,
    green_gamma: f64,
    blue_min: f64,
    blue_max: f64,
    blue_gamma: f64,
    state: State<'_, DatasetCache>,
) -> Result<Response, String> {
    if !FIRST_TILE_LOGGED.swap(true, Ordering::Relaxed) {
        let path = state.get_path(&id).unwrap_or_default();
        println!("[TILE] First RGB tile request: z={} x={} y={} bands=({},{},{}) stretch=({}-{},{}-{},{}-{}) path={}",
            z, x, y, red_band, green_band, blue_band,
            red_min, red_max, green_min, green_max, blue_min, blue_max, path);
    }
    let pool = state.get_pool(&id).ok_or("Dataset not found")?;
    let bytes = tokio::task::spawn_blocking(move || {
        let guard = pool.checkout();
        let request = TileRequest {
            x,
            y,
            z,
            band: 1,
            tile_size: 256,
        };
        let rs = StretchParams {
            min: red_min,
            max: red_max,
            gamma: red_gamma,
        };
        let gs = StretchParams {
            min: green_min,
            max: green_max,
            gamma: green_gamma,
        };
        let bs = StretchParams {
            min: blue_min,
            max: blue_max,
            gamma: blue_gamma,
        };
        extract_rgb_tile(
            &guard.0, &request, red_band, green_band, blue_band, &rs, &gs, &bs,
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
    let (counts, bin_edges) = compute_histogram_bins(buffer.data(), min, max, bin_count, nodata);

    Ok(HistogramData {
        band: band as usize,
        min,
        max,
        bin_count,
        counts,
        bin_edges,
    })
}

/// Get a cross-layer RGB composite tile (bands from different datasets)
#[tauri::command]
pub async fn get_cross_layer_rgb_tile(
    red_id: String,
    red_band: i32,
    green_id: String,
    green_band: i32,
    blue_id: String,
    blue_band: i32,
    x: i32,
    y: i32,
    z: u8,
    red_min: f64,
    red_max: f64,
    red_gamma: f64,
    green_min: f64,
    green_max: f64,
    green_gamma: f64,
    blue_min: f64,
    blue_max: f64,
    blue_gamma: f64,
    state: State<'_, DatasetCache>,
) -> Result<Response, String> {
    use crate::gdal::tile_extractor::{extract_cross_layer_rgb_tile, StretchParams, TileRequest};
    let r_pool = state.get_pool(&red_id).ok_or("Red dataset not found")?;
    let g_pool = state.get_pool(&green_id).ok_or("Green dataset not found")?;
    let b_pool = state.get_pool(&blue_id).ok_or("Blue dataset not found")?;
    let bytes = tokio::task::spawn_blocking(move || {
        let rg = r_pool.checkout();
        let gg = g_pool.checkout();
        let bg = b_pool.checkout();
        let request = TileRequest {
            x,
            y,
            z,
            band: 1,
            tile_size: 256,
        };
        let rs = StretchParams {
            min: red_min,
            max: red_max,
            gamma: red_gamma,
        };
        let gs = StretchParams {
            min: green_min,
            max: green_max,
            gamma: green_gamma,
        };
        let bs = StretchParams {
            min: blue_min,
            max: blue_max,
            gamma: blue_gamma,
        };
        extract_cross_layer_rgb_tile(
            &rg.0, red_band, &gg.0, green_band, &bg.0, blue_band, &request, &rs, &gs, &bs,
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(Response::new(bytes))
}

/// Get a tile for non-georeferenced images (using pixel coordinates)
#[tauri::command]
pub async fn get_pixel_tile(
    id: String,
    x: i32,
    y: i32,
    z: u8,
    band: Option<i32>,
    min: f64,
    max: f64,
    gamma: f64,
    state: State<'_, DatasetCache>,
) -> Result<Response, String> {
    use crate::gdal::tile_extractor::{extract_pixel_tile, StretchParams, TileRequest};
    let pool = state.get_pool(&id).ok_or("Dataset not found")?;
    let bytes = tokio::task::spawn_blocking(move || {
        let guard = pool.checkout();
        let request = TileRequest {
            x,
            y,
            z,
            band: band.unwrap_or(1),
            tile_size: 256,
        };
        extract_pixel_tile(&guard.0, &request, &StretchParams { min, max, gamma })
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(Response::new(bytes))
}

/// Get an RGB tile for non-georeferenced images (using pixel coordinates)
#[tauri::command]
pub async fn get_pixel_rgb_tile(
    id: String,
    x: i32,
    y: i32,
    z: u8,
    red_band: i32,
    green_band: i32,
    blue_band: i32,
    red_min: f64,
    red_max: f64,
    red_gamma: f64,
    green_min: f64,
    green_max: f64,
    green_gamma: f64,
    blue_min: f64,
    blue_max: f64,
    blue_gamma: f64,
    state: State<'_, DatasetCache>,
) -> Result<Response, String> {
    use crate::gdal::tile_extractor::{extract_pixel_rgb_tile, StretchParams, TileRequest};
    let pool = state.get_pool(&id).ok_or("Dataset not found")?;
    let bytes = tokio::task::spawn_blocking(move || {
        let guard = pool.checkout();
        let request = TileRequest {
            x,
            y,
            z,
            band: 1,
            tile_size: 256,
        };
        let rs = StretchParams {
            min: red_min,
            max: red_max,
            gamma: red_gamma,
        };
        let gs = StretchParams {
            min: green_min,
            max: green_max,
            gamma: green_gamma,
        };
        let bs = StretchParams {
            min: blue_min,
            max: blue_max,
            gamma: blue_gamma,
        };
        extract_pixel_rgb_tile(
            &guard.0, &request, red_band, green_band, blue_band, &rs, &gs, &bs,
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(Response::new(bytes))
}

/// Get a cross-layer RGB tile for non-georeferenced images (using pixel coordinates)
#[tauri::command]
pub async fn get_cross_layer_pixel_rgb_tile(
    red_id: String,
    red_band: i32,
    green_id: String,
    green_band: i32,
    blue_id: String,
    blue_band: i32,
    x: i32,
    y: i32,
    z: u8,
    red_min: f64,
    red_max: f64,
    red_gamma: f64,
    green_min: f64,
    green_max: f64,
    green_gamma: f64,
    blue_min: f64,
    blue_max: f64,
    blue_gamma: f64,
    state: State<'_, DatasetCache>,
) -> Result<Response, String> {
    use crate::gdal::tile_extractor::{
        extract_cross_layer_pixel_rgb_tile, StretchParams, TileRequest,
    };
    let r_pool = state.get_pool(&red_id).ok_or("Red dataset not found")?;
    let g_pool = state.get_pool(&green_id).ok_or("Green dataset not found")?;
    let b_pool = state.get_pool(&blue_id).ok_or("Blue dataset not found")?;
    let bytes = tokio::task::spawn_blocking(move || {
        let rg = r_pool.checkout();
        let gg = g_pool.checkout();
        let bg = b_pool.checkout();
        let request = TileRequest {
            x,
            y,
            z,
            band: 1,
            tile_size: 256,
        };
        let rs = StretchParams {
            min: red_min,
            max: red_max,
            gamma: red_gamma,
        };
        let gs = StretchParams {
            min: green_min,
            max: green_max,
            gamma: green_gamma,
        };
        let bs = StretchParams {
            min: blue_min,
            max: blue_max,
            gamma: blue_gamma,
        };
        extract_cross_layer_pixel_rgb_tile(
            &rg.0, red_band, &gg.0, green_band, &bg.0, blue_band, &request, &rs, &gs, &bs,
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(Response::new(bytes))
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

/// Map a lon/lat (EPSG:4326) point to integer pixel/line through the dataset's
/// geotransform, reprojecting into its native CRS first when needed.
fn geo_to_pixel(dataset: &Dataset, lng: f64, lat: f64) -> Result<(i32, i32), String> {
    let gt = dataset
        .geo_transform()
        .map_err(|e| format!("Failed to get geotransform: {}", e))?;

    let projection = dataset.projection();

    // Transform coordinates from EPSG:4326 to native CRS if needed
    let (native_x, native_y) = if !projection.is_empty() {
        let mut source_srs = SpatialRef::from_epsg(4326)
            .map_err(|e| format!("Failed to create EPSG:4326 SRS: {}", e))?;

        let mut target_srs = SpatialRef::from_wkt(&projection)
            .map_err(|e| format!("Failed to parse target SRS: {}", e))?;

        if !target_srs.is_geographic() {
            // Set axis mapping to traditional GIS order (lng, lat) not (lat, lng)
            source_srs.set_axis_mapping_strategy(
                gdal::spatial_ref::AxisMappingStrategy::TraditionalGisOrder,
            );
            target_srs.set_axis_mapping_strategy(
                gdal::spatial_ref::AxisMappingStrategy::TraditionalGisOrder,
            );

            let transform = CoordTransform::new(&source_srs, &target_srs)
                .map_err(|e| format!("Failed to create coordinate transform: {}", e))?;

            let mut xs = vec![lng];
            let mut ys = vec![lat];

            transform
                .transform_coords(&mut xs, &mut ys, &mut [])
                .map_err(|e| format!("Failed to transform coordinates: {}", e))?;

            (xs[0], ys[0])
        } else {
            (lng, lat)
        }
    } else {
        (lng, lat)
    };

    // Convert geographic coordinates to pixel coordinates
    // Inverse geotransform: pixel_x = (geo_x - gt[0]) / gt[1]
    //                       pixel_y = (geo_y - gt[3]) / gt[5]
    let pixel_x = ((native_x - gt[0]) / gt[1]).floor() as i32;
    let pixel_y = ((native_y - gt[3]) / gt[5]).floor() as i32;
    Ok((pixel_x, pixel_y))
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

/// Elevation profile point
#[derive(Clone, Serialize, Deserialize)]
pub struct ProfilePoint {
    pub distance: f64,  // Distance from start in meters
    pub elevation: f64, // Elevation value
    pub lng: f64,
    pub lat: f64,
    pub is_valid: bool,
}

/// Elevation profile result
#[derive(Clone, Serialize, Deserialize)]
pub struct ProfileResult {
    pub points: Vec<ProfilePoint>,
    pub min_elevation: f64,
    pub max_elevation: f64,
    pub total_distance: f64,
    pub elevation_gain: f64,
    pub elevation_loss: f64,
}

/// Get elevation profile along a line
#[tauri::command]
pub async fn get_elevation_profile(
    id: String,
    coords: Vec<[f64; 2]>, // Array of [lng, lat] pairs
    num_samples: Option<usize>,
    state: State<'_, DatasetCache>,
) -> Result<ProfileResult, String> {
    let ds_pool = state.get_pool(&id).ok_or("Dataset not found")?;
    let ds_guard = ds_pool.checkout();
    let dataset = &ds_guard.0;

    let is_rpc = georef::georef_method(dataset) == GeorefMethod::Rpc;
    // RPC rasters have no geotransform; it's only read on the affine path.
    let gt = if is_rpc {
        [0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
    } else {
        dataset
            .geo_transform()
            .map_err(|e| format!("Failed to get geotransform: {}", e))?
    };

    let projection = dataset.projection();
    let (width, height) = dataset.raster_size();
    let band = dataset
        .rasterband(1)
        .map_err(|e| format!("Failed to get band: {}", e))?;
    let nodata = band.no_data_value();

    // Create coordinate transform if needed
    let needs_transform = !is_rpc && !projection.is_empty() && {
        let srs = SpatialRef::from_wkt(&projection).ok();
        srs.is_some_and(|s| !s.is_geographic())
    };

    let transform = if needs_transform {
        let mut source_srs = SpatialRef::from_epsg(4326)
            .map_err(|e| format!("Failed to create EPSG:4326 SRS: {}", e))?;
        let mut target_srs = SpatialRef::from_wkt(&projection)
            .map_err(|e| format!("Failed to parse target SRS: {}", e))?;
        // Set axis mapping to traditional GIS order (lng, lat) not (lat, lng)
        source_srs
            .set_axis_mapping_strategy(gdal::spatial_ref::AxisMappingStrategy::TraditionalGisOrder);
        target_srs
            .set_axis_mapping_strategy(gdal::spatial_ref::AxisMappingStrategy::TraditionalGisOrder);
        Some(
            CoordTransform::new(&source_srs, &target_srs)
                .map_err(|e| format!("Failed to create transform: {}", e))?,
        )
    } else {
        None
    };

    // Calculate total distance and sample points along the line
    let samples = num_samples.unwrap_or(100);
    let mut points = Vec::with_capacity(samples);

    // Calculate total line length using Haversine
    let mut total_distance = 0.0;
    let mut segment_lengths = Vec::new();

    for i in 1..coords.len() {
        let d = haversine_distance(
            coords[i - 1][0],
            coords[i - 1][1],
            coords[i][0],
            coords[i][1],
        );
        segment_lengths.push(d);
        total_distance += d;
    }

    if total_distance == 0.0 {
        return Err("Line has zero length".to_string());
    }

    // Sample points along the line
    let step = total_distance / (samples - 1) as f64;
    let mut segment_idx = 0;
    let mut segment_start_distance = 0.0;

    let mut min_elev = f64::INFINITY;
    let mut max_elev = f64::NEG_INFINITY;
    let mut elevation_gain = 0.0;
    let mut elevation_loss = 0.0;
    let mut prev_elevation: Option<f64> = None;

    for i in 0..samples {
        let target_distance = i as f64 * step;

        // Find the segment containing this distance
        while segment_idx < segment_lengths.len()
            && segment_start_distance + segment_lengths[segment_idx] < target_distance
        {
            segment_start_distance += segment_lengths[segment_idx];
            segment_idx += 1;
        }

        // Interpolate position along segment
        let (lng, lat) = if segment_idx >= segment_lengths.len() {
            // Last point
            (coords[coords.len() - 1][0], coords[coords.len() - 1][1])
        } else {
            let segment_progress =
                (target_distance - segment_start_distance) / segment_lengths[segment_idx];
            let lng = coords[segment_idx][0]
                + (coords[segment_idx + 1][0] - coords[segment_idx][0]) * segment_progress;
            let lat = coords[segment_idx][1]
                + (coords[segment_idx + 1][1] - coords[segment_idx][1]) * segment_progress;
            (lng, lat)
        };

        // Transform coordinates if needed
        let (native_x, native_y) = if let Some(ref t) = transform {
            let mut xs = vec![lng];
            let mut ys = vec![lat];
            t.transform_coords(&mut xs, &mut ys, &mut [])
                .map_err(|e| format!("Transform failed: {}", e))?;
            (xs[0], ys[0])
        } else {
            (lng, lat)
        };

        // Convert to pixel coordinates
        let (pixel_x, pixel_y) = if is_rpc {
            let (mut xs, mut ys) = ([lng], [lat]);
            georef::rpc_lonlat_to_pixel(dataset, &mut xs, &mut ys)?;
            (xs[0].floor() as i32, ys[0].floor() as i32)
        } else {
            (
                ((native_x - gt[0]) / gt[1]).floor() as i32,
                ((native_y - gt[3]) / gt[5]).floor() as i32,
            )
        };

        let (elevation, is_valid) =
            if pixel_x >= 0 && pixel_x < width as i32 && pixel_y >= 0 && pixel_y < height as i32 {
                let buffer = band
                    .read_as::<f64>((pixel_x as isize, pixel_y as isize), (1, 1), (1, 1), None)
                    .map_err(|e| format!("Failed to read: {}", e))?;
                let value = buffer.data()[0];
                let is_nodata = nodata.is_some_and(|nd| (value - nd).abs() < 1e-10);
                if is_nodata {
                    (0.0, false)
                } else {
                    (value, true)
                }
            } else {
                (0.0, false)
            };

        if is_valid {
            min_elev = min_elev.min(elevation);
            max_elev = max_elev.max(elevation);

            if let Some(prev) = prev_elevation {
                let diff = elevation - prev;
                if diff > 0.0 {
                    elevation_gain += diff;
                } else {
                    elevation_loss += diff.abs();
                }
            }
            prev_elevation = Some(elevation);
        }

        points.push(ProfilePoint {
            distance: target_distance,
            elevation,
            lng,
            lat,
            is_valid,
        });
    }

    Ok(ProfileResult {
        points,
        min_elevation: if min_elev.is_finite() { min_elev } else { 0.0 },
        max_elevation: if max_elev.is_finite() { max_elev } else { 0.0 },
        total_distance,
        elevation_gain,
        elevation_loss,
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

/// Euclidean distance in pixels
fn pixel_distance(x1: i32, y1: i32, x2: i32, y2: i32) -> f64 {
    let dx = (x2 - x1) as f64;
    let dy = (y2 - y1) as f64;
    (dx * dx + dy * dy).sqrt()
}

/// Get elevation profile along a line using pixel coordinates (for non-georeferenced images)
#[tauri::command]
pub async fn get_elevation_profile_pixels(
    id: String,
    pixel_coords: Vec<[i32; 2]>, // Array of [x, y] pixel pairs
    num_samples: Option<usize>,
    state: State<'_, DatasetCache>,
) -> Result<ProfileResult, String> {
    let ds_pool = state.get_pool(&id).ok_or("Dataset not found")?;
    let ds_guard = ds_pool.checkout();
    let dataset = &ds_guard.0;

    let (width, height) = dataset.raster_size();
    let band = dataset
        .rasterband(1)
        .map_err(|e| format!("Failed to get band: {}", e))?;
    let nodata = band.no_data_value();

    // Calculate total distance and sample points along the line
    let samples = num_samples.unwrap_or(100);
    let mut points = Vec::with_capacity(samples);

    // Calculate total line length in pixels
    let mut total_distance = 0.0;
    let mut segment_lengths = Vec::new();

    for i in 1..pixel_coords.len() {
        let d = pixel_distance(
            pixel_coords[i - 1][0],
            pixel_coords[i - 1][1],
            pixel_coords[i][0],
            pixel_coords[i][1],
        );
        segment_lengths.push(d);
        total_distance += d;
    }

    if total_distance == 0.0 {
        return Err("Line has zero length".to_string());
    }

    // Sample points along the line
    let step = total_distance / (samples - 1) as f64;
    let mut segment_idx = 0;
    let mut segment_start_distance = 0.0;

    let mut min_elev = f64::INFINITY;
    let mut max_elev = f64::NEG_INFINITY;
    let mut elevation_gain = 0.0;
    let mut elevation_loss = 0.0;
    let mut prev_elevation: Option<f64> = None;

    for i in 0..samples {
        let target_distance = i as f64 * step;

        // Find the segment containing this distance
        while segment_idx < segment_lengths.len()
            && segment_start_distance + segment_lengths[segment_idx] < target_distance
        {
            segment_start_distance += segment_lengths[segment_idx];
            segment_idx += 1;
        }

        // Interpolate position along segment
        let (pixel_x, pixel_y) = if segment_idx >= segment_lengths.len() {
            // Last point
            (
                pixel_coords[pixel_coords.len() - 1][0],
                pixel_coords[pixel_coords.len() - 1][1],
            )
        } else {
            let segment_progress =
                (target_distance - segment_start_distance) / segment_lengths[segment_idx];
            let x = pixel_coords[segment_idx][0] as f64
                + (pixel_coords[segment_idx + 1][0] - pixel_coords[segment_idx][0]) as f64
                    * segment_progress;
            let y = pixel_coords[segment_idx][1] as f64
                + (pixel_coords[segment_idx + 1][1] - pixel_coords[segment_idx][1]) as f64
                    * segment_progress;
            (x.round() as i32, y.round() as i32)
        };

        let (elevation, is_valid) =
            if pixel_x >= 0 && pixel_x < width as i32 && pixel_y >= 0 && pixel_y < height as i32 {
                let buffer = band
                    .read_as::<f64>((pixel_x as isize, pixel_y as isize), (1, 1), (1, 1), None)
                    .map_err(|e| format!("Failed to read: {}", e))?;
                let value = buffer.data()[0];
                let is_nodata = nodata.is_some_and(|nd| (value - nd).abs() < 1e-10);
                if is_nodata {
                    (0.0, false)
                } else {
                    (value, true)
                }
            } else {
                (0.0, false)
            };

        if is_valid {
            min_elev = min_elev.min(elevation);
            max_elev = max_elev.max(elevation);

            if let Some(prev) = prev_elevation {
                let diff = elevation - prev;
                if diff > 0.0 {
                    elevation_gain += diff;
                } else {
                    elevation_loss += diff.abs();
                }
            }
            prev_elevation = Some(elevation);
        }

        points.push(ProfilePoint {
            distance: target_distance,
            elevation,
            lng: pixel_x as f64, // Use pixel coords as "lng/lat" for display
            lat: pixel_y as f64,
            is_valid,
        });
    }

    Ok(ProfileResult {
        points,
        min_elevation: if min_elev.is_finite() { min_elev } else { 0.0 },
        max_elevation: if max_elev.is_finite() { max_elev } else { 0.0 },
        total_distance,
        elevation_gain,
        elevation_loss,
    })
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
