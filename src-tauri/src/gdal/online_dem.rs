//! Copernicus GLO-30 as an on-demand online DEM for RPC projection.
//!
//! The DEM is published as 1°×1° Cloud-Optimized GeoTIFFs on AWS Open Data
//! (public, no credentials). We mosaic only the tiles a scene's footprint
//! touches into a VRT of `/vsicurl/` sources, so GDAL fetches just the DEM
//! blocks the RPC transformer actually samples.
//!
//! Copernicus heights are relative to the EGM2008 geoid while RPC models expect
//! heights above the WGS84 ellipsoid; the difference (geoid undulation N) is
//! returned so it can be added to DEM heights. N varies by well under a meter
//! across a single scene, so one value at the footprint center is enough.

use gdal::programs::raster::build_vrt;
use gdal::spatial_ref::{AxisMappingStrategy, CoordTransform, SpatialRef};
use gdal::Dataset;
use std::path::PathBuf;

const COPERNICUS_GLO30_URL: &str = "https://copernicus-dem-30m.s3.amazonaws.com";

/// Extra margin (degrees) around the flat-terrain footprint: terrain height
/// moves the footprint, and DEM cells just outside it get sampled too.
const FOOTPRINT_MARGIN_DEG: f64 = 0.05;

/// Tile id for the 1°×1° cell whose south-west corner is (`lon`, `lat`),
/// e.g. `Copernicus_DSM_COG_10_N32_00_W098_00_DEM`.
fn tile_name(lon: i32, lat: i32) -> String {
    let ns = if lat >= 0 { 'N' } else { 'S' };
    let ew = if lon >= 0 { 'E' } else { 'W' };
    format!(
        "Copernicus_DSM_COG_10_{}{:02}_00_{}{:03}_00_DEM",
        ns,
        lat.abs(),
        ew,
        lon.abs()
    )
}

fn tile_url(lon: i32, lat: i32) -> String {
    let name = tile_name(lon, lat);
    format!("/vsicurl/{}/{}/{}.tif", COPERNICUS_GLO30_URL, name, name)
}

/// South-west corners of every 1° cell intersecting `bounds`
/// (`[min_lon, min_lat, max_lon, max_lat]`).
fn cells_covering(bounds: [f64; 4]) -> Vec<(i32, i32)> {
    let lon0 = bounds[0].floor().max(-180.0) as i32;
    let lon1 = (bounds[2].ceil() as i32).min(180);
    let lat0 = bounds[1].floor().max(-90.0) as i32;
    let lat1 = (bounds[3].ceil() as i32).min(90);
    let mut cells = Vec::new();
    for lat in lat0..lat1.max(lat0 + 1) {
        for lon in lon0..lon1.max(lon0 + 1) {
            cells.push((lon, lat));
        }
    }
    cells
}

fn cache_dir() -> Result<PathBuf, String> {
    let dir = dirs::cache_dir()
        .ok_or("No cache directory")?
        .join("heimdall")
        .join("dem");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create DEM cache: {}", e))?;
    Ok(dir)
}

/// Build (or reuse) a VRT mosaicking the Copernicus GLO-30 tiles over
/// `footprint`. Cells without a tile (open ocean) are skipped. Returns the
/// VRT path.
pub fn copernicus_vrt_for(footprint: [f64; 4]) -> Result<String, String> {
    let padded = [
        footprint[0] - FOOTPRINT_MARGIN_DEG,
        footprint[1] - FOOTPRINT_MARGIN_DEG,
        footprint[2] + FOOTPRINT_MARGIN_DEG,
        footprint[3] + FOOTPRINT_MARGIN_DEG,
    ];
    let cells = cells_covering(padded);
    let key = cells
        .iter()
        .map(|&(lon, lat)| format!("{}_{}", lon, lat))
        .collect::<Vec<_>>()
        .join("-");
    let vrt_path = cache_dir()?.join(format!("copernicus_glo30_{}.vrt", key));
    if vrt_path.exists() {
        return Ok(vrt_path.to_string_lossy().into_owned());
    }

    let tiles: Vec<Dataset> = cells
        .iter()
        .filter_map(|&(lon, lat)| Dataset::open(tile_url(lon, lat)).ok())
        .collect();
    if tiles.is_empty() {
        return Err(
            "No Copernicus DEM tiles for this area (open ocean, or no network access)".to_string(),
        );
    }

    build_vrt(Some(&vrt_path), &tiles, None)
        .map_err(|e| format!("Failed to build DEM mosaic: {}", e))?;
    Ok(vrt_path.to_string_lossy().into_owned())
}

/// EGM2008 geoid undulation N (meters) at `lon`/`lat`: add it to a geoid
/// (orthometric) height to get a WGS84 ellipsoidal height.
///
/// Needs PROJ's EGM2008 grid; PROJ network access is enabled just for this
/// lookup so the grid is fetched once from the PROJ CDN and cached by PROJ.
pub fn egm2008_undulation(lon: f64, lat: f64) -> Result<f64, String> {
    let previous = unsafe { gdal_sys::OSRGetPROJEnableNetwork() };
    unsafe { gdal_sys::OSRSetPROJEnableNetwork(1) };
    let result = (|| {
        let mut geoid = SpatialRef::from_definition("EPSG:4326+3855")
            .map_err(|e| format!("EGM2008 CRS: {}", e))?;
        let mut ellipsoid = SpatialRef::from_epsg(4979).map_err(|e| format!("EPSG:4979: {}", e))?;
        geoid.set_axis_mapping_strategy(AxisMappingStrategy::TraditionalGisOrder);
        ellipsoid.set_axis_mapping_strategy(AxisMappingStrategy::TraditionalGisOrder);
        let transform = CoordTransform::new(&geoid, &ellipsoid)
            .map_err(|e| format!("Geoid transform: {}", e))?;
        let (mut xs, mut ys, mut zs) = ([lon], [lat], [0.0]);
        transform
            .transform_coords(&mut xs, &mut ys, &mut zs)
            .map_err(|e| format!("Geoid lookup failed: {}", e))?;
        // Without the grid PROJ silently falls back to a no-op ballpark
        // transform; an exact 0 almost certainly means that, not N = 0.
        if !zs[0].is_finite() || zs[0] == 0.0 {
            return Err("EGM2008 geoid grid unavailable".to_string());
        }
        Ok(zs[0])
    })();
    unsafe { gdal_sys::OSRSetPROJEnableNetwork(previous) };
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tile_name() {
        assert_eq!(
            tile_name(-98, 32),
            "Copernicus_DSM_COG_10_N32_00_W098_00_DEM"
        );
        assert_eq!(tile_name(9, -1), "Copernicus_DSM_COG_10_S01_00_E009_00_DEM");
        assert_eq!(tile_name(0, 0), "Copernicus_DSM_COG_10_N00_00_E000_00_DEM");
    }

    #[test]
    fn test_cells_covering() {
        // Fort Worth scene, padded: inside one cell.
        assert_eq!(
            cells_covering([-97.53, 32.66, -97.27, 32.98]),
            vec![(-98, 32)]
        );
        // Straddling a meridian and a parallel.
        assert_eq!(
            cells_covering([-0.2, 44.9, 0.3, 45.1]),
            vec![(-1, 44), (0, 44), (-1, 45), (0, 45)]
        );
        // Exactly on an integer edge still yields its cell.
        assert_eq!(cells_covering([10.0, 45.0, 10.0, 45.0]), vec![(10, 45)]);
    }

    /// Hits the network (AWS + PROJ CDN): run with `--ignored`.
    #[test]
    #[ignore]
    fn test_online_copernicus_fort_worth() {
        let vrt = copernicus_vrt_for([-97.48, 32.71, -97.32, 32.93]).unwrap();
        let ds = Dataset::open(&vrt).unwrap();
        assert!(ds.raster_size().0 >= 3600);

        let n = egm2008_undulation(-97.4, 32.8).unwrap();
        assert!((n - -28.8).abs() < 0.5, "N = {}", n);
    }
}
