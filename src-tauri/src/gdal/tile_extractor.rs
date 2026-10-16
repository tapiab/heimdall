#![allow(clippy::too_many_arguments)]

use crate::gdal::georef::{self, GenImgTransformer, GeorefMethod};
use crate::gdal::overview;
use gdal::raster::ColorInterpretation;
use gdal::spatial_ref::SpatialRef;
use gdal::{Dataset, DriverManager};
use gdal_sys::{
    CPLErr, GDALApproxTransform, GDALChunkAndWarpImage, GDALCreateApproxTransformer,
    GDALCreateWarpOperation, GDALCreateWarpOptions, GDALDestroyApproxTransformer,
    GDALDestroyWarpOperation, GDALDestroyWarpOptions, GDALGenImgProjTransform, GDALResampleAlg,
};
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::ImageEncoder;
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
    if georef::georef_method(dataset) == GeorefMethod::Rpc {
        return georef::rpc_geo_bounds(dataset);
    }

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
fn compute_tile_coverage_mask(
    dataset: &Dataset,
    request: &TileRequest,
) -> Result<Vec<bool>, String> {
    let tile_bounds = tile_to_web_mercator_bounds(request.x, request.y, request.z);
    let tile_size = request.tile_size;
    let (img_w, img_h) = dataset.raster_size();
    let (img_w, img_h) = (img_w as f64, img_h as f64);

    if georef::georef_method(dataset) == GeorefMethod::Rpc {
        return rpc_tile_coverage_mask(dataset, tile_bounds, tile_size, img_w, img_h);
    }

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

/// RPC flavour of `compute_tile_coverage_mask`: map each tile pixel center from
/// Web Mercator straight to source pixel/line through the RPC model.
fn rpc_tile_coverage_mask(
    dataset: &Dataset,
    tile_bounds: [f64; 4],
    tile_size: usize,
    img_w: f64,
    img_h: f64,
) -> Result<Vec<bool>, String> {
    let pixel_size_x = (tile_bounds[2] - tile_bounds[0]) / tile_size as f64;
    let pixel_size_y = (tile_bounds[1] - tile_bounds[3]) / tile_size as f64;
    let mut xs = Vec::with_capacity(tile_size * tile_size);
    let mut ys = Vec::with_capacity(tile_size * tile_size);
    for j in 0..tile_size {
        let cy = tile_bounds[3] + (j as f64 + 0.5) * pixel_size_y;
        for i in 0..tile_size {
            xs.push(tile_bounds[0] + (i as f64 + 0.5) * pixel_size_x);
            ys.push(cy);
        }
    }

    // Cached model's destination is EPSG:3857 when targeted at the identity.
    georef::with_rpc_model(dataset, |model| {
        model
            .transformer_for(&[0.0, 1.0, 0.0, 0.0, 0.0, 1.0])
            .transform(true, &mut xs, &mut ys);
        Ok(())
    })?;

    Ok(xs
        .iter()
        .zip(&ys)
        .map(|(&i, &j)| i >= 0.0 && i < img_w && j >= 0.0 && j < img_h)
        .collect())
}

/// Max error, in output pixels, for the approximate transformer used when
/// warping (gdalwarp's default). It transforms points exactly only along
/// scanline ends/midpoints and interpolates linearly between them, recursing
/// where that would exceed this error, instead of running the full
/// reprojection/RPC/DEM chain for every one of a tile's 65k pixels.
const WARP_MAX_ERROR: f64 = 0.125;

/// Warp `src_bands` of `dataset` into `dst_bands` of `output_ds` through
/// `transformer`, approximated within `max_error` pixels (0 = exact).
fn run_warp(
    dataset: &Dataset,
    output_ds: &Dataset,
    transformer: &GenImgTransformer,
    src_bands: &mut [i32],
    dst_bands: &mut [i32],
    tile_size: usize,
    max_error: f64,
) -> Result<(), String> {
    unsafe {
        // Doesn't own the wrapped transformer; destroyed below, before it.
        let approx = if max_error > 0.0 {
            let arg = GDALCreateApproxTransformer(
                Some(GDALGenImgProjTransform),
                transformer.as_ptr(),
                max_error,
            );
            if arg.is_null() {
                return Err("Failed to create approximate transformer".to_string());
            }
            Some(arg)
        } else {
            None
        };

        let warp_opts = GDALCreateWarpOptions();
        (*warp_opts).hSrcDS = dataset.c_dataset();
        (*warp_opts).hDstDS = output_ds.c_dataset();
        (*warp_opts).nBandCount = src_bands.len() as i32;
        (*warp_opts).panSrcBands = src_bands.as_mut_ptr();
        (*warp_opts).panDstBands = dst_bands.as_mut_ptr();
        (*warp_opts).eResampleAlg = GDALResampleAlg::GRA_Bilinear;
        match approx {
            Some(arg) => {
                (*warp_opts).pfnTransformer = Some(GDALApproxTransform);
                (*warp_opts).pTransformerArg = arg;
            }
            None => {
                (*warp_opts).pfnTransformer = Some(GDALGenImgProjTransform);
                (*warp_opts).pTransformerArg = transformer.as_ptr();
            }
        }

        // GDALCreateWarpOperation deep-copies the options (including band arrays),
        // so null our Rust-owned pointers before GDALDestroyWarpOptions to prevent
        // it from calling CPLFree on Rust-managed memory.
        let warp_op = GDALCreateWarpOperation(warp_opts);
        (*warp_opts).panSrcBands = std::ptr::null_mut();
        (*warp_opts).panDstBands = std::ptr::null_mut();
        (*warp_opts).pfnTransformer = None;
        (*warp_opts).pTransformerArg = std::ptr::null_mut();
        GDALDestroyWarpOptions(warp_opts);

        let rv = if warp_op.is_null() {
            None
        } else {
            let rv = GDALChunkAndWarpImage(warp_op, 0, 0, tile_size as i32, tile_size as i32);
            // DestroyWarpOperation doesn't free the transformers; their owners do.
            GDALDestroyWarpOperation(warp_op);
            Some(rv)
        };
        if let Some(arg) = approx {
            GDALDestroyApproxTransformer(arg);
        }

        let Some(rv) = rv else {
            return Err("Failed to create warp operation".to_string());
        };

        if rv != CPLErr::CE_None {
            return Err("Warp failed".to_string());
        }
    }
    Ok(())
}

/// Warp specific bands from `dataset` into a 256×256 Web Mercator tile in one pass.
///
/// `bands` is a list of 1-indexed source band numbers. Returns one `Vec<f64>` per
/// requested band in the same order. Using a single warp for N bands avoids the
/// N× overhead of calling the old per-band helper (especially bad for 32-band
/// hyperspectral data where the old code warped all bands but read only one).
fn warp_bands(
    dataset: &Dataset,
    request: &TileRequest,
    bands: &[i32],
) -> Result<Vec<Vec<f64>>, String> {
    warp_bands_with_error(dataset, request, bands, WARP_MAX_ERROR)
}

/// `warp_bands` with an explicit approximation error (0 = exact transform).
/// Reads from the overview level matching the tile resolution, if any.
fn warp_bands_with_error(
    dataset: &Dataset,
    request: &TileRequest,
    bands: &[i32],
    max_error: f64,
) -> Result<Vec<Vec<f64>>, String> {
    let level = tile_downsample_factor(dataset, request)
        .and_then(|factor| overview::pick_overview_level(dataset, factor));
    match level {
        Some(level) => overview::with_overview(dataset, level, |ovr| {
            warp_source_bands(ovr, request, bands, max_error)
        }),
        None => warp_source_bands(dataset, request, bands, max_error),
    }
}

/// How many full-resolution source pixels fall on one tile pixel, estimated
/// from the footprint's lon/lat bbox. Takes the finer axis, and a rotated or
/// skewed footprint's bbox only overstates the extent, so the estimate errs
/// toward finer overviews (sharper, never blurrier than needed).
fn tile_downsample_factor(dataset: &Dataset, request: &TileRequest) -> Option<f64> {
    let geo = get_dataset_geo_bounds(dataset).ok()?;
    let (w, h) = dataset.raster_size();
    let tile = tile_to_web_mercator_bounds(request.x, request.y, request.z);
    let tile_px_m = (tile[2] - tile[0]) / request.tile_size as f64;

    let lon_to_m = |lon: f64| 6378137.0 * lon.to_radians();
    let lat_to_m = |lat: f64| {
        let lat = lat.clamp(-85.0511, 85.0511).to_radians();
        6378137.0 * (PI / 4.0 + lat / 2.0).tan().ln()
    };
    let extent_x = lon_to_m(geo[2]) - lon_to_m(geo[0]);
    let extent_y = lat_to_m(geo[3]) - lat_to_m(geo[1]);
    if extent_x <= 0.0 || extent_y <= 0.0 {
        return None;
    }

    let fx = tile_px_m * w as f64 / extent_x;
    let fy = tile_px_m * h as f64 / extent_y;
    Some(fx.min(fy))
}

/// Warp from exactly `dataset` (no overview selection).
fn warp_source_bands(
    dataset: &Dataset,
    request: &TileRequest,
    bands: &[i32],
    max_error: f64,
) -> Result<Vec<Vec<f64>>, String> {
    let tile_bounds = tile_to_web_mercator_bounds(request.x, request.y, request.z);
    let tile_size = request.tile_size;
    let n_bands = bands.len();

    let mem_driver =
        DriverManager::get_driver_by_name("MEM").map_err(|e| format!("MEM driver: {}", e))?;
    let mut output_ds = mem_driver
        .create_with_band_type::<f64, _>("", tile_size, tile_size, n_bands)
        .map_err(|e| format!("create output dataset: {}", e))?;

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
        .map_err(|e| format!("set geotransform: {}", e))?;
    let web_mercator = SpatialRef::from_epsg(3857).map_err(|e| format!("EPSG:3857: {}", e))?;
    output_ds
        .set_projection(&web_mercator.to_wkt().unwrap_or_default())
        .map_err(|e| format!("set projection: {}", e))?;

    // src_bands: which source bands to read; dst_bands: corresponding 1-indexed output bands.
    let mut src_bands: Vec<i32> = bands.to_vec();
    let mut dst_bands: Vec<i32> = (1..=(n_bands as i32)).collect();

    if georef::georef_method(dataset) == GeorefMethod::Rpc {
        // Reuse the cached RPC model (and its open DEM), re-targeted at this tile.
        let tile_gt = output_ds
            .geo_transform()
            .map_err(|e| format!("get geotransform: {}", e))?;
        georef::with_rpc_model(dataset, |model| {
            let transformer = model.transformer_for(&tile_gt);
            run_warp(
                dataset,
                &output_ds,
                transformer,
                &mut src_bands,
                &mut dst_bands,
                tile_size,
                max_error,
            )
        })?;
    } else {
        let transformer = GenImgTransformer::new(
            dataset,
            Some(&output_ds),
            georef::georef_method(dataset),
            None,
        )?;
        run_warp(
            dataset,
            &output_ds,
            &transformer,
            &mut src_bands,
            &mut dst_bands,
            tile_size,
            max_error,
        )?;
    }

    let mut results = Vec::with_capacity(n_bands);
    for i in 1..=(n_bands) {
        let band = output_ds
            .rasterband(i)
            .map_err(|e| format!("get output band {}: {}", i, e))?;
        let buffer = band
            .read_as::<f64>((0, 0), (tile_size, tile_size), (tile_size, tile_size), None)
            .map_err(|e| format!("read band {}: {}", i, e))?;
        results.push(buffer.data().to_vec());
    }

    Ok(results)
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

    let data = warp_bands(dataset, request, &[request.band])?.remove(0);
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

    // Single warp pass for all 3 bands — avoids warping all N source bands 3 times.
    let mut rgb = warp_bands(dataset, request, &[red_band, green_band, blue_band])?;
    let b_data = rgb.remove(2);
    let g_data = rgb.remove(1);
    let r_data = rgb.remove(0);

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
    let mut bytes: Vec<u8> = Vec::new();
    let encoder = PngEncoder::new_with_quality(
        Cursor::new(&mut bytes),
        CompressionType::Fast,
        FilterType::NoFilter,
    );
    encoder
        .write_image(
            rgba_data,
            size as u32,
            size as u32,
            image::ExtendedColorType::Rgba8,
        )
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
    // 3 different datasets — one warp each, but each warp touches only 1 band.
    let r_data = warp_bands(red_ds, request, &[red_band])?.remove(0);
    let g_data = warp_bands(green_ds, request, &[green_band])?.remove(0);
    let b_data = warp_bands(blue_ds, request, &[blue_band])?.remove(0);

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

    // ==================== Approximate Warp Tests ====================

    /// Fill band 1 with its column index so a warped value reads as the source
    /// x position it was sampled from.
    fn fill_with_column_index(ds: &mut Dataset) {
        let (w, h) = ds.raster_size();
        let data: Vec<f64> = (0..w * h).map(|i| (i % w) as f64 + 1.0).collect();
        let mut buf = gdal::raster::Buffer::new((w, h), data);
        ds.rasterband(1)
            .unwrap()
            .write((0, 0), (w, h), &mut buf)
            .unwrap();
    }

    /// Largest difference between the approximate and the exact warp.
    fn max_approx_error(ds: &Dataset) -> f64 {
        let req = rpc_tile_request();
        let approx = warp_bands(ds, &req, &[1]).unwrap().remove(0);
        let exact = warp_bands_with_error(ds, &req, &[1], 0.0)
            .unwrap()
            .remove(0);
        approx
            .iter()
            .zip(&exact)
            .filter(|(a, e)| **a != 0.0 && **e != 0.0)
            .map(|(a, e)| (a - e).abs())
            .fold(0.0, f64::max)
    }

    #[test]
    fn test_approx_warp_matches_exact_utm() {
        // UTM 32N, 1000x1000 @ 100 m around lon 10 / lat 45.
        let driver = DriverManager::get_driver_by_name("MEM").unwrap();
        let mut ds = driver
            .create_with_band_type::<f64, _>("", 1000, 1000, 1)
            .unwrap();
        ds.set_geo_transform(&[528800.0, 100.0, 0.0, 5033600.0, 0.0, -100.0])
            .unwrap();
        ds.set_spatial_ref(&SpatialRef::from_epsg(32632).unwrap())
            .unwrap();
        fill_with_column_index(&mut ds);

        let err = max_approx_error(&ds);
        assert!(err < 0.2, "approx warp off by {} source px", err);
    }

    #[test]
    fn test_approx_warp_matches_exact_rpc() {
        let mut ds = crate::gdal::georef::named_synthetic_rpc_dataset("rpc-approx");
        fill_with_column_index(&mut ds);
        crate::gdal::georef::set_rpc_elevation(
            "rpc-approx",
            crate::gdal::georef::RpcElevation {
                dem_path: None,
                height: Some(800.0),
                dem_height_offset: None,
            },
        );

        let err = max_approx_error(&ds);
        crate::gdal::georef::set_rpc_elevation("rpc-approx", Default::default());
        assert!(err < 0.2, "approx warp off by {} source px", err);
    }

    // ==================== Overview Tests ====================

    /// GTiff in /vsimem (so it can be reopened at an overview level) with the
    /// synthetic RPC model, a column-index gradient and 2x/4x overviews.
    fn rpc_gtiff_with_overviews(path: &str) -> crate::gdal::dataset_cache::SendDataset {
        let mut mem = crate::gdal::georef::synthetic_rpc_dataset();
        fill_with_column_index(&mut mem);
        let driver = DriverManager::get_driver_by_name("GTiff").unwrap();
        let mut ds = mem.create_copy(&driver, path, &Default::default()).unwrap();
        ds.build_overviews("AVERAGE", &[2, 4], &[]).unwrap();
        drop(ds);
        crate::gdal::dataset_cache::SendDataset::new(Dataset::open(path).unwrap())
    }

    #[test]
    fn test_pick_overview_level() {
        let path = "/vsimem/ovr_pick.tif";
        let handle = rpc_gtiff_with_overviews(path);
        let ds = &handle.0;
        assert_eq!(overview::pick_overview_level(ds, 0.5), None);
        assert_eq!(overview::pick_overview_level(ds, 1.9), None);
        assert_eq!(overview::pick_overview_level(ds, 2.0), Some(0));
        assert_eq!(overview::pick_overview_level(ds, 3.9), Some(0));
        assert_eq!(overview::pick_overview_level(ds, 4.0), Some(1));
        assert_eq!(overview::pick_overview_level(ds, 100.0), Some(1));
        drop(handle);
        gdal::vsi::unlink_mem_file(path).unwrap();
    }

    #[test]
    fn test_rpc_overview_warp_matches_full_resolution() {
        let path = "/vsimem/ovr_rpc_warp.tif";
        let handle = rpc_gtiff_with_overviews(path);
        let ds = &handle.0;

        // z4 tile: ~6 source px per tile px on the finer (y) axis, so the 4x overview is used.
        let z = 4u8;
        let n = 2_f64.powi(z as i32);
        let lat = 45_f64.to_radians();
        let req = TileRequest {
            x: ((10.0 + 180.0) / 360.0 * n).floor() as i32,
            y: ((1.0 - (lat.tan() + 1.0 / lat.cos()).ln() / PI) / 2.0 * n).floor() as i32,
            z,
            band: 1,
            tile_size: 256,
        };
        let factor = tile_downsample_factor(ds, &req).unwrap();
        assert_eq!(overview::pick_overview_level(ds, factor), Some(1));

        let full = warp_source_bands(ds, &req, &[1], 0.0).unwrap().remove(0);
        let ovr = warp_bands(ds, &req, &[1]).unwrap().remove(0);
        let diffs: Vec<f64> = full
            .iter()
            .zip(&ovr)
            .filter(|(a, b)| **a > 0.0 && **b > 0.0)
            .map(|(a, b)| (a - b).abs())
            .collect();
        assert!(diffs.len() > 100, "tile should overlap the footprint");
        // Values are source column indices: a misplaced overview (e.g. RPC not
        // rescaled) would be off by tens of columns, averaging by ~1-2.
        let mean = diffs.iter().sum::<f64>() / diffs.len() as f64;
        assert!(mean < 2.5, "overview tile off by {} source columns", mean);

        drop(handle);
        gdal::vsi::unlink_mem_file(path).unwrap();
    }

    // ==================== RPC Tests ====================

    /// z=10 tile containing lon 10, lat 45 (inside the synthetic RPC footprint).
    fn rpc_tile_request() -> TileRequest {
        let z = 10u8;
        let n = 2_f64.powi(z as i32);
        let x = ((10.0 + 180.0) / 360.0 * n).floor() as i32;
        let lat = 45_f64.to_radians();
        let y = ((1.0 - (lat.tan() + 1.0 / lat.cos()).ln() / PI) / 2.0 * n).floor() as i32;
        TileRequest {
            x,
            y,
            z,
            band: 1,
            tile_size: 256,
        }
    }

    #[test]
    fn test_rpc_dataset_geo_bounds() {
        let ds = crate::gdal::georef::synthetic_rpc_dataset();
        let b = get_dataset_geo_bounds(&ds).unwrap();
        assert!((b[0] - 9.495).abs() < 1e-3 && (b[3] - 45.505).abs() < 1e-3);
    }

    #[test]
    fn test_rpc_warp_fills_tile() {
        let ds = crate::gdal::georef::synthetic_rpc_dataset();
        let data = warp_bands(&ds, &rpc_tile_request(), &[1])
            .unwrap()
            .remove(0);
        let valid = data.iter().filter(|&&v| (v - 7.0).abs() < 1e-6).count();
        assert_eq!(valid, data.len(), "tile fully inside footprint");
    }

    #[test]
    fn test_rpc_coverage_mask() {
        let ds = crate::gdal::georef::synthetic_rpc_dataset();
        let inside = compute_tile_coverage_mask(&ds, &rpc_tile_request()).unwrap();
        assert!(inside.iter().all(|&m| m));

        let outside = TileRequest {
            x: 0,
            y: 0,
            ..rpc_tile_request()
        };
        let mask = compute_tile_coverage_mask(&ds, &outside).unwrap();
        assert!(mask.iter().all(|&m| !m));
    }
}
