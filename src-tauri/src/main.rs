// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod gdal;

use commands::app::get_version;
use commands::raster::{
    close_dataset, get_cross_layer_pixel_rgb_tile, get_cross_layer_rgb_tile, get_histogram,
    get_pixel_tile, get_raster_stats, get_rgb_tile, get_tile, get_tile_stretched, open_raster,
};
use commands::vector::open_vector;
use gdal::dataset_cache::DatasetCache;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
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
            open_vector
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
