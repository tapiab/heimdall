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
use std::f64::consts::PI;

#[derive(Clone, Copy)]
pub struct TileRequest {
    pub x: i32,
    pub y: i32,
    pub z: u8,
    pub tile_size: usize,
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

/// Nodata handling for the bands of one raw tile.
///
/// Three bands from one dataset are an RGB composite and go through
/// `resolve_rgb_nodata`; any other request uses each band's own nodata.
/// `suppress_mask` means no per-band masking: only pixels outside the source
/// footprint are masked.
struct RawNodata {
    per_band: Vec<Option<f64>>,
    suppress_mask: bool,
}

fn raw_nodata(dataset: &Dataset, bands: &[i32]) -> RawNodata {
    if let [r, g, b] = *bands {
        let nd = resolve_rgb_nodata(dataset, r, g, b);
        return RawNodata {
            per_band: vec![nd.r, nd.g, nd.b],
            suppress_mask: nd.suppress_mask,
        };
    }
    RawNodata {
        per_band: bands
            .iter()
            .map(|&b| {
                dataset
                    .rasterband(b as usize)
                    .ok()
                    .and_then(|band| band.no_data_value())
            })
            .collect(),
        suppress_mask: false,
    }
}

fn masked_sample(val: f64, nodata: Option<f64>, suppress_mask: bool) -> f32 {
    if suppress_mask || !is_nodata(val, nodata) {
        val as f32
    } else {
        f32::NAN
    }
}

/// Raw samples of `bands` warped into one Web Mercator tile: band-sequential
/// `f32`, `tile_size²` per band, `NaN` where the pixel is nodata or outside the
/// raster. `None` when the tile misses the raster entirely. Stretch and
/// colormap are applied by the frontend.
pub fn extract_raw_tile(
    dataset: &Dataset,
    request: &TileRequest,
    bands: &[i32],
) -> Result<Option<Vec<f32>>, String> {
    let tile_geo_bounds = tile_to_geo_bounds(request.x, request.y, request.z);
    let ds_geo_bounds = get_dataset_geo_bounds(dataset)?;
    if !bounds_intersect(tile_geo_bounds, ds_geo_bounds) {
        return Ok(None);
    }

    let nd = raw_nodata(dataset, bands);
    let data = warp_bands(dataset, request, bands)?;

    // Band nodata=0 is ambiguous on RGB orthos (water is also 0), so the
    // source footprint is the only way to tell padding from imagery.
    let coverage = if nd.suppress_mask {
        Some(compute_tile_coverage_mask(dataset, request)?)
    } else {
        None
    };

    let pixels = request.tile_size * request.tile_size;
    let mut out = Vec::with_capacity(pixels * bands.len());
    for (band_data, &nodata) in data.iter().zip(&nd.per_band) {
        for (i, &val) in band_data.iter().enumerate() {
            let inside = coverage.as_ref().is_none_or(|mask| mask[i]);
            out.push(if inside {
                masked_sample(val, nodata, nd.suppress_mask)
            } else {
                f32::NAN
            });
        }
    }
    Ok(Some(out))
}

/// Where a tile of a non-georeferenced image reads from and draws to.
struct PixelWindow {
    src_x: isize,
    src_y: isize,
    src_width: usize,
    src_height: usize,
    dst_x: usize,
    dst_y: usize,
    dst_width: usize,
    dst_height: usize,
}

/// Source window and destination rectangle of a tile over a non-georeferenced
/// image, in the frontend's synthetic coordinates (0.01° per pixel, centered
/// on 0,0). A tile partly off the image fills only its matching part.
fn pixel_tile_window(dataset: &Dataset, request: &TileRequest) -> Option<PixelWindow> {
    let (img_width, img_height) = dataset.raster_size();
    let tile_size = request.tile_size;

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
        return None;
    }

    // geo_x = -half_width + pixel_x * scale
    // geo_y = clamped_half_height - pixel_y * pixel_scale_y
    let pixel_scale_y = if half_height > 85.0 {
        (clamped_half_height * 2.0) / img_height as f64
    } else {
        scale
    };

    // Full tile extent in source pixels (unclamped)
    let tile_src_x_start = (tile_geo_bounds[0] + half_width) / scale;
    let tile_src_y_start = (clamped_half_height - tile_geo_bounds[3]) / pixel_scale_y;
    let tile_src_x_end = (tile_geo_bounds[2] + half_width) / scale;
    let tile_src_y_end = (clamped_half_height - tile_geo_bounds[1]) / pixel_scale_y;

    // Intersection with the image
    let src_x_f = tile_src_x_start.max(0.0);
    let src_y_f = tile_src_y_start.max(0.0);
    let src_x_end_f = tile_src_x_end.min(img_width as f64);
    let src_y_end_f = tile_src_y_end.min(img_height as f64);

    let src_x = src_x_f.floor() as isize;
    let src_y = src_y_f.floor() as isize;
    let src_width = (src_x_end_f.ceil() as isize - src_x).max(0) as usize;
    let src_height = (src_y_end_f.ceil() as isize - src_y).max(0) as usize;

    if src_width == 0
        || src_height == 0
        || src_x >= img_width as isize
        || src_y >= img_height as isize
    {
        return None;
    }

    // Destination rectangle in tile pixels
    let tile_pixel_width = tile_src_x_end - tile_src_x_start;
    let tile_pixel_height = tile_src_y_end - tile_src_y_start;
    let to_dst_x =
        |sx: f64| ((sx - tile_src_x_start) / tile_pixel_width * tile_size as f64).round();
    let to_dst_y =
        |sy: f64| ((sy - tile_src_y_start) / tile_pixel_height * tile_size as f64).round();
    let dst_x = (to_dst_x(src_x_f) as usize).min(tile_size - 1);
    let dst_y = (to_dst_y(src_y_f) as usize).min(tile_size - 1);
    let dst_x_end = to_dst_x(src_x_end_f) as usize;
    let dst_y_end = to_dst_y(src_y_end_f) as usize;

    Some(PixelWindow {
        src_x,
        src_y,
        src_width,
        src_height,
        dst_x,
        dst_y,
        dst_width: dst_x_end
            .saturating_sub(dst_x)
            .max(1)
            .min(tile_size - dst_x),
        dst_height: dst_y_end
            .saturating_sub(dst_y)
            .max(1)
            .min(tile_size - dst_y),
    })
}

/// `extract_raw_tile` for non-georeferenced images: same layout, read through
/// the synthetic pixel coordinates instead of a warp.
pub fn extract_raw_pixel_tile(
    dataset: &Dataset,
    request: &TileRequest,
    bands: &[i32],
) -> Result<Option<Vec<f32>>, String> {
    let Some(win) = pixel_tile_window(dataset, request) else {
        return Ok(None);
    };
    let nd = raw_nodata(dataset, bands);
    let tile_size = request.tile_size;
    let pixels = tile_size * tile_size;
    let mut out = vec![f32::NAN; pixels * bands.len()];

    for (k, (&band_index, &nodata)) in bands.iter().zip(&nd.per_band).enumerate() {
        let band = dataset
            .rasterband(band_index as usize)
            .map_err(|e| format!("Failed to get band {}: {}", band_index, e))?;
        let buffer = band
            .read_as::<f64>(
                (win.src_x, win.src_y),
                (win.src_width, win.src_height),
                (win.dst_width, win.dst_height),
                None,
            )
            .map_err(|e| format!("Failed to read band {}: {}", band_index, e))?;
        let data = buffer.data();
        let plane = &mut out[k * pixels..(k + 1) * pixels];
        for dy in 0..win.dst_height {
            let row = (win.dst_y + dy) * tile_size + win.dst_x;
            for dx in 0..win.dst_width {
                plane[row + dx] =
                    masked_sample(data[dy * win.dst_width + dx], nodata, nd.suppress_mask);
            }
        }
    }
    Ok(Some(out))
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

    // ==================== TileRequest Tests ====================

    #[test]
    fn test_tile_request_copy() {
        let req = TileRequest {
            x: 10,
            y: 20,
            z: 5,
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

    // ==================== Raw Tile Tests ====================

    #[test]
    fn test_raw_tile_inside_footprint() {
        let ds = crate::gdal::georef::synthetic_rpc_dataset();
        let samples = extract_raw_tile(&ds, &rpc_tile_request(), &[1])
            .unwrap()
            .expect("tile overlaps the raster");
        assert_eq!(samples.len(), 256 * 256);
        assert!(samples.iter().all(|&v| (v - 7.0).abs() < 1e-6));
    }

    #[test]
    fn test_raw_tile_outside_raster_is_none() {
        let ds = crate::gdal::georef::synthetic_rpc_dataset();
        let req = TileRequest {
            x: 0,
            y: 0,
            ..rpc_tile_request()
        };
        assert!(extract_raw_tile(&ds, &req, &[1]).unwrap().is_none());
    }

    /// Non-georeferenced 200x100 image: band 1 = column index + 1, band 2 = 5,
    /// with nodata 5 declared on band 2.
    fn pixel_dataset() -> Dataset {
        let driver = DriverManager::get_driver_by_name("MEM").unwrap();
        let mut ds = driver
            .create_with_band_type::<f64, _>("", 200, 100, 2)
            .unwrap();
        fill_with_column_index(&mut ds);
        let mut buf = gdal::raster::Buffer::new((200, 100), vec![5.0; 200 * 100]);
        let mut band2 = ds.rasterband(2).unwrap();
        band2.write((0, 0), (200, 100), &mut buf).unwrap();
        band2.set_no_data_value(Some(5.0)).unwrap();
        ds
    }

    #[test]
    fn test_raw_pixel_tile_places_image_and_masks_nodata() {
        let ds = pixel_dataset();
        // z=0 covers the world; the 2°x1° image fills a few pixels at its center.
        let req = TileRequest {
            x: 0,
            y: 0,
            z: 0,
            tile_size: 256,
        };
        let samples = extract_raw_pixel_tile(&ds, &req, &[1, 2])
            .unwrap()
            .expect("tile overlaps the image");
        assert_eq!(samples.len(), 2 * 256 * 256);
        let (band1, band2) = samples.split_at(256 * 256);
        let valid = band1.iter().filter(|v| !v.is_nan()).count();
        assert!(
            valid > 0 && valid < 256 * 256,
            "image fills part of the tile"
        );
        assert!(band1
            .iter()
            .all(|&v| v.is_nan() || (1.0..=200.0).contains(&v)));
        assert!(band2.iter().all(|v| v.is_nan()), "band 2 is all nodata");
    }

    #[test]
    fn test_raw_pixel_tile_outside_image_is_none() {
        let ds = pixel_dataset();
        // z=4 tile at the antimeridian, far from the image at 0,0.
        let req = TileRequest {
            x: 0,
            y: 0,
            z: 4,
            tile_size: 256,
        };
        assert!(extract_raw_pixel_tile(&ds, &req, &[1]).unwrap().is_none());
    }
}
