//! How a raster maps pixels to the ground, and a safe wrapper around GDAL's
//! generic image-projection transformer so tiles, bounds and pixel queries all
//! share the same model (affine geotransform or RPC).

use gdal::{Dataset, Metadata};
use gdal_sys::{
    CSLDestroy, CSLSetNameValue, GDALCreateGenImgProjTransformer2,
    GDALDestroyGenImgProjTransformer, GDALGenImgProjTransform,
    GDALSetGenImgProjTransformerDstGeoTransform,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::{c_char, c_void, CString};
use std::sync::{LazyLock, Mutex, RwLock};

/// Pixel-to-ground model used to place a raster on the map.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GeorefMethod {
    /// Affine geotransform (+ optional projection).
    GeoTransform,
    /// Rational Polynomial Coefficients, projected on the fly against a DEM or constant height.
    Rpc,
    /// No usable georeferencing; displayed in synthetic pixel coordinates.
    #[default]
    None,
}

/// Whether the dataset carries a real (non-identity) geotransform or a projection.
pub fn has_geotransform(dataset: &Dataset) -> bool {
    let has_projection = !dataset.projection().is_empty();

    let gt = match dataset.geo_transform() {
        Ok(gt) => gt,
        Err(_) => return has_projection,
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

/// Whether the dataset exposes an RPC model (embedded, .RPB or _RPC.TXT sidecar).
pub fn has_rpc(dataset: &Dataset) -> bool {
    dataset
        .metadata_domain("RPC")
        .is_some_and(|items| items.iter().any(|i| i.starts_with("LINE_NUM_COEFF")))
}

/// Pick the georeferencing model. A real geotransform wins over RPC, matching
/// gdalwarp's default precedence.
pub fn georef_method(dataset: &Dataset) -> GeorefMethod {
    if has_geotransform(dataset) {
        GeorefMethod::GeoTransform
    } else if has_rpc(dataset) {
        GeorefMethod::Rpc
    } else {
        GeorefMethod::None
    }
}

/// Constant height (meters above ellipsoid) used to intersect RPC rays with the
/// ground. The model's HEIGHT_OFF is the scene's mean height, which is a far
/// better default than GDAL's 0 for anything above sea level.
pub fn rpc_default_height(dataset: &Dataset) -> Option<f64> {
    dataset
        .metadata_item("HEIGHT_OFF", "RPC")?
        .split_whitespace()
        .next()?
        .parse::<f64>()
        .ok()
        .filter(|h| h.is_finite())
}

/// User-chosen terrain for RPC orthorectification.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RpcElevation {
    /// DEM raster sampled for per-pixel heights. Cells it doesn't cover fall
    /// back to `height` (or the model's HEIGHT_OFF).
    pub dem_path: Option<String>,
    /// Constant height override in meters; replaces HEIGHT_OFF.
    pub height: Option<f64>,
}

/// Elevation settings keyed by dataset path. Tile code only sees a pooled
/// `Dataset`, whose description is the path it was opened with, so a path key
/// reaches every pooled handle without threading options through each call.
static RPC_ELEVATION: LazyLock<RwLock<HashMap<String, RpcElevation>>> =
    LazyLock::new(Default::default);

pub fn set_rpc_elevation(path: &str, elevation: RpcElevation) {
    let mut map = RPC_ELEVATION.write().unwrap();
    if elevation == RpcElevation::default() {
        map.remove(path);
    } else {
        map.insert(path.to_string(), elevation);
    }
}

pub fn get_rpc_elevation(path: &str) -> RpcElevation {
    RPC_ELEVATION
        .read()
        .unwrap()
        .get(path)
        .cloned()
        .unwrap_or_default()
}

fn rpc_elevation(dataset: &Dataset) -> RpcElevation {
    dataset
        .description()
        .map(|path| get_rpc_elevation(&path))
        .unwrap_or_default()
}

/// GDAL transformer options for an RPC dataset's current elevation settings.
fn rpc_transformer_options(dataset: &Dataset) -> Vec<(&'static str, String)> {
    let elevation = rpc_elevation(dataset);
    let height = elevation.height.or_else(|| rpc_default_height(dataset));

    let mut pairs = vec![("METHOD", "RPC".to_string())];
    match elevation.dem_path {
        Some(dem) => {
            pairs.push(("RPC_DEM", dem));
            pairs.push(("RPC_DEMINTERPOLATION", "BILINEAR".to_string()));
            // RPC_HEIGHT would be added on top of DEM heights, so it only
            // serves as the fill value outside the DEM.
            if let Some(h) = height {
                pairs.push(("RPC_DEM_MISSING_VALUE", h.to_string()));
            }
        }
        None => {
            if let Some(h) = height {
                pairs.push(("RPC_HEIGHT", h.to_string()));
            }
        }
    }
    pairs
}

/// Owned GDAL string list, freed on drop.
struct CslOptions(*mut *mut c_char);

impl CslOptions {
    fn new(pairs: &[(&str, String)]) -> Result<Self, String> {
        let mut list = CslOptions(std::ptr::null_mut());
        for (key, value) in pairs {
            let k = CString::new(*key).map_err(|e| e.to_string())?;
            let v = CString::new(value.as_str()).map_err(|e| e.to_string())?;
            list.0 = unsafe { CSLSetNameValue(list.0, k.as_ptr(), v.as_ptr()) };
        }
        Ok(list)
    }
}

impl Drop for CslOptions {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CSLDestroy(self.0) };
        }
    }
}

/// RAII wrapper over `GDALCreateGenImgProjTransformer2`.
///
/// "Source" coordinates are pixel/line of `src`. "Destination" coordinates are
/// pixel/line of `dst` when given, otherwise georeferenced coordinates in
/// `dst_srs` (or the source's own SRS — lon/lat WGS84 for RPC — when `None`).
pub struct GenImgTransformer(*mut c_void);

impl GenImgTransformer {
    pub fn new(
        src: &Dataset,
        dst: Option<&Dataset>,
        method: GeorefMethod,
        dst_srs: Option<&str>,
    ) -> Result<Self, String> {
        let mut pairs = match method {
            GeorefMethod::Rpc => rpc_transformer_options(src),
            // No GCP fallback: identity-geotransform rasters with a projection
            // have always been warped by their geotransform.
            GeorefMethod::GeoTransform | GeorefMethod::None => {
                vec![("METHOD", "GEOTRANSFORM".to_string())]
            }
        };
        if let Some(srs) = dst_srs {
            pairs.push(("DST_SRS", srs.to_string()));
        }
        let options = CslOptions::new(&pairs)?;

        let arg = unsafe {
            GDALCreateGenImgProjTransformer2(
                src.c_dataset(),
                dst.map_or(std::ptr::null_mut(), |d| d.c_dataset()),
                options.0 as _,
            )
        };
        if arg.is_null() {
            return Err(format!("Failed to create {:?} transformer", method));
        }
        Ok(Self(arg))
    }

    pub fn as_ptr(&self) -> *mut c_void {
        self.0
    }

    /// Transform points in place. Returns per-point success flags; failed
    /// points are also set to NaN so callers can't use them by accident.
    pub fn transform(&self, dst_to_src: bool, xs: &mut [f64], ys: &mut [f64]) -> Vec<bool> {
        let n = xs.len().min(ys.len());
        let mut zs = vec![0.0; n];
        let mut ok = vec![0i32; n];
        unsafe {
            GDALGenImgProjTransform(
                self.0,
                dst_to_src as i32,
                n as i32,
                xs.as_mut_ptr(),
                ys.as_mut_ptr(),
                zs.as_mut_ptr(),
                ok.as_mut_ptr(),
            );
        }
        let ok: Vec<bool> = ok.iter().map(|&s| s != 0).collect();
        for i in 0..n {
            if !ok[i] {
                xs[i] = f64::NAN;
                ys[i] = f64::NAN;
            }
        }
        ok
    }
}

impl Drop for GenImgTransformer {
    fn drop(&mut self) {
        unsafe { GDALDestroyGenImgProjTransformer(self.0) };
    }
}

const WEB_MERCATOR_RADIUS: f64 = 6378137.0;

fn lonlat_to_mercator(lon: f64, lat: f64) -> (f64, f64) {
    let x = WEB_MERCATOR_RADIUS * lon.to_radians();
    let y = WEB_MERCATOR_RADIUS
        * (std::f64::consts::FRAC_PI_4 + lat.to_radians() / 2.0)
            .tan()
            .ln();
    (x, y)
}

fn mercator_to_lonlat(x: f64, y: f64) -> (f64, f64) {
    let lon = (x / WEB_MERCATOR_RADIUS).to_degrees();
    let lat =
        (2.0 * (y / WEB_MERCATOR_RADIUS).exp().atan() - std::f64::consts::FRAC_PI_2).to_degrees();
    (lon, lat)
}

const IDENTITY_GT: [f64; 6] = [0.0, 1.0, 0.0, 0.0, 0.0, 1.0];

/// An RPC dataset's pixel ↔ EPSG:3857 transformer (which owns the opened DEM
/// and its block cache) plus its footprint, built for one elevation setting.
///
/// Building it means parsing the RPC model, opening the DEM and inverting the
/// model along the image edges, so it is cached per pooled dataset handle (see
/// `with_rpc_model`) instead of rebuilt for every tile.
pub struct RpcModel {
    elevation: RpcElevation,
    transformer: GenImgTransformer,
    bounds: Option<[f64; 4]>,
}

// The transformer is only ever used by the thread that checked the model out.
unsafe impl Send for RpcModel {}

impl RpcModel {
    fn new(dataset: &Dataset, elevation: RpcElevation) -> Result<Self, String> {
        let transformer =
            GenImgTransformer::new(dataset, None, GeorefMethod::Rpc, Some("EPSG:3857"))?;
        Ok(Self {
            elevation,
            transformer,
            bounds: None,
        })
    }

    /// Transformer whose destination is the raster described by `dst_gt` in
    /// EPSG:3857 (e.g. a tile). Re-targeted on every call, so callers never see
    /// a destination left over from a previous use.
    pub fn transformer_for(&self, dst_gt: &[f64; 6]) -> &GenImgTransformer {
        unsafe {
            GDALSetGenImgProjTransformerDstGeoTransform(self.transformer.as_ptr(), dst_gt.as_ptr())
        };
        &self.transformer
    }

    /// Footprint bbox `[min_lon, min_lat, max_lon, max_lat]`, sampled densely
    /// along the image edges since RPC footprints aren't affine.
    pub fn geo_bounds(&mut self, dataset: &Dataset) -> Result<[f64; 4], String> {
        if let Some(bounds) = self.bounds {
            return Ok(bounds);
        }

        const STEPS: usize = 16;
        let (w, h) = dataset.raster_size();
        let (w, h) = (w as f64, h as f64);

        let mut xs = Vec::with_capacity(STEPS * 4);
        let mut ys = Vec::with_capacity(STEPS * 4);
        for s in 0..STEPS {
            let t = s as f64 / STEPS as f64;
            xs.extend_from_slice(&[t * w, w, w - t * w, 0.0]);
            ys.extend_from_slice(&[0.0, t * h, h, h - t * h]);
        }
        self.transformer_for(&IDENTITY_GT)
            .transform(false, &mut xs, &mut ys);

        let mut bbox = [
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ];
        for (&x, &y) in xs.iter().zip(&ys) {
            if x.is_finite() && y.is_finite() {
                let (lon, lat) = mercator_to_lonlat(x, y);
                bbox[0] = bbox[0].min(lon);
                bbox[1] = bbox[1].min(lat);
                bbox[2] = bbox[2].max(lon);
                bbox[3] = bbox[3].max(lat);
            }
        }
        if !bbox.iter().all(|v| v.is_finite()) {
            return Err("RPC footprint could not be computed".to_string());
        }
        self.bounds = Some(bbox);
        Ok(bbox)
    }

    /// Map lon/lat (WGS84) points to fractional pixel/line in place. Points that
    /// fail come back as NaN.
    pub fn lonlat_to_pixel(&self, lons: &mut [f64], lats: &mut [f64]) {
        for (lon, lat) in lons.iter_mut().zip(lats.iter_mut()) {
            (*lon, *lat) = lonlat_to_mercator(*lon, *lat);
        }
        self.transformer_for(&IDENTITY_GT)
            .transform(true, lons, lats);
    }
}

/// Cached models keyed by dataset handle. Only handles registered through
/// `register_rpc_cache` (the long-lived pooled ones) get an entry; `None` means
/// registered but not built yet, or checked out by the thread using it.
static RPC_MODELS: LazyLock<Mutex<HashMap<usize, Option<RpcModel>>>> =
    LazyLock::new(Default::default);

fn dataset_key(dataset: &Dataset) -> usize {
    dataset.c_dataset() as usize
}

/// Let `with_rpc_model` keep this handle's model between calls. The handle
/// must be unregistered before it is closed.
pub fn register_rpc_cache(dataset: &Dataset) {
    RPC_MODELS
        .lock()
        .unwrap()
        .insert(dataset_key(dataset), None);
}

/// Drop this handle's cached model (and the DEM it holds open).
pub fn unregister_rpc_cache(dataset: &Dataset) {
    RPC_MODELS.lock().unwrap().remove(&dataset_key(dataset));
}

/// Run `f` with the dataset's RPC model, reusing the cached one when the
/// elevation settings haven't changed since it was built. The model is taken
/// out of the cache while `f` runs, so the cache lock isn't held during GDAL
/// work and the transformer is never shared between threads.
pub fn with_rpc_model<R>(
    dataset: &Dataset,
    f: impl FnOnce(&mut RpcModel) -> Result<R, String>,
) -> Result<R, String> {
    let key = dataset_key(dataset);
    let elevation = rpc_elevation(dataset);

    let (registered, cached) = {
        let mut models = RPC_MODELS.lock().unwrap();
        match models.get_mut(&key) {
            Some(slot) => (true, slot.take()),
            None => (false, None),
        }
    };

    let mut model = match cached {
        Some(model) if model.elevation == elevation => model,
        _ => RpcModel::new(dataset, elevation)?,
    };
    let result = f(&mut model);

    if registered {
        if let Some(slot) = RPC_MODELS.lock().unwrap().get_mut(&key) {
            *slot = Some(model);
        }
    }
    result
}

/// Footprint bbox `[min_lon, min_lat, max_lon, max_lat]` of an RPC raster.
pub fn rpc_geo_bounds(dataset: &Dataset) -> Result<[f64; 4], String> {
    with_rpc_model(dataset, |model| model.geo_bounds(dataset))
}

/// Map lon/lat (WGS84) points to fractional pixel/line through the RPC model.
/// Points that fail to invert come back as NaN.
pub fn rpc_lonlat_to_pixel(
    dataset: &Dataset,
    lons: &mut [f64],
    lats: &mut [f64],
) -> Result<(), String> {
    with_rpc_model(dataset, |model| {
        model.lonlat_to_pixel(lons, lats);
        Ok(())
    })
}

/// In-memory raster whose RPC model is a plain lon/lat grid: 100×100 pixels
/// of 0.01°, north up, every pixel = 7. RPC line/samp address pixel centers, so
/// GDAL places the footprint half a pixel off [9.5, 44.5, 10.5, 45.5] at the
/// default height of 0. Each 1000 m of height shifts samples +5 px east.
#[cfg(test)]
pub(crate) fn synthetic_rpc_dataset() -> Dataset {
    use gdal::DriverManager;

    let driver = DriverManager::get_driver_by_name("MEM").unwrap();
    let mut ds = driver
        .create_with_band_type::<f64, _>("", 100, 100, 1)
        .unwrap();
    ds.rasterband(1).unwrap().fill(7.0, None).unwrap();

    let zeros = |lead: &str| {
        let mut c = vec!["0"; 20];
        c.splice(0..lead.split(' ').count(), lead.split(' '));
        c.join(" ")
    };
    let items = [
        ("LINE_OFF", "50".to_string()),
        ("SAMP_OFF", "50".to_string()),
        ("LAT_OFF", "45".to_string()),
        ("LONG_OFF", "10".to_string()),
        ("HEIGHT_OFF", "0".to_string()),
        ("LINE_SCALE", "50".to_string()),
        ("SAMP_SCALE", "50".to_string()),
        ("LAT_SCALE", "0.5".to_string()),
        ("LONG_SCALE", "0.5".to_string()),
        ("HEIGHT_SCALE", "1000".to_string()),
        // Coefficient order: 1, L(lon), P(lat), H, ...
        ("LINE_NUM_COEFF", zeros("0 0 -1")),
        ("LINE_DEN_COEFF", zeros("1")),
        ("SAMP_NUM_COEFF", zeros("0 1 0 0.1")),
        ("SAMP_DEN_COEFF", zeros("1")),
    ];
    for (k, v) in items {
        ds.set_metadata_item(k, &v, "RPC").unwrap();
    }
    ds
}

/// Same as `synthetic_rpc_dataset`, but with a unique description so tests
/// that set elevation (keyed by description) don't race each other.
#[cfg(test)]
pub(crate) fn named_synthetic_rpc_dataset(name: &str) -> Dataset {
    let mut ds = synthetic_rpc_dataset();
    ds.set_description(name).unwrap();
    ds
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detects_rpc_when_no_geotransform() {
        let ds = synthetic_rpc_dataset();
        assert!(has_rpc(&ds));
        assert_eq!(georef_method(&ds), GeorefMethod::Rpc);
    }

    #[test]
    fn test_geotransform_wins_over_rpc() {
        let mut ds = synthetic_rpc_dataset();
        ds.set_geo_transform(&[9.5, 0.01, 0.0, 45.5, 0.0, -0.01])
            .unwrap();
        assert_eq!(georef_method(&ds), GeorefMethod::GeoTransform);
    }

    #[test]
    fn test_rpc_geo_bounds() {
        let b = rpc_geo_bounds(&synthetic_rpc_dataset()).unwrap();
        let expected = [9.495, 44.505, 10.495, 45.505];
        for (got, want) in b.iter().zip(expected) {
            assert!(
                (got - want).abs() < 1e-3,
                "bounds {:?} != {:?}",
                b,
                expected
            );
        }
    }

    #[test]
    fn test_rpc_lonlat_to_pixel() {
        let ds = synthetic_rpc_dataset();
        let mut lons = [10.0, 9.75];
        let mut lats = [45.0, 45.25];
        rpc_lonlat_to_pixel(&ds, &mut lons, &mut lats).unwrap();
        // +0.5: RPC addresses pixel centers, GDAL pixel space addresses corners.
        assert!((lons[0] - 50.5).abs() < 1e-3 && (lats[0] - 50.5).abs() < 1e-3);
        assert!((lons[1] - 25.5).abs() < 1e-3 && (lats[1] - 25.5).abs() < 1e-3);
    }

    #[test]
    fn test_rpc_default_height_parses_units() {
        let mut ds = synthetic_rpc_dataset();
        ds.set_metadata_item("HEIGHT_OFF", "+0245 meters", "RPC")
            .unwrap();
        assert_eq!(rpc_default_height(&ds), Some(245.0));
    }

    /// Sample/line of lon 10, lat 45 under the dataset's current elevation.
    fn center_pixel(ds: &Dataset) -> (f64, f64) {
        let (mut xs, mut ys) = ([10.0], [45.0]);
        rpc_lonlat_to_pixel(ds, &mut xs, &mut ys).unwrap();
        (xs[0], ys[0])
    }

    #[test]
    fn test_rpc_height_override() {
        let ds = named_synthetic_rpc_dataset("rpc-height-override");
        assert!((center_pixel(&ds).0 - 50.5).abs() < 1e-3);

        set_rpc_elevation(
            "rpc-height-override",
            RpcElevation {
                dem_path: None,
                height: Some(1000.0),
            },
        );
        let (x, y) = center_pixel(&ds);
        assert!((x - 55.5).abs() < 1e-3, "x = {}", x);
        assert!((y - 50.5).abs() < 1e-3, "y = {}", y);

        set_rpc_elevation("rpc-height-override", RpcElevation::default());
        assert!((center_pixel(&ds).0 - 50.5).abs() < 1e-3);
    }

    #[test]
    fn test_rpc_dem() {
        use gdal::spatial_ref::SpatialRef;
        use gdal::DriverManager;

        // Flat 2000 m DEM over the footprint's west half only.
        let dem_path = "/vsimem/rpc_test_dem.tif";
        {
            let driver = DriverManager::get_driver_by_name("GTiff").unwrap();
            let mut dem = driver
                .create_with_band_type::<f32, _>(dem_path, 50, 100, 1)
                .unwrap();
            dem.set_geo_transform(&[9.4, 0.012, 0.0, 45.6, 0.0, -0.012])
                .unwrap();
            dem.set_spatial_ref(&SpatialRef::from_epsg(4326).unwrap())
                .unwrap();
            dem.rasterband(1).unwrap().fill(2000.0, None).unwrap();
        }

        let ds = named_synthetic_rpc_dataset("rpc-dem");
        set_rpc_elevation(
            "rpc-dem",
            RpcElevation {
                dem_path: Some(dem_path.to_string()),
                height: Some(1000.0),
            },
        );

        // Inside the DEM: 2000 m → +10 px.
        let (mut xs, mut ys) = ([9.75], [45.0]);
        rpc_lonlat_to_pixel(&ds, &mut xs, &mut ys).unwrap();
        assert!((xs[0] - 35.5).abs() < 1e-3, "x = {}", xs[0]);

        // Outside the DEM: falls back to the 1000 m height → +5 px.
        let (mut xs, mut ys) = ([10.3], [45.0]);
        rpc_lonlat_to_pixel(&ds, &mut xs, &mut ys).unwrap();
        assert!((xs[0] - 85.5).abs() < 1e-3, "x = {}", xs[0]);

        set_rpc_elevation("rpc-dem", RpcElevation::default());
        unsafe {
            let c = CString::new(dem_path).unwrap();
            gdal_sys::VSIUnlink(c.as_ptr());
        }
    }

    #[test]
    fn test_cached_model_follows_elevation_changes() {
        let ds = named_synthetic_rpc_dataset("rpc-cached");
        register_rpc_cache(&ds);

        let west_edge = |ds: &Dataset| rpc_geo_bounds(ds).unwrap()[0];
        assert!((center_pixel(&ds).0 - 50.5).abs() < 1e-3);
        let flat_west = west_edge(&ds);
        assert!(RPC_MODELS.lock().unwrap()[&dataset_key(&ds)].is_some());

        // Raising the terrain shifts samples east, so the footprint moves west.
        set_rpc_elevation(
            "rpc-cached",
            RpcElevation {
                dem_path: None,
                height: Some(1000.0),
            },
        );
        assert!((center_pixel(&ds).0 - 55.5).abs() < 1e-3);
        assert!((west_edge(&ds) - (flat_west - 0.05)).abs() < 1e-3);

        set_rpc_elevation("rpc-cached", RpcElevation::default());
        assert!((west_edge(&ds) - flat_west).abs() < 1e-9);

        unregister_rpc_cache(&ds);
        assert!(!RPC_MODELS.lock().unwrap().contains_key(&dataset_key(&ds)));
    }
}
