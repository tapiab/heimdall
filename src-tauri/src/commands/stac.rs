//! STAC (SpatioTemporal Asset Catalog) API Integration
//!
//! This module provides Tauri commands for browsing and loading data from STAC APIs,
//! enabling users to search satellite imagery catalogs and load Cloud Optimized GeoTIFFs
//! (COGs) directly into Heimdall.
//!
//! # Supported Operations
//!
//! - **Connect**: Connect to a STAC API and retrieve catalog metadata
//! - **List Collections**: Enumerate available data collections in a catalog
//! - **Search Items**: Query items with spatial, temporal, and property filters
//! - **Open Assets**: Load COG raster assets via GDAL's `/vsicurl/` virtual filesystem
//!
//! # Example STAC APIs
//!
//! - Earth Search (AWS): `https://earth-search.aws.element84.com/v1`
//! - Microsoft Planetary Computer: `https://planetarycomputer.microsoft.com/api/stac/v1`
//!
//! # Architecture
//!
//! The module uses `reqwest` for HTTP requests to STAC APIs and GDAL for opening
//! remote COG files. COGs are accessed via the `/vsicurl/` virtual filesystem,
//! which enables efficient tile-based streaming without downloading entire files.

use crate::gdal::dataset_cache::DatasetCache;
use gdal::spatial_ref::{CoordTransform, SpatialRef};
use gdal::{Dataset, Metadata};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::State;

use super::raster::{BandStats, RasterMetadata};

// ============================================================================
// STAC Data Structures
// ============================================================================

/// Represents a STAC Catalog - the root entity of a STAC API.
///
/// A catalog contains metadata about the API and links to collections.
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct StacCatalog {
    /// Unique identifier for the catalog
    pub id: String,
    /// Human-readable title
    pub title: Option<String>,
    /// Detailed description of the catalog
    pub description: String,
    /// Entity type, typically "Catalog"
    #[serde(rename = "type")]
    pub catalog_type: String,
    /// STAC specification version (e.g., "1.0.0")
    #[serde(rename = "stac_version")]
    pub stac_version: Option<String>,
    /// List of conformance URIs indicating supported capabilities
    #[serde(rename = "conformsTo")]
    pub conforms_to: Option<Vec<String>>,
}

/// Represents a STAC Collection - a group of related items (e.g., Sentinel-2 imagery).
///
/// Collections define the common properties, extent, and license for their items.
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct StacCollection {
    /// Unique identifier for the collection (e.g., "sentinel-2-l2a")
    pub id: String,
    /// Human-readable title
    pub title: Option<String>,
    /// Detailed description of the collection
    pub description: String,
    /// License for the data (e.g., "CC-BY-4.0", "proprietary")
    pub license: Option<String>,
    /// Spatial and temporal extent of the collection
    pub extent: Option<StacExtent>,
    /// Keywords for discoverability
    pub keywords: Option<Vec<String>>,
    /// Data providers (producers, hosts, processors)
    pub providers: Option<Vec<StacProvider>>,
    /// STAC specification version
    #[serde(rename = "stac_version")]
    pub stac_version: Option<String>,
}

/// Spatial and temporal extent of a STAC collection.
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct StacExtent {
    /// Spatial extent (bounding boxes)
    pub spatial: Option<StacSpatialExtent>,
    /// Temporal extent (time intervals)
    pub temporal: Option<StacTemporalExtent>,
}

/// Spatial extent as one or more bounding boxes.
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct StacSpatialExtent {
    /// Bounding boxes in [west, south, east, north] format
    pub bbox: Option<Vec<Vec<f64>>>,
}

/// Temporal extent as one or more time intervals.
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct StacTemporalExtent {
    /// Time intervals as [start, end] pairs (null means open-ended)
    pub interval: Option<Vec<Vec<Option<String>>>>,
}

/// A data provider associated with a STAC collection.
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct StacProvider {
    /// Organization name
    pub name: String,
    /// Roles: "producer", "licensor", "processor", "host"
    pub roles: Option<Vec<String>>,
    /// URL to the provider's homepage
    pub url: Option<String>,
}

/// Response from the /collections endpoint.
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct StacCollectionsResponse {
    /// List of available collections
    pub collections: Vec<StacCollection>,
}

/// Represents a STAC Item - a single spatiotemporal asset (e.g., one satellite scene).
///
/// Items contain geometry, timestamps, and links to downloadable assets.
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct StacItem {
    /// Unique identifier for the item
    pub id: String,
    /// GeoJSON type, always "Feature"
    #[serde(rename = "type")]
    pub item_type: String,
    /// Parent collection ID
    pub collection: Option<String>,
    /// GeoJSON geometry (typically the scene footprint)
    pub geometry: serde_json::Value,
    /// Bounding box in [west, south, east, north] format
    pub bbox: Option<Vec<f64>>,
    /// Item properties including datetime and sensor-specific metadata
    pub properties: StacItemProperties,
    /// Available assets (files) keyed by role (e.g., "visual", "B01", "thumbnail")
    pub assets: HashMap<String, StacAsset>,
    /// Links to related resources
    pub links: Option<Vec<StacLink>>,
}

/// Properties of a STAC Item including datetime and sensor-specific metadata.
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct StacItemProperties {
    /// Acquisition datetime in ISO 8601 format
    pub datetime: Option<String>,
    /// Cloud cover percentage (0-100), from eo:cloud_cover extension
    #[serde(rename = "eo:cloud_cover")]
    pub cloud_cover: Option<f64>,
    /// Additional properties not explicitly modeled
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Represents a downloadable asset within a STAC Item.
///
/// Assets are typically raster files (COGs), thumbnails, or metadata files.
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct StacAsset {
    /// URL to download the asset
    pub href: String,
    /// Human-readable title
    pub title: Option<String>,
    /// Detailed description
    pub description: Option<String>,
    /// Media type (e.g., "image/tiff; application=geotiff; profile=cloud-optimized")
    #[serde(rename = "type")]
    pub media_type: Option<String>,
    /// Asset roles (e.g., "data", "visual", "thumbnail", "overview")
    pub roles: Option<Vec<String>>,
    /// Band information for multispectral assets
    #[serde(rename = "eo:bands")]
    pub eo_bands: Option<Vec<EoBand>>,
}

/// Electro-optical band metadata from the eo:bands extension.
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct EoBand {
    /// Band name (e.g., "B01", "red")
    pub name: Option<String>,
    /// Common name (e.g., "coastal", "blue", "green", "red", "nir")
    pub common_name: Option<String>,
    /// Center wavelength in micrometers
    pub center_wavelength: Option<f64>,
}

/// A link to a related resource.
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct StacLink {
    /// URL of the linked resource
    pub href: String,
    /// Relationship type (e.g., "self", "root", "parent", "collection")
    pub rel: String,
    /// Media type of the linked resource
    #[serde(rename = "type")]
    pub link_type: Option<String>,
    /// Human-readable title
    pub title: Option<String>,
}

/// Parameters for searching STAC items.
///
/// All parameters are optional; omitting a parameter means no filtering on that criterion.
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct StacSearchParams {
    /// Filter by collection IDs
    pub collections: Option<Vec<String>>,
    /// Spatial filter as [west, south, east, north]
    pub bbox: Option<Vec<f64>>,
    /// Temporal filter in ISO 8601 format (e.g., "2024-01-01/2024-01-31")
    pub datetime: Option<String>,
    /// Maximum number of items to return (default: 20)
    pub limit: Option<u32>,
    /// Legacy STAC query extension (deprecated, use filter instead)
    pub query: Option<serde_json::Value>,
    /// CQL2-JSON filter for property filtering (e.g., cloud cover)
    pub filter: Option<serde_json::Value>,
    /// Filter language (e.g., "cql2-json")
    #[serde(rename = "filter-lang")]
    pub filter_lang: Option<String>,
}

/// Result of a STAC search query.
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct StacSearchResult {
    /// GeoJSON type, always "FeatureCollection"
    #[serde(rename = "type")]
    pub result_type: String,
    /// Matching items
    pub features: Vec<StacItem>,
    /// Total number of matching items (may be estimated)
    #[serde(rename = "numberMatched")]
    pub number_matched: Option<u64>,
    /// Number of items returned in this response
    #[serde(rename = "numberReturned")]
    pub number_returned: Option<u64>,
    /// Additional context about the search
    pub context: Option<StacSearchContext>,
}

/// Additional context from a STAC search response.
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct StacSearchContext {
    /// Total number of matching items
    pub matched: Option<u64>,
    /// Number of items returned
    pub returned: Option<u64>,
    /// Maximum items requested
    pub limit: Option<u32>,
}

// ============================================================================
// STAC API Commands
// ============================================================================

/// Connect to a STAC API and retrieve catalog metadata.
///
/// This is typically the first step when using a STAC API. The catalog
/// provides basic information about the API and what data is available.
///
/// # Arguments
///
/// * `url` - The base URL of the STAC API (e.g., "https://earth-search.aws.element84.com/v1")
///
/// # Returns
///
/// Returns the catalog metadata on success, or an error message on failure.
///
/// # Errors
///
/// Returns an error if:
/// - The URL is unreachable
/// - The response is not valid STAC catalog JSON
/// - The server returns an error status code
#[tauri::command]
pub async fn connect_stac_api(url: String) -> Result<StacCatalog, String> {
    let client = reqwest::Client::new();

    // Normalize URL - remove trailing slash
    let base_url = url.trim_end_matches('/');

    let response = client
        .get(base_url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Failed to connect to STAC API: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "STAC API returned error status: {}",
            response.status()
        ));
    }

    let catalog: StacCatalog = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse STAC catalog: {}", e))?;

    Ok(catalog)
}

/// List all collections available in a STAC catalog.
///
/// Collections group related items together (e.g., all Sentinel-2 imagery).
/// This returns metadata about each collection including spatial/temporal extent.
///
/// # Arguments
///
/// * `url` - The base URL of the STAC API
///
/// # Returns
///
/// Returns a vector of collection metadata on success.
#[tauri::command]
pub async fn list_stac_collections(url: String) -> Result<Vec<StacCollection>, String> {
    let client = reqwest::Client::new();

    // Normalize URL
    let base_url = url.trim_end_matches('/');
    let collections_url = format!("{}/collections", base_url);

    let response = client
        .get(&collections_url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch collections: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to fetch collections: HTTP {}",
            response.status()
        ));
    }

    let collections_response: StacCollectionsResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse collections: {}", e))?;

    Ok(collections_response.collections)
}

/// Search for STAC items matching specified filters.
///
/// This performs a POST request to the `/search` endpoint with the given parameters.
/// Items can be filtered by collection, bounding box, time range, and properties
/// like cloud cover.
///
/// # Arguments
///
/// * `url` - The base URL of the STAC API
/// * `params` - Search parameters (collections, bbox, datetime, limit, query)
///
/// # Returns
///
/// Returns a GeoJSON FeatureCollection of matching items.
///
/// # Example Search Parameters
///
/// ```json
/// {
///   "collections": ["sentinel-2-l2a"],
///   "bbox": [-122.5, 37.5, -122.0, 38.0],
///   "datetime": "2024-01-01/2024-01-31",
///   "limit": 20,
///   "query": {"eo:cloud_cover": {"lte": 10}}
/// }
/// ```
#[tauri::command]
pub async fn search_stac_items(
    url: String,
    params: StacSearchParams,
) -> Result<StacSearchResult, String> {
    let client = reqwest::Client::new();

    // Normalize URL
    let base_url = url.trim_end_matches('/');
    let search_url = format!("{}/search", base_url);

    // Build search body
    let mut body = serde_json::Map::new();

    if let Some(collections) = &params.collections {
        body.insert("collections".to_string(), serde_json::json!(collections));
    }

    if let Some(bbox) = &params.bbox {
        body.insert("bbox".to_string(), serde_json::json!(bbox));
    }

    if let Some(datetime) = &params.datetime {
        body.insert("datetime".to_string(), serde_json::json!(datetime));
    }

    let limit = params.limit.unwrap_or(20);
    body.insert("limit".to_string(), serde_json::json!(limit));

    // Add legacy query filter if provided (deprecated)
    if let Some(query) = &params.query {
        body.insert("query".to_string(), query.clone());
    }

    // Add CQL2 filter if provided (preferred)
    if let Some(filter) = &params.filter {
        body.insert("filter".to_string(), filter.clone());
    }
    if let Some(filter_lang) = &params.filter_lang {
        body.insert("filter-lang".to_string(), serde_json::json!(filter_lang));
    }

    let response = client
        .post(&search_url)
        .header("Accept", "application/geo+json")
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to search STAC items: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!(
            "STAC search failed: HTTP {} - {}",
            status, error_text
        ));
    }

    let response_text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    let result: StacSearchResult = serde_json::from_str(&response_text).map_err(|e| {
        // Include part of the response for debugging
        let preview = if response_text.len() > 200 {
            format!("{}...", &response_text[..200])
        } else {
            response_text.clone()
        };
        format!(
            "STAC response parsing error: {}. Response preview: {}",
            e, preview
        )
    })?;

    Ok(result)
}

/// Open a STAC asset (COG) via GDAL's `/vsicurl/` virtual filesystem.
///
/// This command enables loading Cloud Optimized GeoTIFFs (COGs) directly from
/// remote URLs without downloading the entire file. GDAL's virtual filesystem
/// fetches only the required tiles as needed.
///
/// # Arguments
///
/// * `asset_href` - The full URL to the COG file
/// * `state` - Shared dataset cache for managing open datasets
///
/// # Returns
///
/// Returns `RasterMetadata` with bounds, dimensions, band count, and statistics,
/// suitable for display in the layer manager.
///
/// # GDAL Configuration
///
/// This command configures GDAL for optimal COG access:
/// - `GDAL_HTTP_MULTIPLEX`: Enable HTTP/2 multiplexing
/// - `GDAL_DISABLE_READDIR_ON_OPEN`: Skip directory listing (faster for COGs)
/// - `GDAL_CACHEMAX`: Increased cache for better tile reuse
#[tauri::command]
pub async fn open_stac_asset(
    asset_href: String,
    state: State<'_, DatasetCache>,
) -> Result<RasterMetadata, String> {
    // Minimal GDAL config for remote COG access
    // Most options left at defaults to avoid conflicts
    gdal::config::set_config_option("GDAL_HTTP_USERAGENT", "Heimdall/0.1 GDAL").ok();
    gdal::config::set_config_option("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR").ok();
    gdal::config::set_config_option("VSI_CACHE", "FALSE").ok();
    gdal::config::set_config_option("GDAL_CACHEMAX", "512").ok();

    // Construct /vsicurl/ path - strip any existing /vsicurl/ prefix to avoid doubling
    // Also trim whitespace which might come from JSON parsing
    let asset_href = asset_href.trim();
    let clean_href = asset_href
        .strip_prefix("/vsicurl/")
        .unwrap_or(asset_href)
        .trim();

    // Sign Planetary Computer URLs - they require SAS tokens for access
    let clean_href = if clean_href.contains(".blob.core.windows.net") {
        sign_planetary_computer_url(clean_href).await?
    } else {
        clean_href.to_string()
    };
    let clean_href = clean_href.as_str();

    // Convert S3 URLs to HTTPS for public access without AWS credentials
    // Note: Some S3 buckets (like sentinel-s2-l2a) are requester-pays and need credentials
    let http_href = if clean_href.starts_with("s3://") {
        // Parse S3 URL: s3://bucket-name/path -> https://bucket-name.s3.amazonaws.com/path
        let s3_path = clean_href.strip_prefix("s3://").unwrap();
        let parts: Vec<&str> = s3_path.splitn(2, '/').collect();
        if parts.len() == 2 {
            let bucket = parts[0];
            let path = parts[1];

            // Check for requester-pays buckets that need AWS credentials
            // These buckets require AWS credentials with requester-pays enabled
            let requester_pays_buckets = [
                "sentinel-s2-l2a",    // Sentinel-2 original JP2 files
                "usgs-landsat",       // USGS Landsat Collection 2
                "sentinel-s1-l1c",    // Sentinel-1 data
                "sentinel-s2-l1c",    // Sentinel-2 L1C data
                "copernicus-dem-30m", // Copernicus DEM
                "copernicus-dem-90m", // Copernicus DEM
            ];

            if requester_pays_buckets.contains(&bucket) {
                return Err(format!(
                    "This asset is stored in a requester-pays S3 bucket ({}). \
                     AWS credentials are required to access this data. \
                     Try selecting a different collection or asset that uses public COG storage.",
                    bucket
                ));
            }

            // For public buckets, convert to HTTPS
            // sentinel-cogs bucket is in us-west-2
            if bucket == "sentinel-cogs" {
                format!("https://{}.s3.us-west-2.amazonaws.com/{}", bucket, path)
            } else {
                format!("https://{}.s3.amazonaws.com/{}", bucket, path)
            }
        } else {
            clean_href.to_string()
        }
    } else {
        clean_href.to_string()
    };

    let vsicurl_path = format!("/vsicurl/{}", http_href);

    eprintln!("[STAC] Opening: {}", vsicurl_path);

    // Clone values for the blocking task
    let path_clone = vsicurl_path.clone();
    let href_clone = http_href.to_string();

    // Use tokio's spawn_blocking to run GDAL in a separate blocking thread
    // This avoids potential issues with tokio's async runtime and GDAL's network operations
    let dataset = tokio::task::spawn_blocking(move || {
        // Reset all curl-related GDAL options to avoid conflicts
        gdal::config::set_config_option("CPL_CURL_VERBOSE", "NO").ok();
        gdal::config::set_config_option("GDAL_HTTP_UNSAFESSL", "YES").ok();
        gdal::config::set_config_option("GDAL_HTTP_TCP_KEEPALIVE", "NO").ok();
        gdal::config::set_config_option("GDAL_HTTP_CONNECTTIMEOUT", "30").ok();

        Dataset::open(&path_clone)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| {
        eprintln!("[STAC] GDAL error: {}", e);
        format!("Cannot open remote COG '{}': {}", href_clone, e)
    })?;

    let (width, height) = dataset.raster_size();
    let bands = dataset.raster_count();

    // Get georeferencing info
    let (bounds, native_bounds, pixel_size, is_georeferenced) = get_georef_info(&dataset)?;

    let projection = dataset.projection();
    let nodata = dataset.rasterband(1).ok().and_then(|b| b.no_data_value());

    // For remote COGs, use default stats for instant loading
    // Actual stats can be computed on-demand when needed for visualization
    let band_stats = get_default_band_stats(&dataset);

    let id = uuid::Uuid::new_v4().to_string();

    let metadata = RasterMetadata {
        id: id.clone(),
        path: vsicurl_path.clone(),
        width,
        height,
        bands,
        bounds,
        native_bounds,
        projection,
        pixel_size,
        nodata,
        band_stats,
        is_georeferenced,
    };

    // Store the vsicurl path in cache
    state.add(id, vsicurl_path);

    Ok(metadata)
}

// ============================================================================
// Helper Functions
// ============================================================================

/// Sign a Planetary Computer URL using their token API
/// Planetary Computer assets require SAS tokens for access
async fn sign_planetary_computer_url(url: &str) -> Result<String, String> {
    let client = reqwest::Client::new();

    eprintln!("[STAC] Signing Planetary Computer URL...");

    let response = client
        .get("https://planetarycomputer.microsoft.com/api/sas/v1/sign")
        .query(&[("href", url)])
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Failed to sign URL: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Planetary Computer signing failed: HTTP {}",
            response.status()
        ));
    }

    #[derive(serde::Deserialize)]
    struct SignResponse {
        href: String,
    }

    let signed: SignResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse signed URL: {}", e))?;

    eprintln!("[STAC] URL signed successfully");
    Ok(signed.href)
}

/// Get georeferencing info from dataset
#[allow(clippy::type_complexity)]
fn get_georef_info(dataset: &Dataset) -> Result<([f64; 4], [f64; 4], [f64; 2], bool), String> {
    let (width, height) = dataset.raster_size();

    // Check if georeferenced
    let has_projection = !dataset.projection().is_empty();
    let gt = dataset.geo_transform().ok();

    let is_georeferenced = has_projection
        && gt.is_some_and(|g| {
            // Not an identity transform
            !(g[0] == 0.0 && g[1] == 1.0 && g[2] == 0.0 && g[3] == 0.0 && g[5].abs() == 1.0)
        });

    if is_georeferenced {
        let gt = gt.unwrap();
        let native_bounds = [
            gt[0],                         // minx
            gt[3] + height as f64 * gt[5], // miny (gt[5] is negative)
            gt[0] + width as f64 * gt[1],  // maxx
            gt[3],                         // maxy
        ];

        // Transform to EPSG:4326
        let bounds = transform_bounds_to_4326(dataset, native_bounds)?;
        let pixel_size = [gt[1].abs(), gt[5].abs()];

        Ok((bounds, native_bounds, pixel_size, true))
    } else {
        // Non-georeferenced
        let pixel_bounds = [0.0, 0.0, width as f64, height as f64];
        Ok((pixel_bounds, pixel_bounds, [1.0, 1.0], false))
    }
}

/// Transform bounds from native CRS to EPSG:4326
fn transform_bounds_to_4326(
    dataset: &Dataset,
    native_bounds: [f64; 4],
) -> Result<[f64; 4], String> {
    let projection = dataset.projection();
    if projection.is_empty() {
        return Ok(native_bounds);
    }

    let mut source_srs =
        SpatialRef::from_wkt(&projection).map_err(|e| format!("Invalid projection: {}", e))?;

    let mut target_srs =
        SpatialRef::from_epsg(4326).map_err(|e| format!("Failed to create EPSG:4326: {}", e))?;

    // Set axis mapping to traditional GIS order (lon, lat)
    source_srs
        .set_axis_mapping_strategy(gdal::spatial_ref::AxisMappingStrategy::TraditionalGisOrder);
    target_srs
        .set_axis_mapping_strategy(gdal::spatial_ref::AxisMappingStrategy::TraditionalGisOrder);

    let transform = CoordTransform::new(&source_srs, &target_srs)
        .map_err(|e| format!("Failed to create transform: {}", e))?;

    // Transform corner points
    let mut xs = vec![
        native_bounds[0],
        native_bounds[2],
        native_bounds[0],
        native_bounds[2],
    ];
    let mut ys = vec![
        native_bounds[1],
        native_bounds[1],
        native_bounds[3],
        native_bounds[3],
    ];

    transform
        .transform_coords(&mut xs, &mut ys, &mut [])
        .map_err(|e| format!("Failed to transform coordinates: {}", e))?;

    // Find bounding box of transformed corners
    let minx = xs.iter().cloned().fold(f64::INFINITY, f64::min);
    let maxx = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let miny = ys.iter().cloned().fold(f64::INFINITY, f64::min);
    let maxy = ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max);

    Ok([minx, miny, maxx, maxy])
}

/// Get band stats for remote files
/// Tries to read statistics from raster metadata (fast, no pixel I/O)
/// Falls back to data-type based defaults if metadata not available
fn get_default_band_stats(dataset: &Dataset) -> Vec<BandStats> {
    use gdal::raster::GdalDataType;

    let mut stats = Vec::new();

    for i in 1..=dataset.raster_count() {
        if let Ok(band) = dataset.rasterband(i) {
            // Try to get statistics from metadata (STATISTICS_MINIMUM, STATISTICS_MAXIMUM)
            // These are often embedded in COG files and don't require reading pixel data
            let metadata_stats = get_band_metadata_stats(&band);

            let (min, max, mean, std_dev) =
                if let Some((m_min, m_max, m_mean, m_std)) = metadata_stats {
                    (m_min, m_max, m_mean, m_std)
                } else {
                    // Fall back to data-type based defaults
                    match band.band_type() {
                        GdalDataType::UInt8 => (0.0, 255.0, 128.0, 64.0),
                        GdalDataType::Int8 => (-128.0, 127.0, 0.0, 64.0),
                        GdalDataType::UInt16 => (0.0, 10000.0, 3000.0, 2000.0),
                        GdalDataType::Int16 => (-10000.0, 10000.0, 0.0, 2000.0),
                        GdalDataType::UInt32 => (0.0, 10000.0, 3000.0, 2000.0),
                        GdalDataType::Float32 | GdalDataType::Float64 => (0.0, 1.0, 0.3, 0.2),
                        _ => (0.0, 10000.0, 3000.0, 2000.0),
                    }
                };

            stats.push(BandStats {
                band: i,
                min,
                max,
                mean,
                std_dev,
            });
        }
    }

    stats
}

/// Try to extract statistics from band metadata
/// Returns (min, max, mean, std_dev) if available
fn get_band_metadata_stats(band: &gdal::raster::RasterBand) -> Option<(f64, f64, f64, f64)> {
    // Try to get pre-computed statistics from metadata
    let min: Option<f64> = band
        .metadata_item("STATISTICS_MINIMUM", "")
        .and_then(|s: String| s.parse::<f64>().ok());
    let max: Option<f64> = band
        .metadata_item("STATISTICS_MAXIMUM", "")
        .and_then(|s: String| s.parse::<f64>().ok());
    let mean: Option<f64> = band
        .metadata_item("STATISTICS_MEAN", "")
        .and_then(|s: String| s.parse::<f64>().ok());
    let std_dev: Option<f64> = band
        .metadata_item("STATISTICS_STDDEV", "")
        .and_then(|s: String| s.parse::<f64>().ok());

    // Only return if we have at least min and max
    match (min, max) {
        (Some(mi), Some(ma)) => {
            let me = mean.unwrap_or((mi + ma) / 2.0);
            let sd = std_dev.unwrap_or((ma - mi) / 4.0);
            Some((mi, ma, me, sd))
        }
        _ => None,
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use gdal::{DatasetOptions, GdalOpenFlags};

    // -------------------------------------------------------------------------
    // Data structure serialization tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_stac_catalog_serialization() {
        let catalog = StacCatalog {
            id: "test-catalog".to_string(),
            title: Some("Test Catalog".to_string()),
            description: "A test catalog".to_string(),
            catalog_type: "Catalog".to_string(),
            stac_version: Some("1.0.0".to_string()),
            conforms_to: Some(vec!["https://api.stacspec.org/v1.0.0/core".to_string()]),
        };

        let json = serde_json::to_string(&catalog).unwrap();
        assert!(json.contains("\"id\":\"test-catalog\""));
        assert!(json.contains("\"type\":\"Catalog\""));
    }

    #[test]
    fn test_stac_catalog_deserialization() {
        let json = r#"{
            "id": "earth-search",
            "type": "Catalog",
            "title": "Earth Search",
            "description": "Free satellite imagery",
            "stac_version": "1.0.0",
            "conformsTo": ["https://api.stacspec.org/v1.0.0/core"]
        }"#;

        let catalog: StacCatalog = serde_json::from_str(json).unwrap();
        assert_eq!(catalog.id, "earth-search");
        assert_eq!(catalog.title, Some("Earth Search".to_string()));
        assert_eq!(catalog.catalog_type, "Catalog");
    }

    #[test]
    fn test_stac_collection_deserialization() {
        let json = r#"{
            "id": "sentinel-2-l2a",
            "type": "Collection",
            "title": "Sentinel-2 L2A",
            "description": "Sentinel-2 Level 2A data",
            "license": "proprietary",
            "extent": {
                "spatial": {
                    "bbox": [[-180, -90, 180, 90]]
                },
                "temporal": {
                    "interval": [["2015-06-27T00:00:00Z", null]]
                }
            }
        }"#;

        let collection: StacCollection = serde_json::from_str(json).unwrap();
        assert_eq!(collection.id, "sentinel-2-l2a");
        assert_eq!(collection.title, Some("Sentinel-2 L2A".to_string()));
        assert_eq!(collection.license, Some("proprietary".to_string()));
        assert!(collection.extent.is_some());
    }

    #[test]
    fn test_stac_item_deserialization() {
        let json = r#"{
            "id": "S2A_123",
            "type": "Feature",
            "collection": "sentinel-2-l2a",
            "geometry": {
                "type": "Polygon",
                "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]
            },
            "bbox": [0, 0, 1, 1],
            "properties": {
                "datetime": "2023-01-15T10:30:00Z",
                "eo:cloud_cover": 5.5
            },
            "assets": {
                "visual": {
                    "href": "https://example.com/visual.tif",
                    "title": "Visual",
                    "type": "image/tiff; application=geotiff"
                }
            },
            "links": []
        }"#;

        let item: StacItem = serde_json::from_str(json).unwrap();
        assert_eq!(item.id, "S2A_123");
        assert_eq!(item.collection, Some("sentinel-2-l2a".to_string()));
        assert_eq!(item.properties.cloud_cover, Some(5.5));
        assert!(item.assets.contains_key("visual"));
    }

    #[test]
    fn test_stac_asset_deserialization() {
        let json = r#"{
            "href": "https://example.com/B04.tif",
            "title": "Band 4 (Red)",
            "type": "image/tiff; application=geotiff; profile=cloud-optimized",
            "roles": ["data", "visual"],
            "eo:bands": [
                {
                    "name": "B04",
                    "common_name": "red",
                    "center_wavelength": 0.665
                }
            ]
        }"#;

        let asset: StacAsset = serde_json::from_str(json).unwrap();
        assert_eq!(asset.href, "https://example.com/B04.tif");
        assert_eq!(asset.title, Some("Band 4 (Red)".to_string()));
        assert!(asset.roles.is_some());
        assert!(asset.eo_bands.is_some());

        let bands = asset.eo_bands.unwrap();
        assert_eq!(bands.len(), 1);
        assert_eq!(bands[0].common_name, Some("red".to_string()));
    }

    #[test]
    fn test_stac_search_params_serialization() {
        let params = StacSearchParams {
            collections: Some(vec!["sentinel-2-l2a".to_string()]),
            bbox: Some(vec![-122.5, 37.5, -122.0, 38.0]),
            datetime: Some("2023-01-01/2023-12-31".to_string()),
            limit: Some(10),
            query: None,
            filter: None,
            filter_lang: None,
        };

        let json = serde_json::to_string(&params).unwrap();
        assert!(json.contains("sentinel-2-l2a"));
        assert!(json.contains("-122.5"));
        assert!(json.contains("2023-01-01/2023-12-31"));
    }

    #[test]
    fn test_stac_search_result_deserialization() {
        let json = r#"{
            "type": "FeatureCollection",
            "features": [],
            "numberMatched": 100,
            "numberReturned": 10,
            "context": {
                "matched": 100,
                "returned": 10,
                "limit": 10
            }
        }"#;

        let result: StacSearchResult = serde_json::from_str(json).unwrap();
        assert_eq!(result.result_type, "FeatureCollection");
        assert_eq!(result.features.len(), 0);
        assert_eq!(result.number_matched, Some(100));
        assert_eq!(result.number_returned, Some(10));
    }

    // -------------------------------------------------------------------------
    // Search params with cloud cover query
    // -------------------------------------------------------------------------

    #[test]
    fn test_stac_search_params_with_query() {
        let query = serde_json::json!({
            "eo:cloud_cover": { "lte": 20 }
        });

        let params = StacSearchParams {
            collections: Some(vec!["sentinel-2-l2a".to_string()]),
            bbox: None,
            datetime: None,
            limit: Some(20),
            query: Some(query),
            filter: None,
            filter_lang: None,
        };

        let json = serde_json::to_string(&params).unwrap();
        assert!(json.contains("eo:cloud_cover"));
        assert!(json.contains("lte"));
    }

    #[test]
    fn test_stac_search_params_with_filter() {
        let filter = serde_json::json!({
            "op": "lte",
            "args": [{ "property": "eo:cloud_cover" }, 20]
        });

        let params = StacSearchParams {
            collections: Some(vec!["sentinel-2-l2a".to_string()]),
            bbox: None,
            datetime: None,
            limit: Some(20),
            query: None,
            filter: Some(filter),
            filter_lang: Some("cql2-json".to_string()),
        };

        let json = serde_json::to_string(&params).unwrap();
        assert!(json.contains("filter"));
        assert!(json.contains("cql2-json"));
        assert!(json.contains("eo:cloud_cover"));
    }

    // -------------------------------------------------------------------------
    // Edge cases
    // -------------------------------------------------------------------------

    #[test]
    fn test_stac_item_with_null_datetime() {
        let json = r#"{
            "id": "test-item",
            "type": "Feature",
            "geometry": null,
            "bbox": null,
            "properties": {
                "datetime": null
            },
            "assets": {},
            "links": null
        }"#;

        let item: StacItem = serde_json::from_str(json).unwrap();
        assert_eq!(item.id, "test-item");
        assert_eq!(item.properties.datetime, None);
        assert!(item.bbox.is_none());
    }

    #[test]
    fn test_stac_collection_minimal() {
        let json = r#"{
            "id": "minimal",
            "description": "A minimal collection"
        }"#;

        let collection: StacCollection = serde_json::from_str(json).unwrap();
        assert_eq!(collection.id, "minimal");
        assert_eq!(collection.title, None);
        assert_eq!(collection.license, None);
        assert!(collection.extent.is_none());
    }

    #[test]
    fn test_stac_item_extra_properties() {
        let json = r#"{
            "id": "test",
            "type": "Feature",
            "geometry": null,
            "properties": {
                "datetime": "2023-01-01T00:00:00Z",
                "eo:cloud_cover": 10.0,
                "platform": "sentinel-2a",
                "custom:property": "value"
            },
            "assets": {}
        }"#;

        let item: StacItem = serde_json::from_str(json).unwrap();
        assert_eq!(
            item.properties.datetime,
            Some("2023-01-01T00:00:00Z".to_string())
        );
        assert_eq!(item.properties.cloud_cover, Some(10.0));
        // Extra properties should be captured in the 'extra' field
        assert!(item.properties.extra.contains_key("platform"));
    }

    // -------------------------------------------------------------------------
    // URL handling tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_url_normalization() {
        // Test that trailing slashes are handled correctly
        let url_with_slash = "https://earth-search.aws.element84.com/v1/";
        let url_without_slash = "https://earth-search.aws.element84.com/v1";

        let normalized1 = url_with_slash.trim_end_matches('/');
        let normalized2 = url_without_slash.trim_end_matches('/');

        assert_eq!(normalized1, normalized2);
        assert_eq!(normalized1, "https://earth-search.aws.element84.com/v1");
    }

    #[test]
    fn test_vsicurl_path_construction() {
        let asset_href = "https://example.com/data/image.tif";
        let vsicurl_path = format!("/vsicurl/{}", asset_href);

        assert_eq!(vsicurl_path, "/vsicurl/https://example.com/data/image.tif");
    }

    #[test]
    fn test_collections_url_construction() {
        let base_url = "https://earth-search.aws.element84.com/v1";
        let collections_url = format!("{}/collections", base_url.trim_end_matches('/'));

        assert_eq!(
            collections_url,
            "https://earth-search.aws.element84.com/v1/collections"
        );
    }

    #[test]
    fn test_search_url_construction() {
        let base_url = "https://earth-search.aws.element84.com/v1/";
        let search_url = format!("{}/search", base_url.trim_end_matches('/'));

        assert_eq!(
            search_url,
            "https://earth-search.aws.element84.com/v1/search"
        );
    }

    // -------------------------------------------------------------------------
    // Integration test for vsicurl (requires network)
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // Band stats and data type detection tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_band_stats_structure() {
        let stats = BandStats {
            band: 1,
            min: 0.0,
            max: 255.0,
            mean: 128.0,
            std_dev: 64.0,
        };

        assert_eq!(stats.band, 1);
        assert_eq!(stats.min, 0.0);
        assert_eq!(stats.max, 255.0);
    }

    #[test]
    fn test_raster_metadata_structure() {
        let metadata = RasterMetadata {
            id: "test-id".to_string(),
            path: "/vsicurl/https://example.com/test.tif".to_string(),
            width: 10980,
            height: 10980,
            bands: 3,
            bounds: [-10.0, 35.0, 5.0, 45.0],
            native_bounds: [-10.0, 35.0, 5.0, 45.0],
            projection: "EPSG:32630".to_string(),
            pixel_size: [10.0, 10.0],
            band_stats: vec![],
            nodata: None,
            is_georeferenced: true,
        };

        assert_eq!(metadata.id, "test-id");
        assert!(metadata.path.starts_with("/vsicurl/"));
        assert_eq!(metadata.bands, 3);
        assert_eq!(metadata.projection, "EPSG:32630");
    }

    // -------------------------------------------------------------------------
    // Asset role and type detection tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_asset_is_cog() {
        // COG with explicit profile
        let json = r#"{
            "href": "https://example.com/B04.tif",
            "type": "image/tiff; application=geotiff; profile=cloud-optimized"
        }"#;
        let asset: StacAsset = serde_json::from_str(json).unwrap();
        let media_type = asset.media_type.unwrap();
        assert!(media_type.contains("geotiff"));

        // Standard GeoTIFF (also valid for COG)
        let json2 = r#"{
            "href": "https://example.com/visual.tif",
            "type": "image/tiff; application=geotiff"
        }"#;
        let asset2: StacAsset = serde_json::from_str(json2).unwrap();
        assert!(asset2.media_type.unwrap().contains("tiff"));
    }

    #[test]
    fn test_asset_roles() {
        let json = r#"{
            "href": "https://example.com/visual.tif",
            "roles": ["visual", "data"]
        }"#;
        let asset: StacAsset = serde_json::from_str(json).unwrap();
        let roles = asset.roles.unwrap();
        assert!(roles.contains(&"visual".to_string()));
        assert!(roles.contains(&"data".to_string()));
    }

    #[test]
    fn test_asset_with_eo_bands() {
        let json = r#"{
            "href": "https://example.com/B04.tif",
            "eo:bands": [
                {
                    "name": "B04",
                    "common_name": "red",
                    "center_wavelength": 0.665
                }
            ]
        }"#;
        let asset: StacAsset = serde_json::from_str(json).unwrap();
        let bands = asset.eo_bands.unwrap();
        assert_eq!(bands.len(), 1);
        assert_eq!(bands[0].name, Some("B04".to_string()));
        assert_eq!(bands[0].common_name, Some("red".to_string()));
        assert!((bands[0].center_wavelength.unwrap() - 0.665).abs() < 0.001);
    }

    // -------------------------------------------------------------------------
    // Extent and bbox tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_collection_extent_parsing() {
        let json = r#"{
            "id": "test-collection",
            "description": "Test",
            "extent": {
                "spatial": {
                    "bbox": [[-180, -90, 180, 90]]
                },
                "temporal": {
                    "interval": [["2015-06-27T00:00:00Z", "2025-12-31T23:59:59Z"]]
                }
            }
        }"#;
        let collection: StacCollection = serde_json::from_str(json).unwrap();
        let extent = collection.extent.unwrap();

        let spatial = extent.spatial.unwrap();
        let bbox = &spatial.bbox.unwrap()[0];
        assert_eq!(bbox[0], -180.0);
        assert_eq!(bbox[1], -90.0);
        assert_eq!(bbox[2], 180.0);
        assert_eq!(bbox[3], 90.0);

        let temporal = extent.temporal.unwrap();
        let interval = &temporal.interval.unwrap()[0];
        assert_eq!(interval[0], Some("2015-06-27T00:00:00Z".to_string()));
        assert_eq!(interval[1], Some("2025-12-31T23:59:59Z".to_string()));
    }

    #[test]
    fn test_item_bbox_parsing() {
        let json = r#"{
            "id": "test-item",
            "type": "Feature",
            "geometry": {
                "type": "Polygon",
                "coordinates": [[[-122.5, 37.5], [-122.0, 37.5], [-122.0, 38.0], [-122.5, 38.0], [-122.5, 37.5]]]
            },
            "bbox": [-122.5, 37.5, -122.0, 38.0],
            "properties": {},
            "assets": {}
        }"#;
        let item: StacItem = serde_json::from_str(json).unwrap();
        let bbox = item.bbox.unwrap();

        assert_eq!(bbox[0], -122.5);
        assert_eq!(bbox[1], 37.5);
        assert_eq!(bbox[2], -122.0);
        assert_eq!(bbox[3], 38.0);
    }

    // -------------------------------------------------------------------------
    // Complex real-world item parsing
    // -------------------------------------------------------------------------

    #[test]
    fn test_sentinel2_item_parsing() {
        let json = r#"{
            "id": "S2A_30TYN_20231215_0_L2A",
            "type": "Feature",
            "collection": "sentinel-2-l2a",
            "geometry": {
                "type": "Polygon",
                "coordinates": [[[-5.0, 40.0], [-4.0, 40.0], [-4.0, 41.0], [-5.0, 41.0], [-5.0, 40.0]]]
            },
            "bbox": [-5.0, 40.0, -4.0, 41.0],
            "properties": {
                "datetime": "2023-12-15T10:45:30Z",
                "eo:cloud_cover": 15.5,
                "platform": "sentinel-2a",
                "constellation": "sentinel-2",
                "instruments": ["msi"],
                "s2:mgrs_tile": "30TYN",
                "proj:epsg": 32630
            },
            "assets": {
                "visual": {
                    "href": "https://example.com/TCI.tif",
                    "title": "True Color Image",
                    "type": "image/tiff; application=geotiff; profile=cloud-optimized",
                    "roles": ["visual", "data"]
                },
                "B04": {
                    "href": "https://example.com/B04.tif",
                    "title": "Band 4 (Red)",
                    "type": "image/tiff; application=geotiff; profile=cloud-optimized",
                    "roles": ["data"],
                    "eo:bands": [{"name": "B04", "common_name": "red"}]
                },
                "thumbnail": {
                    "href": "https://example.com/thumbnail.png",
                    "title": "Thumbnail",
                    "type": "image/png",
                    "roles": ["thumbnail"]
                }
            },
            "links": []
        }"#;

        let item: StacItem = serde_json::from_str(json).unwrap();

        // Basic properties
        assert_eq!(item.id, "S2A_30TYN_20231215_0_L2A");
        assert_eq!(item.collection, Some("sentinel-2-l2a".to_string()));
        assert_eq!(item.properties.cloud_cover, Some(15.5));

        // Assets
        assert_eq!(item.assets.len(), 3);
        assert!(item.assets.contains_key("visual"));
        assert!(item.assets.contains_key("B04"));
        assert!(item.assets.contains_key("thumbnail"));

        // Visual asset
        let visual = item.assets.get("visual").unwrap();
        assert!(visual.href.ends_with("TCI.tif"));
        assert!(visual
            .roles
            .as_ref()
            .unwrap()
            .contains(&"visual".to_string()));

        // Band asset with eo:bands
        let b04 = item.assets.get("B04").unwrap();
        assert!(b04.eo_bands.is_some());
    }

    // -------------------------------------------------------------------------
    // Error handling tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_invalid_json_handling() {
        let invalid_json = r#"{ invalid json }"#;
        let result: Result<StacCatalog, _> = serde_json::from_str(invalid_json);
        assert!(result.is_err());
    }

    #[test]
    fn test_missing_required_field() {
        // Missing 'id' field which is required
        let json = r#"{
            "type": "Feature",
            "geometry": null,
            "properties": {},
            "assets": {}
        }"#;
        let result: Result<StacItem, _> = serde_json::from_str(json);
        assert!(result.is_err());
    }

    // -------------------------------------------------------------------------
    // Integration test for vsicurl (requires network)
    // -------------------------------------------------------------------------

    #[test]
    #[ignore] // Run with: cargo test test_vsicurl_real_cog -- --ignored
    fn test_vsicurl_real_cog() {
        let url = "https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/30/T/YN/2025/12/S2C_30TYN_20251220_0_L2A/B03.tif";
        let vsicurl_path = format!("/vsicurl/{}", url);

        eprintln!("Testing vsicurl with: {}", vsicurl_path);
        eprintln!(
            "GDAL version: {}",
            gdal::version::version_info("VERSION_NUM")
        );
        eprintln!("BUILD_INFO: {}", gdal::version::version_info("BUILD_INFO"));
        eprintln!("Registered GDAL drivers: {}", gdal::DriverManager::count());

        // First try using gdalinfo command line to verify the file is accessible
        eprintln!("Testing gdalinfo command line...");
        let output = std::process::Command::new("gdalinfo")
            .arg(&vsicurl_path)
            .output();
        match output {
            Ok(out) => {
                eprintln!(
                    "gdalinfo stdout: {}",
                    String::from_utf8_lossy(&out.stdout)
                        .lines()
                        .take(3)
                        .collect::<Vec<_>>()
                        .join("\n")
                );
                eprintln!("gdalinfo stderr: {}", String::from_utf8_lossy(&out.stderr));
                eprintln!("gdalinfo exit status: {:?}", out.status);
            }
            Err(e) => eprintln!("gdalinfo command failed: {}", e),
        }

        // Try with explicit open_options using GDAL's open options
        eprintln!("Trying Dataset::open_ex with open options...");
        let options = DatasetOptions {
            open_flags: GdalOpenFlags::GDAL_OF_READONLY
                | GdalOpenFlags::GDAL_OF_RASTER
                | GdalOpenFlags::GDAL_OF_VERBOSE_ERROR,
            allowed_drivers: None, // Let GDAL auto-detect
            open_options: None,
            sibling_files: None,
        };

        match Dataset::open_ex(&vsicurl_path, options) {
            Ok(dataset) => {
                let (w, h) = dataset.raster_size();
                eprintln!("Success! Dataset size: {}x{}", w, h);
                assert!(w > 0);
                assert!(h > 0);
            }
            Err(e) => {
                eprintln!("Error opening dataset: {}", e);
                panic!("Failed to open COG via vsicurl: {}", e);
            }
        }
    }
}
