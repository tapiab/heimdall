#![allow(clippy::too_many_arguments)]

use gdal::raster::reproject;
use gdal::raster::ColorInterpretation;
use gdal::spatial_ref::SpatialRef;
use gdal::{Dataset, DriverManager};
use image::ImageBuffer;
use std::f64::consts::PI;
use std::io::Cursor;

#[derive(Clone, Copy)]
pub struct TileRequest {
    pub x: i32,
    pub y: i32,
    pub z: u8,
    pub band: i32,
    pub tile_size: usize,
}

#[derive(Clone)]
pub struct StretchParams {
    pub min: f64,
    pub max: f64,
    pub gamma: f64,
}

impl Default for StretchParams {
    fn default() -> Self {
        Self {
            min: 0.0,
            max: 255.0,
            gamma: 1.0,
        }
    }
}

/// Convert Web Mercator tile coordinates to EPSG:3857 bounds (meters)
fn tile_to_web_mercator_bounds(x: i32, y: i32, z: u8) -> [f64; 4] {
    let n = 2_f64.powi(z as i32);

    // Web Mercator extent
    let world_size = 20037508.342789244 * 2.0;
    let tile_size = world_size / n;

    let min_x = -20037508.342789244 + (x as f64) * tile_size;
    let max_x = min_x + tile_size;
    let max_y = 20037508.342789244 - (y as f64) * tile_size;
    let min_y = max_y - tile_size;

    [min_x, min_y, max_x, max_y]
}

/// Convert Web Mercator tile to geographic bounds (for intersection test)
fn tile_to_geo_bounds(x: i32, y: i32, z: u8) -> [f64; 4] {
    let n = 2_f64.powi(z as i32);

    let lon_min = (x as f64 / n) * 360.0 - 180.0;
    let lon_max = ((x + 1) as f64 / n) * 360.0 - 180.0;

    let lat_rad_max = ((1.0 - 2.0 * y as f64 / n) * PI).sinh().atan();
    let lat_rad_min = ((1.0 - 2.0 * (y + 1) as f64 / n) * PI).sinh().atan();

    let lat_min = lat_rad_min.to_degrees();
    let lat_max = lat_rad_max.to_degrees();

    [lon_min, lat_min, lon_max, lat_max]
}

/// Get dataset bounds in EPSG:4326.
///
/// Uses the full affine geotransform (including shear terms gt[2]/gt[4]) so
/// that rotated rasters yield a bbox covering all four actual corners. Without
/// this, tiles overlapping a rotated raster's corner triangles get rejected by
/// the bounds_intersect early-out and never rendered.
fn get_dataset_geo_bounds(dataset: &Dataset) -> Result<[f64; 4], String> {
    let gt = dataset
        .geo_transform()
        .map_err(|e| format!("Failed to get geotransform: {}", e))?;

    let (width, height) = dataset.raster_size();
    let (w, h) = (width as f64, height as f64);
    let projection = dataset.projection();

    // World coordinates of the four actual pixel corners.
    let native_xs = [
        gt[0],
        gt[0] + w * gt[1],
        gt[0] + h * gt[2],
        gt[0] + w * gt[1] + h * gt[2],
    ];
    let native_ys = [
        gt[3],
        gt[3] + w * gt[4],
        gt[3] + h * gt[5],
        gt[3] + w * gt[4] + h * gt[5],
    ];

    let bbox_from = |xs: &[f64], ys: &[f64]| -> [f64; 4] {
        let min_x = xs.iter().cloned().fold(f64::INFINITY, f64::min);
        let max_x = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let min_y = ys.iter().cloned().fold(f64::INFINITY, f64::min);
        let max_y = ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        [min_x, min_y, max_x, max_y]
    };

    if projection.is_empty() {
        return Ok(bbox_from(&native_xs, &native_ys));
    }

    let source_srs = SpatialRef::from_wkt(&projection)
        .map_err(|e| format!("Failed to parse source SRS: {}", e))?;

    if source_srs.is_geographic() {
        return Ok(bbox_from(&native_xs, &native_ys));
    }

    // Transform to EPSG:4326
    let mut target_srs = SpatialRef::from_epsg(4326)
        .map_err(|e| format!("Failed to create EPSG:4326 SRS: {}", e))?;
    target_srs
        .set_axis_mapping_strategy(gdal::spatial_ref::AxisMappingStrategy::TraditionalGisOrder);

    let transform = gdal::spatial_ref::CoordTransform::new(&source_srs, &target_srs)
        .map_err(|e| format!("Failed to create transform: {}", e))?;

    let mut xs = native_xs.to_vec();
    let mut ys = native_ys.to_vec();

    transform
        .transform_coords(&mut xs, &mut ys, &mut [])
        .map_err(|e| format!("Failed to transform: {}", e))?;

    Ok(bbox_from(&xs, &ys))
}

/// Check if two bounding boxes intersect
fn bounds_intersect(a: [f64; 4], b: [f64; 4]) -> bool {
    !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3])
}

/// Per-output-pixel boolean mask: true where the tile pixel falls inside the
/// source raster's footprint, false where it would be outside (i.e. padded by
/// the warp). Used to keep outside-extent padding transparent for RGB
/// composites where band-level nodata=0 is ambiguous with valid imagery zeros.
fn compute_tile_coverage_mask(dataset: &Dataset, request: &TileRequest) -> Result<Vec<bool>, String> {
    let tile_bounds = tile_to_web_mercator_bounds(request.x, request.y, request.z);
    let tile_size = request.tile_size;
    let (img_w, img_h) = dataset.raster_size();
    let (img_w, img_h) = (img_w as f64, img_h as f64);

    let gt = dataset
        .geo_transform()
        .map_err(|e| format!("Failed to get geotransform: {}", e))?;
    let det = gt[1] * gt[5] - gt[2] * gt[4];
    if det.abs() < 1e-30 {
        return Ok(vec![true; tile_size * tile_size]);
    }

    let pixel_size_x = (tile_bounds[2] - tile_bounds[0]) / tile_size as f64;
    let pixel_size_y = (tile_bounds[1] - tile_bounds[3]) / tile_size as f64;

    // Build WM -> source-CRS transform. If source has no projection, the WM
    // bounds already match dataset bounds; treat as identity.
    let proj = dataset.projection();
    let mut xs = Vec::with_capacity(tile_size * tile_size);
    let mut ys = Vec::with_capacity(tile_size * tile_size);
    for j in 0..tile_size {
        let cy = tile_bounds[3] + (j as f64 + 0.5) * pixel_size_y;
        for i in 0..tile_size {
            let cx = tile_bounds[0] + (i as f64 + 0.5) * pixel_size_x;
            xs.push(cx);
            ys.push(cy);
        }
    }

    if !proj.is_empty() {
        let src_srs = SpatialRef::from_wkt(&proj)
            .map_err(|e| format!("Failed to parse source SRS: {}", e))?;
        let web_mercator = SpatialRef::from_epsg(3857)
            .map_err(|e| format!("Failed to create EPSG:3857: {}", e))?;
        let transform = gdal::spatial_ref::CoordTransform::new(&web_mercator, &src_srs)
            .map_err(|e| format!("Failed to create transform: {}", e))?;
        let mut zs: Vec<f64> = vec![0.0; xs.len()];
        transform
            .transform_coords(&mut xs, &mut ys, &mut zs)
            .map_err(|e| format!("Failed to transform: {}", e))?;
    }

    let mut mask = vec![false; tile_size * tile_size];
    for k in 0..mask.len() {
        let x = xs[k];
        let y = ys[k];
        if !x.is_finite() || !y.is_finite() {
            continue;
        }
        let dx = x - gt[0];
        let dy = y - gt[3];
        let i = (dx * gt[5] - dy * gt[2]) / det;
        let j = (dy * gt[1] - dx * gt[4]) / det;
        if i >= 0.0 && i < img_w && j >= 0.0 && j < img_h {
            mask[k] = true;
        }
    }
    Ok(mask)
}

/// Extract raw tile data (f64 values) for a single band
fn extract_raw_tile(dataset: &Dataset, request: &TileRequest) -> Result<Vec<f64>, String> {
    // Get tile bounds in Web Mercator (EPSG:3857)
    let tile_bounds = tile_to_web_mercator_bounds(request.x, request.y, request.z);
    let tile_size = request.tile_size;
    let band_count = dataset.raster_count();

    // Create in-memory output dataset in Web Mercator with same number of bands
    let mem_driver = DriverManager::get_driver_by_name("MEM")
        .map_err(|e| format!("Failed to get MEM driver: {}", e))?;

    let mut output_ds = mem_driver
        .create_with_band_type::<f64, _>("", tile_size, tile_size, band_count)
        .map_err(|e| format!("Failed to create output dataset: {}", e))?;

    // Set output geotransform for Web Mercator tile
    let pixel_size_x = (tile_bounds[2] - tile_bounds[0]) / tile_size as f64;
    let pixel_size_y = (tile_bounds[1] - tile_bounds[3]) / tile_size as f64;

    output_ds
        .set_geo_transform(&[
            tile_bounds[0],
            pixel_size_x,
            0.0,
            tile_bounds[3],
            0.0,
            pixel_size_y,
        ])
        .map_err(|e| format!("Failed to set geotransform: {}", e))?;

    // Set output projection to Web Mercator
    let web_mercator =
        SpatialRef::from_epsg(3857).map_err(|e| format!("Failed to create EPSG:3857: {}", e))?;
    output_ds
        .set_projection(&web_mercator.to_wkt().unwrap_or_default())
        .map_err(|e| format!("Failed to set projection: {}", e))?;

    // Use GDAL's warp to reproject all bands
    reproject(dataset, &output_ds).map_err(|e| format!("Failed to reproject: {}", e))?;

    // Read the requested band from the reprojected output
    let output_band = output_ds
        .rasterband(request.band as usize)
        .map_err(|e| format!("Failed to get output band {}: {}", request.band, e))?;

    let buffer = output_band
        .read_as::<f64>((0, 0), (tile_size, tile_size), (tile_size, tile_size), None)
        .map_err(|e| format!("Failed to read output: {}", e))?;

    Ok(buffer.data().to_vec())
}

/// Apply stretch and gamma to a value
/// Resolve effective nodata values for an RGB composite.
///
/// Many 8-bit RGB orthos declare nodata=0 on every band as a marker for the
/// outside-extent padding, but water/dark imagery pixels are *also* exactly 0
/// (and individual channels are very often 0 on darker pixels). Honoring those
/// nodata values produces speckle/holes on water. Heuristic: if all three
/// bands report ColorInterp Red/Green/Blue and every declared nodata equals 0,
/// treat the file as truly opaque RGB and drop the nodata mask.
struct RgbNodata {
    r: Option<f64>,
    g: Option<f64>,
    b: Option<f64>,
    /// When true, mask nothing — neither per-band nor the all-bands gate.
    /// Set by the heuristic that detects ambiguous nodata=0 on RGB orthos.
    suppress_mask: bool,
}

fn resolve_rgb_nodata(
    dataset: &Dataset,
    red_band: i32,
    green_band: i32,
    blue_band: i32,
) -> RgbNodata {
    let r = dataset.rasterband(red_band as usize).ok();
    let g = dataset.rasterband(green_band as usize).ok();
    let b = dataset.rasterband(blue_band as usize).ok();

    let r_nd = r.as_ref().and_then(|band| band.no_data_value());
    let g_nd = g.as_ref().and_then(|band| band.no_data_value());
    let b_nd = b.as_ref().and_then(|band| band.no_data_value());

    let interps_match = matches!(
        r.as_ref().map(|band| band.color_interpretation()),
        Some(ColorInterpretation::RedBand)
    ) && matches!(
        g.as_ref().map(|band| band.color_interpretation()),
        Some(ColorInterpretation::GreenBand)
    ) && matches!(
        b.as_ref().map(|band| band.color_interpretation()),
        Some(ColorInterpretation::BlueBand)
    );
    let all_zero_nodata = r_nd == Some(0.0) && g_nd == Some(0.0) && b_nd == Some(0.0);

    if interps_match && all_zero_nodata {
        RgbNodata {
            r: None,
            g: None,
            b: None,
            suppress_mask: true,
        }
    } else {
        RgbNodata {
            r: r_nd,
            g: g_nd,
            b: b_nd,
            suppress_mask: false,
        }
    }
}

/// Whether a sample should be treated as nodata.
///
/// If the band declares a nodata value, only that exact value (with epsilon)
/// masks the pixel. If no nodata is declared, fall back to treating 0.0 as
/// nodata so outside-extent padding stays transparent for legacy rasters.
/// Non-finite samples always count as nodata.
fn is_nodata(val: f64, nodata: Option<f64>) -> bool {
    if !val.is_finite() {
        return true;
    }
    match nodata {
        Some(nd) => (val - nd).abs() < 1e-10,
        None => val == 0.0,
    }
}

fn apply_stretch(val: f64, stretch: &StretchParams, nodata: Option<f64>) -> Option<u8> {
    if is_nodata(val, nodata) {
        return None;
    }
    Some(stretch_value(val, stretch))
}

/// Map a sample to 0..=255 via min/max stretch and gamma, with no nodata mask.
fn stretch_value(val: f64, stretch: &StretchParams) -> u8 {
    if !val.is_finite() {
        return 0;
    }
    let range = if stretch.max > stretch.min {
        stretch.max - stretch.min
    } else {
        1.0
    };
    let normalized = (val - stretch.min) / range;
    let clamped = normalized.clamp(0.0, 1.0);
    let gamma_corrected = clamped.powf(1.0 / stretch.gamma);
    (gamma_corrected * 255.0).clamp(0.0, 255.0) as u8
}

/// Extract a tile with custom stretch parameters
pub fn extract_tile_with_stretch(
    dataset: &Dataset,
    request: &TileRequest,
    stretch: &StretchParams,
) -> Result<Vec<u8>, String> {
    // Get tile bounds in geographic coordinates for intersection test
    let tile_geo_bounds = tile_to_geo_bounds(request.x, request.y, request.z);

    // Get dataset bounds in geographic coordinates
    let ds_geo_bounds = get_dataset_geo_bounds(dataset)?;

    // Check if tile intersects dataset
    if !bounds_intersect(tile_geo_bounds, ds_geo_bounds) {
        return create_empty_tile(request.tile_size);
    }

    // Get nodata value
    let band = dataset
        .rasterband(request.band as usize)
        .map_err(|e| format!("Failed to get band: {}", e))?;
    let nodata = band.no_data_value();

    // Extract raw tile data
    let data = extract_raw_tile(dataset, request)?;
    let tile_size = request.tile_size;

    // Create RGBA output
    let mut tile_data = vec![0u8; tile_size * tile_size * 4];

    for (i, &val) in data.iter().enumerate() {
        let idx = i * 4;

        if let Some(stretched) = apply_stretch(val, stretch, nodata) {
            tile_data[idx] = stretched;
            tile_data[idx + 1] = stretched;
            tile_data[idx + 2] = stretched;
            tile_data[idx + 3] = 255;
        }
        // else: leave as transparent (0, 0, 0, 0)
    }

    encode_png(&tile_data, tile_size)
}

/// Extract a tile using default auto-calculated stretch
pub fn extract_tile(dataset: &Dataset, request: &TileRequest) -> Result<Vec<u8>, String> {
    // Get global statistics for auto stretch
    let band = dataset
        .rasterband(request.band as usize)
        .map_err(|e| format!("Failed to get band: {}", e))?;

    let (min_val, max_val) = match band.compute_raster_min_max(true) {
        Ok(stats) => (stats.min, stats.max),
        Err(_) => (0.0, 255.0),
    };

    let stretch = StretchParams {
        min: min_val,
        max: max_val,
        gamma: 1.0,
    };

    extract_tile_with_stretch(dataset, request, &stretch)
}

/// Extract an RGB composite tile from potentially different bands
pub fn extract_rgb_tile(
    dataset: &Dataset,
    request: &TileRequest,
    red_band: i32,
    green_band: i32,
    blue_band: i32,
    red_stretch: &StretchParams,
    green_stretch: &StretchParams,
    blue_stretch: &StretchParams,
) -> Result<Vec<u8>, String> {
    // Get tile bounds in geographic coordinates for intersection test
    let tile_geo_bounds = tile_to_geo_bounds(request.x, request.y, request.z);
    let ds_geo_bounds = get_dataset_geo_bounds(dataset)?;

    if !bounds_intersect(tile_geo_bounds, ds_geo_bounds) {
        return create_empty_tile(request.tile_size);
    }

    let nd = resolve_rgb_nodata(dataset, red_band, green_band, blue_band);

    // Extract raw data for each band
    let r_request = TileRequest {
        band: red_band,
        ..*request
    };
    let g_request = TileRequest {
        band: green_band,
        ..*request
    };
    let b_request = TileRequest {
        band: blue_band,
        ..*request
    };

    let r_data = extract_raw_tile(dataset, &r_request)?;
    let g_data = extract_raw_tile(dataset, &g_request)?;
    let b_data = extract_raw_tile(dataset, &b_request)?;

    let tile_size = request.tile_size;
    let mut tile_data = vec![0u8; tile_size * tile_size * 4];

    // When the resolver suppresses band-level nodata (ambiguous nodata=0 on an
    // RGB ortho where water also sits at 0), the only way to tell padding from
    // valid imagery is the source footprint itself. Build a coverage mask that
    // marks tile pixels falling inside the source raster window.
    let coverage = if nd.suppress_mask {
        Some(compute_tile_coverage_mask(dataset, request)?)
    } else {
        None
    };

    // For RGB composites, only mask a pixel when ALL three bands are nodata
    // (i.e. outside the data extent). Per-band masking would punch one channel
    // to zero on valid dark pixels — e.g. 8-bit imagery with nodata=0 declared
    // on every band sparkles cyan on water where R happens to be 0.
    for i in 0..r_data.len() {
        let idx = i * 4;

        let rv = r_data[i];
        let gv = g_data[i];
        let bv = b_data[i];

        if let Some(mask) = &coverage {
            if !mask[i] {
                continue;
            }
        } else if is_nodata(rv, nd.r) && is_nodata(gv, nd.g) && is_nodata(bv, nd.b) {
            continue;
        }

        tile_data[idx] = stretch_value(rv, red_stretch);
        tile_data[idx + 1] = stretch_value(gv, green_stretch);
        tile_data[idx + 2] = stretch_value(bv, blue_stretch);
        tile_data[idx + 3] = 255;
    }

    encode_png(&tile_data, tile_size)
}

fn create_empty_tile(size: usize) -> Result<Vec<u8>, String> {
    let data = vec![0u8; size * size * 4];
    encode_png(&data, size)
}

fn encode_png(rgba_data: &[u8], size: usize) -> Result<Vec<u8>, String> {
    let img: ImageBuffer<image::Rgba<u8>, Vec<u8>> =
        ImageBuffer::from_raw(size as u32, size as u32, rgba_data.to_vec())
            .ok_or("Failed to create image buffer")?;

    let mut bytes: Vec<u8> = Vec::new();
    let mut cursor = Cursor::new(&mut bytes);

    img.write_to(&mut cursor, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode PNG: {}", e))?;

    Ok(bytes)
}

/// Extract raw pixel data for non-georeferenced images (returns f64 values)
fn extract_raw_pixel_tile(dataset: &Dataset, request: &TileRequest) -> Result<Vec<f64>, String> {
    let (img_width, img_height) = dataset.raster_size();
    let tile_size = request.tile_size;

    // Use the same synthetic coordinate system as the frontend
    let scale = 0.01;
    let half_width = (img_width as f64 * scale) / 2.0;
    let half_height = (img_height as f64 * scale) / 2.0;
    let clamped_half_height = half_height.min(85.0);

    let tile_geo_bounds = tile_to_geo_bounds(request.x, request.y, request.z);
    let img_geo_bounds = [
        -half_width,
        -clamped_half_height,
        half_width,
        clamped_half_height,
    ];

    if !bounds_intersect(tile_geo_bounds, img_geo_bounds) {
        return Ok(vec![0.0; tile_size * tile_size]);
    }

    let pixel_scale_y = if half_height > 85.0 {
        (clamped_half_height * 2.0) / img_height as f64
    } else {
        scale
    };

    let src_x_f = (tile_geo_bounds[0] + half_width) / scale;
    let src_y_f = (clamped_half_height - tile_geo_bounds[3]) / pixel_scale_y;
    let src_x_end_f = (tile_geo_bounds[2] + half_width) / scale;
    let src_y_end_f = (clamped_half_height - tile_geo_bounds[1]) / pixel_scale_y;

    let src_x = src_x_f.max(0.0).floor() as isize;
    let src_y = src_y_f.max(0.0).floor() as isize;
    let src_x_end = src_x_end_f.min(img_width as f64).ceil() as isize;
    let src_y_end = src_y_end_f.min(img_height as f64).ceil() as isize;

    let src_width = (src_x_end - src_x).max(1) as usize;
    let src_height = (src_y_end - src_y).max(1) as usize;

    if src_width == 0
        || src_height == 0
        || src_x >= img_width as isize
        || src_y >= img_height as isize
    {
        return Ok(vec![0.0; tile_size * tile_size]);
    }

    let band = dataset
        .rasterband(request.band as usize)
        .map_err(|e| format!("Failed to get band: {}", e))?;

    let buffer = band
        .read_as::<f64>(
            (src_x, src_y),
            (src_width, src_height),
            (tile_size, tile_size),
            None,
        )
        .map_err(|e| format!("Failed to read: {}", e))?;

    Ok(buffer.data().to_vec())
}

/// Extract a cross-layer RGB tile from multiple datasets (for non-georeferenced images)
pub fn extract_cross_layer_pixel_rgb_tile(
    red_ds: &Dataset,
    red_band: i32,
    green_ds: &Dataset,
    green_band: i32,
    blue_ds: &Dataset,
    blue_band: i32,
    request: &TileRequest,
    red_stretch: &StretchParams,
    green_stretch: &StretchParams,
    blue_stretch: &StretchParams,
) -> Result<Vec<u8>, String> {
    let tile_size = request.tile_size;

    let r_request = TileRequest {
        band: red_band,
        ..*request
    };
    let g_request = TileRequest {
        band: green_band,
        ..*request
    };
    let b_request = TileRequest {
        band: blue_band,
        ..*request
    };

    let r_data = extract_raw_pixel_tile(red_ds, &r_request)?;
    let g_data = extract_raw_pixel_tile(green_ds, &g_request)?;
    let b_data = extract_raw_pixel_tile(blue_ds, &b_request)?;

    let r_nodata = red_ds
        .rasterband(red_band as usize)
        .ok()
        .and_then(|b| b.no_data_value());
    let g_nodata = green_ds
        .rasterband(green_band as usize)
        .ok()
        .and_then(|b| b.no_data_value());
    let b_nodata = blue_ds
        .rasterband(blue_band as usize)
        .ok()
        .and_then(|b| b.no_data_value());

    let mut tile_data = vec![0u8; tile_size * tile_size * 4];

    for i in 0..r_data.len() {
        let idx = i * 4;

        let r = apply_stretch(r_data[i], red_stretch, r_nodata);
        let g = apply_stretch(g_data[i], green_stretch, g_nodata);
        let b = apply_stretch(b_data[i], blue_stretch, b_nodata);

        if r.is_some() || g.is_some() || b.is_some() {
            tile_data[idx] = r.unwrap_or(0);
            tile_data[idx + 1] = g.unwrap_or(0);
            tile_data[idx + 2] = b.unwrap_or(0);
            tile_data[idx + 3] = 255;
        }
    }

    encode_png(&tile_data, tile_size)
}

/// Extract a cross-layer RGB tile from multiple datasets
pub fn extract_cross_layer_rgb_tile(
    red_ds: &Dataset,
    red_band: i32,
    green_ds: &Dataset,
    green_band: i32,
    blue_ds: &Dataset,
    blue_band: i32,
    request: &TileRequest,
    red_stretch: &StretchParams,
    green_stretch: &StretchParams,
    blue_stretch: &StretchParams,
) -> Result<Vec<u8>, String> {
    let tile_size = request.tile_size;

    // Extract raw data from each dataset
    let r_request = TileRequest {
        band: red_band,
        ..*request
    };
    let g_request = TileRequest {
        band: green_band,
        ..*request
    };
    let b_request = TileRequest {
        band: blue_band,
        ..*request
    };

    let r_data = extract_raw_tile(red_ds, &r_request)?;
    let g_data = extract_raw_tile(green_ds, &g_request)?;
    let b_data = extract_raw_tile(blue_ds, &b_request)?;

    // Get nodata values
    let r_nodata = red_ds
        .rasterband(red_band as usize)
        .ok()
        .and_then(|b| b.no_data_value());
    let g_nodata = green_ds
        .rasterband(green_band as usize)
        .ok()
        .and_then(|b| b.no_data_value());
    let b_nodata = blue_ds
        .rasterband(blue_band as usize)
        .ok()
        .and_then(|b| b.no_data_value());

    let mut tile_data = vec![0u8; tile_size * tile_size * 4];

    for i in 0..r_data.len() {
        let idx = i * 4;

        let r = apply_stretch(r_data[i], red_stretch, r_nodata);
        let g = apply_stretch(g_data[i], green_stretch, g_nodata);
        let b = apply_stretch(b_data[i], blue_stretch, b_nodata);

        if r.is_some() || g.is_some() || b.is_some() {
            tile_data[idx] = r.unwrap_or(0);
            tile_data[idx + 1] = g.unwrap_or(0);
            tile_data[idx + 2] = b.unwrap_or(0);
            tile_data[idx + 3] = 255;
        }
    }

    encode_png(&tile_data, tile_size)
}

/// Extract an RGB tile using pixel coordinates (for non-georeferenced images)
/// Uses synthetic geographic bounds matching the frontend's coordinate system
pub fn extract_pixel_rgb_tile(
    dataset: &Dataset,
    request: &TileRequest,
    red_band: i32,
    green_band: i32,
    blue_band: i32,
    red_stretch: &StretchParams,
    green_stretch: &StretchParams,
    blue_stretch: &StretchParams,
) -> Result<Vec<u8>, String> {
    let (img_width, img_height) = dataset.raster_size();
    let tile_size = request.tile_size;

    // Use the same synthetic coordinate system as the frontend
    let scale = 0.01;
    let half_width = (img_width as f64 * scale) / 2.0;
    let half_height = (img_height as f64 * scale) / 2.0;
    let clamped_half_height = half_height.min(85.0);

    // Get tile bounds in geographic coordinates (from MapLibre)
    let tile_geo_bounds = tile_to_geo_bounds(request.x, request.y, request.z);

    // Image bounds in synthetic geographic coordinates
    let img_geo_bounds = [
        -half_width,
        -clamped_half_height,
        half_width,
        clamped_half_height,
    ];

    // Check intersection
    if !bounds_intersect(tile_geo_bounds, img_geo_bounds) {
        return create_empty_tile(tile_size);
    }

    // Convert tile geographic bounds to pixel coordinates
    let pixel_scale_y = if half_height > 85.0 {
        (clamped_half_height * 2.0) / img_height as f64
    } else {
        scale
    };

    // Calculate full tile extent in source pixel coordinates (unclamped)
    let tile_src_x_start = (tile_geo_bounds[0] + half_width) / scale;
    let tile_src_y_start = (clamped_half_height - tile_geo_bounds[3]) / pixel_scale_y;
    let tile_src_x_end = (tile_geo_bounds[2] + half_width) / scale;
    let tile_src_y_end = (clamped_half_height - tile_geo_bounds[1]) / pixel_scale_y;

    // Calculate the intersection with image bounds (clamped source coordinates)
    let src_x_f = tile_src_x_start.max(0.0);
    let src_y_f = tile_src_y_start.max(0.0);
    let src_x_end_f = tile_src_x_end.min(img_width as f64);
    let src_y_end_f = tile_src_y_end.min(img_height as f64);

    // Integer source coordinates
    let src_x = src_x_f.floor() as isize;
    let src_y = src_y_f.floor() as isize;
    let src_x_end = src_x_end_f.ceil() as isize;
    let src_y_end = src_y_end_f.ceil() as isize;

    let src_width = (src_x_end - src_x).max(0) as usize;
    let src_height = (src_y_end - src_y).max(0) as usize;

    if src_width == 0
        || src_height == 0
        || src_x >= img_width as isize
        || src_y >= img_height as isize
    {
        return create_empty_tile(tile_size);
    }

    // Calculate where in the output tile the image data should be placed
    let tile_pixel_width = tile_src_x_end - tile_src_x_start;
    let tile_pixel_height = tile_src_y_end - tile_src_y_start;

    // Destination rectangle in tile coordinates (0 to tile_size)
    let dst_x_start =
        ((src_x_f - tile_src_x_start) / tile_pixel_width * tile_size as f64).round() as usize;
    let dst_y_start =
        ((src_y_f - tile_src_y_start) / tile_pixel_height * tile_size as f64).round() as usize;
    let dst_x_end =
        ((src_x_end_f - tile_src_x_start) / tile_pixel_width * tile_size as f64).round() as usize;
    let dst_y_end =
        ((src_y_end_f - tile_src_y_start) / tile_pixel_height * tile_size as f64).round() as usize;

    let dst_width = (dst_x_end - dst_x_start)
        .max(1)
        .min(tile_size - dst_x_start);
    let dst_height = (dst_y_end - dst_y_start)
        .max(1)
        .min(tile_size - dst_y_start);

    let nd = resolve_rgb_nodata(dataset, red_band, green_band, blue_band);

    // Read each band
    let r_band = dataset
        .rasterband(red_band as usize)
        .map_err(|e| format!("Failed to get red band: {}", e))?;
    let g_band = dataset
        .rasterband(green_band as usize)
        .map_err(|e| format!("Failed to get green band: {}", e))?;
    let b_band = dataset
        .rasterband(blue_band as usize)
        .map_err(|e| format!("Failed to get blue band: {}", e))?;

    let r_buffer = r_band
        .read_as::<f64>(
            (src_x, src_y),
            (src_width, src_height),
            (dst_width, dst_height),
            None,
        )
        .map_err(|e| format!("Failed to read red: {}", e))?;

    let g_buffer = g_band
        .read_as::<f64>(
            (src_x, src_y),
            (src_width, src_height),
            (dst_width, dst_height),
            None,
        )
        .map_err(|e| format!("Failed to read green: {}", e))?;

    let b_buffer = b_band
        .read_as::<f64>(
            (src_x, src_y),
            (src_width, src_height),
            (dst_width, dst_height),
            None,
        )
        .map_err(|e| format!("Failed to read blue: {}", e))?;

    let r_data = r_buffer.data();
    let g_data = g_buffer.data();
    let b_data = b_buffer.data();

    let mut tile_data = vec![0u8; tile_size * tile_size * 4];

    // Place the resampled data at the correct position in the output tile
    for dy in 0..dst_height {
        for dx in 0..dst_width {
            let src_idx = dy * dst_width + dx;
            let dst_tile_x = dst_x_start + dx;
            let dst_tile_y = dst_y_start + dy;

            if dst_tile_x >= tile_size || dst_tile_y >= tile_size {
                continue;
            }

            let dst_idx = (dst_tile_y * tile_size + dst_tile_x) * 4;

            let rv = r_data[src_idx];
            let gv = g_data[src_idx];
            let bv = b_data[src_idx];

            if !nd.suppress_mask
                && is_nodata(rv, nd.r)
                && is_nodata(gv, nd.g)
                && is_nodata(bv, nd.b)
            {
                continue;
            }

            tile_data[dst_idx] = stretch_value(rv, red_stretch);
            tile_data[dst_idx + 1] = stretch_value(gv, green_stretch);
            tile_data[dst_idx + 2] = stretch_value(bv, blue_stretch);
            tile_data[dst_idx + 3] = 255;
        }
    }

    encode_png(&tile_data, tile_size)
}

/// Extract a tile using pixel coordinates (for non-georeferenced images)
/// Uses synthetic geographic bounds matching the frontend's coordinate system
pub fn extract_pixel_tile(
    dataset: &Dataset,
    request: &TileRequest,
    stretch: &StretchParams,
) -> Result<Vec<u8>, String> {
    let (img_width, img_height) = dataset.raster_size();
    let tile_size = request.tile_size;

    // Use the same synthetic coordinate system as the frontend
    // All non-geo images are centered at 0,0 with scale 0.01° per pixel
    let scale = 0.01;
    let half_width = (img_width as f64 * scale) / 2.0;
    let half_height = (img_height as f64 * scale) / 2.0;
    let clamped_half_height = half_height.min(85.0);

    // Get tile bounds in geographic coordinates (from MapLibre)
    let tile_geo_bounds = tile_to_geo_bounds(request.x, request.y, request.z);

    // Image bounds in synthetic geographic coordinates
    let img_geo_bounds = [
        -half_width,
        -clamped_half_height,
        half_width,
        clamped_half_height,
    ];

    // Check intersection
    if !bounds_intersect(tile_geo_bounds, img_geo_bounds) {
        return create_empty_tile(tile_size);
    }

    // Convert tile geographic bounds to pixel coordinates
    // geo_x = -half_width + pixel_x * scale  =>  pixel_x = (geo_x + half_width) / scale
    // geo_y = clamped_half_height - pixel_y * pixel_scale_y  =>  pixel_y = (clamped_half_height - geo_y) / pixel_scale_y
    let pixel_scale_y = if half_height > 85.0 {
        (clamped_half_height * 2.0) / img_height as f64
    } else {
        scale
    };

    // Calculate full tile extent in source pixel coordinates (unclamped)
    let tile_src_x_start = (tile_geo_bounds[0] + half_width) / scale;
    let tile_src_y_start = (clamped_half_height - tile_geo_bounds[3]) / pixel_scale_y;
    let tile_src_x_end = (tile_geo_bounds[2] + half_width) / scale;
    let tile_src_y_end = (clamped_half_height - tile_geo_bounds[1]) / pixel_scale_y;

    // Calculate the intersection with image bounds (clamped source coordinates)
    let src_x_f = tile_src_x_start.max(0.0);
    let src_y_f = tile_src_y_start.max(0.0);
    let src_x_end_f = tile_src_x_end.min(img_width as f64);
    let src_y_end_f = tile_src_y_end.min(img_height as f64);

    // Integer source coordinates
    let src_x = src_x_f.floor() as isize;
    let src_y = src_y_f.floor() as isize;
    let src_x_end = src_x_end_f.ceil() as isize;
    let src_y_end = src_y_end_f.ceil() as isize;

    let src_width = (src_x_end - src_x).max(0) as usize;
    let src_height = (src_y_end - src_y).max(0) as usize;

    if src_width == 0
        || src_height == 0
        || src_x >= img_width as isize
        || src_y >= img_height as isize
    {
        return create_empty_tile(tile_size);
    }

    // Calculate where in the output tile the image data should be placed
    // This is the key fix: partial tiles should only fill the corresponding portion
    let tile_pixel_width = tile_src_x_end - tile_src_x_start;
    let tile_pixel_height = tile_src_y_end - tile_src_y_start;

    // Destination rectangle in tile coordinates (0 to tile_size)
    let dst_x_start =
        ((src_x_f - tile_src_x_start) / tile_pixel_width * tile_size as f64).round() as usize;
    let dst_y_start =
        ((src_y_f - tile_src_y_start) / tile_pixel_height * tile_size as f64).round() as usize;
    let dst_x_end =
        ((src_x_end_f - tile_src_x_start) / tile_pixel_width * tile_size as f64).round() as usize;
    let dst_y_end =
        ((src_y_end_f - tile_src_y_start) / tile_pixel_height * tile_size as f64).round() as usize;

    let dst_width = (dst_x_end - dst_x_start)
        .max(1)
        .min(tile_size - dst_x_start);
    let dst_height = (dst_y_end - dst_y_start)
        .max(1)
        .min(tile_size - dst_y_start);

    let band = dataset
        .rasterband(request.band as usize)
        .map_err(|e| format!("Failed to get band: {}", e))?;

    let nodata = band.no_data_value();

    // Read source data and resample to the destination size (not full tile size)
    let buffer = band
        .read_as::<f64>(
            (src_x, src_y),
            (src_width, src_height),
            (dst_width, dst_height),
            None,
        )
        .map_err(|e| format!("Failed to read: {}", e))?;

    let data = buffer.data();
    let mut tile_data = vec![0u8; tile_size * tile_size * 4];

    // Place the resampled data at the correct position in the output tile
    for dy in 0..dst_height {
        for dx in 0..dst_width {
            let src_idx = dy * dst_width + dx;
            let dst_tile_x = dst_x_start + dx;
            let dst_tile_y = dst_y_start + dy;

            if dst_tile_x >= tile_size || dst_tile_y >= tile_size {
                continue;
            }

            let dst_idx = (dst_tile_y * tile_size + dst_tile_x) * 4;
            let val = data[src_idx];

            if let Some(stretched) = apply_stretch(val, stretch, nodata) {
                tile_data[dst_idx] = stretched;
                tile_data[dst_idx + 1] = stretched;
                tile_data[dst_idx + 2] = stretched;
                tile_data[dst_idx + 3] = 255;
            }
        }
    }

    encode_png(&tile_data, tile_size)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ==================== Coordinate Conversion Tests ====================

    #[test]
    fn test_tile_to_geo_bounds_zoom_0() {
        // At zoom 0, there's one tile covering the whole world
        let bounds = tile_to_geo_bounds(0, 0, 0);
        assert!(
            (bounds[0] - (-180.0)).abs() < 0.001,
            "min_lon should be -180"
        );
        assert!((bounds[2] - 180.0).abs() < 0.001, "max_lon should be 180");
        // Latitude is limited by Web Mercator projection (~85.05°)
        assert!(
            bounds[1] > -90.0 && bounds[1] < -80.0,
            "min_lat should be around -85"
        );
        assert!(
            bounds[3] > 80.0 && bounds[3] < 90.0,
            "max_lat should be around 85"
        );
    }

    #[test]
    fn test_tile_to_geo_bounds_zoom_1() {
        // At zoom 1, tile (0,0) should be NW quadrant
        let bounds = tile_to_geo_bounds(0, 0, 1);
        assert!(
            (bounds[0] - (-180.0)).abs() < 0.001,
            "min_lon should be -180"
        );
        assert!((bounds[2] - 0.0).abs() < 0.001, "max_lon should be 0");
        assert!(bounds[3] > 80.0, "max_lat should be > 80 (northern tile)");
    }

    #[test]
    fn test_tile_to_web_mercator_bounds_zoom_0() {
        let bounds = tile_to_web_mercator_bounds(0, 0, 0);
        // Full extent in Web Mercator
        let expected_extent = 20037508.342789244;
        assert!((bounds[0] - (-expected_extent)).abs() < 1.0);
        assert!((bounds[2] - expected_extent).abs() < 1.0);
        assert!((bounds[1] - (-expected_extent)).abs() < 1.0);
        assert!((bounds[3] - expected_extent).abs() < 1.0);
    }

    #[test]
    fn test_tile_to_web_mercator_bounds_symmetry() {
        // At zoom 1, tiles (0,0) and (1,1) should be symmetric about origin
        let nw = tile_to_web_mercator_bounds(0, 0, 1);
        let se = tile_to_web_mercator_bounds(1, 1, 1);

        assert!((nw[0] + se[2]).abs() < 1.0, "bounds should be symmetric");
        assert!((nw[3] + se[1]).abs() < 1.0, "bounds should be symmetric");
    }

    // ==================== Bounds Intersection Tests ====================

    #[test]
    fn test_bounds_intersect_overlapping() {
        let a = [0.0, 0.0, 10.0, 10.0];
        let b = [5.0, 5.0, 15.0, 15.0];
        assert!(
            bounds_intersect(a, b),
            "overlapping bounds should intersect"
        );
    }

    #[test]
    fn test_bounds_intersect_contained() {
        let a = [0.0, 0.0, 20.0, 20.0];
        let b = [5.0, 5.0, 15.0, 15.0];
        assert!(bounds_intersect(a, b), "contained bounds should intersect");
    }

    #[test]
    fn test_bounds_intersect_touching() {
        let a = [0.0, 0.0, 10.0, 10.0];
        let b = [10.0, 0.0, 20.0, 10.0];
        // Edge-touching bounds DO intersect in this implementation (non-strict inequality)
        assert!(
            bounds_intersect(a, b),
            "edge-touching bounds should intersect"
        );
    }

    #[test]
    fn test_bounds_intersect_disjoint() {
        let a = [0.0, 0.0, 10.0, 10.0];
        let b = [20.0, 20.0, 30.0, 30.0];
        assert!(
            !bounds_intersect(a, b),
            "disjoint bounds should not intersect"
        );
    }

    #[test]
    fn test_bounds_intersect_horizontal_gap() {
        let a = [-180.0, -10.0, -170.0, 10.0];
        let b = [170.0, -10.0, 180.0, 10.0];
        assert!(
            !bounds_intersect(a, b),
            "bounds with horizontal gap should not intersect"
        );
    }

    // ==================== Stretch Parameter Tests ====================

    #[test]
    fn test_stretch_params_default() {
        let stretch = StretchParams::default();
        assert_eq!(stretch.min, 0.0);
        assert_eq!(stretch.max, 255.0);
        assert_eq!(stretch.gamma, 1.0);
    }

    #[test]
    fn test_apply_stretch_min_value() {
        let stretch = StretchParams {
            min: 0.0,
            max: 100.0,
            gamma: 1.0,
        };
        let result = apply_stretch(0.0, &stretch, None);
        // 0.0 is treated as nodata/transparent
        assert!(result.is_none(), "zero value should be treated as nodata");
    }

    #[test]
    fn test_apply_stretch_max_value() {
        let stretch = StretchParams {
            min: 0.0,
            max: 100.0,
            gamma: 1.0,
        };
        let result = apply_stretch(100.0, &stretch, None);
        assert_eq!(result, Some(255), "max value should map to 255");
    }

    #[test]
    fn test_apply_stretch_mid_value() {
        let stretch = StretchParams {
            min: 0.0,
            max: 100.0,
            gamma: 1.0,
        };
        let result = apply_stretch(50.0, &stretch, None);
        // 50% of range = 127 or 128
        assert!(result.is_some());
        let val = result.unwrap();
        assert!(val >= 127 && val <= 128, "mid value should map to ~127-128");
    }

    #[test]
    fn test_apply_stretch_with_nodata() {
        let stretch = StretchParams {
            min: 0.0,
            max: 100.0,
            gamma: 1.0,
        };
        let result = apply_stretch(-9999.0, &stretch, Some(-9999.0));
        assert!(result.is_none(), "nodata value should return None");
    }

    #[test]
    fn test_apply_stretch_gamma_low() {
        let stretch = StretchParams {
            min: 0.0,
            max: 100.0,
            gamma: 0.5,
        };
        let result = apply_stretch(25.0, &stretch, None);
        // With gamma < 1, mid-tones should be brighter
        // 25/100 = 0.25, with gamma 0.5: 0.25^(1/0.5) = 0.25^2 = 0.0625
        // Wait, gamma correction: output = input^(1/gamma)
        // 0.25^(1/0.5) = 0.25^2 = 0.0625... that's darker
        // Actually gamma < 1 makes midtones darker, gamma > 1 makes them brighter
        let val = result.unwrap();
        // 0.25^2 = 0.0625 * 255 ≈ 16
        assert!(val < 50, "low gamma should make mid-tones darker");
    }

    #[test]
    fn test_apply_stretch_gamma_high() {
        let stretch = StretchParams {
            min: 0.0,
            max: 100.0,
            gamma: 2.0,
        };
        let result = apply_stretch(25.0, &stretch, None);
        // 0.25^(1/2) = 0.5, * 255 ≈ 127
        let val = result.unwrap();
        assert!(val > 100, "high gamma should make mid-tones brighter");
    }

    #[test]
    fn test_apply_stretch_clamp_below_min() {
        let stretch = StretchParams {
            min: 10.0,
            max: 100.0,
            gamma: 1.0,
        };
        let result = apply_stretch(5.0, &stretch, None);
        // Value below min should clamp to 0
        assert_eq!(result, Some(0), "value below min should clamp to 0");
    }

    #[test]
    fn test_apply_stretch_clamp_above_max() {
        let stretch = StretchParams {
            min: 0.0,
            max: 100.0,
            gamma: 1.0,
        };
        let result = apply_stretch(150.0, &stretch, None);
        // Value above max should clamp to 255
        assert_eq!(result, Some(255), "value above max should clamp to 255");
    }

    #[test]
    fn test_apply_stretch_nan() {
        let stretch = StretchParams::default();
        let result = apply_stretch(f64::NAN, &stretch, None);
        assert!(result.is_none(), "NaN should return None");
    }

    #[test]
    fn test_apply_stretch_infinity() {
        let stretch = StretchParams::default();
        let result = apply_stretch(f64::INFINITY, &stretch, None);
        assert!(result.is_none(), "Infinity should return None");
    }

    // ==================== TileRequest Tests ====================

    #[test]
    fn test_tile_request_copy() {
        let req = TileRequest {
            x: 10,
            y: 20,
            z: 5,
            band: 1,
            tile_size: 256,
        };
        let copy = req;
        assert_eq!(copy.x, 10);
        assert_eq!(copy.y, 20);
        assert_eq!(copy.z, 5);
    }
}
