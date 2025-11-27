use chrono::{Datelike, Timelike};
use gdal::spatial_ref::{CoordTransform, SpatialRef};
use gdal::vector::LayerAccess;
use gdal::Dataset;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Serialize, Deserialize)]
pub struct VectorMetadata {
    pub id: String,
    pub path: String,
    pub name: String,
    pub feature_count: usize,
    pub geometry_type: String,
    pub bounds: [f64; 4], // [minx, miny, maxx, maxy] in EPSG:4326
    pub fields: Vec<FieldInfo>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct FieldInfo {
    pub name: String,
    pub field_type: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct VectorLayerData {
    pub metadata: VectorMetadata,
    pub geojson: Value,
}

/// Open a vector file and return GeoJSON
#[tauri::command]
pub async fn open_vector(path: String) -> Result<VectorLayerData, String> {
    let dataset = Dataset::open(&path).map_err(|e| format!("Failed to open vector: {}", e))?;

    let layer = dataset
        .layer(0)
        .map_err(|e| format!("Failed to get layer: {}", e))?;

    let layer_name = layer.name();
    let feature_count = layer.feature_count() as usize;

    // Get geometry type
    let geom_type = match layer.defn().geom_fields().next() {
        Some(field) => format!("{:?}", field.field_type()),
        None => "Unknown".to_string(),
    };

    // Get field info
    let fields: Vec<FieldInfo> = layer
        .defn()
        .fields()
        .map(|f| FieldInfo {
            name: f.name(),
            field_type: format!("{:?}", f.field_type()),
        })
        .collect();

    // Get bounds and transform to EPSG:4326 if needed
    let extent = layer
        .get_extent()
        .map_err(|e| format!("Failed to get extent: {}", e))?;

    let native_bounds = [extent.MinX, extent.MinY, extent.MaxX, extent.MaxY];
    let bounds = transform_vector_bounds(&layer, native_bounds)?;

    // Convert features to GeoJSON
    let geojson = convert_to_geojson(&dataset, 0)?;

    let id = uuid::Uuid::new_v4().to_string();

    let metadata = VectorMetadata {
        id: id.clone(),
        path,
        name: layer_name,
        feature_count,
        geometry_type: geom_type,
        bounds,
        fields,
    };

    Ok(VectorLayerData { metadata, geojson })
}

/// Transform bounds from layer CRS to EPSG:4326
fn transform_vector_bounds(
    layer: &gdal::vector::Layer,
    native_bounds: [f64; 4],
) -> Result<[f64; 4], String> {
    let spatial_ref = match layer.spatial_ref() {
        Some(srs) => srs,
        None => return Ok(native_bounds), // Assume already geographic
    };

    if spatial_ref.is_geographic() {
        return Ok(native_bounds);
    }

    let mut target_srs =
        SpatialRef::from_epsg(4326).map_err(|e| format!("Failed to create EPSG:4326: {}", e))?;
    target_srs
        .set_axis_mapping_strategy(gdal::spatial_ref::AxisMappingStrategy::TraditionalGisOrder);

    let transform = CoordTransform::new(&spatial_ref, &target_srs)
        .map_err(|e| format!("Failed to create transform: {}", e))?;

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
        .map_err(|e| format!("Failed to transform: {}", e))?;

    let min_lon = xs.iter().cloned().fold(f64::INFINITY, f64::min);
    let max_lon = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let min_lat = ys.iter().cloned().fold(f64::INFINITY, f64::min);
    let max_lat = ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max);

    Ok([min_lon, min_lat, max_lon, max_lat])
}

/// Convert OGR layer to GeoJSON FeatureCollection
fn convert_to_geojson(dataset: &Dataset, layer_idx: usize) -> Result<Value, String> {
    let mut layer = dataset
        .layer(layer_idx)
        .map_err(|e| format!("Failed to get layer: {}", e))?;

    // Get spatial reference for reprojection
    let source_srs = layer.spatial_ref();
    let needs_transform = source_srs
        .as_ref()
        .map(|srs| !srs.is_geographic())
        .unwrap_or(false);

    let transform = if needs_transform {
        let source = source_srs.as_ref().unwrap();
        let mut target = SpatialRef::from_epsg(4326)
            .map_err(|e| format!("Failed to create EPSG:4326: {}", e))?;
        target
            .set_axis_mapping_strategy(gdal::spatial_ref::AxisMappingStrategy::TraditionalGisOrder);
        Some(
            CoordTransform::new(source, &target)
                .map_err(|e| format!("Failed to create transform: {}", e))?,
        )
    } else {
        None
    };

    // Collect field names before iterating (to avoid borrow conflicts)
    let field_names: Vec<String> = layer.defn().fields().map(|f| f.name()).collect();

    let mut features = Vec::new();

    for feature in layer.features() {
        let mut properties = json!({});

        // Get all field values
        for (idx, field_name) in field_names.iter().enumerate() {
            let value = match feature.field(idx) {
                Ok(Some(gdal::vector::FieldValue::IntegerValue(v))) => json!(v),
                Ok(Some(gdal::vector::FieldValue::Integer64Value(v))) => json!(v),
                Ok(Some(gdal::vector::FieldValue::RealValue(v))) => json!(v),
                Ok(Some(gdal::vector::FieldValue::StringValue(v))) => json!(v),
                Ok(Some(gdal::vector::FieldValue::DateValue(d))) => {
                    json!(format!("{}-{:02}-{:02}", d.year(), d.month(), d.day()))
                }
                Ok(Some(gdal::vector::FieldValue::DateTimeValue(dt))) => {
                    json!(format!(
                        "{}-{:02}-{:02}T{:02}:{:02}:{:02}",
                        dt.year(),
                        dt.month(),
                        dt.day(),
                        dt.hour(),
                        dt.minute(),
                        dt.second()
                    ))
                }
                _ => Value::Null,
            };
            properties[field_name.clone()] = value;
        }

        // Get geometry and convert to GeoJSON
        if let Some(geom) = feature.geometry() {
            let mut geom_clone = geom.clone();

            // Transform to EPSG:4326 if needed
            if let Some(ref t) = transform {
                geom_clone
                    .transform_inplace(t)
                    .map_err(|e| format!("Failed to transform geometry: {}", e))?;
            }

            let geom_json = geometry_to_geojson(&geom_clone)?;

            features.push(json!({
                "type": "Feature",
                "properties": properties,
                "geometry": geom_json
            }));
        }
    }

    Ok(json!({
        "type": "FeatureCollection",
        "features": features
    }))
}

/// Convert GDAL geometry to GeoJSON geometry object
fn geometry_to_geojson(geom: &gdal::vector::Geometry) -> Result<Value, String> {
    // Use GDAL's built-in JSON export - much more reliable
    match geom.json() {
        Ok(json_str) => serde_json::from_str(&json_str)
            .map_err(|e| format!("Failed to parse geometry JSON: {}", e)),
        Err(e) => {
            // Fallback: return null geometry
            eprintln!("Warning: Failed to convert geometry to JSON: {}", e);
            Ok(Value::Null)
        }
    }
}
