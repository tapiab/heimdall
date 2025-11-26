// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod gdal;

use commands::raster::{close_dataset, get_raster_stats, get_tile, get_tile_stretched, get_rgb_tile, get_cross_layer_rgb_tile, get_cross_layer_pixel_rgb_tile, get_pixel_tile, open_raster};
use gdal::dataset_cache::DatasetCache;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(DatasetCache::new(10))
        .invoke_handler(tauri::generate_handler![
            open_raster,
            get_tile,
            get_tile_stretched,
            get_rgb_tile,
            get_cross_layer_rgb_tile,
            get_cross_layer_pixel_rgb_tile,
            get_pixel_tile,
            get_raster_stats,
            close_dataset
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
