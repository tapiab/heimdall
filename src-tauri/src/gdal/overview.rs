//! Overview (pyramid) selection for tile warps.
//!
//! The GDAL warp API, unlike the `gdalwarp` utility, never reads overviews by
//! itself: a zoomed-out tile otherwise decodes every full-resolution block the
//! tile covers (seconds per tile on large scenes). We pick the overview level
//! that matches the tile resolution and warp from a dataset opened at that
//! level with `OVERVIEW_LEVEL`, which rescales both the geotransform and RPC.

use crate::gdal::dataset_cache::SendDataset;
use gdal::{Dataset, DatasetOptions, GdalOpenFlags, Metadata};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

/// Coarsest overview whose resolution is still at least as fine as the
/// output, given how many full-resolution source pixels map onto one output
/// pixel. `None` means read full resolution.
pub fn pick_overview_level(dataset: &Dataset, src_px_per_dst_px: f64) -> Option<usize> {
    if !src_px_per_dst_px.is_finite() || src_px_per_dst_px <= 1.0 {
        return None;
    }
    let band = dataset.rasterband(1).ok()?;
    let count = band.overview_count().ok()?.max(0) as usize;
    let full_width = dataset.raster_size().0 as f64;

    let mut best = None;
    for level in 0..count {
        let Ok(ovr) = band.overview(level) else {
            continue;
        };
        let factor = full_width / ovr.size().0 as f64;
        // Small tolerance: overview sizes round, so a 2x level may be 2.0005x.
        if factor <= src_px_per_dst_px * 1.01 {
            match best {
                Some((_, f)) if f >= factor => {}
                _ => best = Some((level, factor)),
            }
        }
    }
    best.map(|(level, _)| level)
}

/// One handle's opened levels, by level. `None` means checked out by the
/// thread using it.
type OpenedLevels = HashMap<usize, Option<SendDataset>>;

/// Overview datasets opened for each long-lived handle, keyed by the handle.
static OVERVIEWS: LazyLock<Mutex<HashMap<usize, OpenedLevels>>> = LazyLock::new(Default::default);

fn dataset_key(dataset: &Dataset) -> usize {
    dataset.c_dataset() as usize
}

/// Let `with_overview` keep opened levels for this handle between calls.
pub fn register_overview_cache(dataset: &Dataset) {
    OVERVIEWS
        .lock()
        .unwrap()
        .insert(dataset_key(dataset), HashMap::new());
}

/// Close this handle's cached overview datasets.
pub fn unregister_overview_cache(dataset: &Dataset) {
    let removed = OVERVIEWS.lock().unwrap().remove(&dataset_key(dataset));
    drop(removed); // outside the lock: dropping closes GDAL datasets
}

fn open_overview(dataset: &Dataset, level: usize) -> Result<SendDataset, String> {
    let path = dataset
        .description()
        .map_err(|e| format!("Dataset has no path: {}", e))?;
    let level_option = format!("OVERVIEW_LEVEL={}", level);
    let options = DatasetOptions {
        open_flags: GdalOpenFlags::GDAL_OF_RASTER | GdalOpenFlags::GDAL_OF_READONLY,
        open_options: Some(&[level_option.as_str()]),
        ..Default::default()
    };
    let ds = Dataset::open_ex(&path, options)
        .map_err(|e| format!("Failed to open overview {}: {}", level, e))?;
    Ok(SendDataset::new(ds))
}

/// Run `f` on `dataset` opened at overview `level`, reusing the cached open
/// for registered handles. The overview is taken out of the cache while `f`
/// runs, so it's never shared between threads.
pub fn with_overview<R>(
    dataset: &Dataset,
    level: usize,
    f: impl FnOnce(&Dataset) -> Result<R, String>,
) -> Result<R, String> {
    let key = dataset_key(dataset);
    let (registered, cached) = {
        let mut cache = OVERVIEWS.lock().unwrap();
        match cache.get_mut(&key) {
            Some(levels) => (true, levels.get_mut(&level).and_then(Option::take)),
            None => (false, None),
        }
    };

    let overview = match cached {
        Some(ds) => ds,
        None => open_overview(dataset, level)?,
    };
    let result = f(&overview.0);

    if registered {
        let mut cache = OVERVIEWS.lock().unwrap();
        if let Some(levels) = cache.get_mut(&key) {
            levels.insert(level, Some(overview));
            return result;
        }
    }
    drop(overview);
    result
}

/// Longest side above which a raster without overviews gets a suggestion to
/// build them: beyond this, zoomed-out tiles decode noticeably many blocks.
const SUGGEST_OVERVIEWS_MIN_SIZE: usize = 2048;

/// Whether to offer building overviews: a large local raster with none.
/// Remote/virtual paths (/vsicurl/, /vsimem/, ...) can't take a sidecar.
pub fn should_suggest_overviews(dataset: &Dataset, path: &str) -> bool {
    let (w, h) = dataset.raster_size();
    let has_overviews = dataset
        .rasterband(1)
        .ok()
        .and_then(|b| b.overview_count().ok())
        .is_some_and(|n| n > 0);
    !has_overviews && w.max(h) > SUGGEST_OVERVIEWS_MIN_SIZE && !path.starts_with("/vsi")
}

/// Power-of-two decimation factors down to the last level whose longest side
/// is still above one tile (256 px), like `gdaladdo` without explicit levels.
pub fn overview_factors(width: usize, height: usize) -> Vec<i32> {
    let longest = width.max(height);
    let mut factors = Vec::new();
    let mut f = 2usize;
    while longest / f > 256 {
        factors.push(f as i32);
        f *= 2;
    }
    if factors.is_empty() && longest > 256 {
        factors.push(2);
    }
    factors
}

/// Sets thread-local GDAL config options for its lifetime.
struct ThreadConfig(Vec<std::ffi::CString>);

impl ThreadConfig {
    fn set(pairs: &[(&str, &str)]) -> Result<Self, String> {
        let mut keys = Vec::new();
        for (k, v) in pairs {
            let key = std::ffi::CString::new(*k).map_err(|e| e.to_string())?;
            let value = std::ffi::CString::new(*v).map_err(|e| e.to_string())?;
            unsafe { gdal_sys::CPLSetThreadLocalConfigOption(key.as_ptr(), value.as_ptr()) };
            keys.push(key);
        }
        Ok(Self(keys))
    }
}

impl Drop for ThreadConfig {
    fn drop(&mut self) {
        for key in &self.0 {
            unsafe { gdal_sys::CPLSetThreadLocalConfigOption(key.as_ptr(), std::ptr::null()) };
        }
    }
}

unsafe extern "C" fn progress_trampoline(
    complete: f64,
    _message: *const std::ffi::c_char,
    arg: *mut std::ffi::c_void,
) -> std::ffi::c_int {
    let callback = &mut *(arg as *mut &mut dyn FnMut(f64));
    callback(complete);
    1 // keep going
}

/// Build external (`.ovr`) overviews for the raster at `path`, leaving the
/// file itself untouched: opened read-only, GDAL writes a sidecar next to it.
/// `on_progress` receives 0.0..=1.0.
pub fn build_external_overviews(
    path: &str,
    mut on_progress: impl FnMut(f64),
) -> Result<(), String> {
    let ds = Dataset::open(path).map_err(|e| format!("Failed to open raster: {}", e))?;
    let (w, h) = ds.raster_size();
    let factors = overview_factors(w, h);
    if factors.is_empty() {
        return Ok(());
    }

    let _config = ThreadConfig::set(&[
        ("COMPRESS_OVERVIEW", "LZW"),
        ("BIGTIFF_OVERVIEW", "IF_SAFER"),
    ])?;
    let resampling = std::ffi::CString::new("AVERAGE").unwrap();
    let mut callback: &mut dyn FnMut(f64) = &mut on_progress;

    let rv = unsafe {
        gdal_sys::GDALBuildOverviews(
            ds.c_dataset(),
            resampling.as_ptr(),
            factors.len() as i32,
            factors.as_ptr(),
            0, // all bands
            std::ptr::null(),
            Some(progress_trampoline),
            &mut callback as *mut &mut dyn FnMut(f64) as *mut std::ffi::c_void,
        )
    };
    if rv != gdal_sys::CPLErr::CE_None {
        let detail = unsafe { std::ffi::CStr::from_ptr(gdal_sys::CPLGetLastErrorMsg()) }
            .to_string_lossy()
            .into_owned();
        return Err(format!("Failed to build overviews: {}", detail));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use gdal::DriverManager;

    fn gtiff(path: &str, w: usize, h: usize) {
        let driver = DriverManager::get_driver_by_name("GTiff").unwrap();
        let ds = driver
            .create_with_band_type::<u8, _>(path, w, h, 1)
            .unwrap();
        ds.rasterband(1).unwrap().fill(9.0, None).unwrap();
    }

    #[test]
    fn test_overview_factors() {
        assert_eq!(overview_factors(9520, 19359), vec![2, 4, 8, 16, 32, 64]);
        assert_eq!(overview_factors(1024, 512), vec![2]);
        assert_eq!(overview_factors(300, 300), vec![2]);
        assert!(overview_factors(256, 100).is_empty());
    }

    #[test]
    fn test_should_suggest_overviews() {
        let path = "/vsimem/suggest.tif";
        gtiff(path, 3000, 100);
        let ds = Dataset::open(path).unwrap();
        // Big enough, no overviews: suggested for a local path only.
        assert!(should_suggest_overviews(&ds, "/data/suggest.tif"));
        assert!(!should_suggest_overviews(&ds, path));
        drop(ds);

        let small = "/vsimem/suggest_small.tif";
        gtiff(small, 2048, 2048);
        let ds = Dataset::open(small).unwrap();
        assert!(!should_suggest_overviews(&ds, "/data/small.tif"));
        drop(ds);

        gdal::vsi::unlink_mem_file(path).unwrap();
        gdal::vsi::unlink_mem_file(small).unwrap();
    }

    #[test]
    fn test_build_external_overviews() {
        let path = "/vsimem/build_ovr.tif";
        gtiff(path, 3000, 1500);

        let mut progress = Vec::new();
        build_external_overviews(path, |p| progress.push(p)).unwrap();
        assert!(progress.last().is_some_and(|&p| (p - 1.0).abs() < 1e-9));
        assert!(progress.windows(2).all(|w| w[1] >= w[0]));

        // Sidecar written, source untouched; a fresh open sees the levels.
        let ovr = format!("{}.ovr", path);
        assert!(Dataset::open(&ovr).is_ok(), "no sidecar at {}", ovr);
        let ds = Dataset::open(path).unwrap();
        assert_eq!(ds.rasterband(1).unwrap().overview_count().unwrap(), 3);
        assert!(!should_suggest_overviews(&ds, "/data/build_ovr.tif"));
        assert_eq!(pick_overview_level(&ds, 8.0), Some(2));
        drop(ds);

        gdal::vsi::unlink_mem_file(&ovr).unwrap();
        gdal::vsi::unlink_mem_file(path).unwrap();
    }
}
