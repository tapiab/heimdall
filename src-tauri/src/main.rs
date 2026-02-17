// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod gdal;

use commands::app::get_version;
use commands::georef::{apply_georeference, calculate_transformation};
use commands::raster::{
    close_dataset, get_cross_layer_pixel_rgb_tile, get_cross_layer_rgb_tile, get_elevation_profile,
    get_elevation_profile_pixels, get_histogram, get_pixel_tile, get_raster_stats, get_rgb_tile,
    get_tile, get_tile_stretched, open_raster, query_pixel_value, query_pixel_value_at_pixel,
};
use commands::stac::{
    browse_static_collection, connect_stac_api, fetch_stac_resource, get_static_catalog_children,
    list_stac_collections, open_stac_asset, search_stac_items,
};
use commands::vector::open_vector;
use gdal::dataset_cache::DatasetCache;

/// Initialize GDAL configuration for remote file access via /vsicurl/
fn init_gdal_for_remote_access() {
    use ::gdal::{config, DriverManager};

    // Set environment variables BEFORE any GDAL calls
    // This ensures they're picked up during GDAL initialization
    std::env::set_var("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR");
    std::env::set_var("GDAL_HTTP_USERAGENT", "Heimdall/0.3 GDAL");
    std::env::set_var("GDAL_HTTP_CONNECTTIMEOUT", "60");
    std::env::set_var("GDAL_HTTP_TIMEOUT", "120");
    std::env::set_var("VSI_CACHE", "TRUE");
    std::env::set_var("VSI_CACHE_SIZE", "50000000"); // 50MB cache
    std::env::set_var(
        "CPL_VSIL_CURL_ALLOWED_EXTENSIONS",
        ".tif,.tiff,.TIF,.TIFF,.vrt,.VRT",
    );

    // Force driver registration - this triggers GDAL initialization
    let _driver_count = DriverManager::count();

    // Also set via config API for good measure
    let _ = config::set_config_option("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR");
    let _ = config::set_config_option("GDAL_HTTP_USERAGENT", "Heimdall/0.3 GDAL");
    let _ = config::set_config_option("GDAL_HTTP_CONNECTTIMEOUT", "60");
    let _ = config::set_config_option("GDAL_HTTP_TIMEOUT", "120");
    let _ = config::set_config_option("VSI_CACHE", "TRUE");
    let _ = config::set_config_option("VSI_CACHE_SIZE", "50000000");
    let _ = config::set_config_option(
        "CPL_VSIL_CURL_ALLOWED_EXTENSIONS",
        ".tif,.tiff,.TIF,.TIFF,.vrt,.VRT",
    );

    println!(
        "[GDAL] Initialized for remote access with {} drivers (GDAL {})",
        _driver_count,
        ::gdal::version::version_info("VERSION_NUM")
    );
}

fn main() {
    // Fix EGL_BAD_PARAMETER error on Arch Linux and other distros with newer Mesa
    // This must be set before WebKitGTK initializes
    #[cfg(target_os = "linux")]
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    // Initialize GDAL settings for remote file access
    // This must be done before any GDAL operations
    init_gdal_for_remote_access();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .manage(DatasetCache::new(10))
        .invoke_handler(tauri::generate_handler![
            get_version,
            open_raster,
            get_tile,
            get_tile_stretched,
            get_rgb_tile,
            get_cross_layer_rgb_tile,
            get_cross_layer_pixel_rgb_tile,
            get_pixel_tile,
            get_raster_stats,
            get_histogram,
            close_dataset,
            open_vector,
            query_pixel_value,
            query_pixel_value_at_pixel,
            get_elevation_profile,
            get_elevation_profile_pixels,
            // STAC commands
            connect_stac_api,
            list_stac_collections,
            search_stac_items,
            open_stac_asset,
            // Static STAC catalog commands
            get_static_catalog_children,
            fetch_stac_resource,
            browse_static_collection,
            // Georeferencing commands
            calculate_transformation,
            apply_georeference
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
