// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod gdal;

use commands::app::get_version;
use commands::raster::{
    close_dataset, get_cross_layer_pixel_rgb_tile, get_cross_layer_rgb_tile, get_elevation_profile,
    get_elevation_profile_pixels, get_histogram, get_pixel_tile, get_raster_stats, get_rgb_tile,
    get_tile, get_tile_stretched, open_raster, query_pixel_value, query_pixel_value_at_pixel,
};
use commands::stac::{connect_stac_api, list_stac_collections, open_stac_asset, search_stac_items};
use commands::vector::open_vector;
use gdal::dataset_cache::DatasetCache;

/// Initialize GDAL configuration for remote file access via /vsicurl/
fn init_gdal_for_remote_access() {
    use ::gdal::{config, DriverManager};

    // Force driver registration
    let _driver_count = DriverManager::count();

    // Minimal GDAL config - most options left at defaults
    let _ = config::set_config_option("GDAL_HTTP_USERAGENT", "Heimdall/0.1 GDAL");
    let _ = config::set_config_option("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR");
    let _ = config::set_config_option("VSI_CACHE", "FALSE");
}

fn main() {
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
            open_stac_asset
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
