#![allow(clippy::too_many_arguments)]

use crate::gdal::dataset_cache::DatasetCache;
use crate::gdal::tile_extractor::{
    extract_rgb_tile, extract_tile, extract_tile_with_stretch, StretchParams, TileRequest,
};
use gdal::spatial_ref::{CoordTransform, SpatialRef};
use gdal::Dataset;
use serde::{Deserialize, Serialize};
use tauri::State;

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
    pub is_georeferenced: bool,     // true if image has valid geotransform/projection
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

/// Check if a dataset has valid georeferencing
fn is_georeferenced(dataset: &Dataset) -> bool {
    // Check if there's a projection
    let has_projection = !dataset.projection().is_empty();

    // Check geotransform - identity would be [0, 1, 0, 0, 0, -1] or [0, 1, 0, 0, 0, 1]
    let gt = match dataset.geo_transform() {
        Ok(gt) => gt,
        Err(_) => return false,
    };

    // Identity geotransform means no real georeferencing
    let is_identity = (gt[0].abs() < 1e-10)
        && ((gt[1] - 1.0).abs() < 1e-10)
        && (gt[2].abs() < 1e-10)
        && (gt[3].abs() < 1e-10)
        && (gt[4].abs() < 1e-10)
        && ((gt[5] + 1.0).abs() < 1e-10 || (gt[5] - 1.0).abs() < 1e-10);

    has_projection || !is_identity
}

/// Calculate bounds in native CRS
fn calculate_native_bounds(dataset: &Dataset) -> Result<[f64; 4], String> {
    let gt = dataset
        .geo_transform()
        .map_err(|e| format!("Failed to get geotransform: {}", e))?;

    let (width, height) = dataset.raster_size();

    // gt[0] = top left x, gt[3] = top left y
    // gt[1] = pixel width, gt[5] = pixel height (usually negative)
    let min_x = gt[0];
    let max_x = gt[0] + (width as f64) * gt[1];
    let max_y = gt[3];
    let min_y = gt[3] + (height as f64) * gt[5];

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
    let georeferenced = is_georeferenced(&dataset);

    let (bounds, native_bounds, pixel_size) = if georeferenced {
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
    };

    // Store only the path, not the dataset (GDAL Dataset is not thread-safe)
    state.add(id, path);

    Ok(metadata)
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
) -> Result<Vec<u8>, String> {
    let path = state.get_path(&id).ok_or("Dataset not found")?;

    // Open dataset fresh for this request (GDAL Dataset is not thread-safe)
    let dataset = Dataset::open(&path).map_err(|e| format!("Failed to open raster: {}", e))?;

    let request = TileRequest {
        x,
        y,
        z,
        band: band.unwrap_or(1),
        tile_size: 256,
    };

    extract_tile(&dataset, &request)
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
) -> Result<Vec<u8>, String> {
    let path = state.get_path(&id).ok_or("Dataset not found")?;
    let dataset = Dataset::open(&path).map_err(|e| format!("Failed to open raster: {}", e))?;

    let request = TileRequest {
        x,
        y,
        z,
        band: band.unwrap_or(1),
        tile_size: 256,
    };

    let stretch = StretchParams { min, max, gamma };

    extract_tile_with_stretch(&dataset, &request, &stretch)
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
) -> Result<Vec<u8>, String> {
    let path = state.get_path(&id).ok_or("Dataset not found")?;
    let dataset = Dataset::open(&path).map_err(|e| format!("Failed to open raster: {}", e))?;

    let request = TileRequest {
        x,
        y,
        z,
        band: 1, // Not used directly
        tile_size: 256,
    };

    let red_stretch = StretchParams {
        min: red_min,
        max: red_max,
        gamma: red_gamma,
    };
    let green_stretch = StretchParams {
        min: green_min,
        max: green_max,
        gamma: green_gamma,
    };
    let blue_stretch = StretchParams {
        min: blue_min,
        max: blue_max,
        gamma: blue_gamma,
    };

    extract_rgb_tile(
        &dataset,
        &request,
        red_band,
        green_band,
        blue_band,
        &red_stretch,
        &green_stretch,
        &blue_stretch,
    )
}

/// Get statistics for a band
#[tauri::command]
pub async fn get_raster_stats(
    id: String,
    band: i32,
    state: State<'_, DatasetCache>,
) -> Result<BandStats, String> {
    let path = state.get_path(&id).ok_or("Dataset not found")?;
    let dataset = Dataset::open(&path).map_err(|e| format!("Failed to open raster: {}", e))?;

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

    let path = state.get_path(&id).ok_or("Dataset not found")?;
    let dataset = Dataset::open(&path).map_err(|e| format!("Failed to open raster: {}", e))?;

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
) -> Result<Vec<u8>, String> {
    use crate::gdal::tile_extractor::{extract_cross_layer_rgb_tile, StretchParams, TileRequest};

    let red_path = state.get_path(&red_id).ok_or("Red dataset not found")?;
    let green_path = state.get_path(&green_id).ok_or("Green dataset not found")?;
    let blue_path = state.get_path(&blue_id).ok_or("Blue dataset not found")?;

    let red_ds =
        Dataset::open(&red_path).map_err(|e| format!("Failed to open red raster: {}", e))?;
    let green_ds =
        Dataset::open(&green_path).map_err(|e| format!("Failed to open green raster: {}", e))?;
    let blue_ds =
        Dataset::open(&blue_path).map_err(|e| format!("Failed to open blue raster: {}", e))?;

    let request = TileRequest {
        x,
        y,
        z,
        band: 1,
        tile_size: 256,
    };

    let red_stretch = StretchParams {
        min: red_min,
        max: red_max,
        gamma: red_gamma,
    };
    let green_stretch = StretchParams {
        min: green_min,
        max: green_max,
        gamma: green_gamma,
    };
    let blue_stretch = StretchParams {
        min: blue_min,
        max: blue_max,
        gamma: blue_gamma,
    };

    extract_cross_layer_rgb_tile(
        &red_ds,
        red_band,
        &green_ds,
        green_band,
        &blue_ds,
        blue_band,
        &request,
        &red_stretch,
        &green_stretch,
        &blue_stretch,
    )
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
) -> Result<Vec<u8>, String> {
    use crate::gdal::tile_extractor::{extract_pixel_tile, StretchParams, TileRequest};

    let path = state.get_path(&id).ok_or("Dataset not found")?;
    let dataset = Dataset::open(&path).map_err(|e| format!("Failed to open raster: {}", e))?;

    let request = TileRequest {
        x,
        y,
        z,
        band: band.unwrap_or(1),
        tile_size: 256,
    };

    let stretch = StretchParams { min, max, gamma };

    extract_pixel_tile(&dataset, &request, &stretch)
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
) -> Result<Vec<u8>, String> {
    use crate::gdal::tile_extractor::{
        extract_cross_layer_pixel_rgb_tile, StretchParams, TileRequest,
    };

    let red_path = state.get_path(&red_id).ok_or("Red dataset not found")?;
    let green_path = state.get_path(&green_id).ok_or("Green dataset not found")?;
    let blue_path = state.get_path(&blue_id).ok_or("Blue dataset not found")?;

    let red_ds =
        Dataset::open(&red_path).map_err(|e| format!("Failed to open red raster: {}", e))?;
    let green_ds =
        Dataset::open(&green_path).map_err(|e| format!("Failed to open green raster: {}", e))?;
    let blue_ds =
        Dataset::open(&blue_path).map_err(|e| format!("Failed to open blue raster: {}", e))?;

    let request = TileRequest {
        x,
        y,
        z,
        band: 1,
        tile_size: 256,
    };

    let red_stretch = StretchParams {
        min: red_min,
        max: red_max,
        gamma: red_gamma,
    };
    let green_stretch = StretchParams {
        min: green_min,
        max: green_max,
        gamma: green_gamma,
    };
    let blue_stretch = StretchParams {
        min: blue_min,
        max: blue_max,
        gamma: blue_gamma,
    };

    extract_cross_layer_pixel_rgb_tile(
        &red_ds,
        red_band,
        &green_ds,
        green_band,
        &blue_ds,
        blue_band,
        &request,
        &red_stretch,
        &green_stretch,
        &blue_stretch,
    )
}

/// Close a dataset and remove from cache
#[tauri::command]
pub async fn close_dataset(id: String, state: State<'_, DatasetCache>) -> Result<(), String> {
    state.remove(&id);
    Ok(())
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
        let (counts, bin_edges) = compute_histogram_bins(&values, 0.0, 10.0, 10, None);

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
